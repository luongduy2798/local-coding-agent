// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  rename,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { PatchTransactionCoordinator, PatchTransactionError } from "../../src/mutation/patch-transaction.mjs";
import { createIsolatedTestRoot, registerDisposableRoot, safeRemove } from "../helpers/test-guard.mjs";

const context = await createIsolatedTestRoot({ prefix: "lca-runtime-patch-" });
const repoA = path.join(context.fixtureDir, "repo-a");
const repoB = path.join(context.fixtureDir, "repo-b");
await Promise.all([mkdir(repoA, { recursive: true }), mkdir(repoB, { recursive: true })]);
await Promise.all([registerDisposableRoot(context, repoA), registerDisposableRoot(context, repoB)]);
await writeFile(path.join(repoA, "api.js"), "export const value = 1;\n", "utf8");
await writeFile(path.join(repoB, "consumer.js"), "import { value } from 'api';\n", "utf8");

const workspaces = new Map([
  ["a", { id: "a", root: repoA }],
  ["b", { id: "b", root: repoB }]
]);
const transactionStates = new Map();
const transactionStateStore = {
  async upsert(record) {
    transactionStates.set(record.id, structuredClone(record));
    return record;
  },
  async listIncomplete() {
    return [...transactionStates.values()].filter(
      (record) => !["complete", "rolled_back"].includes(record.status)
    );
  }
};
const coordinator = new PatchTransactionCoordinator({
  dataDir: path.join(context.dataDir, "tx"),
  resolveWorkspace: async (id) => workspaces.get(id),
  stateStore: transactionStateStore
});
await coordinator.init();

const preview = await coordinator.preview({
  taskId: "task-preview",
  operations: [
    { workspace_id: "a", op: "update", path: "api.js", content: "export const value = 99;\n" },
    { workspace_id: "b", op: "create", path: "preview-only.js", content: "never written\n" }
  ]
});
assert.equal(preview.status, "validated");
assert.equal(preview.transaction_id, null);
assert.equal(preview.results.length, 2);
assert.equal(preview.results[0].after.version.length, 64);
assert.equal(await readFile(path.join(repoA, "api.js"), "utf8"), "export const value = 1;\n");
assert.equal(await stat(path.join(repoB, "preview-only.js")).catch(() => null), null);
assert.deepEqual(transactionStates, new Map(), "preview must not persist coordinator state");

