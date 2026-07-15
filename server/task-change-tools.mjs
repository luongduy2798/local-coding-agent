// MCP tool registration for task-scoped change sets.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export function registerTaskChangeTools({ mcp, z, reg, resolvePath, manager, widgetUri }) {
  const cwdSchema = z.string().optional().describe("Git repository directory inside an allowed workspace root. Defaults to the primary root.");
  const taskIdSchema = z.string().min(1).describe("Task ID returned by task_begin.");
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };

  reg(
    mcp,
    "task_begin",
    {
      title: "Begin task change set",
      description: "When Task Mode is explicitly enabled, start a task-scoped change set immediately before the first workspace mutation. Do not use this tool for the default fast direct-edit flow. Pass every repository-relative path the task may change for a fast path-scoped snapshot; omit paths when the mutation scope is unknown to snapshot the full working tree. The real Git index is never changed.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      inputSchema: {
        title: z.string().min(1).describe("Short task title."),
        description: z.string().optional().describe("Optional task goal or implementation note."),
        paths: z.array(z.string().min(1)).max(500).optional().describe("Every repository-relative file or directory path the task may change. Include both source and destination for renames. Omit for commands or unknown mutation scope to snapshot the full repository."),
        cwd: cwdSchema
      },
      _meta: { ui: { visibility: ["model"] } }
    },
    async ({ title, description = "", paths, cwd = "." }) =>
      structuredResult(await manager.begin({ title, description, paths, cwd: resolvePath(cwd) }))
  );

  reg(
    mcp,
    "task_finish",
    {
      title: "Finish task change set",
      description: "Finish an active task after its edits are complete. Captures the after snapshot for the same scope, stores one forward patch, and returns only this task's changed files. Immediately call task_get with the returned task ID to render the widget.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        task_id: taskIdSchema,
        summary: z.string().optional().describe("Concise summary of the completed work."),
        cwd: cwdSchema
      },
      _meta: modelToolMeta("Finishing task…", "Task ready.")
    },
    async ({ task_id, summary = "", cwd = "." }) =>
      structuredResult(await manager.finish({ taskId: task_id, summary, cwd: resolvePath(cwd) }))
  );

  reg(
    mcp,
    "task_get",
    {
      title: "Get task",
      description: "Get the latest metadata for one task and render its task widget. Call this immediately after task_finish and whenever reopening an existing task.",
      annotations: readOnly,
      inputSchema: { task_id: taskIdSchema, cwd: cwdSchema },
      _meta: widgetMeta(widgetUri, "Loading task…", "Task loaded.", ["model", "app"])
    },
    async ({ task_id, cwd = "." }) =>
      widgetResult(await manager.get({ taskId: task_id, cwd: resolvePath(cwd) }))
  );

  reg(
    mcp,
    "task_list",
    {
      title: "List task change sets",
      description: "List recent task-scoped change sets for the current Git repository. Use only when the user asks for task history or the task ID is unknown.",
      annotations: readOnly,
      inputSchema: {
        cwd: cwdSchema,
        status: z.enum(["active", "applied", "undone", "abandoned"]).optional(),
        limit: z.number().int().min(1).max(100).optional()
      },
      _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true }
    },
    async ({ cwd = ".", status, limit = 20 }) =>
      structuredResult(await manager.list({ cwd: resolvePath(cwd), status, limit }))
  );

  reg(
    mcp,
    "task_diff",
    {
      title: "Task diff",
      description: "Return only the changes captured by one task by lazily reading its stored forward patch. The ChatGPT task widget calls this directly for View diff.",
      annotations: readOnly,
      inputSchema: {
        task_id: taskIdSchema,
        path: z.string().optional().describe("Optional repository-relative file path to filter."),
        mode: z.enum(["summary", "unified"]).optional(),
        max_chars: z.number().int().min(1000).max(1000000).optional(),
        offset: z.number().int().min(0).optional(),
        cwd: cwdSchema
      },
      _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true }
    },
    async ({ task_id, path, mode = "unified", max_chars = 300000, offset = 0, cwd = "." }) =>
      structuredResult(
        await manager.diff({
          taskId: task_id,
          path,
          mode,
          maxChars: max_chars,
          offset,
          cwd: resolvePath(cwd)
        })
      )
  );

  reg(
    mcp,
    "task_undo",
    {
      title: "Undo task",
      description: "Undo exactly one finished task by reverse-applying its stored forward patch. Call only after an explicit user/widget request. Fails without changing files when later edits overlap. After success or conflict, call task_get with the same task ID to render the latest widget state.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      inputSchema: { task_id: taskIdSchema, cwd: cwdSchema },
      _meta: modelToolMeta("Undoing task…", "Undo complete.")
    },
    async ({ task_id, cwd = "." }) =>
      widgetResult(await manager.undo({ taskId: task_id, cwd: resolvePath(cwd) }))
  );

  reg(
    mcp,
    "task_reapply",
    {
      title: "Reapply task",
      description: "Reapply exactly one previously undone task by applying its stored forward patch. Call only after an explicit user/widget request. Fails without changing files when current edits overlap. After success or conflict, call task_get with the same task ID to render the latest widget state.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      inputSchema: { task_id: taskIdSchema, cwd: cwdSchema },
      _meta: modelToolMeta("Reapplying task…", "Task reapplied.")
    },
    async ({ task_id, cwd = "." }) =>
      widgetResult(await manager.reapply({ taskId: task_id, cwd: resolvePath(cwd) }))
  );
}

function widgetMeta(widgetUri, invoking, invoked, visibility = ["model", "app"]) {
  return {
    ui: { resourceUri: widgetUri, visibility },
    "openai/outputTemplate": widgetUri,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked
  };
}

function modelToolMeta(invoking, invoked) {
  return {
    ui: { visibility: ["model"] },
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked
  };
}

function structuredResult(value) {
  return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
}

function widgetResult(result) {
  const task = result.task;
  const availableActions = task?.status === "applied"
    ? ["view_diff", "undo"]
    : task?.status === "undone"
      ? ["view_diff", "reapply"]
      : [];
  const payload = { ...result, availableActions };
  const text = result.ok === false
    ? `${result.error?.message || "Task operation failed."} Files were not overwritten.`
    : task
      ? `Task ${task.id} is ${task.status}. ${task.stats?.filesChanged || 0} files in this task change set.`
      : "Task state updated.";
  return { structuredContent: payload, content: [{ type: "text", text }] };
}
