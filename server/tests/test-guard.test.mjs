// Local Coding Agent test safety guard regression suite
// SPDX-License-Identifier: AGPL-3.0-or-later

import { symlink, unlink, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRepositoryIntact,
  assertSafeDeleteTarget,
  createGitFixture,
  createIsolatedTestRoot,
  safeRemove,
  snapshotRepositoryState
} from "./helpers/test-guard.mjs";

let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function rejects(name, work) {
  try {
    await work();
    check(name, false, "operation unexpectedly succeeded");
  } catch {
    check(name, true);
  }
}

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const realRepo = path.resolve(TESTS_DIR, "../..");
const beforeRepo = await snapshotRepositoryState(realRepo);
const context = await createIsolatedTestRoot({
  prefix: "lca-test-guard-",
  protectedPaths: [realRepo]
});

await rejects("rejects the real repository", () => assertSafeDeleteTarget(realRepo, context));
await rejects("rejects the test root", () => assertSafeDeleteTarget(context.testRoot, context));
await rejects("rejects the OS temp root", () => assertSafeDeleteTarget(os.tmpdir(), context));
await rejects("rejects the home directory", () => assertSafeDeleteTarget(os.homedir(), context));
await rejects("rejects the Desktop directory", () => assertSafeDeleteTarget(path.join(os.homedir(), "Desktop"), context));
await rejects("rejects process.cwd", () => assertSafeDeleteTarget(process.cwd(), context));
await rejects("rejects the protected repo container", () => assertSafeDeleteTarget(context.repoDir, context));
await rejects("rejects a path outside the test root", () => assertSafeDeleteTarget(path.join(os.tmpdir(), "outside-lca-test"), context));

const valid = path.join(context.fixtureDir, "generated");
await mkdir(valid, { recursive: true });
await writeFile(path.join(valid, "file.txt"), "fixture\n", "utf8");
await safeRemove(valid, context, { recursive: true, force: true });
check("allows deleting a valid fixture subtree", !existsSync(valid));

const markerText = `${context.runId}\n`;
await unlink(context.markerPath);
await rejects("rejects cleanup when marker is missing", () => assertSafeDeleteTarget(path.join(context.fixtureDir, "missing-marker"), context));
await writeFile(context.markerPath, markerText, "utf8");
await writeFile(context.markerPath, "wrong-run-id\n", "utf8");
await rejects("rejects cleanup when marker run ID differs", () => assertSafeDeleteTarget(path.join(context.fixtureDir, "wrong-marker"), context));
await writeFile(context.markerPath, markerText, "utf8");

const outsideLink = path.join(context.fixtureDir, "outside-link");
try {
  await symlink(realRepo, outsideLink, process.platform === "win32" ? "junction" : "dir");
  await rejects("rejects a symlink escaping into the real repository", () => assertSafeDeleteTarget(outsideLink, context));
} catch (error) {
  console.log(`[SKIP] outside symlink setup unavailable: ${error?.message || error}`);
}

const parentLink = path.join(context.fixtureDir, "parent-link");
try {
  await symlink(realRepo, parentLink, process.platform === "win32" ? "junction" : "dir");
  await rejects("rejects a parent symlink escaping the test root", () => assertSafeDeleteTarget(path.join(parentLink, "missing-child"), context));
} catch (error) {
  console.log(`[SKIP] parent symlink setup unavailable: ${error?.message || error}`);
}

const gitFixture = await createGitFixture(context);
await rejects("rejects a Git fixture root", () => assertSafeDeleteTarget(gitFixture.root, context));
const gitGenerated = path.join(gitFixture.fixtureDir, "generated");
await mkdir(gitGenerated, { recursive: true });
await writeFile(path.join(gitGenerated, "file.txt"), "generated\n", "utf8");
await safeRemove(gitGenerated, context, { recursive: true, force: true });
check("allows a registered disposable subtree inside a Git fixture", !existsSync(gitGenerated));

const nestedGit = path.join(context.fixtureDir, "nested-git");
await mkdir(path.join(nestedGit, ".git"), { recursive: true });
await rejects("rejects a subtree containing a nested Git repository", () => assertSafeDeleteTarget(nestedGit, context));

const worktreeLike = path.join(context.fixtureDir, "worktree-like");
await mkdir(worktreeLike, { recursive: true });
await writeFile(path.join(worktreeLike, ".git"), "gitdir: ../repo/.git/worktrees/example\n", "utf8");
await rejects("rejects a Git worktree marker file", () => assertSafeDeleteTarget(worktreeLike, context));

await assertRepositoryIntact(realRepo, beforeRepo);
check("real repository remains intact", true);

console.log(`\n==== TEST GUARD: ${pass} passed, ${fail} failed ====`);
console.log(`Fixture retained for inspection: ${context.testRoot}`);
process.exit(fail === 0 ? 0 : 1);
