import assert from "node:assert/strict";
import path from "node:path";
import * as vscode from "vscode";
import type { HealthResponse } from "../src/api/api-types.js";
import { ConnectionManager } from "../src/connection/connection-manager.js";
import { ReviewChangesStore } from "../src/review-changes/review-changes-store.js";
import { filterAuditForRegisteredWorkspaces } from "../src/control-center/control-center-store.js";

const roots = {
  lzz: path.resolve("fixtures", "lzz"),
  cac: path.resolve("fixtures", "cac"),
  agent: path.resolve("fixtures", "local-coding-agent"),
};
const health = {
  status: "ok",
  version: "5.0.0-pro",
  workspace: roots.lzz,
  workspace_id: "ws_aaaaaaaaaaaaaaaa",
  change_events_endpoint: "/changes/events",
  workspaces: [
    descriptor("ws_aaaaaaaaaaaaaaaa", "lzz", roots.lzz),
    descriptor("ws_bbbbbbbbbbbbbbbb", "cac", roots.cac),
    descriptor("ws_cccccccccccccccc", "local-coding-agent", roots.agent),
    {
      ...descriptor("ws_dddddddddddddddd", "archived", path.resolve("fixtures", "archived")),
      registration_state: "archived" as const,
    },
  ],
} as HealthResponse;

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const savedKeys: unknown[] = [];
  const currentFolder = {
    name: "local-coding-agent",
    uri: {
      fsPath: roots.agent,
      toString: () => `file://${roots.agent}`,
    },
  };
  (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [currentFolder];
  const context = {
    workspaceState: {
      get: () => "__all_available_workspaces__",
      update: async (_key: string, value: unknown) => { savedKeys.push(value); },
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
  };
  const manager = new ConnectionManager(context as never);
  const choices = await manager.workspaceChoices(health);
  assert.deepEqual(
    choices.map((choice) => choice.label),
    ["local-coding-agent", "lzz", "cac"],
  );
  assert.equal(choices[0].workspaceId, "ws_cccccccccccccccc");
  assert.equal(choices[0].opened, true);
  assert.equal(choices.some((choice) => choice.registrationState === "archived"), false);
  assert.equal(manager.selectedReviewWorkspaceKey, undefined);
  await manager.selectWorkspaceFolder(choices[1].key);
  assert.equal(savedKeys.at(-1), choices[1].key);
  await manager.selectWorkspaceFolder(undefined);
  assert.equal(savedKeys.at(-1), undefined);
  assert.equal(manager.selectedReviewWorkspaceKey, undefined);

  const unregisteredFolder = {
    name: "new-repo",
    uri: {
      fsPath: path.resolve("fixtures", "new-repo"),
      toString: () => `file://${path.resolve("fixtures", "new-repo")}`,
    },
  };
  (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
    unregisteredFolder,
  ];
  const unregisteredChoices = await manager.workspaceChoices(health);
  assert.equal(unregisteredChoices[0].label, "new-repo");
  assert.equal(unregisteredChoices[0].registered, false);
  assert.deepEqual(
    unregisteredChoices.slice(1).map((choice) => choice.label),
    ["lzz", "cac", "local-coding-agent"],
  );
  let unregisteredRequests = 0;
  const unregisteredStore = new ReviewChangesStore({
    selectedReviewWorkspaceKey: undefined,
    serverUrl: "http://127.0.0.1:8789",
    selectWorkspaceFolder: async () => undefined,
    check: async () => ({
      kind: "connected" as const,
      health,
      workspaceFolder: unregisteredFolder,
      workspaceFolders: [unregisteredFolder],
    }),
    workspaceChoices: async () => unregisteredChoices,
    client: {
      listChanges: async () => {
        unregisteredRequests++;
        throw new Error("Unregistered workspace must not load aggregate changes.");
      },
      watchChangeEvents: async () => {
        unregisteredRequests++;
        return "ended" as const;
      },
    },
  } as never);
  try {
    unregisteredStore.setVisible(true);
    await waitFor(
      () => !unregisteredStore.current.loading &&
        unregisteredStore.current.workspaceOptions.length === 4,
      3_000,
    );
    assert.equal(unregisteredStore.current.selectedWorkspaceKey, unregisteredChoices[0].key);
    assert.equal(unregisteredStore.current.syncMode, "idle");
    assert.equal(unregisteredRequests, 0);
  } finally {
    unregisteredStore.dispose();
  }
  (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [currentFolder];

  const filteredAudit = filterAuditForRegisteredWorkspaces({
    available: true,
    enabled: true,
    currentRuntimeId: "runtime-test",
    activities: [
      activity("kept", ["ws_aaaaaaaaaaaaaaaa"]),
      activity("removed", ["ws_removed12345678"]),
      activity("global", []),
    ],
  }, [{ id: "ws_aaaaaaaaaaaaaaaa" }]);
  assert.deepEqual(filteredAudit.activities.map((activity) => activity.invocationId), ["kept", "global"]);

  let watchCalls = 0;
  let listCalls = 0;
  const selectedKeys: Array<string | undefined> = [];
  const requestedWorkspaceIds: Array<string | undefined> = [];
  const fakeConnection = {
    selectedReviewWorkspaceKey: undefined,
    serverUrl: "http://127.0.0.1:8789",
    selectWorkspaceFolder: async (key: string | undefined) => { selectedKeys.push(key); },
    check: async () => ({
      kind: "connected" as const,
      health,
      workspaceFolder: currentFolder,
      workspaceFolders: [currentFolder],
    }),
    workspaceChoices: async () => choices,
    client: {
      listChanges: async (_limit: number, scope: { workspaceId?: string }) => {
        requestedWorkspaceIds.push(scope.workspaceId);
        return {
          revision: `revision-${++listCalls}`,
          workspace_id: scope.workspaceId,
          workspaces: choices.map((choice) => ({
            workspace_id: choice.workspaceId,
            label: choice.label,
            canonical_root: choice.root,
            revision: `workspace-${listCalls}`,
            changes: [],
          })),
        };
      },
      watchChangeEvents: async ({
        signal,
        scope,
      }: {
        signal: AbortSignal;
        scope: { workspaceId?: string };
      }) => {
        requestedWorkspaceIds.push(scope.workspaceId);
        watchCalls++;
        if (watchCalls === 1) return "unsupported" as const;
        return new Promise<"ended">((resolve) => {
          if (signal.aborted) resolve("ended");
          else signal.addEventListener("abort", () => resolve("ended"), { once: true });
        });
      },
    },
  };
  const store = new ReviewChangesStore(fakeConnection as never);
  try {
    store.setVisible(true);
    await waitFor(
      () => store.current.syncMode === "polling" && store.current.workspaceOptions.length === 3,
      3_000,
    );
    assert.equal(store.current.selectedWorkspaceKey, choices[0].key);
    assert.equal(store.current.workspaceOptions.length, 3);
    assert.equal(selectedKeys.at(-1), choices[0].key);
    assert.ok(requestedWorkspaceIds.every((workspaceId) => workspaceId === choices[0].workspaceId));
    await waitFor(() => store.current.syncMode === "sse" && watchCalls >= 2, 8_000);
    assert.equal(store.current.syncMode, "sse");
    assert.ok(listCalls >= 5, "polling must refresh before attempting SSE again");
  } finally {
    store.dispose();
  }

  console.log("[PASS] Control Center defaults to the current repo and reconnects Polling to Live");
}

function descriptor(workspaceId: string, label: string, root: string) {
  return {
    workspace_id: workspaceId,
    label,
    canonical_root: root,
    availability: "available" as const,
    available: true,
    registration_state: "active" as const,
    trusted: true,
  };
}

function activity(invocationId: string, workspaceIds: string[]) {
  return {
    invocationId,
    runtimeId: "runtime-test",
    tool: "lca_status",
    taskId: null,
    workspaceIds,
    status: "finished" as const,
    ok: true,
    startedAt: "2026-07-22T02:00:00.000Z",
    finishedAt: "2026-07-22T02:00:00.001Z",
    durationMs: 1,
    errorCode: null,
    verification: null,
    changeCount: null,
    fileCount: null,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Condition was not met within ${timeoutMs} ms`);
}
