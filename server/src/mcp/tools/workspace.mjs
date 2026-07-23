// Local Coding Agent MCP workspace and query tools
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { WorkspaceRegistryError } from "../../workspace/registry.mjs";
import { confirmTaskComplexity } from "../../workspace/task-orchestration.mjs";

export function registerWorkspaceTools(mcp, dependencies) {
  const {
    DEFAULT_RESPONSE_CHARS,
    REAL_ROOTS,
    boundedNumber,
    captureTaskWorkspaceBaseline,
    comparePath,
    currentMcpSessionId,
    decodePageCursor,
    dedupe,
    evictWorkspaceRuntime,
    fitJsonItems,
    invalidPageCursor,
    invalidateStatusControlCache,
    isWithinRoots,
    jsonResult,
    modelSafeGraphSnapshot,
    modelSafeSemanticAdapterStatus,
    modelSafeWatcherStatus,
    pageMetadata,
    pageScope,
    primaryWorkspaceId,
    reg,
    registry,
    sanitizeGraphSnapshot,
    selectWorkspace,
    storageError,
    taskOpenPayload,
    taskRouter
  } = dependencies;
  reg(
    mcp,
    "workspace_list",
    {
      title: "List workspaces",
      description: "List registered workspaces and their availability without silently falling back to another root.",
      inputSchema: {}
    },
    async () => {
      if (!registry) throw new Error(`Multi-workspace storage unavailable: ${storageError?.message || "unknown error"}`);
      const workspaces = await registry.listWorkspaces();
      const sessionId = currentMcpSessionId();
      let selected = await registry.getSelectedWorkspace({
        scope: sessionId ? `session:${sessionId}` : "default",
        fallback: false
      }).catch(() => null);
      if (!selected && sessionId) {
        selected = await registry.getSelectedWorkspace({
          scope: "default",
          fallback: false
        }).catch(() => null);
      }
      return jsonResult({
        count: workspaces.length,
        selected_workspace_id: selected?.workspace?.id || null,
        selected_workspace_scope: selected?.scope || null,
        workspaces: workspaces.map((workspace) => ({
          workspace_id: workspace.id,
          label: workspace.metadata?.label || path.basename(workspace.canonicalRoot),
          root: { workspace_id: workspace.id, path: "." },
          availability: workspace.availability,
          trusted: workspace.metadata?.trusted === true,
          git_repository: workspace.metadata?.git?.is_repository === true,
          git_identity: workspace.metadata?.git?.identity || null,
          last_selected_at: workspace.lastSelectedAt
        }))
      });
    }
  );

  reg(
    mcp,
    "workspace_register",
    {
      title: "Register workspace",
      description: "Register a root already trusted through CLI/config. Use `lca workspace use <path>` locally for a new root.",
      inputSchema: {
        root: z.string().min(1),
        label: z.string().max(120).optional()
      }
    },
    async ({ root, label }) => {
      if (!registry) throw new Error(`Multi-workspace storage unavailable: ${storageError?.message || "unknown error"}`);
      const canonicalRoot = await realpath(path.resolve(root)).catch(() => null);
      if (!canonicalRoot) {
        throw new WorkspaceRegistryError("WORKSPACE_UNAVAILABLE", `Workspace root is unavailable: ${root}`);
      }
      const existing = (await registry.listWorkspaces({ refreshAvailability: false }))
        .find((workspace) => comparePath(workspace.canonicalRoot) === comparePath(canonicalRoot));
      if (!existing && !isWithinRoots(canonicalRoot, REAL_ROOTS)) {
        throw new WorkspaceRegistryError(
          "WORKSPACE_TRUST_REQUIRED",
          "A new root must be explicitly trusted from the local CLI before the model can use it.",
          { guidance: "Run `lca workspace use <path>` locally, then call workspace_list." }
        );
      }
      const registered = await registry.registerWorkspace(root, {
        metadata: {
          label: label || path.basename(path.resolve(root)),
          trusted: existing?.metadata?.trusted === true || isWithinRoots(canonicalRoot, REAL_ROOTS),
          source: existing?.metadata?.source || "configured-root"
        }
      });
      invalidateStatusControlCache();
      return jsonResult({
        ok: true,
        created: registered.created,
        workspace: {
          workspace_id: registered.workspace.id,
          root: { workspace_id: registered.workspace.id, path: "." },
          availability: registered.workspace.availability,
          label: registered.workspace.metadata?.label,
          trusted: registered.workspace.metadata?.trusted === true,
          git_repository: registered.workspace.metadata?.git?.is_repository === true,
          git_identity: registered.workspace.metadata?.git?.identity || null
        }
      });
    }
  );

  reg(
    mcp,
    "workspace_select",
    {
      title: "Select workspace",
      description: "Select the default workspace for the next task in this MCP session; active tasks are unchanged.",
      inputSchema: { workspace_id: z.string().min(1) }
    },
    async ({ workspace_id }) => {
      if (!registry) throw new Error(`Multi-workspace storage unavailable: ${storageError?.message || "unknown error"}`);
      const sessionId = currentMcpSessionId();
      const selection = await registry.selectWorkspace(workspace_id, {
        scope: sessionId ? `session:${sessionId}` : "default",
        fallback: false
      });
      invalidateStatusControlCache();
      return jsonResult({
        ok: true,
        workspace_id: selection.workspace.id,
        root: { workspace_id: selection.workspace.id, path: "." },
        scope: selection.scope
      });
    }
  );

  reg(
    mcp,
    "task_open",
    {
      title: "Open task",
      description: "Open or resume a task. Provide a concise objective and a model-selected complexity_hint; title is only a short UI label. LCA may report advisory scope signals but does not change the effective profile automatically.",
      inputSchema: {
        objective: z.string().max(4000).optional().describe("Concise task objective preserving the user's requested behavior and constraints; do not include unrelated conversation text."),
        title: z.string().max(180).optional().describe("Optional short UI label. Defaults from objective when omitted."),
        complexity_hint: z.enum(["quick_edit", "normal", "complex"]).optional().describe("Model-selected effective complexity. Defaults to normal when omitted."),
        complexity_override: z.boolean().optional().describe("Compatibility field; LCA no longer changes the effective profile automatically."),
        primary_workspace_id: z.string().optional(),
        attached_workspace_ids: z.array(z.string()).max(8).optional(),
        task_token: z.string().optional().describe("Resume an existing task after reconnect.")
      }
    },
    async ({ objective, title, complexity_hint, complexity_override = false, primary_workspace_id, attached_workspace_ids = [], task_token }) => {
      if (!taskRouter || !registry) {
        throw new Error(`Multi-workspace task storage unavailable: ${storageError?.message || "unknown error"}`);
      }
      const sessionId = currentMcpSessionId();
      if (task_token) {
        const resumed = await taskRouter.resumeTask({ taskToken: task_token, sessionId });
        return jsonResult({ ok: true, resumed: true, task: await taskOpenPayload(resumed) });
      }
      let primaryId = primary_workspace_id;
      if (!primaryId) {
        let selected = await registry.getSelectedWorkspace({
          scope: sessionId ? `session:${sessionId}` : "default",
          fallback: false
        }).catch(() => null);
        if (!selected && sessionId) {
          selected = await registry.getSelectedWorkspace({
            scope: "default",
            fallback: false
          }).catch(() => null);
        }
        primaryId = selected?.workspace?.id || primaryWorkspaceId;
      }
      const workspaceIds = dedupe([primaryId, ...attached_workspace_ids]);
      const workspaceBaselines = [];
      for (const workspaceId of workspaceIds) {
        const workspace = await registry.getWorkspace(workspaceId);
        if (workspace.availability !== "available") throw new Error(`Workspace is unavailable: ${workspaceId}`);
        if (workspace.metadata?.trusted !== true) throw new Error(`Workspace is not explicitly trusted: ${workspaceId}`);
        workspaceBaselines.push(await captureTaskWorkspaceBaseline(workspaceId));
      }
      const task = await taskRouter.openTask({
        title: title || objective || "LCA task",
        objective,
        complexityHint: complexity_hint,
        complexityOverride: complexity_override,
        primaryWorkspaceId: primaryId,
        attachedWorkspaceIds: workspaceIds.slice(1),
        ownerSessionId: sessionId,
        workspaceBaselines
      });
      return jsonResult({ ok: true, resumed: false, task: await taskOpenPayload(task) });
    }
  );

  reg(
    mcp,
    "task_reclassify",
    {
      title: "Reclassify task",
      description: "Confirm a new effective task profile after the model evaluates LCA's advisory scope signals. LCA never calls this decision automatically.",
      inputSchema: {
        task_token: z.string().min(1),
        complexity: z.enum(["quick_edit", "normal", "complex"]),
        reason: z.string().min(1).max(1000).describe("Model rationale for changing or reaffirming the effective profile.")
      }
    },
    async ({ task_token, complexity, reason }) => {
      if (!taskRouter) throw new Error("Task storage unavailable.");
      const current = await taskRouter.getTask({
        taskToken: task_token,
        sessionId: currentMcpSessionId(),
        required: true
      });
      const orchestration = confirmTaskComplexity(current.orchestration, complexity, reason);
      const updated = await taskRouter.updateOrchestration({
        taskId: current.id,
        orchestration,
        effectiveProfile: complexity,
        profileConfidence: current.profile_confidence
      });
      return jsonResult({
        ok: true,
        previous_profile: current.effective_profile,
        effective_profile: updated.effective_profile,
        task: await taskOpenPayload(updated)
      });
    }
  );

  reg(
    mcp,
    "workspace_attach",
    {
      title: "Attach workspace",
      description: "Attach an explicitly trusted secondary workspace before the task's first mutation.",
      inputSchema: {
        task_token: z.string().min(1),
        workspace_id: z.string().min(1)
      }
    },
    async ({ task_token, workspace_id }) => {
      if (!taskRouter || !registry) throw new Error("Multi-workspace task storage unavailable.");
      const workspace = await registry.getWorkspace(workspace_id);
      if (workspace.availability !== "available" || workspace.metadata?.trusted !== true) {
        throw new Error(`Workspace must be available and explicitly trusted: ${workspace_id}`);
      }
      const baseline = await captureTaskWorkspaceBaseline(workspace_id);
      return jsonResult({
        ok: true,
        task: await taskRouter.attachWorkspace({
          taskToken: task_token,
          workspaceId: workspace_id,
          baseline
        })
      });
    }
  );

  reg(
    mcp,
    "workspace_detach",
    {
      title: "Detach workspace",
      description: "Detach a secondary workspace before the task's first mutation.",
      inputSchema: {
        task_token: z.string().min(1),
        workspace_id: z.string().min(1)
      }
    },
    async ({ task_token, workspace_id }) =>
      jsonResult({ ok: true, task: await taskRouter.detachWorkspace({ taskToken: task_token, workspaceId: workspace_id }) })
  );

  reg(
    mcp,
    "code_query",
    {
      title: "Code query",
      description: "Query text, symbols, definitions, references, imports, callers, callees or types with fast-first semantic fallback metadata.",
      inputSchema: {
        query: z.string().min(1),
        mode: z.enum(["text", "symbol", "definition", "references", "imports", "callers", "callees", "type"]).optional(),
        depth: z.enum(["fast", "auto", "semantic"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().max(2048).optional(),
        case_sensitive: z.boolean().optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        refresh: z.boolean().optional()
      }
    },
    async ({ workspace_id, task_token, cursor, ...query }) => {
      const selected = await selectWorkspace({ workspaceId: workspace_id, taskToken: task_token });
      const pageLimit = boundedNumber(query.limit, 50, 1, 500);
      const scope = pageScope("code_query", {
        workspace_id: selected.workspace.id,
        query: query.query,
        mode: query.mode || "text",
        depth: query.depth || "auto",
        case_sensitive: Boolean(query.case_sensitive),
        refresh: Boolean(query.refresh)
      });
      const offset = decodePageCursor(cursor, { kind: "code_query", scope });
      if (offset >= 500) throw invalidPageCursor();
      const windowLimit = Math.min(500, offset + pageLimit + 1);
      const result = await selected.runtime.query.query({ ...query, limit: windowLimit });
      const page = result.results.slice(offset, offset + pageLimit);
      const fitted = fitJsonItems(page, DEFAULT_RESPONSE_CHARS - 8_192);
      const beyondWindow = result.completeness?.result_truncated === true;
      const windowExhausted = offset + fitted.items.length >= 500 && beyondWindow;
      const hasMore = !windowExhausted && (
        result.results.length > offset + fitted.items.length ||
        fitted.truncated ||
        beyondWindow
      );
      return jsonResult({
        ...result,
        count: fitted.items.length,
        results: fitted.items,
        pagination: pageMetadata({
          kind: "code_query",
          scope,
          offset,
          limit: pageLimit,
          returned: fitted.items.length,
          hasMore,
          windowExhausted
        })
      });
    }
  );

  reg(
    mcp,
    "index_control",
    {
      title: "Index control",
      description: "Inspect, refresh, rebuild or evict a workspace's lightweight code graph.",
      inputSchema: {
        action: z.enum(["status", "refresh", "rebuild", "evict"]).optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        max_files: z.number().int().min(100).max(250000).optional(),
        max_depth: z.number().int().min(1).max(64).optional(),
        max_file_bytes: z.number().int().min(8192).max(4194304).optional()
      }
    },
    async ({ action = "status", workspace_id, task_token, max_files, max_depth, max_file_bytes }) => {
      const selected = await selectWorkspace({ workspaceId: workspace_id, taskToken: task_token });
      if (action === "evict") {
        await evictWorkspaceRuntime(selected.workspace.id);
        return jsonResult({ ok: true, workspace_id: selected.workspace.id, evicted: true });
      }
      if (action === "status") {
        return jsonResult({
          ...modelSafeGraphSnapshot(selected.runtime.graph),
          watcher: modelSafeWatcherStatus(selected.runtime.graph),
          semantic: modelSafeSemanticAdapterStatus(selected.runtime)
        });
      }
      const snapshot = await selected.runtime.graph.refresh({
        ...(max_files ? { maxFiles: max_files } : {}),
        ...(max_depth ? { maxDepth: max_depth } : {}),
        ...(max_file_bytes ? { maxFileBytes: max_file_bytes } : {}),
        replaceCoverage: action === "rebuild"
      });
      return jsonResult({ ok: true, action, ...sanitizeGraphSnapshot(snapshot) });
    }
  );
}
