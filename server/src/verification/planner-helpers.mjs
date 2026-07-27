// Local Coding Agent verification package and gate helpers.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const DEFAULT_GATES = ["lint", "typecheck", "test", "build"];
const SUPPORTED_GATES = new Set(DEFAULT_GATES);
const RELEVANT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs",
  ".java", ".kt", ".kts", ".cs", ".dart", ".sh", ".bash", ".zsh", ".fish",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".swift", ".php", ".rb",
  ".vue", ".svelte", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml",
  ".sql", ".gradle"
]);
const MANIFEST_NAMES = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml",
  "pubspec.yaml", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle",
  "settings.gradle.kts", "pytest.ini", "setup.cfg", "tox.ini"
]);

export function discoverPackages(records) {
  const packages = [];
  const recordByPath = new Map(records.map((record) => [record.path, record]));
  const allPaths = new Set(recordByPath.keys());

  for (const record of records) {
    const name = path.posix.basename(record.path);
    const cwd = path.posix.dirname(record.path) === "." ? "." : path.posix.dirname(record.path);
    if (name === "package.json") {
      const parsed = parseJson(record.content);
      const scripts = parsed?.scripts || {};
      const manager = nodePackageManager(cwd, allPaths);
      packages.push({
        cwd,
        ecosystem: "node",
        name: typeof parsed?.name === "string" ? parsed.name : null,
        declared_dependencies: dependencyNames(parsed),
        targeted_test_support: supportsNodeTargetedTests(scripts.test),
        manifest: record.path,
        commands: {
          test: scriptCommand(manager, "test", scripts.test),
          build: scriptCommand(manager, "build", scripts.build),
          lint: scriptCommand(manager, "lint", scripts.lint),
          typecheck: firstScriptCommand(manager, scripts, ["typecheck", "type-check", "type:check"])
        }
      });
    } else if (name === "pyproject.toml" || name === "requirements.txt") {
      const source = record.content || "";
      packages.push({
        cwd,
        ecosystem: "python",
        name: tomlValue(source, "name"),
        declared_dependencies: [],
        targeted_test_support: true,
        manifest: record.path,
        commands: {
          test: "python -m pytest",
          build: /\[build-system\]/.test(source) ? "python -m build" : null,
          lint: /\b(ruff|flake8)\b/i.test(source)
            ? (/\bruff\b/i.test(source) ? "python -m ruff check ." : "python -m flake8")
            : null,
          typecheck: /\b(mypy|pyright)\b/i.test(source)
            ? (/\bmypy\b/i.test(source) ? "python -m mypy ." : "pyright")
            : null
        }
      });
    } else if (name === "go.mod") {
      packages.push({
        cwd,
        ecosystem: "go",
        name: String(record.content || "").match(/^\s*module\s+(\S+)/m)?.[1] || null,
        declared_dependencies: [...String(record.content || "").matchAll(/^\s*require\s+(\S+)/gm)].map((match) => match[1]),
        targeted_test_support: true,
        manifest: record.path,
        commands: {
          test: "go test ./...",
          build: "go build ./...",
          lint: "go vet ./...",
          typecheck: null
        }
      });
    } else if (name === "Cargo.toml") {
      packages.push({
        cwd,
        ecosystem: "rust",
        name: tomlValue(record.content, "name"),
        declared_dependencies: tomlSectionKeys(record.content, "dependencies"),
        targeted_test_support: false,
        manifest: record.path,
        commands: {
          test: "cargo test",
          build: "cargo build",
          lint: "cargo clippy --all-targets --all-features -- -D warnings",
          typecheck: "cargo check"
        }
      });
    } else if (name === "pubspec.yaml") {
      const flutter = /\bflutter\s*:/m.test(record.content || "");
      packages.push({
        cwd,
        ecosystem: flutter ? "flutter" : "dart",
        name: yamlTopLevelValue(record.content, "name"),
        declared_dependencies: yamlSectionKeys(record.content, "dependencies"),
        targeted_test_support: true,
        manifest: record.path,
        commands: {
          test: flutter ? "flutter test" : "dart test",
          build: null,
          lint: flutter ? "flutter analyze" : "dart analyze",
          typecheck: flutter ? "flutter analyze" : "dart analyze"
        }
      });
    } else if (name === "pom.xml") {
      packages.push({
        cwd,
        ecosystem: "maven",
        name: String(record.content || "").match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/)?.[1]?.trim() || null,
        declared_dependencies: [...String(record.content || "").matchAll(/<dependency>[\s\S]*?<artifactId>\s*([^<]+)\s*<\/artifactId>[\s\S]*?<\/dependency>/g)]
          .map((match) => match[1].trim()),
        targeted_test_support: false,
        manifest: record.path,
        commands: { test: "mvn test", build: "mvn package", lint: null, typecheck: null }
      });
    } else if (name === "build.gradle" || name === "build.gradle.kts") {
      const wrapper = allPaths.has(joinRelative(cwd, process.platform === "win32" ? "gradlew.bat" : "gradlew"));
      const gradle = wrapper ? (process.platform === "win32" ? "gradlew.bat" : "./gradlew") : "gradle";
      packages.push({
        cwd,
        ecosystem: "gradle",
        name: null,
        declared_dependencies: [],
        targeted_test_support: false,
        manifest: record.path,
        commands: { test: `${gradle} test`, build: `${gradle} build`, lint: null, typecheck: null }
      });
    } else if (name.endsWith(".csproj") || name.endsWith(".sln")) {
      packages.push({
        cwd,
        ecosystem: "dotnet",
        name: String(record.content || "").match(/<AssemblyName>\s*([^<]+)\s*<\/AssemblyName>/)?.[1]?.trim() || path.posix.basename(name, path.posix.extname(name)),
        declared_dependencies: [...String(record.content || "").matchAll(/<ProjectReference\s+Include=["']([^"']+)["']/g)]
          .map((match) => path.posix.basename(match[1].replaceAll("\\", "/"), ".csproj")),
        targeted_test_support: false,
        manifest: record.path,
        commands: { test: "dotnet test", build: "dotnet build", lint: null, typecheck: null }
      });
    }
  }
  return linkPackageDependencies(deduplicatePackages(packages));
}

