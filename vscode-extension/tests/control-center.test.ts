import assert from "node:assert/strict";
import path from "node:path";
import type { HealthResponse } from "../src/api/api-types.js";
import {
  ALL_AVAILABLE_WORKSPACES_KEY,
  ConnectionManager,
  type WorkspaceFolderChoice,
} from "../src/connection/connection-manager.js";
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
  const context = {
    workspaceState: {
      get: () => undefined,
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
    ["All available workspaces", "lzz", "cac", "local-coding-agent"],
  );
  assert.equal(choices[0].key, ALL_AVAILABLE_WORKSPACES_KEY);
  assert.equal(choices[0].workspaceId, "all");
  assert.equal(choices.some((choice) => choice.registrationState === "archived"), false);
  await manager.selectWorkspaceFolder(`workspace:${health.workspaces?.[1].workspace_id}`);
  await manager.selectWorkspaceFolder(undefined);
  assert.equal(savedKeys.at(-1), ALL_AVAILABLE_WORKSPACES_KEY);
  assert.equal(manager.selectedReviewWorkspaceKey, ALL_AVAILABLE_WORKSPACES_KEY);

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
  const fakeConnection = {
    selectedReviewWorkspaceKey: ALL_AVAILABLE_WORKSPACES_KEY,
    serverUrl: "http://127.0.0.1:8789",
    check: async () => ({
      kind: "connected" as const,
      health,
      workspaceFolders: [],
    }),
    workspaceChoices: async () => choices,
    client: {
      listChanges: async () => ({
        revision: `revision-${++listCalls}`,
        workspaces: choices.slice(1).map((choice) => ({
          workspace_id: choice.workspaceId,
          label: choice.label,
          canonical_root: choice.root,
          revision: `workspace-${listCalls}`,
          changes: [],
        })),
      }),
      watchChangeEvents: async ({ signal }: { signal: AbortSignal }) => {
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
      () => store.current.syncMode === "polling" && store.current.workspaceOptions.length === 4,
      3_000,
    );
    assert.equal(store.current.selectedWorkspaceKey, ALL_AVAILABLE_WORKSPACES_KEY);
    assert.equal(store.current.workspaceOptions.length, 4);
    await waitFor(() => store.current.syncMode === "sse" && watchCalls >= 2, 8_000);
    assert.equal(store.current.syncMode, "sse");
    assert.ok(listCalls >= 5, "polling must refresh before attempting SSE again");
  } finally {
    store.dispose();
  }

  console.log("[PASS] Control Center preserves All and reconnects Polling to Live");
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
