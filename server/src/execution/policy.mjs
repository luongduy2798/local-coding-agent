// Local Coding Agent execution approval policy and workspace profile
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { TaskRouterError } from "../workspace/task-router.mjs";

let approvalLock = Promise.resolve();
let AGENT_POLICY;
let APPROVALS_DIR;
let APPROVAL_TTL_MINUTES;
let CATASTROPHIC;
let FIGMA_DESKTOP_READ_ONLY_TOOLS;
let GIT_READONLY;
let PRIMARY_ROOT;
let atomicWriteJson;
let auditIdentifier;
let currentMcpSessionId;
let currentTask;
let dedupe;
let detectTestCommands;
let getWorkspaceProfile;
let isoNow;
let log;
let setWorkspaceProfile;

export function configureExecutionPolicy(dependencies) {
  ({
    AGENT_POLICY,
    APPROVALS_DIR,
    APPROVAL_TTL_MINUTES,
    CATASTROPHIC,
    FIGMA_DESKTOP_READ_ONLY_TOOLS,
    GIT_READONLY,
    PRIMARY_ROOT,
    atomicWriteJson,
    auditIdentifier,
    currentMcpSessionId,
    currentTask,
    dedupe,
    detectTestCommands,
    getWorkspaceProfile,
    isoNow,
    log,
    setWorkspaceProfile
  } = dependencies);
}

const POLICY_RULES = {
  strict: {
    description: "Read and analyze only. No writes, installs, external network, deletes, process execution, verification commands, or git mutations. Read-only Figma Desktop loopback tools are allowed."
  },
  balanced: {
    description: "Read + edit allowed. Manual verification tools remain available only when explicitly requested. Delete, install, network commands need approval.",
    dangerous_patterns: [
      /\b(npm|pip|pip3|yarn|pnpm|cargo|apt|brew|gem|composer)\s+install\b/i,
      /\bcurl\b.*-[oO]/i,
      /\bwget\b/i,
      /\bgit\s+(push|fetch|pull|clone)\b/i,
      /\bdocker\s+(push|pull|run|build)\b/i
    ]
  },
  full: {
    description: "Full trusted-workspace access; root confinement and catastrophic-command blocks remain active."
  }
};

const STRICT_ALWAYS_BLOCKED_TOOLS = new Set([
  "apply_patch",
  "run_command",
  "run_commands",
  "run_changed_tests",
  "verify_changes",
  "task_plan",
  "task_checkpoint",
  "task_close"
]);