export function selectAffectedPackages(packages, changes) {
  const selected = new Map();
  for (const change of changes) {
    const changePath = change.location.path;
    const candidates = packages.filter((pkg) => isWithinPackage(changePath, pkg.cwd));
    const byEcosystem = new Map();
    for (const pkg of candidates) {
      const prior = byEcosystem.get(pkg.ecosystem);
      if (!prior || pathDepth(pkg.cwd) > pathDepth(prior.cwd)) byEcosystem.set(pkg.ecosystem, pkg);
    }
    for (const pkg of byEcosystem.values()) {
      const key = `${pkg.ecosystem}:${pkg.cwd}`;
      const existing = selected.get(key) || { ...pkg, affected_files: [] };
      if (!existing.affected_files.some((location) => location.path === changePath)) {
        existing.affected_files.push(change.location);
      }
      selected.set(key, existing);
    }
  }
  return [...selected.values()].sort((a, b) => a.cwd.localeCompare(b.cwd) || a.ecosystem.localeCompare(b.ecosystem));
}

export function verificationChangeLocations(files) {
  const output = [];
  const seen = new Set();
  for (const entry of files || []) {
    for (const location of [entry.location, entry.original_location]) {
      if (!location?.path || seen.has(location.path)) continue;
      seen.add(location.path);
      output.push({ ...entry, location });
    }
  }
  return output;
}

