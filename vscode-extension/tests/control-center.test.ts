import assert from "node:assert/strict";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as vscode from "vscode";
import type { HealthResponse } from "../src/api/api-types.js";
import { ConnectionManager } from "../src/connection/connection-manager.js";
import { ReviewChangesStore } from "../src/review-changes/review-changes-store.js";
import { filterAuditForRegisteredWorkspaces } from "../src/control-center/control-center-store.js";
import {
  buildWorkspaceTasks,
  ChronologicalTaskFeed,
  groupRepeatedActivities,
  isScrollNearBottom,
  taskActivitiesExpanded,
  taskIsDetached,
  visibleActivityVerification,
  visibleTaskObjective,
} from "../src/webview/control-center.js";

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
  assert.equal(
    visibleActivityVerification({ tool: "task_close", verification: "INCOMPLETE" }),
    null,
    "internal incomplete close evidence must not become a fourth user-facing task state",
  );
  assert.equal(
    visibleActivityVerification({ tool: "verify_changes", verification: "INCOMPLETE" }),
    "INCOMPLETE",
    "explicit verification results must remain visible",
  );
  assert.equal(
    visibleTaskObjective({ title: "Title only", objective: null }),
    null,
    "tasks without objective must not render an objective block",
  );
  assert.equal(
    visibleTaskObjective({ title: "Legacy duplicate", objective: "Legacy duplicate" }),
    null,
    "legacy title/objective duplicates must stay hidden",
  );
  assert.equal(
    visibleTaskObjective({
      title: "Visible objective",
      objective: "  Preserve the first line.\nPreserve the second line.  ",
    }),
    "Preserve the first line.\nPreserve the second line.",
    "multiline objectives must remain fully visible",
  );
  assert.equal(taskActivitiesExpanded("auto", true), true, "the latest task opens calls by default");
  assert.equal(taskActivitiesExpanded("auto", false), false, "older tasks collapse calls by default");
  assert.equal(taskActivitiesExpanded("collapsed", true), false, "users can collapse the latest task");
  assert.equal(taskActivitiesExpanded("expanded", false), true, "users can keep an older task expanded");

  const taskActivities = [
    {
      ...activity("newer", ["ws_cccccccccccccccc"]),
      taskId: "task_workspacefeed0001",
      startedAt: "2026-07-22T02:00:02.000Z",
      finishedAt: "2026-07-22T02:00:02.001Z",
    },
    {
      ...activity("other-workspace", ["ws_bbbbbbbbbbbbbbbb"]),
      taskId: "task_workspacefeed0001",
      startedAt: "2026-07-22T02:00:01.000Z",
      finishedAt: "2026-07-22T02:00:01.001Z",
    },
    {
      ...activity("older", ["ws_cccccccccccccccc"]),
      taskId: "task_workspacefeed0001",
      startedAt: "2026-07-22T02:00:00.000Z",
      finishedAt: "2026-07-22T02:00:00.001Z",
    },
  ];

  const workspaceTasks = buildWorkspaceTasks({
    tasks: [
      {
        id: "task_workspacefeed0002",
        title: "Newer workspace feed task",
        status: "open",
        primaryWorkspaceId: "ws_cccccccccccccccc",
        workspaceIds: ["ws_cccccccccccccccc"],
        createdAt: "2026-07-22T02:03:00.000Z",
        updatedAt: "2026-07-22T02:03:00.000Z",
        closedAt: null,
      },
      {
        id: "task_workspacefeed0001",
        title: "Older workspace feed task",
        status: "completed",
        primaryWorkspaceId: "ws_cccccccccccccccc",
        workspaceIds: ["ws_cccccccccccccccc"],
        createdAt: "2026-07-22T02:00:00.000Z",
        updatedAt: "2026-07-22T02:00:02.000Z",
        closedAt: "2026-07-22T02:00:03.000Z",
      },
      {
        id: "task_otherworkspace01",
        title: "Other workspace task",
        status: "open",
        primaryWorkspaceId: "ws_bbbbbbbbbbbbbbbb",
        workspaceIds: ["ws_bbbbbbbbbbbbbbbb"],
        createdAt: "2026-07-22T02:01:00.000Z",
        updatedAt: "2026-07-22T02:01:00.000Z",
        closedAt: null,
      },
    ],
    audit: { activities: taskActivities },
    processes: [],
  } as never, [
    {
      id: "change-current",
      workspace_id: "ws_cccccccccccccccc",
      task_id: "task_workspacefeed0001",
      files: [{ path: "src/current.ts" }],
    },
    {
      id: "change-other",
      workspace_id: "ws_bbbbbbbbbbbbbbbb",
      task_id: "task_workspacefeed0001",
      files: [{ path: "src/other.ts" }],
    },
  ], "ws_cccccccccccccccc");
  assert.deepEqual(
    workspaceTasks.map((item) => item.task.id),
    ["task_workspacefeed0001", "task_workspacefeed0002"],
    "task feed must render oldest above newest",
  );
  assert.deepEqual(
    workspaceTasks[0].activities.map((item) => item.invocationId),
    ["older", "newer"],
    "activity must stay chronological inside its task",
  );
  assert.deepEqual(workspaceTasks[0].changes.map((change) => change.id), ["change-current"]);
  assert.equal(workspaceTasks[0].elapsedMs, 3_000);
  assert.equal(workspaceTasks[0].activeToolTimeMs, 2);
  assert.equal(workspaceTasks[0].betweenCallsMs, 2_998);

  const renderTaskId = "task_renderfeed0001";
  const renderActivities = [
    { ...activity("render-open", ["ws_cccccccccccccccc"]), taskId: renderTaskId, tool: "task_open", startedAt: "2026-07-22T03:00:00.000Z", finishedAt: "2026-07-22T03:00:00.010Z" },
    { ...activity("render-plan", ["ws_cccccccccccccccc"]), taskId: renderTaskId, tool: "task_plan", startedAt: "2026-07-22T03:00:01.000Z", finishedAt: "2026-07-22T03:00:01.010Z" },
    { ...activity("render-read", ["ws_cccccccccccccccc"]), taskId: renderTaskId, tool: "read_many", startedAt: "2026-07-22T03:00:02.000Z", finishedAt: "2026-07-22T03:00:02.010Z" },
    {
      ...activity("render-running", ["ws_cccccccccccccccc"]),
      taskId: renderTaskId,
      tool: "search_text",
      status: "started" as const,
      ok: null,
      startedAt: "2026-07-22T03:00:03.000Z",
      finishedAt: null,
      durationMs: null,
    },
  ];
  const renderTasks = buildWorkspaceTasks({
    tasks: [{
      id: renderTaskId,
      title: "Rendered latest task",
      objective: "Keep the objective visible inside the task timeline.",
      requestedProfile: "normal",
      effectiveProfile: "normal",
      profileConfidence: 1,
      orchestration: null,
      status: "open",
      primaryWorkspaceId: "ws_cccccccccccccccc",
      workspaceIds: ["ws_cccccccccccccccc"],
      createdAt: "2026-07-22T03:00:00.000Z",
      updatedAt: "2026-07-22T03:00:03.000Z",
      closedAt: null,
    }],
    audit: { activities: renderActivities },
    processes: [],
  } as never, [], "ws_cccccccccccccccc");
  const renderedTaskFeed = renderToStaticMarkup(React.createElement(ChronologicalTaskFeed, {
    tasks: renderTasks,
    workspaceLabel: "local-coding-agent",
    workspaceId: "ws_cccccccccccccccc",
    onCloseDetachedTask: () => undefined,
    onDeleteTask: () => undefined,
    onDeleteAll: () => undefined,
    renderChanges: () => null,
  }));
  const timelineStart = renderedTaskFeed.indexOf("<ol class=\"tool-timeline task-tool-timeline\"");
  const objectiveIndex = renderedTaskFeed.indexOf("Agent objective");
  const firstToolIndex = renderedTaskFeed.indexOf("Open task");
  const timelineEnd = renderedTaskFeed.indexOf("</ol>", timelineStart);
  assert.ok(
    timelineStart >= 0 && objectiveIndex > timelineStart && firstToolIndex > objectiveIndex && timelineEnd > firstToolIndex,
    "the full objective must render as the first item inside the same tool timeline",
  );
  assert.match(renderedTaskFeed, /Show fewer calls/, "the latest task must expose its collapse control");
  assert.equal(
    renderedTaskFeed.match(/class=\"rotating-dots(?: rotating-dots-compact)?\s*\"/g)?.length,
    2,
    "running task and running tool rows must both render RotatingDots",
  );

  const tokenOnlyItem = {
    ...renderTasks[0],
    task: {
      ...renderTasks[0].task,
      sessionBound: false,
      detachedAt: null,
    },
  };
  assert.equal(taskIsDetached(tokenOnlyItem), false, "a token-only task without detach evidence must remain active");

  const continuedAfterDetachItem = {
    ...renderTasks[0],
    task: {
      ...renderTasks[0].task,
      sessionBound: false,
      detachedAt: "2026-07-22T03:00:01.500Z",
    },
  };
  assert.equal(taskIsDetached(continuedAfterDetachItem), false, "new tool activity must invalidate stale detach metadata");

  const detachedItem = {
    ...renderTasks[0],
    task: {
      ...renderTasks[0].task,
      sessionBound: false,
      detachedAt: "2026-07-22T03:00:04.000Z",
    },
  };
  assert.equal(taskIsDetached(detachedItem), true, "an open task without a session or activity after detach must be detached");
  const detachedTaskFeed = renderToStaticMarkup(React.createElement(ChronologicalTaskFeed, {
    tasks: [detachedItem],
    workspaceLabel: "local-coding-agent",
    workspaceId: "ws_cccccccccccccccc",
    onCloseDetachedTask: () => undefined,
    onDeleteTask: () => undefined,
    onDeleteAll: () => undefined,
    renderChanges: () => null,
  }));
  assert.match(detachedTaskFeed, />Detached</, "detached tasks must not appear as running");
  assert.match(detachedTaskFeed, /Close detached task Rendered latest task/, "detached tasks must expose a safe close action");
  assert.doesNotMatch(detachedTaskFeed, /Task running|rotating-dots/, "detached tasks and stale started calls must not render running indicators");
  assert.match(detachedTaskFeed, /Interrupted after/, "a stale started call must freeze as interrupted when its task detaches");

  const semanticActivities = [
    {
      ...activity("semantic-first", ["ws_cccccccccccccccc"]),
      tool: "run_command",
      purpose: "check_file_exists",
      purposeFingerprint: "purpose-export-zip",
      taskId: renderTaskId,
    },
    {
      ...activity("semantic-second", ["ws_cccccccccccccccc"]),
      tool: "run_command",
      purpose: "check_file_exists",
      purposeFingerprint: "purpose-export-zip",
      taskId: renderTaskId,
    },
    {
      ...activity("forensic-distinct", ["ws_cccccccccccccccc"]),
      tool: "run_command",
      purpose: "read_audit_timeline",
      purposeFingerprint: "purpose-audit-timeline",
      taskId: renderTaskId,
    },
  ];
  const semanticGroups = groupRepeatedActivities(semanticActivities as never);
  assert.equal(semanticGroups.length, 2, "only adjacent calls with the same semantic purpose should collapse");
  assert.equal(semanticGroups[0].repeatCount, 2);
  assert.equal(semanticGroups[1].repeatCount, 1, "distinct forensic purposes must remain separate");

  const blockedItem = {
    ...renderTasks[0],
    task: {
      ...renderTasks[0].task,
      orchestration: {
        run_state: "waiting_for_user" as const,
        blocker: {
          code: "missing_file",
          summary: "The uploaded ZIP is not available on the Macmini host.",
          evidence: ["/mnt/data/export.zip was not found."],
          required_action: "Copy it into the workspace and provide its local Mac path.",
        },
      },
    },
    activities: renderTasks[0].activities.map((entry) => ({
      ...entry,
      status: "finished" as const,
      ok: true,
      finishedAt: entry.finishedAt || entry.startedAt,
      durationMs: entry.durationMs || 1,
    })),
  };
  const blockedTaskFeed = renderToStaticMarkup(React.createElement(ChronologicalTaskFeed, {
    tasks: [blockedItem],
    workspaceLabel: "local-coding-agent",
    workspaceId: "ws_cccccccccccccccc",
    onCloseDetachedTask: () => undefined,
    onDeleteTask: () => undefined,
    onDeleteAll: () => undefined,
    renderChanges: () => null,
  }));
  assert.match(blockedTaskFeed, />Waiting for input</, "waiting tasks must replace the running badge");
  assert.match(blockedTaskFeed, /The uploaded ZIP is not available on the Macmini host/);
  assert.match(blockedTaskFeed, /Required:/);
  assert.match(blockedTaskFeed, /Copy it into the workspace/);
  assert.doesNotMatch(blockedTaskFeed, /Task running/, "blocked tasks must stop the task spinner");

  assert.equal(
    isScrollNearBottom({ scrollHeight: 1_000, scrollTop: 764, clientHeight: 200 }),
    true,
    "feed should auto-follow while the user remains near the bottom",
  );
  assert.equal(
    isScrollNearBottom({ scrollHeight: 1_000, scrollTop: 600, clientHeight: 200 }),
    false,
    "feed should stop following after the user scrolls into history",
  );

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
    toolClass: null,
    fingerprint: null,
    purpose: null,
    purposeFingerprint: null,
    orchestrationEvent: null,
    runState: null,
    duplicate: false,
    statusOnly: false,
    policySkip: false,
    cacheHit: false,
    evidenceDelta: false,
    orchestrationNoticeCode: null,
    orchestrationPhaseBefore: null,
    orchestrationPhaseAfter: null,
    effectiveProfile: null,
    evidenceStatus: null,
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
