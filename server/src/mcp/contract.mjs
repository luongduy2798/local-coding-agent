// Local Coding Agent model-visible MCP contract.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";

export const CATALOG_VERSION = 8;

export const MODEL_TOOL_NAMES = new Set([
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

export const CATALOG_HASH = createHash("sha256")
  .update([...MODEL_TOOL_NAMES].sort().join("\n"))
  .digest("hex")
  .slice(0, 16);

export const STORAGE_REQUIRED_TOOLS = new Set([
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
  "notes"
]);

export const TASK_CONTEXT_TOOLS = new Set([
  "workspace_attach",
  "workspace_detach",
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
  "notes"
]);

export const TASK_ACTIVITY_TOOLS = new Set([
  "workspace_attach",
  "workspace_detach",
  "task_reclassify",
  "task_plan",
  "task_checkpoint",
  "apply_patch",
  "git",
  "run_command",
  "run_commands",
  "process",
  "run_changed_tests",
  "verify_changes",
  "skills",
  "notes"
]);