export function expandAffectedDependents(packages, directlyAffected) {
  const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const selected = new Map();
  const queue = [];
  for (const pkg of directlyAffected) {
    const enriched = {
      ...pkg,
      impact_reason: "direct_change",
      dependency_source_packages: []
    };
    selected.set(pkg.id, enriched);
    queue.push(enriched);
  }
  while (queue.length) {
    const source = queue.shift();
    for (const dependentId of source.dependents || []) {
      const dependent = packageById.get(dependentId);
      if (!dependent) continue;
      const existing = selected.get(dependentId);
      if (existing) {
        if (!existing.dependency_source_packages.includes(source.id)) {
          existing.dependency_source_packages.push(source.id);
        }
        continue;
      }
      const expanded = {
        ...dependent,
        affected_files: [...source.affected_files],
        impact_reason: "internal_dependency_change",
        dependency_source_packages: [source.id]
      };
      selected.set(dependentId, expanded);
      queue.push(expanded);
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.cwd.localeCompare(right.cwd) || left.ecosystem.localeCompare(right.ecosystem)
  );
}

export function targetedTestSelectionFor(pkg, impact, { maxFiles, maxCommandLength }) {
  const fullCommand = pkg.commands?.test;
  if (!fullCommand) return { command: null, fallbackReason: "test_command_missing" };
  if (pkg.targeted_test_support !== true) {
    return { command: null, fallbackReason: "targeted_tests_unsupported" };
  }
  if (impact?.completeness !== "complete") {
    return { command: null, fallbackReason: "impact_analysis_incomplete" };
  }
  const changedPaths = (pkg.affected_files || []).map((location) => location.path);
  if (changedPaths.some((filePath) => isManifestOrLockfile(filePath))) {
    return { command: null, fallbackReason: "manifest_or_lockfile_changed" };
  }
  const testFiles = (impact.required_tests || []).map((location) => relativeToPackage(pkg.cwd, location.path));
  if (!testFiles.length) return { command: null, fallbackReason: "no_impacted_tests" };
  if (testFiles.length > maxFiles) {
    return { command: null, fallbackReason: "targeted_test_file_limit_exceeded" };
  }
  if (testFiles.some((filePath) => !isSafeCommandPath(filePath))) {
    return { command: null, fallbackReason: "unsafe_targeted_test_path" };
  }
  const fileList = testFiles.join(" ");
  let command = null;
  if (pkg.ecosystem === "node") {
    if (/^npm\s+(?:run\s+\S+|test)(?:\s|$)/.test(fullCommand)) command = `${fullCommand} -- ${fileList}`;
    else if (/^(?:pnpm|yarn|bun)\s+/.test(fullCommand)) command = `${fullCommand} ${fileList}`;
  } else if (pkg.ecosystem === "python") {
    command = `python -m pytest ${fileList}`;
  } else if (pkg.ecosystem === "go") {
    const directories = [...new Set(testFiles.map((filePath) => {
      const directory = path.posix.dirname(filePath);
      return directory === "." ? "." : `./${directory}`;
    }))];
    command = `go test ${directories.join(" ")}`;
  } else if (pkg.ecosystem === "dart") {
    command = `dart test ${fileList}`;
  } else if (pkg.ecosystem === "flutter") {
    command = `flutter test ${fileList}`;
  }
  if (!command) return { command: null, fallbackReason: "targeted_tests_unsupported" };
  if (command.length > maxCommandLength) {
    return { command: null, fallbackReason: "targeted_test_command_length_exceeded" };
  }
  return { command, fallbackReason: null };
}

export function evaluateGates({
  changes,
  relevantChanges,
  gates,
  unmanagedChanges,
  unmanagedStateUnknown,
  transactionInDoubt,
  coverage
}) {
  const summary = {
    pass: gates.filter((gate) => gate.status === "pass").length,
    fail: gates.filter((gate) => gate.status === "fail").length,
    pending: gates.filter((gate) => gate.status === "pending").length,
    missing: gates.filter((gate) => gate.status === "missing").length,
    skipped: gates.filter((gate) => gate.status === "skipped").length,
    total: gates.length
  };
  const reasons = [];
  if (summary.fail) reasons.push("REQUIRED_GATE_FAILED");
  if (summary.pending) reasons.push("REQUIRED_GATE_NOT_RUN");
  if (summary.missing) reasons.push("REQUIRED_GATE_MISSING");
  if (summary.skipped) reasons.push("REQUIRED_GATE_SKIPPED");
  if (unmanagedChanges) reasons.push("UNMANAGED_CHANGES");
  if (unmanagedStateUnknown) reasons.push("UNMANAGED_STATE_UNKNOWN");
  if (transactionInDoubt) reasons.push("TRANSACTION_IN_DOUBT");
  if (changes?.baseline_unknown) reasons.push("TASK_BASELINE_UNKNOWN");
  if (changes?.dirty_unknown) reasons.push("CHANGE_SET_UNKNOWN");
  if ((changes?.files?.length || 0) > 0 && coverage?.complete === false) {
    reasons.push("INDEX_COVERAGE_INCOMPLETE");
  }
  if (relevantChanges.length > 0 && gates.length === 0) reasons.push("NO_VERIFICATION_GATES");

  let status;
  if (summary.fail) status = "FAIL";
  else if (
    (changes?.files?.length || 0) === 0 &&
    !changes?.dirty_unknown &&
    !unmanagedChanges &&
    !unmanagedStateUnknown &&
    !transactionInDoubt &&
    reasons.length === 0
  ) status = "PASS";
  else if (reasons.length || gates.some((gate) => gate.status !== "pass")) status = "INCOMPLETE";
  else status = "PASS";
  return { status, reasons: [...new Set(reasons)], summary };
}

export function normalizeRequestedGates(include) {
  const source = Array.isArray(include) && include.length ? include : DEFAULT_GATES;
  const output = [];
  for (const raw of source) {
    const gate = String(raw);
    if (!SUPPORTED_GATES.has(gate)) throw new TypeError(`Unsupported verification gate: ${gate}`);
    if (!output.includes(gate)) output.push(gate);
  }
  return output;
}

export function normalizeResult(value) {
  if (!value) return null;
  let status = String(value.status || (value.ok === true ? "pass" : value.ok === false ? "fail" : "")).toLowerCase();
  if (!["pass", "fail", "skipped", "pending"].includes(status)) return null;
  const exitCode = Number.isInteger(value.exit_code) ? value.exit_code : null;
  const timedOut = value.timed_out === true;
  if (status === "pass" && (timedOut || (exitCode !== null && exitCode !== 0))) status = "fail";
  return {
    status,
    command: value.command ? String(value.command) : null,
    exit_code: exitCode,
    timed_out: timedOut,
    duration_ms: Number.isFinite(value.duration_ms) ? Number(value.duration_ms) : null,
    summary: value.summary ? String(value.summary).slice(0, 2_000) : null
  };
}

export function findResult(results, id, kind, cwd) {
  if (Array.isArray(results)) {
    return results.find((result) =>
      result?.id === id || (result?.kind === kind && resultCwd(result?.cwd) === cwd)
    );
  }
  if (!results || typeof results !== "object") return null;
  return results[id] || results[`${cwd}:${kind}`] || results[kind] || null;
}

export function gateReason(status, kind, pkg) {
  if (status === "missing") return `No ${kind} command detected for ${pkg.ecosystem || "workspace"} package.`;
  if (status === "skipped") return `Required ${kind} gate was skipped.`;
  if (status === "pending") return `Required ${kind} gate has not run.`;
  if (status === "fail") return `Required ${kind} gate failed.`;
  return null;
}

export function nodePackageManager(cwd, paths) {
  for (const directory of ancestors(cwd)) {
    if (paths.has(joinRelative(directory, "pnpm-lock.yaml"))) return "pnpm";
    if (paths.has(joinRelative(directory, "yarn.lock"))) return "yarn";
    if (paths.has(joinRelative(directory, "bun.lock")) || paths.has(joinRelative(directory, "bun.lockb"))) return "bun";
    if (paths.has(joinRelative(directory, "package-lock.json"))) return "npm";
  }
  return "npm";
}

export function scriptCommand(manager, name, source) {
  if (!source) return null;
  if (manager === "npm") return name === "test" ? "npm test" : `npm run ${name}`;
  if (manager === "yarn") return `yarn ${name}`;
  if (manager === "pnpm") return `pnpm ${name}`;
  if (manager === "bun") return `bun run ${name}`;
  return null;
}

export function firstScriptCommand(manager, scripts, names) {
  const name = names.find((candidate) => scripts[candidate]);
  return name ? scriptCommand(manager, name, scripts[name]) : null;
}

export function supportsNodeTargetedTests(source) {
  return typeof source === "string" && /\b(?:node\s+--test|jest|vitest|mocha|ava)\b/.test(source);
}

export function isVerificationRelevant(filePath) {
  const name = path.posix.basename(filePath);
  return isManifestOrLockfile(filePath) ||
    RELEVANT_EXTENSIONS.has(path.posix.extname(name).toLowerCase());
}

export function isWithinPackage(filePath, cwd) {
  return cwd === "." || filePath === cwd || filePath.startsWith(`${cwd}/`);
}

export function deduplicatePackages(packages) {
  const output = new Map();
  for (const pkg of packages) {
    const key = `${pkg.ecosystem}:${pkg.cwd}`;
    const existing = output.get(key);
    if (!existing) {
      output.set(key, pkg);
      continue;
    }
    output.set(key, {
      ...existing,
      name: existing.name || pkg.name || null,
      targeted_test_support: existing.targeted_test_support === true || pkg.targeted_test_support === true,
      declared_dependencies: [...new Set([
        ...(existing.declared_dependencies || []),
        ...(pkg.declared_dependencies || [])
      ])],
      manifest: existing.manifest || pkg.manifest,
      commands: {
        test: existing.commands.test || pkg.commands.test,
        build: existing.commands.build || pkg.commands.build,
        lint: existing.commands.lint || pkg.commands.lint,
        typecheck: existing.commands.typecheck || pkg.commands.typecheck
      }
    });
  }
  return [...output.values()];
}

export function linkPackageDependencies(packages) {
  const linked = packages.map((pkg) => ({
    ...pkg,
    id: `${pkg.ecosystem}:${pkg.cwd}`,
    declared_dependencies: [...new Set(pkg.declared_dependencies || [])].sort(),
    internal_dependencies: [],
    dependents: []
  }));
  const byName = new Map();
  for (const pkg of linked.filter((candidate) => candidate.name)) {
    const candidates = byName.get(pkg.name) || [];
    candidates.push(pkg);
    byName.set(pkg.name, candidates);
  }
  const byId = new Map(linked.map((pkg) => [pkg.id, pkg]));
  for (const pkg of linked) {
    pkg.internal_dependencies = pkg.declared_dependencies
      .map((dependency) => selectCompatiblePackage(pkg, byName.get(dependency))?.id)
      .filter(Boolean);
    for (const dependencyId of pkg.internal_dependencies) {
      const dependency = byId.get(dependencyId);
      if (dependency && !dependency.dependents.includes(pkg.id)) dependency.dependents.push(pkg.id);
    }
  }
  return linked;
}

export function selectCompatiblePackage(source, candidates = []) {
  return candidates.find((candidate) => ecosystemFamily(candidate.ecosystem) === ecosystemFamily(source.ecosystem)) || null;
}

export function ecosystemFamily(value) {
  if (["dart", "flutter"].includes(value)) return "dart";
  return value;
}

export function augmentPackageDependencies(packages, dependencyGraph) {
  const augmented = packages.map((pkg) => ({
    ...pkg,
    internal_dependencies: [...(pkg.internal_dependencies || [])],
    dependents: [...(pkg.dependents || [])]
  }));
  const byId = new Map(augmented.map((pkg) => [pkg.id, pkg]));
  const owner = (filePath) => augmented
    .filter((pkg) => isWithinPackage(filePath, pkg.cwd))
    .sort((left, right) => pathDepth(right.cwd) - pathDepth(left.cwd))[0] || null;
  for (const edge of dependencyGraph?.import_edges || []) {
    if (!edge.to?.path) continue;
    const importer = owner(edge.from.path);
    const dependency = owner(edge.to.path);
    if (!importer || !dependency || importer.id === dependency.id) continue;
    if (!importer.internal_dependencies.includes(dependency.id)) {
      importer.internal_dependencies.push(dependency.id);
    }
    if (!dependency.dependents.includes(importer.id)) dependency.dependents.push(importer.id);
  }
  for (const pkg of augmented) {
    pkg.internal_dependencies = pkg.internal_dependencies.filter((id) => byId.has(id)).sort();
    pkg.dependents = pkg.dependents.filter((id) => byId.has(id)).sort();
  }
  return augmented;
}

export function dependencyNames(parsed) {
  if (!parsed || typeof parsed !== "object") return [];
  return [...new Set([
    ...objectKeys(parsed.dependencies),
    ...objectKeys(parsed.devDependencies),
    ...objectKeys(parsed.peerDependencies),
    ...objectKeys(parsed.optionalDependencies)
  ])];
}

export function objectKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

export function tomlValue(source, key) {
  return String(source || "").match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m"))?.[1] || null;
}

export function tomlSectionKeys(source, section) {
  const output = [];
  let active = false;
  for (const line of String(source || "").split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)]/);
    if (heading) {
      active = heading[1] === section;
      continue;
    }
    if (!active) continue;
    const key = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1];
    if (key) output.push(key);
  }
  return output;
}

