// Incremental repository intelligence: instruction hierarchy and project graph.

import path from "node:path";
import os from "node:os";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

const MANIFESTS = new Set([
  "package.json", "pnpm-workspace.yaml", "yarn.lock", "package-lock.json",
  "turbo.json", "nx.json", "pubspec.yaml", "Cargo.toml", "go.mod",
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle",
  "settings.gradle.kts", "Package.swift", "pyproject.toml", "requirements.txt",
  "composer.json", "Gemfile"
]);
const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".cache", "coverage", ".venv", "__pycache__", "vendor"]);
const graphCache = new Map();

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function normalizeRel(root, absolute) { return path.relative(root, absolute).split(path.sep).join("/") || "."; }

async function walk(root, { maxDepth = 6, maxFiles = 10000 } = {}) {
  const files = [];
  async function visit(dir, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.isDirectory() && SKIP.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(root, 0);
  return files;
}

async function readText(file, maxChars = 100000) {
  const content = await readFile(file, "utf8");
  return content.slice(0, maxChars);
}

export async function discoverInstructionChain(root, target = ".", options = {}) {
  const maxChars = Number(options.maxChars || 32000);
  const targetAbs = path.resolve(root, target);
  const info = await stat(targetAbs).catch(() => null);
  const targetDir = info?.isDirectory() ? targetAbs : path.dirname(targetAbs);
  const candidates = [];
  const globalDir = path.join(os.homedir(), ".config", "lca");
  for (const name of ["AGENTS.md", "AGENTS.override.md"]) candidates.push({ path: path.join(globalDir, name), scope: "global", priority: 0 });

  let cursor = root;
  let priority = 10;
  while (true) {
    for (const name of ["AGENTS.md", "AGENTS.override.md"]) candidates.push({ path: path.join(cursor, name), scope: normalizeRel(root, cursor), priority: priority + (name.includes("override") ? 1 : 0) });
    if (cursor === targetDir) break;
    const rel = path.relative(cursor, targetDir);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) break;
    const nextPart = rel.split(path.sep).filter(Boolean)[0];
    if (!nextPart) break;
    cursor = path.join(cursor, nextPart);
    priority += 10;
  }

  const instructions = [];
  let used = 0;
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    const content = await readText(candidate.path, maxChars - used).catch(() => "");
    if (!content) continue;
    used += content.length;
    instructions.push({
      path: candidate.path.startsWith(root) ? normalizeRel(root, candidate.path) : candidate.path,
      scope: candidate.scope,
      priority: candidate.priority,
      override: path.basename(candidate.path).includes("override"),
      sha256: hash(content),
      content
    });
    if (used >= maxChars) break;
  }
  instructions.sort((a, b) => a.priority - b.priority);
  return { root, target: normalizeRel(root, targetAbs), count: instructions.length, chars: used, instructions };
}

function detectPackageManager(packageJson, dir) {
  if (typeof packageJson?.packageManager === "string") return packageJson.packageManager.split("@")[0];
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(dir, "package-lock.json"))) return "npm";
  return "npm";
}

function commandKind(name) {
  const key = String(name).toLowerCase();
  if (/test|spec|e2e|integration/.test(key)) return "test";
  if (/lint|eslint|clippy|flake/.test(key)) return "lint";
  if (/type.?check|tsc|analyze/.test(key)) return "typecheck";
  if (/build|compile|bundle|package/.test(key)) return "build";
  if (/dev|serve|start|watch/.test(key)) return "dev";
  if (/format|prettier|fmt/.test(key)) return "format";
  if (/security|audit/.test(key)) return "security";
  return "script";
}

async function packageProject(root, manifest) {
  const dir = path.dirname(manifest);
  const pkg = JSON.parse(await readText(manifest, 100000));
  const packageManager = detectPackageManager(pkg, dir);
  const prefix = packageManager === "npm" ? ["npm", "run"] : [packageManager, "run"];
  const commands = Object.entries(pkg.scripts || {}).map(([name, script]) => ({
    id: name,
    name,
    kind: commandKind(name),
    file: prefix[0],
    args: name === "test" && packageManager === "npm" ? ["test"] : [prefix[1], name],
    shell_command: packageManager === "npm" && name === "test" ? "npm test" : `${packageManager} run ${name}`,
    script,
    cost: /e2e|integration|all|full|build/.test(name.toLowerCase()) ? "high" : /test|lint|type/.test(name.toLowerCase()) ? "medium" : "low"
  }));
  return {
    id: pkg.name || normalizeRel(root, dir),
    name: pkg.name || path.basename(dir),
    path: normalizeRel(root, dir),
    manifest: normalizeRel(root, manifest),
    language: "javascript",
    framework: Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).find((name) => ["next", "react", "vue", "svelte", "@angular/core"].includes(name)) || null,
    packageManager,
    commands,
    dependencies: Object.keys(pkg.dependencies || {}),
    devDependencies: Object.keys(pkg.devDependencies || {})
  };
}

