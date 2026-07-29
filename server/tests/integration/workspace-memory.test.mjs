// Persistent workspace memory integration tests.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";
import { WorkspaceMemoryService } from "../../src/workspace/workspace-memory.mjs";
import { WorkspaceRegistry } from "../../src/workspace/registry.mjs";
import { TaskRouter } from "../../src/workspace/task-router.mjs";


const context = await createIsolatedTestRoot({
  prefix: "lca-workspace-memory-",
  protectedPaths: [path.resolve("..")]
});
let registry;
let router;
let runtime;

try {
  const dataDir = path.join(context.dataDir, "service-runtime");
  const workspaceRoot = path.join(context.fixtureDir, "service-workspace");
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  registry = await WorkspaceRegistry.open({ dataDir });
  const registered = await registry.registerWorkspace(workspaceRoot, {
    metadata: { label: "Memory fixture", trusted: true }
  });
  router = await TaskRouter.open({ dataDir });
  const memory = new WorkspaceMemoryService({ registry, taskRouter: router });
  const workspaceId = registered.workspace.id;

  const decision = await memory.save(workspaceId, {
    kind: "architecture_decision",
    title: "Managed execution boundary",
    summary: "The external model reasons while LCA executes journaled tasks with user control.",
    pinned: true,
    paths: ["src/runtime.mjs"],
    tags: ["architecture", "runtime"]
  }, { actor: "user" });
  assert.equal(decision.workspace_id, workspaceId);
  assert.equal(decision.revision, 1);
  assert.deepEqual(decision.paths, ["src/runtime.mjs"]);

  await assert.rejects(
    memory.save(workspaceId, {
      title: "Rejected secret",
      summary: "api_key=abcdefghijklmnopqrstuvwxyz123456"
    }),
    (error) => error?.code === "WORKSPACE_MEMORY_SENSITIVE_CONTENT"
  );

  const updated = await memory.update(workspaceId, decision.id, {
    expected_revision: decision.revision,
    summary: "The external model owns reasoning; LCA owns bounded, journaled execution.",
    paths: ["src/runtime.mjs", "src/task.mjs"],
    tags: ["runtime", "task"]
  }, { actor: "user" });
  assert.equal(updated.revision, 2);
  await assert.rejects(
    memory.update(workspaceId, decision.id, {
      expected_revision: decision.revision,
      summary: "This stale update must not partially modify paths or tags.",
      paths: ["wrong/path.mjs"],
      tags: ["wrong"]
    }),
    (error) => error?.code === "WORKSPACE_MEMORY_REVISION_CONFLICT"
  );
  const afterConflict = await memory.get(workspaceId, decision.id);
  assert.deepEqual(afterConflict.paths, ["src/runtime.mjs", "src/task.mjs"]);
  assert.deepEqual(afterConflict.tags, ["runtime", "task"]);

  const freshness = await memory.markPathsChanged([{
    workspace_id: workspaceId,
    op: "update",
    path: "src/runtime.mjs"
  }], { taskId: "task_memoryfreshness1" });
  assert.equal(freshness[0].updated, 1);
  assert.equal((await memory.get(workspaceId, decision.id)).freshness, "needs_review");
  await memory.transition(workspaceId, decision.id, "current", { actor: "user" });
  await memory.markPathsChanged([{
    workspace_id: workspaceId,
    op: "delete",
    path: "src/runtime.mjs"
  }], { taskId: "task_memoryfreshness2" });
  assert.equal((await memory.get(workspaceId, decision.id)).freshness, "stale");

  for (let index = 0; index < 4; index++) {
    const task = await router.openTask({
      title: `Recent memory task ${index + 1}`,
      objective: `Completed durable task ${index + 1}.`,
      primaryWorkspaceId: workspaceId
    });
    await router.closeTask({ taskToken: task.task_token });
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  memory.invalidateRecentTasks([workspaceId]);
  const independentFullTask = await router.openTask({
    title: "Independent full Memory task",
    memoryMode: "full",
    primaryWorkspaceId: workspaceId
  });
  const independentBrief = await memory.briefForTask(independentFullTask);
  assert.equal(independentBrief.recent_tasks_requested, false);
  assert.deepEqual(independentBrief.recent_tasks, []);

  const activeTask = await router.openTask({
    title: "Memory startup brief",
    objective: "Use architecture decisions and recent task context.",
    memoryMode: "full",
    includeRecentTasks: true,
    primaryWorkspaceId: workspaceId
  });
  const brief = await memory.briefForTask(activeTask);
  assert.equal(brief.available, true);
  assert.equal(brief.requested_mode, "full");
  assert.equal(brief.effective_mode, "full");
  assert.equal(brief.recent_tasks_requested, true);
  assert.ok(brief.items.length <= 8);
  assert.equal(brief.recent_tasks.length, 3);
  assert.equal(brief.recent_tasks_included, true);
  assert.ok(Buffer.byteLength(JSON.stringify(brief), "utf8") <= 4_096);
  assert.match(brief.brief, /Managed execution boundary/);
  assert.equal(brief.brief.includes("Recent memory task 1"), false, "only the three newest tasks belong in the startup brief");

  const view = await memory.view(workspaceId);
  assert.equal(view.counts.total, 1);
  assert.equal(view.settings.auto_load, true);
  assert.ok(view.auto_load_payload.items.length <= 8);
  await memory.settings(workspaceId, { include_recent_tasks: false });
  memory.invalidateRecentTasks([workspaceId]);
  const withoutRecent = await memory.briefForTask(activeTask);
  assert.deepEqual(withoutRecent.recent_tasks, []);

  const semanticWorkspaceRoot = path.join(context.fixtureDir, "semantic-workspace");
  await mkdir(path.join(semanticWorkspaceRoot, "src"), { recursive: true });
  const semanticRegistered = await registry.registerWorkspace(semanticWorkspaceRoot, {
    metadata: { label: "Semantic memory fixture", trusted: true }
  });
  const semanticWorkspaceId = semanticRegistered.workspace.id;
  const fakeEmbedding = createFakeEmbeddingService();
  const semanticMemory = new WorkspaceMemoryService({
    registry,
    taskRouter: router,
    embeddingService: fakeEmbedding,
    semanticDeadlineMs: 5
  });
  const localStorageDecision = await semanticMemory.save(semanticWorkspaceId, {
    kind: "architecture_decision",
    title: "Local-only storage",
    summary: "Do not use a cloud database; durable state must remain on the local machine.",
    paths: ["src/storage.mjs"],
    tags: ["storage", "local"]
  }, { actor: "user" });
  const interfaceConstraint = await semanticMemory.save(semanticWorkspaceId, {
    kind: "constraint",
    title: "Interface corner styling",
    summary: "Control Center cards use rounded borders and compact spacing.",
    paths: ["src/ui.mjs"],
    tags: ["ui", "style"]
  }, { actor: "user" });
  await waitFor(async () => (
    await semanticMemory.view(semanticWorkspaceId)
  ).semantic.current_items === 2);

  const lightTask = await router.openTask({
    title: "Change storage type",
    objective: "Apply a mechanical type correction in the known storage file.",
    complexityHint: "quick_edit",
    memoryMode: "auto",
    includeRecentTasks: true,
    relevantPaths: [{ path: "src/storage.mjs" }],
    primaryWorkspaceId: semanticWorkspaceId
  });
  const globalConstraint = await semanticMemory.save(semanticWorkspaceId, {
    kind: "constraint",
    title: "Workspace-wide safety rule",
    summary: "Do not bypass task boundaries during any edit.",
    pinned: true
  }, { actor: "user" });
  const queryCallsBeforeLight = fakeEmbedding.queryCalls;
  const lightBrief = await semanticMemory.briefForTask(lightTask);
  assert.equal(lightBrief.requested_mode, "auto");
  assert.equal(lightBrief.effective_mode, "light");
  assert.equal(lightBrief.semantic_used, false);
  assert.equal(lightBrief.recent_tasks_included, false);
  assert.deepEqual(lightBrief.recent_tasks, []);
  assert.ok(lightBrief.items.length <= 2);
  assert.equal(lightBrief.items[0].id, localStorageDecision.id);
  assert.ok(
    lightBrief.items.length === 1 || lightBrief.items[1].id === globalConstraint.id,
    "a directly related item must outrank the optional workspace-wide fallback"
  );
  assert.ok(Buffer.byteLength(JSON.stringify(lightBrief), "utf8") <= 1_024);
  assert.equal(fakeEmbedding.queryCalls, queryCallsBeforeLight, "light mode must not query the embedding model");

  const fallbackLightTask = await router.openTask({
    title: "Apply workspace-wide safety fallback",
    complexityHint: "quick_edit",
    memoryMode: "auto",
    relevantPaths: [{ path: "src/unrelated.mjs" }],
    primaryWorkspaceId: semanticWorkspaceId
  });
  const fallbackLightBrief = await semanticMemory.briefForTask(fallbackLightTask);
  assert.equal(fallbackLightBrief.effective_mode, "light");
  assert.equal(fallbackLightBrief.items[0].id, globalConstraint.id);
  assert.ok(Buffer.byteLength(JSON.stringify(fallbackLightBrief), "utf8") <= 1_024);

  await semanticMemory.transition(
    semanticWorkspaceId,
    globalConstraint.id,
    "archive",
    { actor: "user" }
  );

  const unrelatedLightTask = await router.openTask({
    title: "Change unrelated type",
    complexityHint: "quick_edit",
    relevantPaths: [{ path: "src/unrelated.mjs" }],
    primaryWorkspaceId: semanticWorkspaceId
  });
  const unrelatedLightBrief = await semanticMemory.briefForTask(unrelatedLightTask);
  assert.equal(unrelatedLightBrief.effective_mode, "light");
  assert.deepEqual(unrelatedLightBrief.items, []);
  assert.equal(fakeEmbedding.queryCalls, queryCallsBeforeLight);

  const skippedTask = await router.openTask({
    title: "Mechanical typo",
    complexityHint: "quick_edit",
    memoryMode: "skip",
    primaryWorkspaceId: semanticWorkspaceId
  });
  const skippedBrief = await semanticMemory.briefForTask(skippedTask);
  assert.equal(skippedBrief.skipped, true);
  assert.equal(skippedBrief.effective_mode, "skip");
  assert.deepEqual(skippedBrief.items, []);
  assert.deepEqual(skippedBrief.recent_tasks, []);
  assert.equal(fakeEmbedding.queryCalls, queryCallsBeforeLight);

  const semanticTask = await router.openTask({
    title: "Disconnected persistence",
    objective: "Operate correctly without network access.",
    primaryWorkspaceId: semanticWorkspaceId
  });
  const semanticBrief = await semanticMemory.briefForTask(semanticTask);
  assert.equal(semanticBrief.effective_mode, "full");
  assert.equal(semanticBrief.items[0].id, localStorageDecision.id);
  assert.equal(fakeEmbedding.queryCalls, 1);

  const semanticDatabase = await registry.openWorkspace(semanticWorkspaceId, {
    allowUnavailable: true,
    refreshAvailability: false
  });
  assert.equal(await semanticDatabase.upsertMemoryEmbedding({
    memoryId: localStorageDecision.id,
    contentHash: "0".repeat(64),
    modelId: fakeEmbedding.modelId,
    dimensions: 2,
    vector: new Float32Array([1, 0])
  }), false, "a stale content hash must not overwrite the current embedding");

  const alternateModelId = "test/alternate-multilingual-model";
  assert.equal(await semanticDatabase.upsertMemoryEmbedding({
    memoryId: localStorageDecision.id,
    contentHash: localStorageDecision.content_hash,
    modelId: alternateModelId,
    dimensions: 2,
    vector: new Float32Array([0, 1])
  }), true);
  assert.equal((await semanticDatabase.listMemoryEmbeddings({
    modelId: fakeEmbedding.modelId,
    memoryIds: [localStorageDecision.id]
  })).length, 1, "the active model cache must remain available");
  assert.equal((await semanticDatabase.listMemoryEmbeddings({
    modelId: alternateModelId,
    memoryIds: [localStorageDecision.id]
  })).length, 1, "model-specific embeddings must not overwrite each other");

  const disabledSettings = await semanticMemory.settings(
    semanticWorkspaceId,
    { semantic_search: false }
  );
  assert.equal(disabledSettings.semantic_search, false);
  assert.equal(
    (await semanticMemory.view(semanticWorkspaceId)).settings.semantic_search,
    false
  );
  const lexicalBrief = await semanticMemory.briefForTask(semanticTask);
  assert.equal(fakeEmbedding.queryCalls, 1, "workspace setting must avoid semantic inference entirely");
  assert.equal(
    lexicalBrief.items[0].id,
    interfaceConstraint.id,
    `lexical rank returned ${lexicalBrief.items[0]?.title}`
  );

  await semanticMemory.settings(semanticWorkspaceId, { semantic_search: true });
  fakeEmbedding.queryUnavailable = true;
  const fallbackBrief = await semanticMemory.briefForTask(semanticTask);
  assert.equal(fallbackBrief.available, true);
  assert.equal(fallbackBrief.items[0].id, interfaceConstraint.id);
  assert.ok(Buffer.byteLength(JSON.stringify(fallbackBrief), "utf8") <= 4_096);

  const queryCallsBeforeDisabledAutoLoad = fakeEmbedding.queryCalls;
  await semanticMemory.settings(semanticWorkspaceId, { auto_load: false });
  const disabledAutoLoadBrief = await semanticMemory.briefForTask(semanticTask);
  assert.deepEqual(disabledAutoLoadBrief.items, []);
  assert.deepEqual(disabledAutoLoadBrief.recent_tasks, []);
  assert.equal(
    fakeEmbedding.queryCalls,
    queryCallsBeforeDisabledAutoLoad,
    "disabled auto-load must not invoke semantic retrieval"
  );
  await semanticMemory.settings(semanticWorkspaceId, { auto_load: true });
  await semanticMemory.close();

  await router.close();
  router = null;
  await registry.close();
  registry = null;

  const httpWorkspace = path.join(context.fixtureDir, "http-workspace");
  await mkdir(httpWorkspace, { recursive: true });
  runtime = await startTestServer({
    workspace: httpWorkspace,
    dataDir: path.join(context.dataDir, "http-runtime"),
    runId: context.runId,
    mode: "full",
    policy: "full",
    env: { LCA_TEST_RUNTIME_DIAGNOSTICS: "0" }
  });
  const origin = `http://127.0.0.1:${runtime.port}`;
  const nonceHeaders = {
    "content-type": "application/json",
    "x-lca-instance-nonce": context.runId
  };
  const denied = await fetch(`${origin}/memory?workspace_id=missing`);
  assert.equal(denied.status, 401);
  const health = await fetch(`${origin}/healthz/details`, {
    headers: { "x-lca-instance-nonce": context.runId }
  }).then((response) => response.json());
  const httpWorkspaceId = health.global_default_workspace_id;
  assert.match(httpWorkspaceId, /^ws_/);

  const created = await fetch(`${origin}/memory?workspace_id=${encodeURIComponent(httpWorkspaceId)}`, {
    method: "POST",
    headers: nonceHeaders,
    body: JSON.stringify({
      kind: "constraint",
      title: "HTTP memory fixture",
      summary: "The browser and IDE hosts share this authenticated local API.",
      pinned: true
    })
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.item.title, "HTTP memory fixture");

  const ticket = await fetch(`${origin}/control/tickets`, {
    method: "POST",
    headers: nonceHeaders,
    body: JSON.stringify({ host: "jetbrains" })
  }).then((response) => response.json());
  const launch = await fetch(`${origin}/control/launch?t=${encodeURIComponent(ticket.ticket)}`, {
    redirect: "manual"
  });
  assert.equal(launch.status, 302);
  const cookie = String(launch.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^lca_control_session=/);

  const controlState = await fetch(
    `${origin}/control/state?workspace_key=${encodeURIComponent(`workspace:${httpWorkspaceId}`)}`,
    { headers: { cookie } }
  ).then((response) => response.json());
  assert.equal(controlState.host.kind, "jetbrains");
  assert.equal(controlState.host.capabilities.memoryManagement, true);
  assert.equal(controlState.memorySummary.counts.total, 1);
  assert.equal(controlState.memorySummary.semantic_search, true);
  assert.equal("items" in controlState.memorySummary, false, "polling state must not include full memory content");

  const deniedCookieMutation = await fetch(
    `${origin}/memory?workspace_id=${encodeURIComponent(httpWorkspaceId)}`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Denied", summary: "Missing CSRF headers." })
    }
  );
  assert.equal(deniedCookieMutation.status, 401);

  const cookieMutation = await fetch(
    `${origin}/memory?workspace_id=${encodeURIComponent(httpWorkspaceId)}`,
    {
      method: "POST",
      headers: {
        cookie,
        origin,
        "content-type": "application/json",
        "x-lca-control-request": "1"
      },
      body: JSON.stringify({
        kind: "known_issue",
        title: "Cookie-managed memory",
        summary: "Control Center mutations require same-origin and an explicit control header."
      })
    }
  );
  assert.equal(cookieMutation.status, 201);
  const listed = await fetch(
    `${origin}/memory?workspace_id=${encodeURIComponent(httpWorkspaceId)}`,
    { headers: { cookie } }
  ).then((response) => response.json());
  assert.equal(listed.items.length, 2);
  assert.equal(listed.settings.semantic_search, true);
  assert.equal(listed.semantic.enabled, false, "test runtimes do not load the real embedding model by default");
  assert.equal(listed.read_only, false);

  console.log("[PASS] Persistent workspace memory storage, fast brief, privacy, HTTP auth, and shared-host projection");
} finally {
  if (runtime) await stopTestProcess(runtime.child).catch(() => {});
  await router?.close().catch(() => {});
  await registry?.close().catch(() => {});
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true }).catch(() => {});
  await safeRemove(context.dataDir, context, { recursive: true, force: true }).catch(() => {});
}

function createFakeEmbeddingService() {
  return {
    enabled: true,
    modelId: "test/multilingual-e5-small",
    deadlineMs: 5,
    queryCalls: 0,
    queryUnavailable: false,
    preload() {},
    status() {
      return {
        enabled: true,
        state: "ready",
        ready: true,
        model_id: this.modelId,
        dtype: "test",
        deadline_ms: this.deadlineMs,
        in_flight: 0,
        last_error_code: null,
        metrics: {}
      };
    },
    async embedPassage(text) {
      return semanticVector(text);
    },
    async embedQuery(text) {
      this.queryCalls++;
      return this.queryUnavailable ? null : semanticVector(text);
    },
    async close() {}
  };
}

function semanticVector(text) {
  return /cloud database|local-only|local machine|disconnected|without network/i.test(String(text || ""))
    ? new Float32Array([1, 0])
    : new Float32Array([0, 1]);
}

async function waitFor(predicate, { timeoutMs = 1_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`Condition was not met within ${timeoutMs} ms.`);
}
