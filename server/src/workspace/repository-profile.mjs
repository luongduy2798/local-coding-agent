// Local Coding Agent repository profile and mutation fingerprint services
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

let DEFAULT_CMD_TIMEOUT;
let NON_GIT_MUTATION_MAX_FILES;
let NON_GIT_MUTATION_MAX_FILE_BYTES;
let NON_GIT_MUTATION_MAX_TOTAL_BYTES;
let NON_GIT_MUTATION_TIMEOUT_MS;
let SKIP_DIRS;
let isWithinRoots;
let parsePorcelainZ;
let spawnCapture;
let spawnOutputHash;
let toRel;

export function configureRepositoryProfile(dependencies) {
  ({
    DEFAULT_CMD_TIMEOUT,
    NON_GIT_MUTATION_MAX_FILES,
    NON_GIT_MUTATION_MAX_FILE_BYTES,
    NON_GIT_MUTATION_MAX_TOTAL_BYTES,
    NON_GIT_MUTATION_TIMEOUT_MS,
    SKIP_DIRS,
    isWithinRoots,
    parsePorcelainZ,
    spawnCapture,
    spawnOutputHash,
    toRel
  } = dependencies);
}

export async function detectProjectProfile(rootDir) {
  const profile = { languages: [], frameworks: [], packageManagers: [], scripts: {}, manifests: [] };

  async function tryRead(rel) {
    try {
      return await readFile(path.join(rootDir, rel), "utf8");
    } catch {
      return null;
    }
  }

  // Node / JavaScript / TypeScript
  const pkgJson = await tryRead("package.json");
  if (pkgJson) {
    profile.manifests.push("package.json");
    try {
      const pkg = JSON.parse(pkgJson);
      profile.languages.push("javascript");
      profile.packageManagers.push("npm");
      if (existsSync(path.join(rootDir, "yarn.lock"))) profile.packageManagers.push("yarn");
      if (existsSync(path.join(rootDir, "pnpm-lock.yaml"))) profile.packageManagers.push("pnpm");
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["typescript"] || existsSync(path.join(rootDir, "tsconfig.json"))) profile.languages.push("typescript");
      if (deps["react"] || deps["react-dom"]) profile.frameworks.push("react");
      if (deps["next"]) profile.frameworks.push("next.js");
      if (deps["express"]) profile.frameworks.push("express");
      if (deps["@nestjs/core"]) profile.frameworks.push("nestjs");
      if (deps["vite"]) profile.frameworks.push("vite");
      if (deps["vue"]) profile.frameworks.push("vue");
      if (deps["svelte"]) profile.frameworks.push("svelte");
      if (pkg.scripts) profile.scripts = pkg.scripts;
    } catch {
      // invalid json
    }
  }

  // Flutter / Dart
  const pubspec = await tryRead("pubspec.yaml");
  if (pubspec) {
    profile.manifests.push("pubspec.yaml");
    profile.languages.push("dart");
    profile.frameworks.push("flutter");
    profile.packageManagers.push("pub");
  }

  // Python
  const reqTxt = await tryRead("requirements.txt");
  const pyproject = await tryRead("pyproject.toml");
  if (reqTxt || pyproject) {
    profile.languages.push("python");
    if (pyproject) {
      profile.manifests.push("pyproject.toml");
      profile.packageManagers.push("pip");
      if (pyproject.includes("[tool.poetry]")) profile.packageManagers.push("poetry");
      if (pyproject.includes("[tool.rye]")) profile.packageManagers.push("rye");
    }
    if (reqTxt) {
      profile.manifests.push("requirements.txt");
      if (!profile.packageManagers.includes("pip")) profile.packageManagers.push("pip");
    }
    const hasTests = existsSync(path.join(rootDir, "pytest.ini")) || existsSync(path.join(rootDir, "setup.cfg"));
    if (hasTests) profile.frameworks.push("pytest");
  }

  // Go
  const goMod = await tryRead("go.mod");
  if (goMod) {
    profile.manifests.push("go.mod");
    profile.languages.push("go");
    profile.packageManagers.push("go modules");
  }

  // Rust
  const cargoToml = await tryRead("Cargo.toml");
  if (cargoToml) {
    profile.manifests.push("Cargo.toml");
    profile.languages.push("rust");
    profile.packageManagers.push("cargo");
  }

  // .NET
  let items;
  try {
    items = await readdir(rootDir);
  } catch {
    items = [];
  }
  const csproj = items.find((f) => f.endsWith(".csproj"));
  const sln = items.find((f) => f.endsWith(".sln"));
  if (csproj || sln) {
    if (csproj) profile.manifests.push(csproj);
    if (sln) profile.manifests.push(sln);
    profile.languages.push("csharp");
    profile.packageManagers.push("dotnet");
    profile.frameworks.push(".NET");
  }

  // Java / Gradle / Maven
  const pomXml = await tryRead("pom.xml");
  const buildGradle = await tryRead("build.gradle");
  if (pomXml) {
    profile.manifests.push("pom.xml");
    profile.languages.push("java");
    profile.packageManagers.push("maven");
  }
  if (buildGradle) {
    profile.manifests.push("build.gradle");
    if (!profile.languages.includes("java")) profile.languages.push("java");
    profile.packageManagers.push("gradle");
  }

  // Deduplicate
  profile.languages = [...new Set(profile.languages)];
  profile.frameworks = [...new Set(profile.frameworks)];
  profile.packageManagers = [...new Set(profile.packageManagers)];

  return profile;
}

