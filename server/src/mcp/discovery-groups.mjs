// Local Coding Agent dynamic discovery groups.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export const DISCOVERY_GROUPS = Object.freeze({
  "task-mutation": Object.freeze([
    "workspace_list",
    "task_open",
    "read_file",
    "apply_patch",
    "review_diff",
    "change_history",
    "task_close"
  ]),
  "task-investigation": Object.freeze([
    "workspace_list",
    "task_open",
    "task_reclassify",
    "workspace_snapshot",
    "project_profile",
    "list_files",
    "find_files",
    "search_text",
    "code_query",
    "read_file",
    "read_many",
    "git",
    "todo_scan",
    "workspace_memory",
    "task_close"
  ]),
  "task-planning": Object.freeze([
    "workspace_list",
    "workspace_attach",
    "workspace_detach",
    "task_open",
    "task_reclassify",
    "workspace_snapshot",
    "project_profile",
    "find_files",
    "search_text",
    "code_query",
    "read_file",
    "read_many",
    "git",
    "todo_scan",
    "task_plan",
    "workspace_memory",
    "task_checkpoint",
    "task_close"
  ]),
  "task-code-change": Object.freeze([
    "workspace_list",
    "workspace_attach",
    "workspace_detach",
    "task_open",
    "task_reclassify",
    "workspace_snapshot",
    "project_profile",
    "find_files",
    "search_text",
    "code_query",
    "read_file",
    "read_many",
    "git",
    "apply_patch",
    "review_diff",
    "change_history",
    "task_plan",
    "skills",
    "workspace_memory",
    "task_checkpoint",
    "task_close"
  ]),
  "task-verification": Object.freeze([
    "workspace_list",
    "task_open",
    "git",
    "review_diff",
    "verify_changes",
    "security_scan",
    "task_close"
  ]),
  "task-process": Object.freeze([
    "workspace_list",
    "task_open",
    "project_profile",
    "run_command",
    "run_commands",
    "process",
    "task_checkpoint",
    "task_close"
  ]),
  "workspace-management": Object.freeze([
    "lca_status",
    "lca_input",
    "workspace_list",
    "workspace_register",
    "workspace_select",
    "workspace_attach",
    "workspace_detach",
    "task_open",
    "task_close",
    "index_control",
    "workspace_memory"
  ]),
  "change-management": Object.freeze([
    "workspace_list",
    "task_open",
    "change_history",
    "review_diff",
    "git",
    "task_close"
  ]),
  "figma-workflow": Object.freeze([
    "workspace_list",
    "task_open",
    "figma",
    "workspace_snapshot",
    "read_file",
    "read_many",
    "apply_patch",
    "review_diff",
    "task_checkpoint",
    "task_close"
  ])
});

const GROUPS_BY_TOOL = new Map();
for (const [group, tools] of Object.entries(DISCOVERY_GROUPS)) {
  for (const tool of tools) {
    const groups = GROUPS_BY_TOOL.get(tool) || [];
    groups.push(group);
    GROUPS_BY_TOOL.set(tool, groups);
  }
}

export function discoveryGroupsForTool(name) {
  return Object.freeze([...(GROUPS_BY_TOOL.get(name) || [])]);
}

export function withDiscoveryGroups(name, definition) {
  const groups = discoveryGroupsForTool(name);
  if (!groups.length) {
    throw new Error(`Tool ${name} is missing a discovery group.`);
  }
  const description = String(definition?.description || "").trim();
  const tags = groups.map((group) => `discovery-group:${group}`).join(", ");
  return {
    ...definition,
    description: `${description}${description ? " " : ""}Discovery groups: ${tags}.`
  };
}

export const CONNECTOR_APP_DESCRIPTION = "This app connects ChatGPT to the Local Coding Agent running on the computer associated with this app. It supports task-scoped repository inspection, code changes, journaled review, undo, redo, verification, persistent workspace memory, and local process execution.";

export const CONNECTOR_ENTRYPOINT_INSTRUCTIONS = "ENTRYPOINT: a bare `lca` or `call lca` request means `lca_status`. Use `lca_input` only when the user explicitly requests the widget, composer, PiP, `@` context, or `/` workflow.";

export const CONNECTOR_MEMORY_INSTRUCTIONS = "PERSISTENT MEMORY: new `task_open` calls default to `memory_mode=auto`. `quick_edit` receives light path-aware Memory with no semantic query or recent-task lookup; normal/complex tasks receive full bounded retrieval. Use `memory_mode=skip` only for fully mechanical work and `memory_mode=full` when complete durable context is required. Pass `relevant_paths` for known quick-edit targets. Request `include_recent_tasks=true` only for explicit continuation work; the workspace setting must also permit it. Do not call `workspace_memory` as a mandatory startup step when the returned brief is sufficient. Never store raw chat, private reasoning, prompts, credentials, secrets, environment values, command output, or copied file contents.";

export function discoveryRoutingInstructions() {
  return [
    CONNECTOR_APP_DESCRIPTION,
    CONNECTOR_ENTRYPOINT_INSTRUCTIONS,
    CONNECTOR_MEMORY_INSTRUCTIONS,
    "DISCOVERY ROUTING: when dynamically loading tools for this app, compose one exact query from the prefix `discovery-group:` plus exactly one routing label below. Full searchable tags are intentionally published only on matching tool descriptions so connector filtering does not select the whole catalog.",
    "task-mutation — known file create/update/delete/rename.",
    "task-investigation — read-only repository inspection.",
    "task-planning — planning without implementation.",
    "task-code-change — investigation followed by code changes.",
    "task-verification — explicit test/lint/typecheck/build/security verification.",
    "task-process — background process or development-server work.",
    "workspace-management — runtime, index, Memory, or workspace operations.",
    "change-management — undo, redo, or tracked change history.",
    "figma-workflow — Figma-specific work.",
    "Do not invent free-form discovery queries such as write, edit, code, or file. Do not call api_tool.list_resources for this app without a query. Do not fall back to the full catalog when a composed routing query is missing. Stop and report the catalog configuration error instead.",
    "Load another group only when the requested scope genuinely changes. Load verification tools and run lint, tests, typecheck, build, security checks, audits, or formatting only when the user explicitly requests them."
  ].join("\n");
}