export function yamlTopLevelValue(source, key) {
  return String(source || "").match(new RegExp(`^${key}:\\s*["']?([^#\\s"']+)`, "m"))?.[1] || null;
}

export function yamlSectionKeys(source, section) {
  const output = [];
  let active = false;
  for (const line of String(source || "").split(/\r?\n/)) {
    if (!/^\s/.test(line)) {
      active = line.startsWith(`${section}:`);
      continue;
    }
    if (!active) continue;
    const key = line.match(/^\s{2,}([A-Za-z0-9_.-]+):/)?.[1];
    if (key) output.push(key);
  }
  return output;
}

export function isManifestOrLockfile(filePath) {
  const name = path.posix.basename(filePath);
  return MANIFEST_NAMES.has(name) ||
    /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|pubspec\.lock)$/.test(name) ||
    name.endsWith(".csproj") ||
    name.endsWith(".sln");
}

export function relativeToPackage(cwd, filePath) {
  if (cwd === ".") return filePath;
  return filePath.startsWith(`${cwd}/`) ? filePath.slice(cwd.length + 1) : filePath;
}

export function isSafeCommandPath(filePath) {
  return /^[A-Za-z0-9_./@+-]+$/.test(filePath) &&
    !filePath.startsWith("-") &&
    !filePath.split("/").includes("..");
}