async function runFaultMatrixScenario({ label, point, operationIndex = null, outcome, errorCode = null }) {
  const scenarioRoot = path.join(context.fixtureDir, `fault-${label}`);
  const scenarioRepoA = path.join(scenarioRoot, "repo-a");
  const scenarioRepoB = path.join(scenarioRoot, "repo-b");
  await Promise.all([
    mkdir(scenarioRepoA, { recursive: true }),
    mkdir(scenarioRepoB, { recursive: true })
  ]);
  await Promise.all([
    registerDisposableRoot(context, scenarioRepoA),
    registerDisposableRoot(context, scenarioRepoB)
  ]);
  const sourceA = path.join(scenarioRepoA, "source-a.js");
  const sourceB = path.join(scenarioRepoB, "source-b.js");
  await Promise.all([
    writeFile(sourceA, "export const state = 'before-a';\n", "utf8"),
    writeFile(sourceB, "export const state = 'before-b';\n", "utf8")
  ]);

  const scenarioWorkspaces = new Map([
    ["a", { id: "a", root: scenarioRepoA }],
    ["b", { id: "b", root: scenarioRepoB }]
  ]);
  const dataDir = path.join(context.dataDir, `fault-${label}`);
  let injectionCount = 0;
  const faultingCoordinator = new PatchTransactionCoordinator({
    dataDir,
    resolveWorkspace: async (id) => scenarioWorkspaces.get(id),
    faultInjector(injectedPoint, payload) {
      if (injectedPoint !== point) return;
      if (operationIndex !== null && payload?.index !== operationIndex) return;
      injectionCount += 1;
      const error = new Error(`fault matrix: ${label}`);
      if (errorCode) error.code = errorCode;
      throw error;
    }
  });
  await faultingCoordinator.init();

  const transactionId = `fault-${label}`;
  let result = null;
  let failure = null;
  try {
    result = await faultingCoordinator.apply({
      transactionId,
      taskId: `task-${label}`,
      operations: [
        {
          workspace_id: "a",
          op: "update",
          path: "source-a.js",
          content: "export const state = 'after-a';\n"
        },
        {
          workspace_id: "b",
          op: "update",
          path: "source-b.js",
          content: "export const state = 'after-b';\n"
        }
      ]
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(injectionCount, 1, `${label} must reach its fault point exactly once`);
  if (outcome === "before") {
    assert.equal(result, null);
    assert.equal(failure instanceof PatchTransactionError, true);
    assert.equal(failure.code, "PATCH_ABORTED");
    assert.equal(await readFile(sourceA, "utf8"), "export const state = 'before-a';\n");
    assert.equal(await readFile(sourceB, "utf8"), "export const state = 'before-b';\n");
  } else {
    assert.equal(failure, null);
    assert.equal(result?.ok, true);
    assert.match(result?.warning || "", /committed fully/i);
    assert.equal(await readFile(sourceA, "utf8"), "export const state = 'after-a';\n");
    assert.equal(await readFile(sourceB, "utf8"), "export const state = 'after-b';\n");
  }
  assert.equal(faultingCoordinator.status().in_doubt, false);

  const manifestPath = path.join(dataDir, "transactions", `${transactionId}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.status, outcome === "before" ? "rolled_back" : "complete");
  for (const operation of manifest.operations) {
    for (const artifact of [operation.stage_path, operation.backup_path]) {
      if (artifact) assert.equal(await stat(artifact).catch(() => null), null);
    }
  }

  const restartedCoordinator = new PatchTransactionCoordinator({
    dataDir,
    resolveWorkspace: async (id) => scenarioWorkspaces.get(id)
  });
  const recovery = await restartedCoordinator.init();
  assert.deepEqual(recovery.failed, []);
  assert.equal(restartedCoordinator.status().in_doubt, false);
  const probe = await restartedCoordinator.apply({
    transactionId: `probe-${label}`,
    operations: [
      { workspace_id: "a", op: "create", path: "recovery-probe.txt", content: "unblocked\n" }
    ]
  });
  assert.equal(probe.ok, true, `${label} restart must allow subsequent mutation`);
}

const result = await coordinator.apply({
  taskId: "task-1",
  operations: [
    { workspace_id: "a", op: "update", path: "api.js", edits: [{ old_text: "value = 1", new_text: "value = 2" }] },
    { workspace_id: "b", op: "create", path: "consumer.test.js", content: "test('consumer', () => {});\n" }
  ]
});
assert.equal(result.ok, true);
assert.equal(transactionStates.get(result.transaction_id)?.status, "complete");
assert.deepEqual(await transactionStateStore.listIncomplete(), []);
assert.equal(result.workspaces.length, 2);
assert.match(await readFile(path.join(repoA, "api.js"), "utf8"), /value = 2/);
assert.match(await readFile(path.join(repoB, "consumer.test.js"), "utf8"), /consumer/);

const directoryResult = await coordinator.apply({
  operations: [
    { workspace_id: "a", op: "mkdir", path: "generated/empty" },
    { workspace_id: "b", op: "create", path: "generated/deep/value.txt", content: "nested-secret-marker\n" }
  ]
});
assert.equal(directoryResult.ok, true);
assert.equal((await stat(path.join(repoA, "generated", "empty"))).isDirectory(), true);
assert.equal(await readFile(path.join(repoB, "generated", "deep", "value.txt"), "utf8"), "nested-secret-marker\n");
const directoryManifest = await readFile(
  path.join(context.dataDir, "tx", "transactions", `${directoryResult.transaction_id}.json`),
  "utf8"
);
assert.doesNotMatch(directoryManifest, /nested-secret-marker/);
assert.doesNotMatch(directoryManifest, /next_content/);
const firstManifest = JSON.parse(await readFile(
  path.join(context.dataDir, "tx", "transactions", `${result.transaction_id}.json`),
  "utf8"
));
const parsedDirectoryManifest = JSON.parse(directoryManifest);
assert.ok(firstManifest.fencing_tokens.a >= 1 && firstManifest.fencing_tokens.b >= 1);
assert.ok(parsedDirectoryManifest.fencing_tokens.a > firstManifest.fencing_tokens.a);
assert.ok(parsedDirectoryManifest.fencing_tokens.b > firstManifest.fencing_tokens.b);

await assert.rejects(
  () => coordinator.apply({
    operations: [
      { workspace_id: "a", op: "mkdir", path: "overlap" },
      { workspace_id: "a", op: "create", path: "overlap/file.txt", content: "unsafe overlap\n" }
    ]
  }),
  (error) => error instanceof PatchTransactionError && error.code === "OVERLAPPING_PATCH"
);

const mkdirFailing = new PatchTransactionCoordinator({
  dataDir: path.join(context.dataDir, "tx-mkdir-fail"),
  resolveWorkspace: async (id) => workspaces.get(id),
  faultInjector(point, payload) {
    if (point === "after_commit_operation" && payload.index === 0) {
      // Simulate a crash/restart losing the volatile list between mkdir(2) and
      // its next durable manifest write. Recovery must rely on preflight data.
      payload.manifest.operations[0].created_parents = [];
      throw new Error("mkdir rollback fault injection");
    }
  }
});
await mkdirFailing.init();
await assert.rejects(
  () => mkdirFailing.apply({
    operations: [
      { workspace_id: "a", op: "mkdir", path: "rollback-parent/empty" },
      { workspace_id: "b", op: "update", path: "consumer.js", content: "should not commit\n" }
    ]
  }),
  (error) => error instanceof PatchTransactionError && error.code === "PATCH_ABORTED"
);
assert.equal(await stat(path.join(repoA, "rollback-parent")).catch(() => null), null);

let injected = false;
const failing = new PatchTransactionCoordinator({
  dataDir: path.join(context.dataDir, "tx-fail"),
  resolveWorkspace: async (id) => workspaces.get(id),
  faultInjector(point, payload) {
    if (!injected && point === "after_commit_operation" && payload.index === 0) {
      injected = true;
      throw new Error("fault injection");
    }
  }
});
await failing.init();
await assert.rejects(
  () => failing.apply({
    operations: [
      { workspace_id: "a", op: "update", path: "api.js", edits: [{ old_text: "value = 2", new_text: "value = 3" }] },
      { workspace_id: "b", op: "update", path: "consumer.js", edits: [{ old_text: "value", new_text: "renamed" }] }
    ]
  }),
  (error) => error instanceof PatchTransactionError && error.code === "PATCH_ABORTED"
);
assert.match(await readFile(path.join(repoA, "api.js"), "utf8"), /value = 2/);
assert.match(await readFile(path.join(repoB, "consumer.js"), "utf8"), /value/);

let raced = false;
const racing = new PatchTransactionCoordinator({
  dataDir: path.join(context.dataDir, "tx-race"),
  resolveWorkspace: async (id) => workspaces.get(id),
  async faultInjector(point) {
    if (!raced && point === "after_manifest") {
      raced = true;
      await writeFile(path.join(repoA, "api.js"), "export const value = 99;\n", "utf8");
    }
  }
});
await racing.init();
await assert.rejects(
  () => racing.apply({
    operations: [
      { workspace_id: "a", op: "update", path: "api.js", edits: [{ old_text: "value = 2", new_text: "value = 3" }] }
    ]
  }),
  (error) => error instanceof PatchTransactionError && error.code === "PATCH_ABORTED"
);
assert.match(await readFile(path.join(repoA, "api.js"), "utf8"), /value = 99/);
await writeFile(path.join(repoA, "api.js"), "export const value = 2;\n", "utf8");

const committed = new PatchTransactionCoordinator({
  dataDir: path.join(context.dataDir, "tx-post-commit"),
  resolveWorkspace: async (id) => workspaces.get(id),
  faultInjector(point) {
    if (point === "after_commit") throw new Error("post-commit fault");
  }
});
await committed.init();
const committedResult = await committed.apply({
  operations: [
    { workspace_id: "a", op: "update", path: "api.js", edits: [{ old_text: "value = 2", new_text: "value = 4" }] },
    { workspace_id: "b", op: "create", path: "post-commit.txt", content: "committed\n" }
  ]
});
assert.equal(committedResult.ok, true);
assert.match(committedResult.warning, /post-commit error/i);
assert.match(await readFile(path.join(repoA, "api.js"), "utf8"), /value = 4/);
assert.equal(await readFile(path.join(repoB, "post-commit.txt"), "utf8"), "committed\n");

for (const scenario of [
  { label: "after_manifest", point: "after_manifest", outcome: "before" },
  {
    label: "after_stage_operation",
    point: "after_stage_operation",
    operationIndex: 0,
    outcome: "before"
  },
  {
    label: "disk_full_during_stage",
    point: "after_stage_operation",
    operationIndex: 0,
    errorCode: "ENOSPC",
    outcome: "before"
  },
  { label: "before_commit", point: "before_commit", outcome: "before" },
  {
    label: "after_commit_operation_partial",
    point: "after_commit_operation",
    operationIndex: 0,
    outcome: "before"
  },
  {
    label: "after_commit_operation_final",
    point: "after_commit_operation",
    operationIndex: 1,
    outcome: "after"
  },
  { label: "after_commit", point: "after_commit", outcome: "after" }
]) {
  await runFaultMatrixScenario(scenario);
}

await assert.rejects(
  () => coordinator.apply({
    operations: [{ workspace_id: "a", op: "update", path: "../escape.js", content: "bad\n" }]
  }),
  (error) => error instanceof PatchTransactionError && error.code === "PATH_OUTSIDE_WORKSPACE"
);

const corruptDataDir = path.join(context.dataDir, "tx-corrupt");
await mkdir(path.join(corruptDataDir, "transactions"), { recursive: true });
await writeFile(
  path.join(corruptDataDir, "transactions", "broken-manifest.json"),
  "{ definitely-not-json",
  "utf8"
);
const corruptCoordinator = new PatchTransactionCoordinator({
  dataDir: corruptDataDir,
  resolveWorkspace: async (id) => workspaces.get(id)
});
const corruptRecovery = await corruptCoordinator.init();
assert.equal(corruptRecovery.failed.length, 1);
assert.equal(corruptCoordinator.status().in_doubt, true);
assert.equal(corruptCoordinator.status().recovery_block?.code, "TRANSACTION_MANIFEST_INVALID");
await assert.rejects(
  () => corruptCoordinator.apply({
    operations: [{ workspace_id: "a", op: "create", path: "must-not-run.txt", content: "blocked\n" }]
  }),
  (error) =>
    error instanceof PatchTransactionError
    && error.code === "TRANSACTION_COORDINATOR_IN_DOUBT"
);
assert.equal(await stat(path.join(repoA, "must-not-run.txt")).catch(() => null), null);

const missingManifestCoordinator = new PatchTransactionCoordinator({
  dataDir: path.join(context.dataDir, "tx-missing-manifest"),
  resolveWorkspace: async (id) => workspaces.get(id),
  stateStore: {
    async upsert(record) {
      return record;
    },
    async listIncomplete() {
      return [{
        id: "missing_manifest_probe",
        status: "committing",
        workspace_ids: ["a"],
        manifest_file: "missing_manifest_probe.json"
      }];
    }
  }
});
const missingManifestRecovery = await missingManifestCoordinator.init();
assert.equal(missingManifestRecovery.failed.length, 1);
assert.equal(missingManifestCoordinator.status().in_doubt, true);
assert.equal(
  missingManifestCoordinator.status().recovery_block?.code,
  "TRANSACTION_MANIFEST_MISSING"
);
await assert.rejects(
  () => missingManifestCoordinator.apply({
    operations: [{ workspace_id: "a", op: "create", path: "missing-state-block.txt", content: "blocked\n" }]
  }),
  (error) =>
    error instanceof PatchTransactionError
    && error.code === "TRANSACTION_COORDINATOR_IN_DOUBT"
);

const swapParent = path.join(repoA, "swap-parent");
const swapParentOriginal = path.join(repoA, "swap-parent-original");
await mkdir(swapParent, { recursive: true });
let parentSwapped = false;
const swapDataDir = path.join(context.dataDir, "tx-symlink-swap");
const swapCoordinator = new PatchTransactionCoordinator({
  dataDir: swapDataDir,
  resolveWorkspace: async (id) => workspaces.get(id),
  async faultInjector(point) {
    if (point !== "after_manifest" || parentSwapped) return;
    parentSwapped = true;
    await rename(swapParent, swapParentOriginal);
    await symlink(repoB, swapParent, process.platform === "win32" ? "junction" : "dir");
  }
});
await swapCoordinator.init();
await assert.rejects(
  () => swapCoordinator.apply({
    operations: [{
      workspace_id: "a",
      op: "create",
      path: "swap-parent/must-stay-in-a.txt",
      content: "never escape\n"
    }]
  }),
  (error) =>
    error instanceof PatchTransactionError
    && error.code === "TRANSACTION_IN_DOUBT"
);
assert.equal(
  await stat(path.join(repoB, "must-stay-in-a.txt")).catch(() => null),
  null,
  "a parent symlink swap must not stage or commit into another workspace"
);
await unlink(swapParent);
await rename(swapParentOriginal, swapParent);
const recoveredSwapCoordinator = new PatchTransactionCoordinator({
  dataDir: swapDataDir,
  resolveWorkspace: async (id) => workspaces.get(id)
});
const recoveredSwap = await recoveredSwapCoordinator.init();
assert.equal(recoveredSwap.failed.length, 0);
assert.equal(recoveredSwapCoordinator.status().in_doubt, false);

await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
await safeRemove(context.dataDir, context, { recursive: true, force: true });
console.log("runtime patch transaction tests passed");
