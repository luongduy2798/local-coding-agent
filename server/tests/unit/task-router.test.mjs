// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  SqliteWorkerDatabase,
  probeSqliteCapability
} from "../../src/storage/database.mjs";
import { TaskRouter, TaskRouterError } from "../../src/workspace/task-router.mjs";
import { WorkspaceRegistry } from "../../src/workspace/registry.mjs";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";

const capability = await probeSqliteCapability();

test("TaskRouter locks an explicit multi-workspace set and resumes by token", {
  skip: capability.ok ? false : `node:sqlite unavailable: ${capability.reason}`
}, async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-task-router-" });
  let router;
  let registry;
  try {
    const dataDir = path.join(context.dataDir, "router");
    registry = await WorkspaceRegistry.open({ dataDir });
    for (const [index, workspaceId] of [
      "ws_aaaaaaaaaaaaaaaa",
      "ws_bbbbbbbbbbbbbbbb",
      "ws_cccccccccccccccc"
    ].entries()) {
      const root = path.join(context.fixtureDir, `workspace-${index}`);
      await mkdir(root, { recursive: true });
      await registry.registerWorkspace(root, { workspaceId });
    }
    router = await TaskRouter.open({ dataDir });
    const opened = await router.openTask({
      title: "Cross repo",
      primaryWorkspaceId: "ws_aaaaaaaaaaaaaaaa",
      attachedWorkspaceIds: ["ws_bbbbbbbbbbbbbbbb"],
      ownerSessionId: "session-a",
      workspaceBaselines: [
        {
          workspace_id: "ws_aaaaaaaaaaaaaaaa",
          known: true,
          base_head: "aaaa1111",
          branch: "main",
          clean: false,
          dirty_unknown: false,
          dirty: { staged: 1, unstaged: 0, untracked: 0 },
          captured_at: "2026-07-17T00:00:00.000Z"
        },
        {
          workspace_id: "ws_bbbbbbbbbbbbbbbb",
          known: true,
          base_head: "bbbb2222",
          branch: "feature",
          clean: true,
          dirty_unknown: false,
          dirty: { staged: 0, unstaged: 0, untracked: 0 },
          captured_at: "2026-07-17T00:00:01.000Z"
        }
      ]
    });
    assert.ok(opened.task_token);
    assert.equal(opened.title, "Cross repo");
    assert.equal(opened.objective, null, "title-only tasks must not duplicate title into objective");
    assert.deepEqual(opened.workspace_ids, ["ws_aaaaaaaaaaaaaaaa", "ws_bbbbbbbbbbbbbbbb"]);
    assert.deepEqual(opened.workspaces[0].baseline, {
      known: true,
      base_head: "aaaa1111",
      branch: "main",
      clean: false,
      dirty_unknown: false,
      dirty: { staged: 1, unstaged: 0, untracked: 0 },
      captured_at: "2026-07-17T00:00:00.000Z"
    });
    const objectiveOnly = await router.openTask({
      objective: "  Create durable task metadata.\r\nPreserve this second line.  ",
      primaryWorkspaceId: "ws_aaaaaaaaaaaaaaaa"
    });
    assert.equal(objectiveOnly.title, "Create durable task metadata. Preserve this second line.");
    assert.equal(objectiveOnly.objective, "Create durable task metadata.\nPreserve this second line.");
    const defaultMetadata = await router.openTask({
      primaryWorkspaceId: "ws_aaaaaaaaaaaaaaaa"
    });
    assert.equal(defaultMetadata.title, "LCA task");
    assert.equal(defaultMetadata.objective, null);

    const bySession = await router.getTask({ sessionId: "session-a" });
    assert.equal(bySession.id, opened.id);
    assert.equal(
      (await router.getTask({ taskToken: opened.task_token, sessionId: "session-a" })).id,
      opened.id
    );

    const otherTask = await router.openTask({
      title: "Other session",
      primaryWorkspaceId: "ws_cccccccccccccccc",
      ownerSessionId: "session-other"
    });
    await assert.rejects(
      () => router.getTask({
        taskToken: otherTask.task_token,
        sessionId: "session-a"
      }),
      (error) =>
        error instanceof TaskRouterError &&
        error.code === "TASK_CONTEXT_MISMATCH" &&
        error.details.task_id === otherTask.id &&
        error.details.bound_task_id === opened.id
    );
    assert.equal(
      (await router.getTask({ taskToken: otherTask.task_token })).id,
      otherTask.id,
      "stateless compatibility may authorize an explicit task token"
    );
    await assert.rejects(
      () => router.getTask({
        taskToken: otherTask.task_token,
        sessionId: "session-unbound"
      }),
      (error) => error instanceof TaskRouterError && error.code === "TASK_CONTEXT_REQUIRED"
    );
    const explicitlyRebound = await router.resumeTask({
      taskToken: otherTask.task_token,
      sessionId: "session-a"
    });
    assert.equal(explicitlyRebound.id, otherTask.id);
    assert.equal((await router.getTask({ sessionId: "session-a" })).id, otherTask.id);
    assert.equal(
      (await router.getTask({ taskToken: otherTask.task_token, sessionId: "session-a" })).id,
      otherTask.id
    );
    await router.resumeTask({ taskToken: opened.task_token, sessionId: "session-a" });

    const attached = await router.attachWorkspace({
      taskToken: opened.task_token,
      workspaceId: "ws_cccccccccccccccc",
      baseline: {
        known: true,
        base_head: "cccc3333",
        branch: "consumer",
        clean: true,
        dirty_unknown: false,
        dirty: { staged: 0, unstaged: 0, untracked: 0 }
      }
    });
    assert.equal(attached.workspace_ids.length, 3);
    assert.equal(attached.workspaces[2].baseline.base_head, "cccc3333");

    const frozen = await router.freezeWorkspaceSet({ taskToken: opened.task_token });
    assert.equal(frozen.workspace_set_frozen, true);
    await assert.rejects(
      () => router.detachWorkspace({
        taskToken: opened.task_token,
        workspaceId: "ws_bbbbbbbbbbbbbbbb"
      }),
      (error) => error instanceof TaskRouterError && error.code === "TASK_WORKSPACE_SET_FROZEN"
    );

    const resumed = await router.resumeTask({ taskToken: opened.task_token, sessionId: "session-b" });
    assert.equal(resumed.id, opened.id);
    assert.equal(resumed.workspaces[0].baseline.base_head, "aaaa1111");
    assert.equal((await router.getTask({ sessionId: "session-b" })).id, opened.id);
    assert.equal(await router.unbindSession("session-b"), true);
    assert.equal(await router.getTask({ sessionId: "session-b", required: false }), null);
    const stillBound = await router.getTaskById(opened.id);
    assert.equal(stillBound.session_bound, true, "another bound session must keep the task active");
    assert.equal(stillBound.detached_at, null);
    assert.equal(await router.unbindSession("session-a"), true);
    const detached = await router.getTaskById(opened.id);
    assert.equal(detached.owner_session_id, null);
    assert.equal(detached.session_bound, false);
    assert.ok(detached.detached_at);
    assert.equal(await router.unbindSession("session-b"), false);
    await assert.rejects(
      () => router.closeDetachedTask({ taskId: otherTask.id }),
      (error) => error instanceof TaskRouterError && error.code === "TASK_NOT_DETACHED"
    );
    const rebound = await router.resumeTask({ taskToken: opened.task_token, sessionId: "session-c" });
    assert.equal(rebound.session_bound, true);
    assert.equal(rebound.detached_at, null);
    await router.unbindSession("session-c");
    const abandoned = await router.closeDetachedTask({ taskId: opened.id });
    assert.equal(abandoned.status, "closed");
    assert.equal(abandoned.closed_reason, "abandoned");

    const resetCandidate = await router.openTask({
      title: "Reset stale binding",
      primaryWorkspaceId: "ws_aaaaaaaaaaaaaaaa",
      ownerSessionId: "session-stale"
    });
    const reset = await router.resetSessionBindings();
    assert.ok(reset.bindings_deleted >= 1);
    const resetState = await router.getTaskById(resetCandidate.id);
    assert.equal(resetState.session_bound, false);
    assert.ok(resetState.detached_at);

    const closed = await router.closeTask({ taskToken: resetCandidate.task_token });
    assert.equal(closed.status, "closed");

    const raced = await router.openTask({
      title: "Attach freeze race",
      primaryWorkspaceId: "ws_aaaaaaaaaaaaaaaa"
    });
    const originalGetTaskByToken = router.getTaskByToken.bind(router);
    let releaseAttach;
    let attachRead;
    const attachReadPromise = new Promise((resolve) => { attachRead = resolve; });
    const attachGate = new Promise((resolve) => { releaseAttach = resolve; });
    let interceptFirstRead = true;
    router.getTaskByToken = async (...args) => {
      const value = await originalGetTaskByToken(...args);
      if (interceptFirstRead) {
        interceptFirstRead = false;
        attachRead();
        await attachGate;
      }
      return value;
    };
    const racedAttach = router.attachWorkspace({
      taskToken: raced.task_token,
      workspaceId: "ws_bbbbbbbbbbbbbbbb"
    });
    await attachReadPromise;
    await router.freezeWorkspaceSet({ taskToken: raced.task_token });
    releaseAttach();
    await assert.rejects(
      racedAttach,
      (error) => error instanceof TaskRouterError && error.code === "TASK_WORKSPACE_SET_FROZEN"
    );
    const racedState = await router.getTaskById(raced.id);
    assert.equal(racedState.workspace_set_frozen, true);
    assert.deepEqual(racedState.workspace_ids, ["ws_aaaaaaaaaaaaaaaa"]);
  } finally {
    await router?.close().catch(() => {});
    await registry?.close().catch(() => {});
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("TaskRouter transactionally imports the one-release legacy task database", {
  skip: capability.ok ? false : `node:sqlite unavailable: ${capability.reason}`
}, async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-task-migration-" });
  const dataDir = path.join(context.dataDir, "router");
  let registry;
  let legacy;
  let router;
  try {
    const workspaceId = "ws_dddddddddddddddd";
    const root = path.join(context.fixtureDir, "workspace");
    await mkdir(root, { recursive: true });
    registry = await WorkspaceRegistry.open({ dataDir });
    await registry.registerWorkspace(root, { workspaceId });
    await registry.close();
    registry = null;

    legacy = await SqliteWorkerDatabase.open({
      databasePath: path.join(dataDir, "task-router.sqlite3"),
      schema: {
        version: 1,
        migrations: [{
          version: 1,
          sql: `
            CREATE TABLE task_router_tasks (
              id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
              owner_session_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
              version INTEGER NOT NULL, workspace_set_frozen INTEGER NOT NULL,
              mutation_started_at TEXT, created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL, closed_at TEXT
            );
            CREATE TABLE task_router_workspaces (
              task_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
              role TEXT NOT NULL, attached_at TEXT NOT NULL,
              PRIMARY KEY(task_id, workspace_id)
            );
            CREATE TABLE task_router_sessions (
              session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
              bound_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
          `
        }]
      }
    });
    const timestamp = new Date().toISOString();
    await legacy.batch([
      {
        mode: "run",
        sql: `
          INSERT INTO task_router_tasks(
            id, token_hash, owner_session_id, title, status, version,
            workspace_set_frozen, mutation_started_at, created_at, updated_at, closed_at
          ) VALUES (?, ?, ?, ?, 'open', 1, 0, NULL, ?, ?, NULL)
        `,
        params: [
          "task_legacyimport1",
          "legacy-token-hash",
          "legacy-session",
          "Legacy task",
          timestamp,
          timestamp
        ]
      },
      {
        mode: "run",
        sql: `
          INSERT INTO task_router_workspaces(task_id, workspace_id, role, attached_at)
          VALUES ('task_legacyimport1', ?, 'primary', ?)
        `,
        params: [workspaceId, timestamp]
      },
      {
        mode: "run",
        sql: `
          INSERT INTO task_router_sessions(session_id, task_id, bound_at, updated_at)
          VALUES ('legacy-session', 'task_legacyimport1', ?, ?)
        `,
        params: [timestamp, timestamp]
      }
    ]);
    await legacy.close();
    legacy = null;

    router = await TaskRouter.open({ dataDir });
    const migrated = await router.getTask({ sessionId: "legacy-session" });
    assert.equal(migrated.id, "task_legacyimport1");
    assert.deepEqual(migrated.workspace_ids, [workspaceId]);
    assert.equal(migrated.workspaces[0].baseline.known, false);
    assert.equal(router.databasePath, path.join(dataDir, "registry.sqlite"));
  } finally {
    await router?.close().catch(() => {});
    await legacy?.close().catch(() => {});
    await registry?.close().catch(() => {});
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("registry and task router share a ref-counted SQLite worker lease", {
  skip: capability.ok ? false : `node:sqlite unavailable: ${capability.reason}`
}, async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-registry-pool-" });
  const dataDir = path.join(context.dataDir, "shared");
  let registry;
  let reopenedRegistry;
  let router;
  try {
    const root = path.join(context.fixtureDir, "workspace");
    await mkdir(root, { recursive: true });
    registry = await WorkspaceRegistry.open({ dataDir });
    const registered = await registry.registerWorkspace(root);
    router = await TaskRouter.open({ dataDir });

    await registry.close();
    registry = null;
    assert.equal((await router.health()).integrity, "ok");
    const task = await router.openTask({
      title: "Shared lease",
      primaryWorkspaceId: registered.workspace.id
    });

    reopenedRegistry = await WorkspaceRegistry.open({ dataDir });
    await router.close();
    router = null;
    assert.equal(
      (await reopenedRegistry.getWorkspace(registered.workspace.id)).id,
      registered.workspace.id
    );
    assert.equal((await reopenedRegistry.listWorkspaces()).length, 1);
    assert.equal((await reopenedRegistry.health()).integrity, "ok");
    assert.equal(task.primary_workspace_id, registered.workspace.id);
  } finally {
    await router?.close().catch(() => {});
    await registry?.close().catch(() => {});
    await reopenedRegistry?.close().catch(() => {});
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});
