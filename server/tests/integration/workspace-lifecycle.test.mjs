// Local Coding Agent workspace archive, restore, and durable purge tests.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import { recoverWorkspacePurges, purgeWorkspace, WorkspacePurgeError } from "../../src/workspace/purge.mjs";
import { WorkspaceRegistry, WorkspaceRegistryError } from "../../src/workspace/registry.mjs";
import { TaskRouter, TaskRouterError } from "../../src/workspace/task-router.mjs";

async function expectCode(promise, code, type = Error) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof type, true, error?.stack || String(error));
    assert.equal(error.code, code, error?.stack || String(error));
    return true;
  });
}

const context = await createIsolatedTestRoot({
  prefix: "lca-workspace-lifecycle-",
  protectedPaths: [path.resolve("..")]
});
const runtimeDir = path.join(context.dataDir, "runtime");
const roots = Object.fromEntries([
  "a",
  "b",
  "c",
  "d",
  "open-task",
  "transaction",
  "untrusted",
  "identity",
  "active-identity",
  "fault-prepared",
  "fault-stage-operation",
  "fault-staged",
  "fault-db-before-intent",
  "fault-db-intent"
].map((name) => [
  name,
  path.join(context.fixtureDir, `workspace-${name}`)
]));
let registry;
let router;
const originalTestRunId = process.env.LCA_TEST_RUN_ID;