export async function collectImportantFiles(rootDir) {
  const IMPORTANT_GLOBS = [
    /^readme(\.\w+)?$/i,
    /^agents\.md$/i,
    /^package\.json$/i,
    /^package-lock\.json$/i,
    /^tsconfig.*\.json$/i,
    /^\.env\.example$/i,
    /^dockerfile$/i,
    /^docker-compose.*\.(yml|yaml)$/i,
    /^pubspec\.yaml$/i,
    /^makefile$/i,
    /^cargo\.toml$/i,
    /^go\.mod$/i,
    /^pyproject\.toml$/i,
    /^requirements.*\.txt$/i,
    /^\.eslintrc.*$/i,
    /^\.prettierrc.*$/i,
    /^\.gitignore$/i,
    /^changelog\.md$/i,
    /^security\.md$/i,
    /^license$/i,
    /^license\..*$/i
  ];
  const result = [];

  let rootItems;
  try {
    rootItems = await readdir(rootDir, { withFileTypes: true });
  } catch {
    rootItems = [];
  }
  for (const e of rootItems) {
    if (!e.isFile()) continue;
    if (IMPORTANT_GLOBS.some((re) => re.test(e.name))) {
      const abs = path.join(rootDir, e.name);
      try {
        const info = await stat(abs);
        result.push({ path: toRel(abs), size: info.size });
      } catch { /* skip */ }
    }
  }

  const ghDir = path.join(rootDir, ".github", "workflows");
  try {
    const wfItems = await readdir(ghDir, { withFileTypes: true });
    for (const e of wfItems) {
      if (e.isFile() && /\.(yml|yaml)$/i.test(e.name)) {
        const abs = path.join(ghDir, e.name);
        try {
          const info = await stat(abs);
          result.push({ path: toRel(abs), size: info.size });
        } catch { /* skip */ }
      }
    }
  } catch { /* no .github/workflows */ }

  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function compactGitStatus(rootDir) {
  const status = await spawnCapture(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    rootDir,
    DEFAULT_CMD_TIMEOUT
  );
  if (status.exit_code !== 0) {
    return {
      is_git_repo: false,
      clean: null,
      error: (status.stderr || "not a git repository").split(/\r?\n/)[0]
    };
  }
  const branchRes = await spawnCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], rootDir, DEFAULT_CMD_TIMEOUT);
  const files = parsePorcelainZ(status.stdout || "");
  const counts = {};
  for (const f of files) {
    const key = `${f.index || " "}${f.worktree || " "}`.trim() || "changed";
    counts[key] = (counts[key] || 0) + 1;
  }
  return {
    is_git_repo: true,
    branch: (branchRes.stdout || "").trim() || null,
    clean: files.length === 0,
    count: files.length,
    counts,
    files: files.slice(0, 60)
  };
}

