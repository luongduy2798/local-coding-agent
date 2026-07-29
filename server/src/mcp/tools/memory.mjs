// Local Coding Agent persistent workspace memory MCP tool.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

export const MEMORY_ACTIONS = Object.freeze([
  "brief",
  "list",
  "search",
  "get",
  "save",
  "update",
  "supersede",
  "pin",
  "unpin",
  "resolve",
  "archive",
  "restore",
  "current",
  "stale",
  "delete",
  "settings"
]);

export const TASK_CLOSE_MEMORY_ACTIONS = Object.freeze([
  "save",
  "update",
  "supersede",
  "pin",
  "unpin",
  "resolve",
  "archive",
  "restore",
  "current",
  "stale"
]);

export const MEMORY_KINDS = Object.freeze([
  "project_goal",
  "architecture_decision",
  "constraint",
  "known_issue",
  "open_question",
  "user_preference",
  "verification_result"
]);

export const MEMORY_LIFECYCLES = Object.freeze([
  "active",
  "resolved",
  "superseded",
  "archived"
]);

export const MEMORY_FRESHNESS = Object.freeze([
  "current",
  "needs_review",
  "stale"
]);

const MEMORY_KIND_SCHEMA = z.enum(MEMORY_KINDS).describe(
  "Memory category: project_goal, architecture_decision, constraint, known_issue, open_question, user_preference, or verification_result. Defaults to architecture_decision when saving."
);
const MEMORY_LIFECYCLE_SCHEMA = z.enum(MEMORY_LIFECYCLES).describe(
  "Lifecycle state. active participates in normal retrieval; resolved, superseded, and archived remain durable history."
);
const MEMORY_FRESHNESS_SCHEMA = z.enum(MEMORY_FRESHNESS).describe(
  "Freshness state. current is trusted, needs_review may have been affected by code changes, and stale is retained only as advisory history."
);
const MEMORY_PATHS_SCHEMA = z.array(z.string().min(1).max(2_000)).max(32).describe(
  "Workspace-relative paths that provide provenance and allow apply_patch to update freshness when related code changes."
);
const MEMORY_TAGS_SCHEMA = z.array(z.string().min(1).max(48)).max(32).describe(
  "Short retrieval tags."
);
const TASK_CLOSE_MEMORY_PATHS_SCHEMA = z.array(z.string().min(1).max(2_000)).max(8).describe(
  "Up to eight workspace-relative provenance paths for compact task-close Memory."
);
const TASK_CLOSE_MEMORY_TAGS_SCHEMA = z.array(z.string().min(1).max(48)).max(8).describe(
  "Up to eight compact retrieval tags."
);
const MEMORY_REPLACEMENT_SCHEMA = z.object({
  kind: MEMORY_KIND_SCHEMA.optional(),
  title: z.string().min(1).max(180).describe("Title for the replacement memory item."),
  summary: z.string().min(1).max(2_000).describe("Durable project context for the replacement item."),
  lifecycle: MEMORY_LIFECYCLE_SCHEMA.optional(),
  freshness: MEMORY_FRESHNESS_SCHEMA.optional(),
  pinned: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  paths: MEMORY_PATHS_SCHEMA.optional(),
  tags: MEMORY_TAGS_SCHEMA.optional()
}).describe("New memory item created by supersede; title and summary are required.");
const TASK_CLOSE_MEMORY_REPLACEMENT_SCHEMA = z.object({
  kind: MEMORY_KIND_SCHEMA.optional(),
  title: z.string().min(1).max(180).describe("Compact replacement Memory title."),
  summary: z.string().min(1).max(800).describe("Compact durable replacement context."),
  lifecycle: MEMORY_LIFECYCLE_SCHEMA.optional(),
  freshness: MEMORY_FRESHNESS_SCHEMA.optional(),
  pinned: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  paths: TASK_CLOSE_MEMORY_PATHS_SCHEMA.optional(),
  tags: TASK_CLOSE_MEMORY_TAGS_SCHEMA.optional()
}).describe("Compact replacement item for task-close supersede.");

