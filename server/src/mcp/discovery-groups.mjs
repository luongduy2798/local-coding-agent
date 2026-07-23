// Local Coding Agent dynamic discovery groups.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export const DISCOVERY_GROUPS = Object.freeze({
  "task-mutation": Object.freeze([
    "workspace_list",
    "workspace_select",
    "task_open",
    "read_file",
    "apply_patch",
    "review_diff",
    "change_history",
    "task_checkpoint",
    "task_close"
  ]),
  "task-investigation": Object.freeze([
    "workspace_list",
    "workspace_select",
    "task_open",
    "task_reclassify",
    "workspace_snapshot",
    "project_profile",
    "index_control",
    "list_files",
    "find_files",
    "search_text",
    "code_query",
    "read_file",
    "read_many",
    "git",
    "todo_scan",
    "notes",
    "task_checkpoint",
    "task_close"
  ]),
  "task-planning": Object.freeze([
    "workspace_list",
    "workspace_select",
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
    "task_state",
    "notes",
    "task_checkpoint",
    "task_close"
  ]),
  "task-code-change": Object.freeze([
    "workspace_list",
    "workspace_select",
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
    "task_state",
    "skills",
    "notes",
    "task_checkpoint",
    "task_close"
  ]),
  "task-verification": Object.freeze([
    "workspace_list",
    "workspace_select",
    "task_open",
    "git",
    "review_diff",
    "run_changed_tests",
    "verify_changes",
    "security_scan",
    "run_command",
    "run_commands",
    "task_checkpoint",
    "task_close"
  ]),
  "task-process": Object.freeze([
    "workspace_list",
    "workspace_select",
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
    "index_control"
  ]),
  "change-management": Object.freeze([
    "workspace_list",
    "workspace_select",
    "task_open",
    "change_history",
    "review_diff",
    "git",
    "task_checkpoint",
    "task_close"
  ]),
  "figma-workflow": Object.freeze([
    "workspace_list",
    "workspace_select",
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

export function discoveryRoutingInstructions() {
  return [
    "This app connects ChatGPT to the Local Coding Agent running on the computer associated with this app. It supports task-scoped repository work with journaled changes, review, undo, and redo.",
    "DISCOVERY ROUTING: when tools for the currently selected Local Coding Agent app are loaded dynamically through api_tool.list_resources, use that app's resource path and choose exactly one initial exact query from the routing table below.",
    "File create/update/delete/rename with a known target: discovery-group:task-mutation.",
    "Repository inspection without modification: discovery-group:task-investigation.",
    "Planning without implementation: discovery-group:task-planning.",
    "Investigation followed by code changes: discovery-group:task-code-change.",
    "Explicit test/lint/typecheck/build/security verification: discovery-group:task-verification.",
    "Background process or development server work: discovery-group:task-process.",
    "Runtime or workspace operations: discovery-group:workspace-management.",
    "Undo, redo, or tracked change history: discovery-group:change-management.",
    "Figma-specific work: discovery-group:figma-workflow.",
    "Do not invent free-form discovery queries such as write, edit, code, or file. Do not call api_tool.list_resources for the selected Local Coding Agent app without a query. Do not fall back to the full catalog when an exact discovery group is missing. Stop and report the catalog configuration error instead.",
    "Load another group only when the requested scope genuinely changes. Load verification tools and run lint, tests, typecheck, build, security checks, audits, or formatting only when the user explicitly requests them."
  ].join("\n");
}
