// Durable asynchronous task-close workspace Memory outbox integration tests.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import { WorkspaceRegistry } from "../../src/workspace/registry.mjs";
import { TaskRouter } from "../../src/workspace/task-router.mjs";
import { WorkspaceMemoryService } from "../../src/workspace/workspace-memory.mjs";
import { TaskMemoryOutboxStore } from "../../src/workspace/task-memory-outbox-store.mjs";
import { prepareTaskMemoryOutbox } from "../../src/workspace/task-memory-outbox-policy.mjs";
import { WorkspaceMemoryOutbox } from "../../src/workspace/workspace-memory-outbox.mjs";

const context = await createIsolatedTestRoot({
  prefix: "lca-memory-outbox-",
  protectedPaths: [path.resolve("..")] 
});
const dataDir = path.join(context.dataDir, "runtime");
const workspaceRoot = path.join(context.fixtureDir, "workspace");
let registry;
let router;
let memory;
let outbox;

try {
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  registry = await WorkspaceRegistry.open({ dataDir });
  const registered = await registry.registerWorkspace(workspaceRoot, {
    metadata: { label: "Memory outbox fixture", trusted: true }
  });
  const workspaceId = registered.workspace.id;
  router = await TaskRouter.open({ dataDir });

  const guardTask = await router.openTask({
    title: "Reject unattached Memory outbox workspace",
    complexityHint: "normal",
    primaryWorkspaceId: workspaceId
  });
  await assert.rejects(router.closeTask({
    taskToken: guardTask.task_token,
    memoryJobs: [{
      id: "memory_job_unattached_fixture",
      workspace_id: "ws_unattached_fixture",
      payload_hash: "a".repeat(64),
      payload: {
        version: 1,
        workspace_id: "ws_unattached_fixture",
        task: { id: guardTask.id },
        updates: []
      },
      available_at: new Date().toISOString(),
      created_at: new Date().toISOString()
    }]
  }));
  assert.equal((await router.getTaskById(guardTask.id)).status, "open");
  assert.equal((await new TaskMemoryOutboxStore({
    database: router.database
  }).summary()).pending, 0);
  await router.closeTask({ taskToken: guardTask.task_token });

  const initialTask = await router.openTask({
    title: "Queue durable Memory",
    complexityHint: "normal",
    primaryWorkspaceId: workspaceId
  });
  const prepared = prepareTaskMemoryOutbox(initialTask, [
    {
      kind: "constraint",
      title: "Durable close policy",
      summary: "Task closure must persist accepted Memory intent before returning success.",
      paths: ["src/runtime.mjs"],
      tags: ["memory", "outbox"]
    },
    {
      kind: "known_issue",
      title: "Dropped normal-task extra",
      summary: "A normal task must not create a second new Memory item."
    }
  ]);
  assert.equal(prepared.response.status, "queued");
  assert.equal(prepared.response.accepted_updates, 1);
  assert.equal(prepared.response.dropped_updates, 1);
  assert.deepEqual(prepared.response.drop_reasons, ["new_memory_limit"]);
  assert.match(prepared.jobs[0].payload.updates[0].id, /^memory_auto_[a-f0-9]{32}$/);

  const closed = await router.closeTask({
    taskToken: initialTask.task_token,
    memoryJobs: prepared.jobs
  });
  assert.equal(closed.status, "closed");
  const preRestartStore = new TaskMemoryOutboxStore({ database: router.database });
  assert.equal((await preRestartStore.summary(workspaceId)).pending, 1);

  await router.close();
  router = null;
  await registry.close();
  registry = null;

  registry = await WorkspaceRegistry.open({ dataDir });
  router = await TaskRouter.open({ dataDir });
  memory = new WorkspaceMemoryService({ registry, taskRouter: router });
  const store = new TaskMemoryOutboxStore({ database: router.database });
  outbox = new WorkspaceMemoryOutbox({
    store,
    memoryService: memory,
    pollMs: 60_000
  });
  await outbox.start();
  await waitFor(async () => (await memory.list(workspaceId, {
    query: "Durable close policy"
  })).length === 1);
  const persisted = (await memory.list(workspaceId, {
    query: "Durable close policy"
  }))[0];
  assert.equal(persisted.source_task_id, initialTask.id);
  assert.equal((await store.summary(workspaceId)).pending, 0);
  assert.ok((await store.summary(workspaceId)).last_completed_at);

  const duplicateTask = await router.openTask({
    title: "Replay durable Memory",
    complexityHint: "normal",
    primaryWorkspaceId: workspaceId
  });
  const duplicatePrepared = prepareTaskMemoryOutbox(duplicateTask, [{
    kind: "constraint",
    title: "Durable close policy",
    summary: "Task closure must persist accepted Memory intent before returning success.",
    paths: ["src/runtime.mjs"],
    tags: ["memory", "outbox"]
  }]);
  assert.equal(
    duplicatePrepared.jobs[0].payload.updates[0].id,
    prepared.jobs[0].payload.updates[0].id,
    "equivalent task-close Memory must receive a stable id"
  );
  await router.closeTask({
    taskToken: duplicateTask.task_token,
    memoryJobs: duplicatePrepared.jobs
  });
  outbox.wake();
  await waitFor(async () => {
    const status = await store.summary(workspaceId);
    return status.pending + status.processing + status.retrying === 0;
  });
  assert.equal((await memory.list(workspaceId, {
    query: "Durable close policy"
  })).length, 1, "retry/replay must not create a duplicate card");

  const leaseTask = await router.openTask({
    title: "Recover expired Memory lease",
    complexityHint: "normal",
    primaryWorkspaceId: workspaceId
  });
  const leasePrepared = prepareTaskMemoryOutbox(leaseTask, [{
    kind: "known_issue",
    title: "Recovered lease fixture",
    summary: "Expired processing leases must return to the retry queue."
  }]);
  await router.closeTask({
    taskToken: leaseTask.task_token,
    memoryJobs: leasePrepared.jobs
  });
  const claimed = await store.claimNext({
    leaseOwner: "outbox-test",
    leaseMs: 1_000
  });
  assert.equal(claimed.task_id, leaseTask.id);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(await store.recoverExpiredLeases(), 1);
  assert.equal((await store.summary(workspaceId)).retrying, 1);
  outbox.wake();
  await waitFor(async () => (await memory.list(workspaceId, {
    query: "Recovered lease fixture"
  })).length === 1);

  const batchTask = await router.openTask({
    title: "Batch Memory rebuild",
    complexityHint: "complex",
    primaryWorkspaceId: workspaceId
  });
  const originalRebuild = memory.rebuildBrief.bind(memory);
  let rebuildCalls = 0;
  memory.rebuildBrief = async (...args) => {
    rebuildCalls++;
    return originalRebuild(...args);
  };
  const batchResult = await memory.applyTaskCloseUpdates(batchTask, [
    {
      action: "save",
      id: "memory_batch_outbox_a",
      kind: "architecture_decision",
      title: "Batch item A",
      summary: "The outbox rebuilds the bounded Memory cache after the batch."
    },
    {
      action: "save",
      id: "memory_batch_outbox_b",
      kind: "constraint",
      title: "Batch item B",
      summary: "Individual outbox operations must not rebuild the cache separately."
    }
  ], { workspaceId, idempotent: true });
  assert.equal(batchResult.status, "complete");
  assert.equal(rebuildCalls, 1);

  const archiveTarget = await memory.save(workspaceId, {
    kind: "known_issue",
    title: "Archive idempotency fixture",
    summary: "Retrying an already applied transition must not increase revision."
  }, { actor: "user" });
  const transitionTask = {
    ...batchTask,
    id: "task_memory_outbox_transition",
    workspace_ids: [workspaceId],
    primary_workspace_id: workspaceId
  };
  await memory.applyTaskCloseUpdates(transitionTask, [{
    action: "archive",
    id: archiveTarget.id
  }], { workspaceId, idempotent: true });
  const archivedOnce = await memory.get(workspaceId, archiveTarget.id);
  await memory.applyTaskCloseUpdates(transitionTask, [{
    action: "archive",
    id: archiveTarget.id
  }], { workspaceId, idempotent: true });
  const archivedTwice = await memory.get(workspaceId, archiveTarget.id);
  assert.equal(archivedTwice.revision, archivedOnce.revision);

  const confidenceTarget = await memory.save(workspaceId, {
    kind: "verification_result",
    title: "Confidence replay fixture",
    summary: "Confidence-only updates must apply once and replay without another revision.",
    confidence: 0.5
  }, { actor: "user" });
  const confidenceUpdate = {
    action: "update",
    id: confidenceTarget.id,
    expected_revision: confidenceTarget.revision,
    confidence: 0.9
  };
  await memory.applyTaskCloseUpdates(transitionTask, [confidenceUpdate], {
    workspaceId,
    idempotent: true
  });
  const confidenceOnce = await memory.get(workspaceId, confidenceTarget.id);
  assert.equal(confidenceOnce.confidence, 0.9);
  await memory.applyTaskCloseUpdates(transitionTask, [confidenceUpdate], {
    workspaceId,
    idempotent: true
  });
  const confidenceTwice = await memory.get(workspaceId, confidenceTarget.id);
  assert.equal(confidenceTwice.revision, confidenceOnce.revision);

  const supersedeTarget = await memory.save(workspaceId, {
    kind: "architecture_decision",
    title: "Supersede replay fixture",
    summary: "The original durable decision is replaced once."
  }, { actor: "user" });
  const supersedeUpdate = {
    action: "supersede",
    id: supersedeTarget.id,
    expected_revision: supersedeTarget.revision,
    replacement: {
      id: "memory_auto_supersede_replay_fixture",
      kind: "architecture_decision",
      title: "Supersede replay replacement",
      summary: "A replay returns the deterministic replacement without another revision change."
    }
  };
  await memory.applyTaskCloseUpdates(transitionTask, [supersedeUpdate], {
    workspaceId,
    idempotent: true
  });
  const supersededOnce = await memory.get(workspaceId, supersedeTarget.id);
  await memory.applyTaskCloseUpdates(transitionTask, [supersedeUpdate], {
    workspaceId,
    idempotent: true
  });
  const supersededTwice = await memory.get(workspaceId, supersedeTarget.id);
  assert.equal(supersededTwice.revision, supersededOnce.revision);
  assert.equal(
    (await memory.get(workspaceId, supersedeUpdate.replacement.id)).supersedes_id,
    supersedeTarget.id
  );

  await outbox.close();
  outbox = null;
  const mixedRetryTask = await router.openTask({
    title: "Retry mixed Memory failures",
    complexityHint: "normal",
    primaryWorkspaceId: workspaceId
  });
  const mixedRetryPrepared = prepareTaskMemoryOutbox(mixedRetryTask, [{
    kind: "constraint",
    title: "Mixed retry fixture",
    summary: "A transient failure in a partial batch must cause an idempotent retry."
  }]);
  await router.closeTask({
    taskToken: mixedRetryTask.task_token,
    memoryJobs: mixedRetryPrepared.jobs
  });
  let mixedRetryCalls = 0;
  outbox = new WorkspaceMemoryOutbox({
    store,
    pollMs: 500,
    memoryService: {
      async applyTaskCloseUpdates() {
        mixedRetryCalls++;
        if (mixedRetryCalls === 1) {
          return {
            status: "partial",
            results: [
              { ok: false, action: "update", error_code: "WORKSPACE_MEMORY_REVISION_CONFLICT", retryable: false },
              { ok: false, action: "rebuild", error_code: "SQLITE_BUSY", retryable: true }
            ]
          };
        }
        return {
          status: "complete",
          results: [{ ok: true, action: "save", item: { id: "memory_mixed_retry_fixture" } }]
        };
      }
    }
  });
  await outbox.start();
  await waitFor(async () => mixedRetryCalls >= 2, 4_000);
  const mixedRetrySummary = await store.summary(workspaceId);
  assert.equal(mixedRetrySummary.retrying, 0);
  assert.equal(mixedRetrySummary.failed, 0);

  console.log("[PASS] Durable asynchronous workspace Memory outbox");
} finally {
  await outbox?.close().catch(() => {});
  await memory?.close().catch(() => {});
  await router?.close().catch(() => {});
  await registry?.close().catch(() => {});
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true }).catch(() => {});
  await safeRemove(context.dataDir, context, { recursive: true, force: true }).catch(() => {});
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for durable Memory outbox state.");
}