export const TASK_CLOSE_MEMORY_UPDATE_SCHEMA = z.object({
  action: z.enum(TASK_CLOSE_MEMORY_ACTIONS).optional().describe(
    "Operation to persist after task closure. Defaults to save. delete and settings are intentionally unavailable during task_close."
  ),
  id: z.string().min(1).max(180).optional().describe(
    "Existing memory ID. Required for update, supersede, pin, unpin, resolve, archive, restore, current, and stale."
  ),
  workspace_id: z.string().min(1).optional().describe(
    "Target attached workspace. Defaults to the task primary workspace."
  ),
  kind: MEMORY_KIND_SCHEMA.optional(),
  title: z.string().min(1).max(180).optional().describe(
    "Required with summary for save; optional changed title for update."
  ),
  summary: z.string().min(1).max(800).optional().describe(
    "Compact durable context for save/update. Never include routine edits, task logs, raw chat, private reasoning, commands, output, credentials, or copied file contents."
  ),
  lifecycle: MEMORY_LIFECYCLE_SCHEMA.optional(),
  freshness: MEMORY_FRESHNESS_SCHEMA.optional(),
  pinned: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional().describe("Confidence from 0 to 1."),
  paths: TASK_CLOSE_MEMORY_PATHS_SCHEMA.optional(),
  tags: TASK_CLOSE_MEMORY_TAGS_SCHEMA.optional(),
  expected_revision: z.number().int().min(1).optional().describe(
    "Required optimistic-concurrency revision for task-close update and supersede."
  ),
  replacement: TASK_CLOSE_MEMORY_REPLACEMENT_SCHEMA.optional().describe(
    "Required compact payload for supersede unless replacement fields are supplied at the top level."
  )
});

function memoryToolInputSchema() {
  return {
    action: z.enum(MEMORY_ACTIONS).optional().describe(
      "Action to perform. Defaults to brief. task_open already returns adaptive bounded Memory according to its task policy, so use brief only for explicit reinspection."
    ),
    id: z.string().min(1).max(180).optional().describe(
      "Existing memory ID. Required for get, update, supersede, transitions, and delete."
    ),
    workspace_id: z.string().min(1).optional().describe(
      "Target workspace attached to the active task. Defaults through task context."
    ),
    task_token: z.string().min(1).optional().describe(
      "Active task token, normally omitted while the current MCP session is bound to the task."
    ),
    query: z.string().min(1).max(500).optional().describe(
      "Text query required for search; matches memory title and summary."
    ),
    kind: MEMORY_KIND_SCHEMA.optional(),
    title: z.string().min(1).max(180).optional().describe(
      "Required with summary for save; optional changed title for update or top-level supersede replacement."
    ),
    summary: z.string().min(1).max(2_000).optional().describe(
      "Required with title for save. Store compact durable project context only; never raw chat, private reasoning, commands, output, credentials, or copied file contents."
    ),
    lifecycle: MEMORY_LIFECYCLE_SCHEMA.optional().describe(
      "Filter list/search or set lifecycle during save/update. Prefer transition actions for ordinary lifecycle changes."
    ),
    freshness: MEMORY_FRESHNESS_SCHEMA.optional().describe(
      "Filter list/search or set freshness during save/update. Prefer current/stale actions for ordinary freshness changes."
    ),
    pinned: z.boolean().optional().describe("Pin state for save/update."),
    origin: z.literal("model").optional().describe(
      "Optional model provenance marker. Omit in normal use; user and system provenance are reserved for trusted local UI/service paths."
    ),
    confidence: z.number().min(0).max(1).optional().describe("Confidence from 0 to 1."),
    paths: MEMORY_PATHS_SCHEMA.optional(),
    tags: MEMORY_TAGS_SCHEMA.optional(),
    expected_revision: z.number().int().min(1).optional().describe(
      "Optimistic-concurrency revision for update."
    ),
    replacement: MEMORY_REPLACEMENT_SCHEMA.optional().describe(
      "Replacement item for supersede. When omitted, top-level kind/title/summary/lifecycle/freshness/pinned/confidence/paths/tags are used."
    ),
    enabled: z.boolean().optional().describe("settings only: enable or disable workspace memory."),
    auto_load: z.boolean().optional().describe("settings only: permit adaptive bounded Memory in task_open; per-task skip/light/full policy still applies."),
    include_recent_tasks: z.boolean().optional().describe("settings only: permit up to three compact recent closed tasks when a task explicitly requests include_recent_tasks=true."),
    semantic_search: z.boolean().optional().describe("settings only: enable or disable optional local semantic retrieval for this workspace. Fallback lexical/path ranking always remains available."),
    limit: z.number().int().min(1).max(500).optional().describe("list/search page size; defaults to 100."),
    offset: z.number().int().min(0).max(100_000).optional().describe("list/search result offset; defaults to 0.")
  };
}

function argumentError(message) {
  const error = new Error(message);
  error.code = "WORKSPACE_MEMORY_ARGUMENT_REQUIRED";
  return error;
}

