// Shared model-visible MCP catalog expectations for integration tests.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export const EXPECTED_CATALOG_VERSION = 14;
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
  "workspace_memory",
  "figma",
  "lca_input"
]);
export const EXPECTED_TOOL_COUNT = EXPECTED_TOOLS.length;

// These are broad transport safety ceilings, not schema-minification targets.
// Catalog clarity and tool-selection correctness take precedence over staying
// close to the previous 35 KB measurement.
export const MAX_TOOLS_LIST_SAFETY_BYTES = 96_000;
export const MAX_COMPRESSED_TOOLS_LIST_SAFETY_BYTES = 24_000;

export const EXPECTED_MEMORY_ACTIONS = Object.freeze([
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
export const EXPECTED_TASK_CLOSE_MEMORY_ACTIONS = Object.freeze([
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
export const EXPECTED_MEMORY_KINDS = Object.freeze([
  "project_goal",
  "architecture_decision",
  "constraint",
  "known_issue",
  "open_question",
  "user_preference",
  "verification_result"
]);
export const EXPECTED_MEMORY_LIFECYCLES = Object.freeze([
  "active",
  "resolved",
  "superseded",
  "archived"
]);
export const EXPECTED_MEMORY_FRESHNESS = Object.freeze([
  "current",
  "needs_review",
  "stale"
]);