async function genericProject(root, manifest) {
  const name = path.basename(manifest);
  const dir = path.dirname(manifest);
  const types = {
    "pubspec.yaml": ["dart", "flutter"],
    "Cargo.toml": ["rust", "cargo"],
    "go.mod": ["go", "go"],
    "pom.xml": ["java", "maven"],
    "build.gradle": ["java", "gradle"],
    "build.gradle.kts": ["kotlin", "gradle"],
    "Package.swift": ["swift", "swiftpm"],
    "pyproject.toml": ["python", "python"],
    "requirements.txt": ["python", "pip"],
    "composer.json": ["php", "composer"],
    "Gemfile": ["ruby", "bundler"]
  };
  const [language, packageManager] = types[name] || ["unknown", null];
  const commandTemplates = {
    flutter: [{ id: "test", kind: "test", file: "flutter", args: ["test"] }, { id: "analyze", kind: "lint", file: "flutter", args: ["analyze"] }],
    cargo: [{ id: "test", kind: "test", file: "cargo", args: ["test"] }, { id: "build", kind: "build", file: "cargo", args: ["build"] }, { id: "clippy", kind: "lint", file: "cargo", args: ["clippy"] }],
    go: [{ id: "test", kind: "test", file: "go", args: ["test", "./..."] }, { id: "build", kind: "build", file: "go", args: ["build", "./..."] }],
    maven: [{ id: "test", kind: "test", file: "mvn", args: ["test"] }, { id: "build", kind: "build", file: "mvn", args: ["package"] }],
    gradle: [{ id: "test", kind: "test", file: existsSync(path.join(dir, "gradlew")) ? "./gradlew" : "gradle", args: ["test"] }, { id: "build", kind: "build", file: existsSync(path.join(dir, "gradlew")) ? "./gradlew" : "gradle", args: ["build"] }],
    swiftpm: [{ id: "test", kind: "test", file: "swift", args: ["test"] }, { id: "build", kind: "build", file: "swift", args: ["build"] }],
    python: [{ id: "test", kind: "test", file: "python", args: ["-m", "pytest"] }]
  };
  return {
    id: normalizeRel(root, dir),
    name: path.basename(dir),
    path: normalizeRel(root, dir),
    manifest: normalizeRel(root, manifest),
    language,
    framework: packageManager === "flutter" ? "flutter" : null,
    packageManager,
    commands: (commandTemplates[packageManager] || []).map((command) => ({ ...command, cost: "medium", shell_command: [command.file, ...command.args].join(" ") })),
    dependencies: [],
    devDependencies: []
  };
}

export async function buildProjectGraph(root, options = {}) {
  const cacheKey = path.resolve(root);
  const cached = graphCache.get(cacheKey);
  const ttlMs = Number(options.ttlMs || 30000);
  if (!options.refresh && cached && Date.now() - cached.savedAt < ttlMs) {
    return { ...cached.value, cached: true };
  }
  const files = await walk(root, { maxDepth: options.maxDepth || 7, maxFiles: options.maxFiles || 20000 });
  const manifests = files.filter((file) => MANIFESTS.has(path.basename(file)));
  const primary = manifests.filter((manifest) => !["yarn.lock", "package-lock.json", "pnpm-workspace.yaml", "turbo.json", "nx.json", "settings.gradle", "settings.gradle.kts"].includes(path.basename(manifest)));
  const projects = [];
  const seenDirs = new Set();
  for (const manifest of primary) {
    const dir = path.dirname(manifest);
    const key = `${dir}:${path.basename(manifest)}`;
    if (seenDirs.has(key)) continue;
    seenDirs.add(key);
    try {
      projects.push(path.basename(manifest) === "package.json" ? await packageProject(root, manifest) : await genericProject(root, manifest));
    } catch (error) {
      projects.push({ id: normalizeRel(root, dir), path: normalizeRel(root, dir), manifest: normalizeRel(root, manifest), error: String(error?.message || error), commands: [] });
    }
  }
  const commands = projects.flatMap((project) => (project.commands || []).map((command) => ({ ...command, project: project.id, cwd: project.path })));
  const value = {
    root,
    generatedAt: new Date().toISOString(),
    manifestCount: manifests.length,
    manifests: manifests.map((file) => normalizeRel(root, file)),
    projectCount: projects.length,
    projects,
    commands,
    cached: false
  };
  graphCache.set(cacheKey, { savedAt: Date.now(), value });
  return value;
}