export async function workspaceMutationFingerprint(workdir, workspaceRoot = workdir) {
  const rootResult = await spawnCapture("git", ["rev-parse", "--show-toplevel"], workdir, 5_000);
  if (rootResult.timed_out === true) {
    return {
      root: workdir,
      fingerprint: null,
      trackedFingerprint: null,
      stateKnown: false,
      errorCode: "GIT_ROOT_TIMED_OUT"
    };
  }
  if (rootResult.exit_code !== 0) {
    return filesystemWorkspaceMutationFingerprint(workdir, workspaceRoot);
  }
  const root = (rootResult.stdout || "").trim() || workdir;
  const [worktree, staged, statusResult, headResult] = await Promise.all([
    spawnOutputHash("git", ["diff", "--binary", "--no-ext-diff"], root, 10_000),
    spawnOutputHash("git", ["diff", "--staged", "--binary", "--no-ext-diff"], root, 10_000),
    spawnOutputHash("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], root, 10_000),
    spawnOutputHash("git", ["rev-parse", "HEAD"], root, 10_000)
  ]);
  const failed = [worktree, staged, statusResult, headResult].find((result) =>
    result.exit_code !== 0 || result.timed_out === true || !result.stdout_hash
  );
  if (failed) {
    return {
      root,
      fingerprint: null,
      trackedFingerprint: null,
      stateKnown: false,
      errorCode: failed.timed_out ? "GIT_FINGERPRINT_TIMED_OUT" : "GIT_FINGERPRINT_FAILED"
    };
  }
  const trackedFingerprint = createHash("sha256")
    .update(worktree.stdout_hash)
    .update(":")
    .update(String(worktree.stdout_bytes))
    .update("\0")
    .update(staged.stdout_hash)
    .update(":")
    .update(String(staged.stdout_bytes))
    .update("\0")
    .update(headResult.stdout_hash)
    .update(":")
    .update(String(headResult.stdout_bytes))
    .digest("hex");
  const fingerprint = createHash("sha256")
    .update(trackedFingerprint)
    .update("\0")
    .update(statusResult.stdout_hash)
    .update(":")
    .update(String(statusResult.stdout_bytes))
    .digest("hex");
  return { root, fingerprint, trackedFingerprint, stateKnown: true, errorCode: null, engine: "git" };
}

async function filesystemWorkspaceMutationFingerprint(workdir, workspaceRoot) {
  let root;
  let canonicalWorkdir;
  try {
    [root, canonicalWorkdir] = await Promise.all([
      realpath(path.resolve(workspaceRoot || workdir)),
      realpath(path.resolve(workdir))
    ]);
  } catch {
    return unknownFilesystemMutationFingerprint(workspaceRoot || workdir, "FILESYSTEM_ROOT_UNAVAILABLE");
  }
  if (!isWithinRoots(canonicalWorkdir, [root])) {
    return unknownFilesystemMutationFingerprint(root, "FILESYSTEM_ROOT_ESCAPE");
  }

  const digest = createHash("sha256");
  const deadline = Date.now() + NON_GIT_MUTATION_TIMEOUT_MS;
  let fileCount = 0;
  let totalBytes = 0;

  const assertWithinDeadline = () => {
    if (Date.now() > deadline) {
      const error = new Error("Non-Git workspace fingerprint timed out.");
      error.code = "FILESYSTEM_FINGERPRINT_TIMED_OUT";
      throw error;
    }
  };

  const walk = async (directory, relativeDirectory = "", depth = 0) => {
    assertWithinDeadline();
    if (depth > 64) {
      const error = new Error("Non-Git workspace fingerprint exceeded the depth limit.");
      error.code = "FILESYSTEM_FINGERPRINT_DEPTH_LIMIT";
      throw error;
    }
    const canonicalDirectory = await realpath(directory);
    if (!isWithinRoots(canonicalDirectory, [root])) {
      const error = new Error("Non-Git workspace fingerprint escaped its root.");
      error.code = "FILESYSTEM_ROOT_ESCAPE";
      throw error;
    }
    const entries = await readdir(canonicalDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertWithinDeadline();
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      const absolute = path.join(canonicalDirectory, entry.name);
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const error = new Error("Non-Git workspace fingerprint does not follow symbolic links.");
        error.code = "FILESYSTEM_FINGERPRINT_SYMLINK";
        throw error;
      }
      if (info.isDirectory()) {
        digest.update(`D\0${relative}\0${info.mode}\0`);
        await walk(absolute, relative, depth + 1);
        continue;
      }
      if (!info.isFile()) {
        const error = new Error("Non-Git workspace contains an unsupported filesystem entry.");
        error.code = "FILESYSTEM_FINGERPRINT_UNSUPPORTED_ENTRY";
        throw error;
      }
      fileCount++;
      totalBytes += info.size;
      if (fileCount > NON_GIT_MUTATION_MAX_FILES) {
        const error = new Error("Non-Git workspace fingerprint exceeded the file limit.");
        error.code = "FILESYSTEM_FINGERPRINT_FILE_LIMIT";
        throw error;
      }
      if (info.size > NON_GIT_MUTATION_MAX_FILE_BYTES || totalBytes > NON_GIT_MUTATION_MAX_TOTAL_BYTES) {
        const error = new Error("Non-Git workspace fingerprint exceeded the content budget.");
        error.code = "FILESYSTEM_FINGERPRINT_BYTE_LIMIT";
        throw error;
      }
      const canonicalFile = await realpath(absolute);
      if (!isWithinRoots(canonicalFile, [root])) {
        const error = new Error("Non-Git workspace file escaped its root.");
        error.code = "FILESYSTEM_ROOT_ESCAPE";
        throw error;
      }
      const contentHash = await hashFilesystemMutationFile(canonicalFile, deadline);
      const after = await lstat(canonicalFile);
      if (
        !after.isFile() ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.mode !== info.mode
      ) {
        const error = new Error("Non-Git workspace changed while it was being fingerprinted.");
        error.code = "FILESYSTEM_FINGERPRINT_RACED";
        throw error;
      }
      digest.update(`F\0${relative}\0${info.mode}\0${info.size}\0${contentHash}\0`);
    }
  };

  try {
    await walk(root);
    const trackedFingerprint = digest.digest("hex");
    return {
      root,
      fingerprint: trackedFingerprint,
      trackedFingerprint,
      stateKnown: true,
      errorCode: null,
      engine: "filesystem",
      fileCount,
      totalBytes
    };
  } catch (error) {
    return unknownFilesystemMutationFingerprint(
      root,
      error?.code || "FILESYSTEM_FINGERPRINT_FAILED"
    );
  }
}

