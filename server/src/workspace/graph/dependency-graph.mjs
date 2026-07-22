// Local Coding Agent workspace package and import dependency graph.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";

export function buildWorkspaceDependencyGraph(records, coverage, workspaceId) {
  const recordByPath = records &&
    typeof records.get === "function" &&
    typeof records.keys === "function" &&
    typeof records.values === "function"
    ? records
    : new Map();
  const allPaths = {
    has: (relativePath) => recordByPath.has(relativePath),
    [Symbol.iterator]: () => recordByPath.keys()
  };
  const dependencyRecords = typeof recordByPath.dependencyValues === "function"
    ? { values: () => recordByPath.dependencyValues() }
    : recordByPath;
  const packages = discoverGraphPackages(dependencyRecords);
  const packagesByName = new Map();
  for (const pkg of packages.filter((candidate) => candidate.name)) {
    const candidates = packagesByName.get(pkg.name) || [];
    candidates.push(pkg);
    packagesByName.set(pkg.name, candidates);
  }
  const importEdges = [];
  const unresolvedLocalImports = [];

  for (const record of dependencyRecords.values()) {
    for (const imported of record.imports) {
      const resolution = resolveModuleTarget({
        record,
        imported,
        allPaths,
        packages,
        packagesByName
      });
      const edge = {
        from: qualifiedPath(workspaceId, record.path),
        to: resolution.path ? qualifiedPath(workspaceId, resolution.path) : null,
        module: imported.module,
        imported_names: [...imported.names],
        line: imported.line,
        kind: resolution.kind,
        resolved: Boolean(resolution.path),
        local: resolution.local
      };
      importEdges.push(edge);
      if (resolution.local && !resolution.path) unresolvedLocalImports.push(edge);
    }
  }

  for (const pkg of packages) {
    pkg.internal_dependencies = pkg.declared_dependencies
      .map((dependency) => selectCompatibleGraphPackage(pkg, packagesByName.get(dependency))?.id)
      .filter(Boolean);
    pkg.dependents = [];
  }
  const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  for (const pkg of packages) {
    for (const dependencyId of pkg.internal_dependencies) {
      const dependency = packageById.get(dependencyId);
      if (dependency && !dependency.dependents.includes(pkg.id)) dependency.dependents.push(pkg.id);
    }
  }
  for (const pkg of packages) {
    pkg.internal_dependencies.sort();
    pkg.dependents.sort();
  }

  return {
    workspace_id: workspaceId,
    generation: null,
    completeness: coverage?.complete && coverage?.content_complete ? "complete" : "partial",
    packages,
    import_edges: importEdges,
    unresolved_local_imports: unresolvedLocalImports
  };
}

export function discoverGraphPackages(records) {
  const packages = [];
  for (const record of records.values()) {
    const name = path.posix.basename(record.path);
    const cwd = path.posix.dirname(record.path) === "." ? "." : path.posix.dirname(record.path);
    let descriptor = null;
    if (name === "package.json") {
      const parsed = parseJsonObject(record.content);
      descriptor = {
        ecosystem: "node",
        name: stringOrNull(parsed?.name),
        declared_dependencies: objectKeys(
          parsed?.dependencies,
          parsed?.devDependencies,
          parsed?.peerDependencies,
          parsed?.optionalDependencies
        )
      };
    } else if (name === "pyproject.toml") {
      descriptor = {
        ecosystem: "python",
        name: tomlValue(record.content, "name"),
        declared_dependencies: []
      };
    } else if (name === "go.mod") {
      descriptor = {
        ecosystem: "go",
        name: String(record.content || "").match(/^\s*module\s+(\S+)/m)?.[1] || null,
        declared_dependencies: [...String(record.content || "").matchAll(/^\s*require\s+(\S+)/gm)].map((match) => match[1])
      };
    } else if (name === "Cargo.toml") {
      descriptor = {
        ecosystem: "rust",
        name: tomlValue(record.content, "name"),
        declared_dependencies: tomlSectionKeys(record.content, "dependencies")
      };
    } else if (name === "pubspec.yaml") {
      descriptor = {
        ecosystem: "dart",
        name: yamlTopLevelValue(record.content, "name"),
        declared_dependencies: yamlSectionKeys(record.content, "dependencies")
      };
    } else if (name === "pom.xml") {
      descriptor = {
        ecosystem: "maven",
        name: String(record.content || "").match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/)?.[1]?.trim() || null,
        declared_dependencies: [...String(record.content || "").matchAll(/<dependency>[\s\S]*?<artifactId>\s*([^<]+)\s*<\/artifactId>[\s\S]*?<\/dependency>/g)]
          .map((match) => match[1].trim())
      };
    } else if (name.endsWith(".csproj")) {
      descriptor = {
        ecosystem: "dotnet",
        name: String(record.content || "").match(/<AssemblyName>\s*([^<]+)\s*<\/AssemblyName>/)?.[1]?.trim() || path.posix.basename(name, ".csproj"),
        declared_dependencies: [...String(record.content || "").matchAll(/<ProjectReference\s+Include=["']([^"']+)["']/g)]
          .map((match) => path.posix.basename(match[1].replaceAll("\\", "/"), ".csproj"))
      };
    }
    if (!descriptor) continue;
    packages.push({
      id: packageId(descriptor.ecosystem, cwd),
      cwd,
      manifest: record.path,
      ecosystem: descriptor.ecosystem,
      name: descriptor.name,
      declared_dependencies: [...new Set(descriptor.declared_dependencies.filter(Boolean))].sort(),
      internal_dependencies: [],
      dependents: []
    });
  }
  return packages.sort((left, right) => left.cwd.localeCompare(right.cwd) || left.ecosystem.localeCompare(right.ecosystem));
}