try {
  await Promise.all(Object.entries(roots).map(async ([name, root]) => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "source.txt"), `${name}\n`, "utf8");
  }));
  registry = await WorkspaceRegistry.open({ dataDir: runtimeDir, maxOpenWorkspaces: 2 });
  router = await TaskRouter.open({ dataDir: runtimeDir });

  const registered = {};
  for (const [name, root] of Object.entries(roots)) {
    registered[name] = (await registry.registerWorkspace(root, {
      metadata: { label: name, trusted: name !== "untrusted", source: "test" }
    })).workspace;
  }

  const purgeLockDir = path.join(runtimeDir, "workspace-purges", "lock");
  await mkdir(purgeLockDir, { recursive: true });
  await writeFile(path.join(purgeLockDir, "owner.json"), `${JSON.stringify({
    version: 1,
    nonce: "00000000-0000-4000-8000-000000000000",
    pid: process.pid,
    created_at: new Date().toISOString()
  })}\n`, "utf8");
  await expectCode(
    purgeWorkspace({
      dataDir: runtimeDir,
      registry,
      workspaceId: registered["open-task"].id,
      configuredRoot: roots.b
    }),
    "PURGE_BUSY",
    WorkspacePurgeError
  );
  await safeRemove(purgeLockDir, context, { recursive: true, force: true });

  const openTask = await router.openTask({
    title: "archive guard",
    primaryWorkspaceId: registered["open-task"].id
  });
  await expectCode(
    registry.archiveWorkspace(registered["open-task"].id),
    "WORKSPACE_TASK_OPEN",
    WorkspaceRegistryError
  );
  await router.closeTask({ taskToken: openTask.task_token });

  const transactionCreatedAt = new Date().toISOString();
  await registry.upsertTransactionState({
    id: "tx_lifecycle_guard",
    status: "staged",
    workspace_ids: [registered.transaction.id],
    manifest_version: 1,
    manifest_file: "tx_lifecycle_guard.json",
    created_at: transactionCreatedAt,
    updated_at: transactionCreatedAt
  });
  await expectCode(
    registry.archiveWorkspace(registered.transaction.id),
    "WORKSPACE_TRANSACTION_INCOMPLETE",
    WorkspaceRegistryError
  );
  await expectCode(
    purgeWorkspace({
      dataDir: runtimeDir,
      registry,
      workspaceId: registered.transaction.id,
      configuredRoot: roots.b
    }),
    "WORKSPACE_TRANSACTION_INCOMPLETE",
    WorkspacePurgeError
  );
  const transactionCompletedAt = new Date().toISOString();
  await registry.upsertTransactionState({
    id: "tx_lifecycle_guard",
    status: "rolled_back",
    workspace_ids: [registered.transaction.id],
    manifest_version: 1,
    manifest_file: "tx_lifecycle_guard.json",
    created_at: transactionCreatedAt,
    updated_at: transactionCompletedAt,
    completed_at: transactionCompletedAt
  });

  await registry.archiveWorkspace(registered.untrusted.id);
  await expectCode(
    registry.restoreWorkspace(registered.untrusted.id),
    "WORKSPACE_TRUST_REQUIRED",
    WorkspaceRegistryError
  );

  await registry.archiveWorkspace(registered.identity.id);
  const movedIdentityRoot = `${roots.identity}-moved`;
  await rename(roots.identity, movedIdentityRoot);
  await expectCode(
    registry.restoreWorkspace(registered.identity.id),
    "WORKSPACE_UNAVAILABLE",
    WorkspaceRegistryError
  );
  await mkdir(roots.identity, { recursive: true });
  await writeFile(path.join(roots.identity, "replacement.txt"), "replacement workspace\n", "utf8");
  assert.equal(
    (await registry.getWorkspace(registered.identity.id, {
      allowArchived: true,
      refreshAvailability: true
    })).availability,
    "unavailable"
  );
  await expectCode(
    registry.restoreWorkspace(registered.identity.id),
    "WORKSPACE_IDENTITY_CHANGED",
    WorkspaceRegistryError
  );

  const movedActiveIdentityRoot = `${roots["active-identity"]}-moved`;
  await rename(roots["active-identity"], movedActiveIdentityRoot);
  await mkdir(roots["active-identity"], { recursive: true });
  await writeFile(
    path.join(roots["active-identity"], "replacement.txt"),
    "replacement active workspace\n",
    "utf8"
  );
  assert.equal(
    (await registry.getWorkspace(registered["active-identity"].id)).availability,
    "unavailable"
  );
  await expectCode(
    registry.registerWorkspace(roots["active-identity"], {
      metadata: { label: "replacement", trusted: true, source: "test" }
    }),
    "WORKSPACE_IDENTITY_CHANGED",
    WorkspaceRegistryError
  );

  await registry.selectWorkspace(registered.a.id, { scope: "default" });
  await expectCode(
    registry.archiveWorkspace(registered.a.id),
    "WORKSPACE_DEFAULT",
    WorkspaceRegistryError
  );
  await registry.selectWorkspace(registered.b.id, { scope: "default" });

  const historyMarker = path.join(runtimeDir, "workspaces", registered.a.id, "changes", "history.txt");
  await mkdir(path.dirname(historyMarker), { recursive: true });
  await writeFile(historyMarker, "preserved history\n", "utf8");
  const archived = await registry.archiveWorkspace(registered.a.id);
  assert.equal(archived.workspace.registrationState, "archived");
  assert.equal((await registry.listWorkspaces()).some((item) => item.id === registered.a.id), false);
  assert.equal(
    (await registry.listWorkspaces({ includeArchived: true })).find((item) => item.id === registered.a.id)?.registrationState,
    "archived"
  );
  await expectCode(
    registry.registerWorkspace(roots.a, { metadata: { trusted: true } }),
    "WORKSPACE_ARCHIVED",
    WorkspaceRegistryError
  );
  const restored = await registry.restoreWorkspace(registered.a.id);
  assert.equal(restored.workspace.id, registered.a.id);
  assert.equal(restored.workspace.registrationState, "active");
  assert.equal(await readFile(historyMarker, "utf8"), "preserved history\n");

  const singleTask = await router.openTask({
    title: "single workspace history",
    primaryWorkspaceId: registered.a.id
  });
  await router.closeTask({ taskToken: singleTask.task_token });
  const taskArtifact = path.join(runtimeDir, "tasks", singleTask.id, "verification", `${registered.a.id}.json`);
  await mkdir(path.dirname(taskArtifact), { recursive: true });
  await writeFile(taskArtifact, "{}\n", "utf8");
  await registry.archiveWorkspace(registered.a.id);

  const removedId = registered.a.id;
  const removed = await purgeWorkspace({
    dataDir: runtimeDir,
    registry,
    workspaceId: removedId,
    configuredRoot: roots.b
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.task_count, 1);
  await expectCode(
    registry.getWorkspace(removedId, { allowArchived: true }),
    "WORKSPACE_NOT_FOUND",
    WorkspaceRegistryError
  );
  await expectCode(router.getTaskById(singleTask.id), "TASK_NOT_FOUND", TaskRouterError);
  assert.equal(await readFile(path.join(roots.a, "source.txt"), "utf8"), "a\n");
  const reregisteredA = (await registry.registerWorkspace(roots.a, {
    metadata: { label: "a", trusted: true, source: "test" }
  })).workspace;
  assert.notEqual(reregisteredA.id, removedId);

  const multiTask = await router.openTask({
    title: "cross workspace history",
    primaryWorkspaceId: registered.c.id,
    attachedWorkspaceIds: [registered.d.id]
  });
  await router.closeTask({ taskToken: multiTask.task_token });
  await expectCode(
    purgeWorkspace({
      dataDir: runtimeDir,
      registry,
      workspaceId: registered.c.id,
      configuredRoot: roots.b
    }),
    "WORKSPACE_MULTI_TASK_HISTORY",
    WorkspacePurgeError
  );

  process.env.LCA_TEST_RUN_ID = context.runId;
  for (const [name, faultAt, expectedRecovery] of [
    ["fault-prepared", "prepared", "rolled_back"],
    ["fault-stage-operation", "staged:1", "rolled_back"],
    ["fault-staged", "staged", "rolled_back"],
    ["fault-db-before-intent", "database_committed_before_intent", "complete"],
    ["fault-db-intent", "database_committed", "complete"]
  ]) {
    const workspace = registered[name];
    const marker = path.join(runtimeDir, "workspaces", workspace.id, "changes", "marker.txt");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, `${name}\n`, "utf8");
    await expectCode(
      purgeWorkspace({
        dataDir: runtimeDir,
        registry,
        workspaceId: workspace.id,
        configuredRoot: roots.b,
        faultAt
      }),
      "PURGE_FAULT_INJECTED",
      WorkspacePurgeError
    );
    const recovery = await recoverWorkspacePurges({ dataDir: runtimeDir, registry });
    assert.ok(recovery.some((item) => item.workspace_id === workspace.id && item.state === expectedRecovery));
    if (expectedRecovery === "rolled_back") {
      assert.equal(await readFile(marker, "utf8"), `${name}\n`);
      assert.equal((await registry.getWorkspace(workspace.id)).id, workspace.id);
    } else {
      await expectCode(
        registry.getWorkspace(workspace.id, { allowArchived: true }),
        "WORKSPACE_NOT_FOUND",
        WorkspaceRegistryError
      );
      assert.equal(await readFile(path.join(roots[name], "source.txt"), "utf8"), `${name}\n`);
    }
  }

  console.log("[PASS] Workspace archive/restore and durable permanent removal");
} finally {
  if (originalTestRunId === undefined) delete process.env.LCA_TEST_RUN_ID;
  else process.env.LCA_TEST_RUN_ID = originalTestRunId;
  await router?.close().catch(() => {});
  await registry?.close().catch(() => {});
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  await safeRemove(context.dataDir, context, { recursive: true, force: true }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
