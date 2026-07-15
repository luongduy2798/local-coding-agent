// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TEST_MARKER = ".lca-test-marker";

export async function createIsolatedTestRoot({ prefix = "lca-test-", protectedPaths = [] } = {}) {
  const runId = randomUUID();
  const tempRoot = await realpath(os.tmpdir());
  const testRoot = await mkdtemp(path.join(tempRoot, prefix));
  const markerPath = path.join(testRoot, TEST_MARKER);
  const fixtureDir = path.join(testRoot, "fixture");
  const dataDir = path.join(testRoot, "data");
  const repoDir = path.join(testRoot, "repo");
  await writeFile(markerPath, `${runId}\n`, "utf8");
  await Promise.all([
    mkdir(fixtureDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(repoDir, { recursive: true })
  ]);

  const context = {
    runId,
    tempRoot,
    testRoot,
    markerPath,
    fixtureDir,
    dataDir,
    repoDir,
    protectedPaths: new Set(),
    disposableRoots: new Set()
  };

  const explicitProtected = [
    process.env.AGENT_WORKSPACE,
    process.env.LCA_REAL_REPO,
    process.env.GITHUB_WORKSPACE,
    process.env.RUNNER_WORKSPACE,
    process.env.INIT_CWD,
    process.env.PWD,
    process.env.OLDPWD,
    ...protectedPaths
  ].filter(Boolean);

  for (const candidate of [
    path.parse(testRoot).root,
    tempRoot,
    testRoot,
    repoDir,
    os.homedir(),
    path.join(os.homedir(), "Desktop"),
    process.cwd(),
    ...explicitProtected,
    ...explicitProtected.map((candidate) => path.dirname(path.resolve(candidate)))
  ]) {
    if (candidate) await protectPath(context, candidate);
  }

  await registerDisposableRoot(context, fixtureDir);
  await registerDisposableRoot(context, dataDir);
  return context;
}

export async function protectPath(context, candidate) {
  const canonical = await canonicalize(candidate, { allowMissing: true });
  context.protectedPaths.add(comparePath(canonical));
  return canonical;
}

export async function registerDisposableRoot(context, candidate) {
  const canonical = await canonicalize(candidate, { allowMissing: true });
  if (!isInside(canonical, context.testRoot) || comparePath(canonical) === comparePath(context.testRoot)) {
    throw new Error(`Disposable root must be below the test root: ${canonical}`);
  }
  context.disposableRoots.add(comparePath(canonical));
  return canonical;
}

export async function assertSafeDeleteTarget(target, context) {
  if (!context?.runId || !context?.testRoot) throw new Error("Invalid test safety context.");
  if (target === null || target === undefined || !String(target).trim() || String(target).trim() === ".") {
    throw new Error("Refusing to delete an empty or ambiguous target.");
  }

  await assertMarker(context);
  const canonicalTarget = await canonicalize(target, { allowMissing: true });
  const canonicalRoot = await canonicalize(context.testRoot, { allowMissing: false });

  if (!isInside(canonicalTarget, canonicalRoot) || comparePath(canonicalTarget) === comparePath(canonicalRoot)) {
    throw new Error("Target is outside the current isolated test root or is the test root itself.");
  }

  const disposableRoot = [...context.disposableRoots]
    .map((value) => value)
    .find((value) => comparePath(canonicalTarget) === value || comparePath(canonicalTarget).startsWith(`${value}${path.sep}`));
  if (!disposableRoot) throw new Error("Target is not inside a registered disposable root.");

  for (const protectedValue of context.protectedPaths) {
    const targetValue = comparePath(canonicalTarget);
    if (
      targetValue === protectedValue ||
      protectedValue.startsWith(`${targetValue}${path.sep}`)
    ) {
      throw new Error(`Target is protected: ${canonicalTarget}`);
    }
  }

  await assertNoEscapingSymlink(canonicalTarget, canonicalRoot, context);
  const gitRoot = await nearestGitRoot(canonicalTarget, canonicalRoot);
  if (gitRoot) {
    const disposableCanonical = [...context.disposableRoots]
      .map((value) => value)
      .find((value) => comparePath(canonicalTarget) === value || comparePath(canonicalTarget).startsWith(`${value}${path.sep}`));
    if (!disposableCanonical || !comparePath(disposableCanonical).startsWith(`${comparePath(gitRoot)}${path.sep}`)) {
      throw new Error(`Refusing to delete a Git repository or an unregistered Git subtree: ${gitRoot}`);
    }
  }

  if (await containsGitMarker(canonicalTarget)) {
    throw new Error(`Refusing to delete a subtree containing .git: ${canonicalTarget}`);
  }

  return canonicalTarget;
}

export async function safeRemove(target, context, { recursive = false, force = false } = {}) {
  const safeTarget = await assertSafeDeleteTarget(target, context);
  console.log(`[test-cleanup] root=${context.testRoot}`);
  console.log(`[test-cleanup] target=${safeTarget}`);
  await rm(safeTarget, { recursive, force });
}

export async function createGitFixture(context, { initialFiles = { "README.md": "fixture\n" } } = {}) {
  const root = path.join(context.repoDir, `git-fixture-${randomUUID().slice(0, 8)}`);
  const fixtureDir = path.join(root, "fixture");
  await mkdir(fixtureDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(initialFiles)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  await runGit(root, ["init"]);
  await runGit(root, ["config", "user.email", "test@example.com"]);
  await runGit(root, ["config", "user.name", "LCA Test"]);
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "-m", "fixture"]);
  await protectPath(context, root);
  await registerDisposableRoot(context, fixtureDir);
  return { root, fixtureDir };
}