function applyPatchDeletePaths(args = {}) {
  const paths = [];
  for (const operation of Array.isArray(args.operations) ? args.operations : []) {
    if (operation?.op === "delete" && operation.path) paths.push(String(operation.path));
  }

  if (typeof args.diff === "string") {
    let previousPath = null;
    for (const line of args.diff.split(/\r?\n/)) {
      if (line.startsWith("--- ")) {
        previousPath = normalizePatchHeaderPath(line.slice(4));
      } else if (line.startsWith("+++ ")) {
        const nextPath = normalizePatchHeaderPath(line.slice(4));
        if (nextPath === "/dev/null" && previousPath && previousPath !== "/dev/null") paths.push(previousPath);
      }
    }
  }

  return dedupe(paths.map((value) => value.replace(/^a\//, "")).filter(Boolean)).sort();
}

function normalizePatchHeaderPath(value) {
  return String(value || "").trim().split("\t")[0];
}

function approvalActionForTool(tool, args) {
  if (tool === "figma" && (args?.action || "status") === "call") {
    const upstreamTool = String(args?.tool || "");
    if (upstreamTool && !FIGMA_DESKTOP_READ_ONLY_TOOLS.has(upstreamTool)) {
      return `figma:${upstreamTool}:${JSON.stringify(args.arguments || {})}`;
    }
  }
  if (tool === "skills" && args?.action === "delete") {
    return `skills:delete:${String(args.name || "")}`;
  }
  if (tool === "change_history" && ["undo", "reapply", "undo_all", "clear"].includes(args?.action)) {
    return `change_history:${args.action}:${JSON.stringify({ id: args.id || null, paths: args.paths || [] })}`;
  }
  if (tool === "run_command" || (tool === "process" && args?.action === "start")) {
    const command = String(args.command || "");
    return policyCheck(command).needsApproval ? `${tool}:${command}` : null;
  }
  if (tool === "run_commands") {
    const risky = (Array.isArray(args.commands) ? args.commands : [])
      .filter((item) => policyCheck(String(item?.command || "")).needsApproval)
      .map((item) => ({ command: String(item.command), cwd: String(item.cwd || "."), shell: item.shell || null }));
    return risky.length ? `run_commands:${JSON.stringify(risky)}` : null;
  }
  if (tool === "git") {
    const argv = Array.isArray(args.args) ? args.args : [];
    const sub = (argv.find((a) => !String(a).startsWith("-")) || "").toLowerCase();
    return GIT_READONLY.has(sub) || argv.some((a) => /^(--version|--help)$/i.test(String(a)))
      ? null
      : `git:${JSON.stringify(argv)}`;
  }
  if (tool === "apply_patch") {
    const deletePaths = applyPatchDeletePaths(args);
    if (deletePaths.length) return `apply_patch:delete:${JSON.stringify(deletePaths)}`;
  }
  return null;
}

function strictMutationRequested(tool, args = {}) {
  if (STRICT_ALWAYS_BLOCKED_TOOLS.has(tool)) return true;
  if (tool === "process") return ["start", "stop"].includes(args.action);
  if (tool === "skills") return ["create", "delete"].includes(args.action);
  if (tool === "notes") return (args.action || "list") === "save";
  if (tool === "change_history") {
    return ["undo", "reapply", "undo_all", "clear"].includes(args.action);
  }
  if (tool === "task_state") {
    return args.set_step_done !== undefined ||
      (Array.isArray(args.add_steps) && args.add_steps.length > 0) ||
      args.status !== undefined;
  }
  return false;
}

export async function enforceToolPolicy(tool, args) {
  if (AGENT_POLICY === "full") return;
  const action = approvalActionForTool(tool, args);
  if (AGENT_POLICY === "strict" && action) {
    throw new Error(`Tool "${tool}" action is blocked by policy=strict.`);
  }
  if (AGENT_POLICY === "strict" && strictMutationRequested(tool, args)) {
    throw new Error(`Tool "${tool}" is blocked by policy=strict.`);
  }
  if (AGENT_POLICY !== "balanced") return;
  if (!action) return;
  const previous = approvalLock;
  let release;
  approvalLock = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const scope = await currentApprovalScope(args);
    const approval = await checkApprovalExists(action, scope);
    if (!approval) {
      const pending = await ensurePendingApprovalRequest({
        actions: [action],
        action,
        reason: `Blocked ${tool} action awaiting local operator approval.`,
        scope
      });
      throw new TaskRouterError(
        "APPROVAL_REQUIRED",
        `Approval required for ${tool}. Run lca approval approve ${pending.id} or lca approval deny ${pending.id} locally.`,
        {
          request_id: pending.id,
          action,
          expires_at: pending.expires_at,
          approve_command: `lca approval approve ${pending.id}`,
          deny_command: `lca approval deny ${pending.id}`,
          task_id: scope.task_id
        }
      );
    }
    const consumed = new Set(Array.isArray(approval.consumed_actions) ? approval.consumed_actions : []);
    consumed.add(action);
    approval.consumed_actions = [...consumed];
    const actions = approvalActions(approval);
    if (actions.every((candidate) => consumed.has(candidate))) {
      approval.status = "consumed";
      approval.consumed_at = isoNow();
    }
    await atomicWriteJson(path.join(APPROVALS_DIR, `${approval.id}.json`), approval);
  } finally {
    release();
  }
}

function approvalActions(record) {
  if (Array.isArray(record?.actions)) return record.actions.map(String);
  return record?.action ? [String(record.action)] : [];
}

function approvalIsExpired(record) {
  return Boolean(record?.expires_at && Date.parse(record.expires_at) <= Date.now());
}

async function currentApprovalScope(args = {}) {
  const sessionId = currentMcpSessionId();
  const task = await currentTask({ taskToken: args?.task_token, required: false });
  return {
    task_id: task?.id || null,
    workspace_set_version: task?.version || null,
    workspace_ids: [...(task?.workspace_ids || [])].sort(),
    session_id_hash: auditIdentifier(sessionId)
  };
}

function approvalScopeMatches(record, scope) {
  if (!record || !scope) return false;
  return (record.task_id || null) === (scope.task_id || null) &&
    (record.session_id_hash || null) === (scope.session_id_hash || null) &&
    JSON.stringify([...(record.workspace_ids || [])].sort()) === JSON.stringify(scope.workspace_ids || []);
}

async function ensurePendingApprovalRequest({
  actions,
  action,
  reason,
  scope,
  expiresInMinutes = APPROVAL_TTL_MINUTES
}) {
  const exactActions = dedupe((actions || []).map((value) => String(value).trim()).filter(Boolean));
  if (!exactActions.length) throw new Error("At least one exact approval action is required.");
  try {
    const files = await readdir(APPROVALS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const record = JSON.parse(await readFile(path.join(APPROVALS_DIR, file), "utf8"));
      if (
        record.status === "pending" &&
        !approvalIsExpired(record) &&
        approvalScopeMatches(record, scope) &&
        JSON.stringify(approvalActions(record)) === JSON.stringify(exactActions)
      ) return record;
    }
  } catch { /* approval directory may not exist or contain a partial stale record */ }

  const id = randomUUID();
  const record = {
    id,
    action: action || (exactActions.length === 1 ? exactActions[0] : `batch:${exactActions.length}`),
    actions: exactActions,
    consumed_actions: [],
    reason: String(reason || "Local operator approval required.").slice(0, 2_000),
    status: "pending",
    created: isoNow(),
    expires_at: new Date(Date.now() + expiresInMinutes * 60_000).toISOString(),
    task_id: scope.task_id,
    workspace_set_version: scope.workspace_set_version,
    workspace_ids: scope.workspace_ids,
    session_id_hash: scope.session_id_hash
  };
  await atomicWriteJson(path.join(APPROVALS_DIR, `${id}.json`), record);
  return record;
}

function classifyAction(action) {
  const patterns = {
    install: /\b(npm|pip|pip3|yarn|pnpm|cargo|apt|brew|gem|composer)\s+install\b/i,
    network: /\b(curl|wget|fetch|git\s+push|git\s+fetch|git\s+pull|git\s+clone)\b/i,
    delete: /\b(apply_patch:delete|rm\s+-rf|remove-item)\b/i,
    git_mutation: /\bgit\s+(push|reset|clean|restore|checkout)\b/i,
    catastrophic: CATASTROPHIC
  };

  for (const [kind, pat] of Object.entries(patterns)) {
    if (Array.isArray(pat)) {
      if (pat.some((p) => p.test(action))) return kind;
    } else if (pat.test(action)) {
      return kind;
    }
  }
  return "general";
}

function policyCheck(action) {
  const rules = POLICY_RULES[AGENT_POLICY];
  const kind = classifyAction(action);

  if (AGENT_POLICY === "strict") {
    if (kind !== "general") {
      throw new Error(`Action blocked by policy=strict: "${kind}" operations are not allowed. Use lca_status to inspect the active policy.`);
    }
  }

  if (AGENT_POLICY === "balanced") {
    const dangerous = rules.dangerous_patterns || [];
    if (dangerous.some((p) => p.test(action))) {
      // Check if there's a valid approval
      return { needsApproval: true, kind };
    }
    if (kind === "delete" || kind === "git_mutation") {
      return { needsApproval: true, kind };
    }
  }

  return { needsApproval: false, kind };
}

async function checkApprovalExists(action, scope) {
  try {
    const files = await readdir(APPROVALS_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await readFile(path.join(APPROVALS_DIR, f), "utf8"));
        if (rec.status !== "approved") continue;
        if (!approvalScopeMatches(rec, scope)) continue;
        if (approvalIsExpired(rec)) {
          rec.status = "expired";
          rec.expired_at = isoNow();
          await atomicWriteJson(path.join(APPROVALS_DIR, f), rec);
          continue;
        }
        const consumed = new Set(Array.isArray(rec.consumed_actions) ? rec.consumed_actions : []);
        if (approvalActions(rec).includes(action) && !consumed.has(action)) return rec;
      } catch { /* skip */ }
    }
  } catch { /* dir may not exist */ }
  return null;
}


// Workspace profile overrides for explicit verification commands.

export async function loadWorkspaceProfile() {
  const profilePath = path.join(PRIMARY_ROOT, ".agent", "profile.json");
  try {
    const raw = await readFile(profilePath, "utf8");
    setWorkspaceProfile(JSON.parse(raw));
    log(`Loaded workspace profile from ${profilePath}`);
  } catch {
    setWorkspaceProfile(null);
  }
}


// Helper for explicit manual verification tools: get test commands merging profile overrides.
export async function getTestCommandsMerged(rootDir) {
  const detected = await detectTestCommands(rootDir);
  const workspaceProfile = getWorkspaceProfile();
  if (workspaceProfile?.testCommands) {
    return { ...detected, ...workspaceProfile.testCommands };
  }
  return detected;
}