export function resolveModuleTarget({ record, imported, allPaths, packages, packagesByName }) {
  const moduleSpecifier = String(imported.module || "").replace(/[?#].*$/, "");
  const fromDirectory = path.posix.dirname(record.path);
  const relative = moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../");
  if (relative) {
    const base = path.posix.normalize(path.posix.join(fromDirectory, moduleSpecifier));
    return candidateResolution(base, record.language, allPaths, true, "relative");
  }
  if (record.language === "python") {
    const leadingDots = moduleSpecifier.match(/^\.+/)?.[0].length || 0;
    let baseDirectory = fromDirectory;
    for (let index = 1; index < leadingDots; index++) baseDirectory = path.posix.dirname(baseDirectory);
    const modulePath = moduleSpecifier.slice(leadingDots).replaceAll(".", "/");
    const base = leadingDots
      ? path.posix.join(baseDirectory, modulePath)
      : modulePath;
    const resolved = candidateResolution(base, "python", allPaths, leadingDots > 0, leadingDots ? "relative" : "workspace_module");
    if (resolved.path) return resolved;
  }
  if (record.language === "rust" && /^(?:crate|self|super)::/.test(moduleSpecifier)) {
    const pkg = packageForPath(packages, record.path);
    const clean = moduleSpecifier.replace(/^(?:crate|self|super)::/, "").replaceAll("::", "/");
    const base = path.posix.join(pkg?.cwd === "." ? "" : pkg?.cwd || "", "src", clean);
    return candidateResolution(base, "rust", allPaths, true, "workspace_module");
  }
  if (record.language === "dart" && moduleSpecifier.startsWith("package:")) {
    const clean = moduleSpecifier.slice("package:".length);
    const slash = clean.indexOf("/");
    const packageName = slash >= 0 ? clean.slice(0, slash) : clean;
    const pkg = selectLanguagePackage(record.language, packagesByName.get(packageName));
    if (pkg) {
      const inner = slash >= 0 ? clean.slice(slash + 1) : "index.dart";
      return candidateResolution(path.posix.join(pkg.cwd === "." ? "" : pkg.cwd, "lib", inner), "dart", allPaths, true, "workspace_package");
    }
  }
  const internalPackage = longestPackagePrefix(packagesByName, moduleSpecifier, record.language);
  if (internalPackage) {
    const suffix = moduleSpecifier.slice(internalPackage.name.length).replace(/^\/+/, "");
    const root = internalPackage.cwd === "." ? "" : internalPackage.cwd;
    for (const base of [
      suffix ? path.posix.join(root, suffix) : path.posix.join(root, "src", "index"),
      suffix ? path.posix.join(root, "src", suffix) : path.posix.join(root, "index")
    ]) {
      const resolved = candidateResolution(base, record.language, allPaths, true, "workspace_package");
      if (resolved.path) return resolved;
    }
    return { path: null, local: true, kind: "workspace_package" };
  }
  const ownPackage = packageForPath(packages, record.path);
  if (record.language === "go" && ownPackage?.name && moduleSpecifier.startsWith(`${ownPackage.name}/`)) {
    const packageRelative = moduleSpecifier.slice(ownPackage.name.length + 1);
    const directory = path.posix.join(ownPackage.cwd === "." ? "" : ownPackage.cwd, packageRelative);
    const target = [...allPaths].find((candidate) =>
      path.posix.dirname(candidate) === directory && candidate.endsWith(".go") && !candidate.endsWith("_test.go")
    );
    return { path: target || null, local: true, kind: "workspace_module" };
  }
  if (["java", "kotlin", "csharp"].includes(record.language)) {
    const suffixes = [
      `${moduleSpecifier.replaceAll(".", "/")}.java`,
      `${moduleSpecifier.replaceAll(".", "/")}.kt`,
      `${moduleSpecifier.replaceAll(".", "/")}.cs`
    ];
    const matches = [...allPaths].filter((candidate) => suffixes.some((suffix) => candidate.endsWith(suffix)));
    if (matches.length === 1) return { path: matches[0], local: true, kind: "workspace_module" };
  }
  return { path: null, local: false, kind: "external" };
}

export function candidateResolution(base, language, allPaths, local, kind) {
  const clean = base.replace(/^\.\//, "");
  const extension = path.posix.extname(clean);
  const candidates = [clean];
  if (extension) {
    const withoutExtension = clean.slice(0, -extension.length);
    if ([".js", ".mjs", ".cjs", ".jsx"].includes(extension)) {
      candidates.push(...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((next) => `${withoutExtension}${next}`));
    }
  } else {
    const extensions = language === "python"
      ? [".py"]
      : language === "go" ? [".go"]
        : language === "rust" ? [".rs"]
          : language === "dart" ? [".dart"]
            : [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
    candidates.push(...extensions.map((next) => `${clean}${next}`));
    candidates.push(...extensions.map((next) => path.posix.join(clean, language === "python" ? `__init__${next}` : `index${next}`)));
    if (language === "rust") candidates.push(path.posix.join(clean, "mod.rs"));
  }
  const selected = candidates.find((candidate) => allPaths.has(candidate));
  return { path: selected || null, local, kind };
}

export function longestPackagePrefix(packagesByName, moduleSpecifier, language) {
  return [...packagesByName.values()].flat()
    .filter((pkg) => moduleSpecifier === pkg.name || moduleSpecifier.startsWith(`${pkg.name}/`))
    .filter((pkg) => packageMatchesLanguage(pkg, language))
    .sort((left, right) => right.name.length - left.name.length)[0] || null;
}

export function selectCompatibleGraphPackage(source, candidates = []) {
  return candidates.find((candidate) => candidate.ecosystem === source.ecosystem) || null;
}

export function selectLanguagePackage(language, candidates = []) {
  return candidates.find((candidate) => packageMatchesLanguage(candidate, language)) || null;
}

export function packageMatchesLanguage(pkg, language) {
  const ecosystem = {
    javascript: "node",
    typescript: "node",
    python: "python",
    go: "go",
    rust: "rust",
    dart: "dart",
    java: "maven",
    kotlin: "maven",
    csharp: "dotnet"
  }[language];
  return !ecosystem || pkg.ecosystem === ecosystem;
}

export function packageForPath(packages, filePath) {
  return packages
    .filter((pkg) => isWithin(filePath, pkg.cwd))
    .sort((left, right) => pathDepth(right.cwd) - pathDepth(left.cwd))[0] || null;
}

export function isWithin(filePath, cwd) {
  return cwd === "." || filePath === cwd || filePath.startsWith(`${cwd}/`);
}

export function isTestFile(filePath) {
  const normalized = `/${String(filePath).toLowerCase()}`;
  const name = path.posix.basename(normalized);
  return /(?:^|\.)test\.[^.]+$/.test(name) ||
    /(?:^|\.)spec\.[^.]+$/.test(name) ||
    /^test_.+\.py$/.test(name) ||
    /_test\.(?:py|go)$/.test(name) ||
    normalized.includes("/__tests__/") ||
    normalized.includes("/tests/") ||
    normalized.includes("/test/") ||
    normalized.includes("/src/test/");
}

export function qualifiedPath(workspaceId, filePath) {
  return { workspace_id: workspaceId, path: filePath };
}

export function packageId(ecosystem, cwd) {
  return `${ecosystem}:${cwd}`;
}

export function pathDepth(value) {
  return value === "." ? 0 : String(value).split("/").length;
}

export function parseJsonObject(source) {
  try {
    const value = JSON.parse(String(source || ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function objectKeys(...values) {
  return [...new Set(values.flatMap((value) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : []
  ))];
}

export function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function tomlValue(source, key) {
  const match = String(source || "").match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m"));
  return match?.[1]?.trim() || null;
}

export function tomlSectionKeys(source, section) {
  const lines = String(source || "").split(/\r?\n/);
  let active = false;
  const keys = [];
  for (const line of lines) {
    const heading = line.match(/^\s*\[([^\]]+)]/);
    if (heading) {
      active = heading[1] === section;
      continue;
    }
    if (!active) continue;
    const key = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1];
    if (key) keys.push(key);
  }
  return keys;
}

export function yamlTopLevelValue(source, key) {
  return String(source || "").match(new RegExp(`^${key}:\\s*["']?([^#\\s"']+)`, "m"))?.[1] || null;
}

export function yamlSectionKeys(source, section) {
  const lines = String(source || "").split(/\r?\n/);
  let active = false;
  const keys = [];
  for (const line of lines) {
    if (!/^\s/.test(line)) {
      active = line.startsWith(`${section}:`);
      continue;
    }
    if (!active) continue;
    const key = line.match(/^\s{2,}([A-Za-z0-9_.-]+):/)?.[1];
    if (key) keys.push(key);
  }
  return keys;
}


function normalizeRelativePath(value) {
  return String(value || "").split(path.sep).join("/").replace(/^\.\/+/, "") || ".";
}