function validateMemoryActionArguments(action, args) {
  const idActions = new Set([
    "get",
    "update",
    "supersede",
    "pin",
    "unpin",
    "resolve",
    "archive",
    "restore",
    "current",
    "stale",
    "delete"
  ]);
  if (idActions.has(action) && !args.id) {
    throw argumentError(`workspace_memory action ${action} requires id.`);
  }
  if (action === "search" && !args.query) {
    throw argumentError("workspace_memory action search requires query.");
  }
  if (action === "save" && (!args.title || !args.summary)) {
    throw argumentError("workspace_memory action save requires title and summary.");
  }
  if (action === "supersede") {
    const replacement = args.replacement || args;
    if (!replacement.title || !replacement.summary) {
      throw argumentError("workspace_memory action supersede requires replacement title and summary.");
    }
  }
  if (action === "settings" && ![
    args.enabled,
    args.auto_load,
    args.include_recent_tasks,
    args.semantic_search
  ].some((value) => typeof value === "boolean")) {
    throw argumentError(
      "workspace_memory action settings requires enabled, auto_load, include_recent_tasks, or semantic_search."
    );
  }
}

export function registerMemoryTools(mcp, dependencies) {
  const { currentTask, jsonResult, memoryService, reg, selectWorkspace } = dependencies;
  reg(
    mcp,
    "workspace_memory",
    {
      title: "Remember workspace context",
      description: "Save, inspect and manage durable workspace knowledge needed by future tasks and ChatGPT conversations, including architecture decisions, constraints, project goals, preferences, known issues and verification results. Use task_checkpoint instead for progress needed only to resume the same active task. Memory is not raw chat, private reasoning, command output, credentials or copied file contents; task_open already supplies bounded adaptive skip/light/full Memory according to task policy.",
      inputSchema: memoryToolInputSchema()
    },
    async (args) => {
      if (!memoryService) throw new Error("Workspace memory storage is unavailable.");
      const action = args.action || "brief";
      validateMemoryActionArguments(action, args);
      const selected = await selectWorkspace({
        workspaceId: args.workspace_id,
        taskToken: args.task_token,
        requireTask: true
      });
      const task = await currentTask({ taskToken: args.task_token, required: true });
      const workspaceId = selected.workspace.id;
      const context = {
        taskId: task.id,
        sourceHead: task.workspaces?.find(
          (item) => item.workspace_id === workspaceId
        )?.baseline?.base_head || null,
        actor: "model"
      };
      if (action === "brief") {
        return jsonResult({
          workspace_id: workspaceId,
          workspace_memory: await memoryService.briefForTask(task)
        });
      }
      if (action === "list" || action === "search") {
        const items = await memoryService.list(workspaceId, {
          query: action === "search" ? args.query : undefined,
          kind: args.kind,
          lifecycle: args.lifecycle,
          freshness: args.freshness,
          limit: args.limit ?? 100,
          offset: args.offset ?? 0
        });
        return jsonResult({ workspace_id: workspaceId, count: items.length, items });
      }
      if (action === "get") {
        return jsonResult({
          workspace_id: workspaceId,
          item: await memoryService.get(workspaceId, args.id)
        });
      }
      if (action === "save") {
        return jsonResult({
          ok: true,
          workspace_id: workspaceId,
          item: await memoryService.save(workspaceId, args, context)
        });
      }
      if (action === "update") {
        return jsonResult({
          ok: true,
          workspace_id: workspaceId,
          item: await memoryService.update(workspaceId, args.id, args, context)
        });
      }
      if (action === "supersede") {
        return jsonResult({
          ok: true,
          workspace_id: workspaceId,
          item: await memoryService.supersede(
            workspaceId,
            args.id,
            args.replacement || args,
            context
          )
        });
      }
      if ([
        "pin",
        "unpin",
        "resolve",
        "archive",
        "restore",
        "current",
        "stale"
      ].includes(action)) {
        return jsonResult({
          ok: true,
          workspace_id: workspaceId,
          item: await memoryService.transition(workspaceId, args.id, action, context)
        });
      }
      if (action === "delete") {
        return jsonResult({
          workspace_id: workspaceId,
          ...(await memoryService.delete(workspaceId, args.id, context))
        });
      }
      if (action === "settings") {
        const settings = await memoryService.settings(workspaceId, args);
        return jsonResult({
          ok: true,
          workspace_id: workspaceId,
          settings: {
            revision: settings.revision,
            enabled: settings.enabled,
            auto_load: settings.auto_load,
            include_recent_tasks: settings.include_recent_tasks,
            semantic_search: settings.semantic_search,
            updated_at: settings.updated_at
          }
        });
      }
      throw new Error(`Unsupported workspace_memory action: ${action}`);
    }
  );
}
