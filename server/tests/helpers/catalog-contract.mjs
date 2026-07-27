// Shared model-visible MCP catalog expectations for integration tests.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export const EXPECTED_CATALOG_VERSION = 8;
export const EXPECTED_TOOLS = Object.freeze([
  "lca_status",
  "workspace_list",
  "workspace_register",
  "workspace_select",
  "workspace_attach",
  "workspace_detach",
  "task_open",
  "task_reclassify",
  "task_state",
  "task_plan",
  "task_checkpoint",
  "task_close",
  "workspace_snapshot",
  "code_query",
  "search_text",
  "find_files",
  "list_files",
  "read_file",
  "read_many",
  "project_profile",
  "index_control",
  "apply_patch",
  "change_history",
  "git",
  "run_command",
  "run_commands",
  "process",
  "run_changed_tests",
  "verify_changes",
  "review_diff",
  "security_scan",
  "todo_scan",
  "skills",
  "notes",
  "figma",
  "lca_input"
]);
export const EXPECTED_TOOL_COUNT = EXPECTED_TOOLS.length;
export const MAX_TOOLS_LIST_BYTES = 35_000;