export async function snapshotRepositoryState(repositoryRoot) {
  const root = await canonicalize(repositoryRoot, { allowMissing: false });
  const gitMarker = path.join(root, ".git");
  const gitInfo = await lstat(gitMarker).catch(() => null);
  if (!gitInfo) throw new Error(`Repository marker is missing: ${gitMarker}`);
  const [inside, head, branch, remotes] = await Promise.all([
    runGit(root, ["rev-parse", "--is-inside-work-tree"]),
    runGit(root, ["rev-parse", "HEAD"]),
    runGit(root, ["branch", "--show-current"]),
    runGit(root, ["remote", "-v"])
  ]);
  return {
    root,
    head: head.trim(),
    branch: branch.trim(),
    remotes: remotes.trim(),
    gitDirExists: true,
    isInsideWorkTree: inside.trim() === "true"
  };
}

export async function assertRepositoryIntact(repositoryRoot, before) {
  const after = await snapshotRepositoryState(repositoryRoot);
  if (before) {
    for (const field of ["root", "head", "branch", "remotes", "gitDirExists", "isInsideWorkTree"]) {
      if (after[field] !== before[field]) throw new Error(`Repository integrity changed: ${field}`);
    }
  }
  return after;
}

async function assertMarker(context) {
  let marker;
  try {
    marker = (await readFile(context.markerPath, "utf8")).trim();
  } catch {
    throw new Error("Test marker is missing or unreadable.");
  }
  if (marker !== context.runId) throw new Error("Test marker run ID does not match the current test run.");
}

async function assertNoEscapingSymlink(target, testRoot, context) {
  const relative = path.relative(testRoot, target);
  let cursor = testRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor).catch(() => null);
    if (!info?.isSymbolicLink()) continue;
    const destination = await realpath(cursor);
    if (!isInside(destination, testRoot)) throw new Error(`Symlink escapes test root: ${cursor}`);
    for (const protectedValue of context.protectedPaths) {
      const destinationValue = comparePath(destination);
      if (destinationValue === protectedValue || destinationValue.startsWith(`${protectedValue}${path.sep}`)) {
        throw new Error(`Symlink resolves into a protected path: ${cursor}`);
      }
    }
    if (await nearestGitRoot(destination, testRoot)) throw new Error(`Symlink resolves into a Git repository: ${cursor}`);
  }
}

async function nearestGitRoot(target, stopAt) {
  let cursor = target;
  const targetInfo = await stat(cursor).catch(() => null);
  if (!targetInfo?.isDirectory()) cursor = path.dirname(cursor);
  while (isInsideOrEqual(cursor, stopAt)) {
    if (await lstat(path.join(cursor, ".git")).catch(() => null)) return cursor;
    if (comparePath(cursor) === comparePath(stopAt)) break;
    cursor = path.dirname(cursor);
  }
  return null;
}

async function containsGitMarker(target) {
  const info = await lstat(target).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return false;
  const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".git") return true;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (await containsGitMarker(path.join(target, entry.name))) return true;
    }
  }
  return false;
}

async function canonicalize(candidate, { allowMissing }) {
  const absolute = path.resolve(String(candidate));
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!allowMissing || error?.code !== "ENOENT") throw error;
    const missing = [];
    let cursor = absolute;
    while (true) {
      try {
        const existing = await realpath(cursor);
        return path.join(existing, ...missing.reverse());
      } catch (inner) {
        if (inner?.code !== "ENOENT") throw inner;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw inner;
        missing.push(path.basename(cursor));
        cursor = parent;
      }
    }
  }
}

function comparePath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

function isInside(candidate, parent) {
  const child = comparePath(candidate);
  const root = comparePath(parent);
  return child.startsWith(`${root}${path.sep}`);
}

function isInsideOrEqual(candidate, parent) {
  return comparePath(candidate) === comparePath(parent) || isInside(candidate, parent);
}

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 });
  return stdout;
}