export function parseJson(source) {
  try {
    return JSON.parse(source || "");
  } catch {
    return null;
  }
}

export function ancestors(cwd) {
  const output = [];
  let cursor = cwd === "." ? "" : cwd;
  while (true) {
    output.push(cursor || ".");
    if (!cursor) break;
    const parent = path.posix.dirname(cursor);
    cursor = parent === "." ? "" : parent;
  }
  return output;
}

export function joinRelative(cwd, name) {
  return cwd === "." || !cwd ? name : `${cwd}/${name}`;
}

export function pathDepth(value) {
  return value === "." ? 0 : value.split("/").length;
}

export function gateId(workspaceId, pkg, kind) {
  return `${workspaceId}:${pkg.ecosystem}:${pkg.cwd}:${kind}`;
}

export function qualifiedLocation(workspaceId, filePath) {
  return {
    workspace_id: workspaceId,
    path: filePath === "." ? "." : normalizeWorkspacePath(filePath)
  };
}

export function resultCwd(value) {
  if (value && typeof value === "object") return String(value.path || ".");
  return String(value || ".");
}

export function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.trunc(parsed)))
    : fallback;
}

export function normalizeWorkspacePath(value) {
  const normalized = String(value || "").split(path.sep).join("/").replace(/^\.\/+/, "");
  if (!normalized || normalized === "." || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Git returned an invalid workspace-relative path: ${value}`);
  }
  return normalized;
}

export function normalizeGitPrefix(value) {
  const normalized = String(value || "").split(path.sep).join("/").replace(/^\.\/+/, "");
  return normalized === "." ? "" : normalized.replace(/\/+$/, "");
}

export function relativizeGitEntry(entry, prefix) {
  if (!prefix) return entry;
  const marker = `${prefix}/`;
  if (!entry.path.startsWith(marker)) return null;
  const originalPath = entry.original_path?.startsWith(marker)
    ? entry.original_path.slice(marker.length)
    : null;
  return {
    ...entry,
    path: entry.path.slice(marker.length),
    original_path: originalPath,
    original_outside_workspace: Boolean(entry.original_path && !originalPath)
  };
}

export async function defaultExecute(command, args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    return { exit_code: 0, stdout, stderr };
  } catch (error) {
    return {
      exit_code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || error?.message || error)
    };
  }
}
