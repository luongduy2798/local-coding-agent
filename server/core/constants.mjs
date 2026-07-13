// Local Coding Agent shared runtime constants.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export const VERSION = "5.0.0-pro";
export const PRODUCT_TIER = "pro";
export const COMPANION_WIDGET_URI = "ui://widget/lca-compact-input-v2.html";
export const DEFAULT_ACCESS_MODE = "full";
export const DEFAULT_POLICY = "full";
export const DEFAULT_WORKFLOW_MODE = "auto";
export const EXPLICIT_VERIFICATION_INSTRUCTION = "Run tests/build/lint only when explicitly requested.";

export const CODE_MUTATION_TOOLS = new Set([
  "write_file",
  "replace_in_file",
  "apply_patch",
  "move_path",
  "delete_path",
  "create_skill",
  "delete_skill",
  "undo_last_patch",
  "transaction_undo",
  "transaction_redo",
  "task_apply_to_main"
]);

// These tools may mutate source indirectly. The server compares workspace state
// before/after synchronous calls instead of falsely marking every command as a
// code change. Background sessions open the dashboard as activity immediately.
export const POTENTIAL_CODE_MUTATION_TOOLS = new Set([
  "run_command",
  "run_commands",
  "git",
  "quality_gate",
  "run_tests",
  "run_build",
  "run_lint",
  "run_changed_tests",
  "hook_run"
]);

export const BACKGROUND_CODE_ACTIVITY_TOOLS = new Set([
  "proc_start",
  "exec_start",
  "exec_write"
]);

export function toolCanAffectCode(tool) {
  return CODE_MUTATION_TOOLS.has(tool) || POTENTIAL_CODE_MUTATION_TOOLS.has(tool) || BACKGROUND_CODE_ACTIVITY_TOOLS.has(tool);
}

const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp",
  ".cs", ".css", ".scss", ".sass", ".less",
  ".dart", ".ex", ".exs", ".go", ".graphql", ".gql",
  ".html", ".htm", ".java", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".jsonc", ".kt", ".kts", ".lua", ".m", ".mm",
  ".php", ".pl", ".pm", ".proto", ".py", ".pyi", ".rb",
  ".rs", ".sh", ".bash", ".zsh", ".fish", ".sql",
  ".svelte", ".swift", ".ts", ".tsx", ".vue", ".xml",
  ".yaml", ".yml", ".toml", ".gradle", ".ps1"
]);

const CODE_FILENAMES = new Set([
  "Dockerfile", "Makefile", "CMakeLists.txt", "Podfile", "Gemfile",
  "package.json", "pubspec.yaml", "Cargo.toml", "go.mod", "pom.xml",
  "build.gradle", "settings.gradle", "Package.swift"
]);

export function isCodePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (!normalized) return false;
  const base = normalized.split("/").pop() || "";
  if (CODE_FILENAMES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : "";
  return CODE_EXTENSIONS.has(ext);
}

export function collectMutationPaths(tool, args = {}) {
  const paths = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim()) paths.add(value.trim());
  };
  add(args.path);
  add(args.from);
  add(args.to);
  add(args.rename_to);
  for (const op of Array.isArray(args.operations) ? args.operations : []) {
    add(op?.path);
    add(op?.rename_to);
  }
  if (typeof args.diff === "string") {
    for (const line of args.diff.split(/\r?\n/)) {
      if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
      const candidate = line.slice(4).replace(/^[ab]\//, "").trim();
      if (candidate && candidate !== "/dev/null") add(candidate);
    }
  }
  return [...paths];
}

export function mutationTouchesCode(tool, args = {}) {
  if (!CODE_MUTATION_TOOLS.has(tool)) return false;
  const paths = collectMutationPaths(tool, args);
  // Unknown paths (for undo/task apply) still represent code-affecting mutations.
  return paths.length === 0 || paths.some(isCodePath);
}