function hashFilesystemMutationFile(filePath, deadline) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      if (Date.now() > deadline) {
        const error = new Error("Non-Git workspace fingerprint timed out while reading a file.");
        error.code = "FILESYSTEM_FINGERPRINT_TIMED_OUT";
        stream.destroy(error);
        return;
      }
      hash.update(chunk);
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function unknownFilesystemMutationFingerprint(root, errorCode) {
  return {
    root: path.resolve(root),
    fingerprint: null,
    trackedFingerprint: null,
    stateKnown: false,
    errorCode,
    engine: "filesystem"
  };
}

export function mutationFingerprintChanged(before, after) {
  return before?.stateKnown !== true ||
    after?.stateKnown !== true ||
    before.trackedFingerprint !== after.trackedFingerprint;
}

export function recommendNextActions({ profile, git, truncated }) {
  const actions = [];
  if (git?.is_git_repo && git.count > 0) {
    actions.push("Review current changes with review_diff or git before large edits.");
  }
  if (truncated) {
    actions.push("Call workspace_snapshot with a narrower path/depth if you need more tree detail.");
  }
  if ((profile?.languages || []).length) {
    actions.push(`Detected stack: ${(profile.languages || []).join(", ")}${profile.frameworks?.length ? ` / ${(profile.frameworks || []).join(", ")}` : ""}.`);
  }
  actions.push("Use recommended_reads with read_many to gather context in one call.");
  actions.push("Use search_text and code_query before opening many files.");
  actions.push("Prefer apply_patch batches to keep MCP tunnel round-trips low.");
  return actions.slice(0, 6);
}
