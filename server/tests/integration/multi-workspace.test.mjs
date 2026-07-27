// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import {
  PatchTransactionCoordinator,
  PatchTransactionError
} from "../../src/mutation/patch-transaction.mjs";
import {
  TaskRouter,
  TaskRouterError
} from "../../src/workspace/task-router.mjs";
import {
  WorkspaceRegistry,
  WorkspaceRegistryError
} from "../../src/workspace/registry.mjs";
import {
  createIsolatedTestRoot,
  safeRemove
} from "../helpers/test-guard.mjs";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function expectCode(promise, ErrorClass, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof ErrorClass, true, error?.stack || String(error));
    assert.equal(error.code, code, error?.stack || String(error));
    return true;
  });
}

test("Runtime isolates task workspaces and coordinates atomic cross-workspace mutation", async (t) => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-multi-workspace-",
    protectedPaths: [path.resolve("..")]
  });
  const workspaceA = path.join(context.fixtureDir, "workspace-a");
  const workspaceB = path.join(context.fixtureDir, "workspace-b");
  const movedWorkspaceB = path.join(context.fixtureDir, "workspace-b-moved");
  const runtimeDataDir = path.join(context.dataDir, "runtime");
  let registry;
  let router;

  try {
    await Promise.all([
      mkdir(workspaceA, { recursive: true }),
      mkdir(workspaceB, { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(workspaceA, "api.js"), "export const value = 1;\n", "utf8"),
      writeFile(path.join(workspaceB, "consumer.js"), "export const seen = 1;\n", "utf8")
    ]);

    registry = await WorkspaceRegistry.open({
      dataDir: runtimeDataDir,
      maxOpenWorkspaces: 2
    });
    router = await TaskRouter.open({ dataDir: runtimeDataDir });

    const registeredA = await registry.registerWorkspace(workspaceA, {
      metadata: { label: "Workspace A", trust: "trusted" }
    });
    const registeredB = await registry.registerWorkspace(workspaceB, {
      metadata: { label: "Workspace B", trust: "trusted" }
    });
    const workspaceAId = registeredA.workspace.id;
    const workspaceBId = registeredB.workspace.id;

    const resolveWorkspace = async (workspaceId) => {
      const workspace = await registry.getWorkspace(workspaceId, {
        refreshAvailability: true
      });
      if (workspace.availability !== "available") return null;
      return { id: workspace.id, root: workspace.canonicalRoot };
    };
    const authorizeWorkspace = async ({
      workspaceId,
      taskId,
      taskToken,
      sessionId
    }) => {
      const taskContext = await router.assertWorkspaceAccess({
        taskToken,
        sessionId,
        workspaceId
      });
      if (taskId && taskContext.id !== taskId) {
        throw new TaskRouterError(
          "TASK_CONTEXT_MISMATCH",
          `Transaction task ${taskId} does not match token task ${taskContext.id}.`,
          {
            expected_task_id: taskId,
            actual_task_id: taskContext.id
          }
        );
      }
      return taskContext;
    };
    const coordinator = new PatchTransactionCoordinator({
      dataDir: path.join(runtimeDataDir, "patches"),
      resolveWorkspace,
      authorizeWorkspace
    });
    await coordinator.init();

    await t.test("two bound sessions cannot access each other's workspace", async () => {
      const taskA = await router.openTask({
        title: "Session A task",
        primaryWorkspaceId: workspaceAId,
        ownerSessionId: "session-a"
      });
      const taskB = await router.openTask({
        title: "Session B task",
        primaryWorkspaceId: workspaceBId,
        ownerSessionId: "session-b"
      });

      assert.equal(
        (await router.getTask({ sessionId: "session-a" })).id,
        taskA.id
      );
      assert.equal(
        (await router.getTask({ sessionId: "session-b" })).id,
        taskB.id
      );
      assert.equal(
        (await router.assertWorkspaceAccess({
          sessionId: "session-a",
          workspaceId: workspaceAId
        })).id,
        taskA.id
      );
      assert.equal(
        (await router.assertWorkspaceAccess({
          sessionId: "session-b",
          workspaceId: workspaceBId
        })).id,
        taskB.id
      );

      await expectCode(
        router.assertWorkspaceAccess({
          sessionId: "session-a",
          workspaceId: workspaceBId
        }),
        TaskRouterError,
        "TASK_WORKSPACE_NOT_ATTACHED"
      );
      await expectCode(
        router.assertWorkspaceAccess({
          sessionId: "session-b",
          workspaceId: workspaceAId
        }),
        TaskRouterError,
        "TASK_WORKSPACE_NOT_ATTACHED"
      );

      const beforeB = await readFile(path.join(workspaceB, "consumer.js"), "utf8");
      await expectCode(
        coordinator.apply({
          taskId: taskA.id,
          sessionId: "session-a",
          operations: [{
            workspace_id: workspaceBId,
            op: "update",
            path: "consumer.js",
            content: "export const leaked = true;\n"
          }]
        }),
        TaskRouterError,
        "TASK_WORKSPACE_NOT_ATTACHED"
      );
      await expectCode(
        coordinator.apply({
          taskId: taskB.id,
          sessionId: "session-a",
          operations: [{
            workspace_id: workspaceAId,
            op: "update",
            path: "api.js",
            content: "export const mismatched = true;\n"
          }]
        }),
        TaskRouterError,
        "TASK_CONTEXT_MISMATCH"
      );
      assert.equal(
        await readFile(path.join(workspaceB, "consumer.js"), "utf8"),
        beforeB
      );
      assert.equal(
        await readFile(path.join(workspaceA, "api.js"), "utf8"),
        "export const value = 1;\n"
      );
    });

    let crossTask;
    await t.test("explicit A+B task freezes and commits both workspaces", async () => {
      crossTask = await router.openTask({
        title: "Cross repository API change",
        primaryWorkspaceId: workspaceAId,
        ownerSessionId: "session-cross"
      });
      const attached = await router.attachWorkspace({
        taskToken: crossTask.task_token,
        workspaceId: workspaceBId
      });
      assert.deepEqual(
        new Set(attached.workspace_ids),
        new Set([workspaceAId, workspaceBId])
      );
      assert.equal(attached.workspace_set_frozen, false);

      const frozen = await router.freezeWorkspaceSet({
        taskToken: crossTask.task_token
      });
      assert.equal(frozen.workspace_set_frozen, true);
      await expectCode(
        router.detachWorkspace({
          taskToken: crossTask.task_token,
          workspaceId: workspaceBId
        }),
        TaskRouterError,
        "TASK_WORKSPACE_SET_FROZEN"
      );

      const apiBefore = await readFile(path.join(workspaceA, "api.js"));
      const consumerBefore = await readFile(path.join(workspaceB, "consumer.js"));
      const result = await coordinator.apply({
        taskId: crossTask.id,
        taskToken: crossTask.task_token,
        operations: [
          {
            workspace_id: workspaceAId,
            op: "update",
            path: "api.js",
            expected_version: sha256(apiBefore),
            content: "export const value = 2;\n"
          },
          {
            workspace_id: workspaceBId,
            op: "update",
            path: "consumer.js",
            expected_version: sha256(consumerBefore),
            content: "export const seen = 2;\n"
          }
        ]
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, "complete");
      assert.deepEqual(
        new Set(result.workspaces),
        new Set([workspaceAId, workspaceBId])
      );
      assert.equal(
        await readFile(path.join(workspaceA, "api.js"), "utf8"),
        "export const value = 2;\n"
      );
      assert.equal(
        await readFile(path.join(workspaceB, "consumer.js"), "utf8"),
        "export const seen = 2;\n"
      );
    });

    await t.test("fault after the first commit rolls both workspaces back", async () => {
      let injected = false;
      const failingCoordinator = new PatchTransactionCoordinator({
        dataDir: path.join(runtimeDataDir, "patches-fault"),
        resolveWorkspace,
        authorizeWorkspace,
        faultInjector(point, payload) {
          if (
            !injected
            && point === "after_commit_operation"
            && payload.index === 0
          ) {
            injected = true;
            throw new Error("seeded cross-workspace commit failure");
          }
        }
      });
      await failingCoordinator.init();

      const beforeA = await readFile(path.join(workspaceA, "api.js"), "utf8");
      const beforeB = await readFile(path.join(workspaceB, "consumer.js"), "utf8");
      await expectCode(
        failingCoordinator.apply({
          taskId: crossTask.id,
          taskToken: crossTask.task_token,
          operations: [
            {
              workspace_id: workspaceAId,
              op: "update",
              path: "api.js",
              content: "export const value = 3;\n"
            },
            {
              workspace_id: workspaceBId,
              op: "update",
              path: "consumer.js",
              content: "export const seen = 3;\n"
            }
          ]
        }),
        PatchTransactionError,
        "PATCH_ABORTED"
      );
      assert.equal(
        await readFile(path.join(workspaceA, "api.js"), "utf8"),
        beforeA
      );
      assert.equal(
        await readFile(path.join(workspaceB, "consumer.js"), "utf8"),
        beforeB
      );
    });

    await t.test("moved workspace becomes unavailable without fallback", async () => {
      await registry.selectWorkspace(workspaceBId);
      await rename(workspaceB, movedWorkspaceB);

      const unavailable = await registry.getWorkspace(workspaceBId, {
        refreshAvailability: true
      });
      assert.equal(unavailable.availability, "unavailable");
      await expectCode(
        registry.getSelectedWorkspace(),
        WorkspaceRegistryError,
        "WORKSPACE_UNAVAILABLE"
      );
      await expectCode(
        registry.openWorkspace(workspaceBId),
        WorkspaceRegistryError,
        "WORKSPACE_UNAVAILABLE"
      );

      await expectCode(
        coordinator.apply({
          taskId: crossTask.id,
          taskToken: crossTask.task_token,
          operations: [{
            workspace_id: workspaceBId,
            op: "create",
            path: "must-not-fallback.txt",
            content: "for workspace B only\n"
          }]
        }),
        PatchTransactionError,
        "WORKSPACE_UNAVAILABLE"
      );
      assert.equal(
        await stat(path.join(workspaceA, "must-not-fallback.txt")).catch(() => null),
        null
      );
      assert.equal(
        await stat(path.join(movedWorkspaceB, "must-not-fallback.txt")).catch(() => null),
        null
      );
    });
  } finally {
    await router?.close().catch(() => {});
    await registry?.close().catch(() => {});
    await safeRemove(context.fixtureDir, context, {
      recursive: true,
      force: true
    }).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
    await safeRemove(context.dataDir, context, {
      recursive: true,
      force: true
    }).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
});
