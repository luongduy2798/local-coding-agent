// Local Coding Agent task-scoped workspace context and path safety
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChangeJournalError } from "../change-journal.mjs";
import { TaskRouterError } from "./task-router.mjs";
import { WorkspaceRegistryError } from "./registry.mjs";

let DATA_DIR;
let MCP_REQUEST_CONTEXT;
let PRIMARY_ROOT;
let REPOSITORY_DIR;
let ROOTS;
let RUNTIME_DATA_DIR;
let TEST_RUNTIME_DIAGNOSTICS;
let UNMANAGED_MANIFEST_LOCKS;
let UNMANAGED_WORKSPACE_CHANGES;
let atomicWriteJson;
let comparePath;
let dedupe;
let getWorkspaceRuntime;
let isoNow;
let primaryWorkspaceId;
let registry;
let storageError;
let taskRouter;
let workspaceMutationFingerprint;
export let REAL_ROOTS = [];

export function configureWorkspaceContext(dependencies) {
  ({
    DATA_DIR,
    MCP_REQUEST_CONTEXT,
    PRIMARY_ROOT,
    REPOSITORY_DIR,
    ROOTS,
    RUNTIME_DATA_DIR,
    TEST_RUNTIME_DIAGNOSTICS,
    UNMANAGED_MANIFEST_LOCKS,
    UNMANAGED_WORKSPACE_CHANGES,
    atomicWriteJson,
    comparePath,
    dedupe,
    getWorkspaceRuntime,
    isoNow,
    primaryWorkspaceId,
    registry,
    storageError,
    taskRouter,
    workspaceMutationFingerprint
  } = dependencies);
  REAL_ROOTS = ROOTS.map((root) => {
    try {
      return realpathSync(root);
    } catch {
      return path.resolve(root);
    }
  });
}

export function canonicalize(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return path.resolve(p);
}

export function resolvePath(input = ".") {
  const raw = String(input ?? ".").trim();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(PRIMARY_ROOT, raw);
  // Validate the canonical path. Besides blocking symlink/junction escapes,
  // this avoids false rejections on case-insensitive macOS volumes when the
  // caller uses different path casing than the filesystem stores.
  const canon = canonicalize(resolved);
  if (!isWithinRoots(canon, REAL_ROOTS)) {
    throw new Error(`Path is outside the allowed roots or resolves outside via a link: ${input}`);
  }
  return resolved;
}

export function currentMcpSessionId() {
  return MCP_REQUEST_CONTEXT.getStore()?.sessionId || null;
}

export async function currentTask({ taskToken, required = false } = {}) {
  if (!taskRouter) {
    if (required) throw new TaskRouterError("TASK_CONTEXT_REQUIRED", `Runtime task storage unavailable: ${storageError?.message || "unknown error"}`);
    return null;
  }
  return taskRouter.getTask({
    taskToken,
    sessionId: currentMcpSessionId(),
    required
  });
}

export async function freezeTaskForMutation(taskToken) {
  if (!taskRouter) return null;
  const current = await currentTask({ taskToken, required: false });
  if (!current) return null;
  return taskRouter.freezeWorkspaceSet({
    taskToken,
    sessionId: currentMcpSessionId()
  });
}

function unmanagedChangeKey(workspaceId, taskId) {
  return `${String(workspaceId || "unknown")}:${String(taskId || "unscoped")}`;
}

function unmanagedArtifactPath(taskId) {
  if (!taskId) return null;
  if (!/^task_[A-Za-z0-9_-]{8,160}$/.test(taskId)) {
    throw new TaskRouterError("INVALID_TASK_ID", `Invalid task ID: ${taskId}`);
  }
  return path.join(RUNTIME_DATA_DIR, "tasks", taskId, "unmanaged-changes.json");
}

async function readUnmanagedManifest(taskId) {
  const artifactPath = unmanagedArtifactPath(taskId);
  if (!artifactPath) return { version: 1, task_id: null, workspaces: {}, state_known: true };
  try {
    const parsed = JSON.parse(await readFile(artifactPath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.version !== 1 ||
      parsed.task_id !== taskId ||
      !parsed.workspaces ||
      typeof parsed.workspaces !== "object" ||
      Array.isArray(parsed.workspaces)
    ) {
      return {
        version: 1,
        task_id: taskId,
        workspaces: {},
        state_known: false,
        error_code: "UNMANAGED_STATE_CORRUPT"
      };
    }
    return { ...parsed, state_known: true };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: 1, task_id: taskId, workspaces: {}, state_known: true };
    }
    return {
      version: 1,
      task_id: taskId,
      workspaces: {},
      state_known: false,
      error_code: error instanceof SyntaxError ? "UNMANAGED_STATE_CORRUPT" : "UNMANAGED_STATE_READ_FAILED"
    };
  }
}

function assertUnmanagedManifestWritable(manifest) {
  if (manifest?.state_known === false) {
    throw new TaskRouterError(
      "UNMANAGED_STATE_UNKNOWN",
      "Unmanaged-change state is unreadable; repair or restore the task artifact before recording more mutations.",
      { cause: manifest.error_code || "UNMANAGED_STATE_UNKNOWN" }
    );
  }
}

async function withUnmanagedManifestLock(taskId, operation) {
  const key = String(taskId || "unscoped");
  const previous = UNMANAGED_MANIFEST_LOCKS.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  UNMANAGED_MANIFEST_LOCKS.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (UNMANAGED_MANIFEST_LOCKS.get(key) === current) UNMANAGED_MANIFEST_LOCKS.delete(key);
  }
}

export async function markUnmanagedChange({
  workspaceId,
  taskId,
  source,
  before,
  after,
  details
}) {
  const key = unmanagedChangeKey(workspaceId, taskId);
  if (!taskId) {
    UNMANAGED_WORKSPACE_CHANGES.add(key);
    return;
  }
  await withUnmanagedManifestLock(taskId, async () => {
    const manifest = await readUnmanagedManifest(taskId);
    assertUnmanagedManifestWritable(manifest);
    const current = manifest.workspaces?.[workspaceId] || { detected: true, events: [] };
    current.detected = true;
    current.adopted = false;
    current.updated_at = isoNow();
    current.events = [...(current.events || []), {
      at: current.updated_at,
      source: source || "unknown",
      ...(before?.trackedFingerprint ? { before_fingerprint: before.trackedFingerprint } : {}),
      ...(after?.trackedFingerprint ? { after_fingerprint: after.trackedFingerprint } : {}),
      ...(details ? { details } : {})
    }].slice(-100);
    manifest.version = 1;
    manifest.task_id = taskId;
    manifest.updated_at = current.updated_at;
    manifest.workspaces = { ...(manifest.workspaces || {}), [workspaceId]: current };
    await atomicWriteJson(unmanagedArtifactPath(taskId), manifest);
    UNMANAGED_WORKSPACE_CHANGES.add(key);
  });
}

export async function unmanagedChangeState(workspaceId, taskId) {
  const key = unmanagedChangeKey(workspaceId, taskId);
  if (UNMANAGED_WORKSPACE_CHANGES.has(key)) return { detected: true, adopted: false };
  if (!taskId) return { detected: false, adopted: false };
  const manifest = await readUnmanagedManifest(taskId);
  if (manifest.state_known === false) {
    return {
      detected: false,
      adopted: false,
      unknown: true,
      error_code: manifest.error_code || "UNMANAGED_STATE_UNKNOWN"
    };
  }
  const state = manifest.workspaces?.[workspaceId];
  if (state?.detected && !state?.adopted) {
    UNMANAGED_WORKSPACE_CHANGES.add(key);
    return state;
  }
  return state || { detected: false, adopted: false };
}

export async function adoptUnmanagedChange(workspaceId, taskId) {
  const key = unmanagedChangeKey(workspaceId, taskId);
  if (!taskId) {
    UNMANAGED_WORKSPACE_CHANGES.delete(key);
    return;
  }
  await withUnmanagedManifestLock(taskId, async () => {
    const manifest = await readUnmanagedManifest(taskId);
    assertUnmanagedManifestWritable(manifest);
    const current = manifest.workspaces?.[workspaceId];
    if (current) {
      current.adopted = true;
      current.adopted_at = isoNow();
      manifest.updated_at = current.adopted_at;
      await atomicWriteJson(unmanagedArtifactPath(taskId), manifest);
    }
    UNMANAGED_WORKSPACE_CHANGES.delete(key);
  });
}

export function taskArtifactPath(task, fileName, fallbackPath) {
  if (!task?.id) return fallbackPath;
  if (!/^task_[A-Za-z0-9]+$/.test(task.id)) throw new Error(`Invalid task id: ${task.id}`);
  return path.join(RUNTIME_DATA_DIR, "tasks", task.id, fileName);
}

function verificationArtifactPath(taskId, workspaceId) {
  if (!/^task_[A-Za-z0-9_-]{8,160}$/.test(String(taskId || ""))) {
    throw new TaskRouterError("INVALID_TASK_ID", `Invalid task ID: ${taskId}`);
  }
  if (!/^ws_[A-Za-z0-9_-]{8,160}$/.test(String(workspaceId || ""))) {
    throw new WorkspaceRegistryError("INVALID_WORKSPACE_ID", `Invalid workspace ID: ${workspaceId}`);
  }
  return path.join(RUNTIME_DATA_DIR, "tasks", taskId, "verification", `${workspaceId}.json`);
}

export async function captureVerificationWorkspaceState(workspace, changes) {
  const root = workspace.canonicalRoot;
  const mutation = await workspaceMutationFingerprint(root);
  const digest = createHash("sha256");
  const files = [...(changes?.files || [])]
    .map((entry) => ({
      path: entry.location?.path || null,
      original_path: entry.original_location?.path || null,
      index_status: entry.index_status || null,
      worktree_status: entry.worktree_status || null,
      staged: entry.staged === true,
      unstaged: entry.unstaged === true,
      untracked: entry.untracked === true,
      deleted: entry.deleted === true
    }))
    .sort((left, right) => String(left.path).localeCompare(String(right.path)));
  digest.update(JSON.stringify({
    workspace_id: workspace.id,
    head: changes?.head || null,
    dirty_unknown: changes?.dirty_unknown === true,
    mutation_fingerprint: mutation.fingerprint,
    tracked_fingerprint: mutation.trackedFingerprint,
    files
  }));

  try {
    for (const entry of files) {
      if (!entry.untracked || !entry.path) continue;
      const target = path.resolve(root, entry.path);
      const canonical = canonicalize(target);
      if (!isWithinRoots(canonical, [root])) {
        return {
          state_known: false,
          error_code: "VERIFICATION_PATH_UNAVAILABLE",
          head: changes?.head || null,
          fingerprint: null
        };
      }
      const info = await stat(target);
      if (!info.isFile()) {
        digest.update(`\0${entry.path}\0${info.mode}\0${info.size}\0non-file`);
        continue;
      }
      digest.update(`\0${entry.path}\0${info.mode}\0${info.size}\0`);
      await updateDigestFromFile(digest, target);
    }
  } catch {
    return {
      state_known: false,
      error_code: "VERIFICATION_FINGERPRINT_FAILED",
      head: changes?.head || null,
      fingerprint: null
    };
  }

  const stateKnown = changes?.dirty_unknown !== true && mutation.stateKnown === true;
  return {
    state_known: stateKnown,
    ...(stateKnown ? {} : { error_code: mutation.errorCode || "CHANGE_SET_UNKNOWN" }),
    head: changes?.head || null,
    fingerprint: stateKnown ? digest.digest("hex") : null
  };
}

function updateDigestFromFile(digest, target) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
}

function verificationGateEvidence(gates = []) {
  return gates.map((gate) => ({
    id: String(gate.id || ""),
    kind: String(gate.kind || ""),
    cwd: gate.cwd?.path || String(gate.cwd || "."),
    required: gate.required !== false,
    command_hash: createHash("sha256").update(String(gate.command || "")).digest("hex"),
    status: String(gate.status || "pending").toLowerCase(),
    exit_code: Number.isInteger(gate.result?.exit_code)
      ? gate.result.exit_code
      : Number.isInteger(gate.exit_code) ? gate.exit_code : null,
    timed_out: gate.result?.timed_out === true || gate.timed_out === true,
    duration_ms: Number.isFinite(gate.result?.duration_ms)
      ? Number(gate.result.duration_ms)
      : Number.isFinite(gate.duration_ms) ? Number(gate.duration_ms) : null
  })).sort((left, right) => left.id.localeCompare(right.id));
}

export function verificationGateSignature(gates = []) {
  return verificationGateEvidence(gates).map((gate) => ({
    id: gate.id,
    kind: gate.kind,
    cwd: gate.cwd,
    required: gate.required,
    command_hash: gate.command_hash
  }));
}

export async function persistTaskVerificationEvidence({ selected, source, status, verification }) {
  const taskId = selected.task?.id;
  if (!taskId) return null;
  const state = await captureVerificationWorkspaceState(selected.workspace, verification?.changes);
  const artifact = {
    version: 1,
    task_id: taskId,
    workspace_id: selected.workspace.id,
    source,
    recorded_at: isoNow(),
    status: state.state_known ? String(status || "INCOMPLETE") : "INCOMPLETE",
    requested_gates: [...(verification?.requested_gates || [])],
    gate_signature: verificationGateSignature(verification?.gates || []),
    gates: verificationGateEvidence(verification?.gates || []),
    reasons: dedupe([
      ...(verification?.reasons || []),
      ...(state.state_known ? [] : [state.error_code || "VERIFICATION_STATE_UNKNOWN"])
    ]),
    state
  };
  await atomicWriteJson(verificationArtifactPath(taskId, selected.workspace.id), artifact);
  return artifact;
}

export async function readTaskVerificationEvidence(taskId, workspaceId) {
  try {
    const artifact = JSON.parse(await readFile(verificationArtifactPath(taskId, workspaceId), "utf8"));
    if (
      artifact?.version !== 1 ||
      artifact.task_id !== taskId ||
      artifact.workspace_id !== workspaceId ||
      !Array.isArray(artifact.requested_gates) ||
      !Array.isArray(artifact.gate_signature) ||
      !Array.isArray(artifact.gates) ||
      typeof artifact.state?.state_known !== "boolean"
    ) {
      return { ok: false, reason: "VERIFICATION_EVIDENCE_CORRUPT" };
    }
    return { ok: true, artifact };
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === "ENOENT"
        ? "VERIFICATION_EVIDENCE_MISSING"
        : "VERIFICATION_EVIDENCE_CORRUPT"
    };
  }
}

export async function selectWorkspace({ workspaceId, taskToken, requireTask = false } = {}) {
  const task = await currentTask({ taskToken, required: requireTask });
  if (task) {
    const selectedId = workspaceId || task.primary_workspace_id;
    if (!task.workspace_ids.includes(selectedId)) {
      throw new TaskRouterError(
        "WORKSPACE_NOT_ATTACHED",
        `Workspace ${selectedId} is not attached to task ${task.id}.`,
        { task_id: task.id, workspace_id: selectedId, workspace_ids: task.workspace_ids }
      );
    }
    const runtime = await getWorkspaceRuntime(selectedId);
    return { task, workspace: runtime.workspace, runtime };
  }
  let selectedId = workspaceId || null;
  if (!selectedId && registry) {
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
    selectedId = selected?.workspace?.id || null;
  }
  selectedId ||= primaryWorkspaceId;
  const runtime = await getWorkspaceRuntime(selectedId);
  return { task: null, workspace: runtime.workspace, runtime };
}

export async function resolveWorkspacePath(input = ".", options = {}) {
  const selected = await selectWorkspace(options);
  const root = selected.workspace.canonicalRoot;
  const raw = String(input ?? ".").trim();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const canon = canonicalize(resolved);
  if (!isWithinRoots(canon, [root])) {
    throw new Error(`Path is outside workspace ${selected.workspace.id} or resolves outside via a link: ${input}`);
  }
  return { ...selected, root, path: resolved };
}

export function toWorkspaceRel(workspace, absolutePath) {
  const root = workspace?.canonicalRoot || PRIMARY_ROOT;
  if (comparePath(absolutePath) === comparePath(root)) return ".";
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (comparePath(absolutePath).startsWith(comparePath(prefix))) {
    return absolutePath.slice(prefix.length).split(path.sep).join("/");
  }
  throw new Error(`Path is outside workspace ${workspace?.id || "unknown"}`);
}

export function qualifiedPath(workspace, absolutePath) {
  return {
    workspace_id: workspace?.id || primaryWorkspaceId,
    path: toWorkspaceRel(workspace, absolutePath)
  };
}

function qualifyGitRelativePath(workspace, value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).replaceAll("\\", "/").replace(/^\.\/+/, "");
  const unsafe = path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw) ||
    raw.split("/").some((segment) => segment === "..");
  return {
    workspace_id: workspace.id,
    path: unsafe ? "<invalid-relative-path>" : raw
  };
}

export function qualifyGitStatus(workspace, status) {
  return {
    ...status,
    files: Array.isArray(status?.files)
      ? status.files.map((file) => ({
          ...file,
          path: qualifyGitRelativePath(workspace, file.path),
          from: qualifyGitRelativePath(workspace, file.from)
        }))
      : []
  };
}

export function redactGitOutputPaths(value, workspace) {
  let output = String(value || "");
  const workspaceRoots = dedupe([
    workspace?.canonicalRoot,
    workspace?.root
  ].filter(Boolean)).sort((left, right) => right.length - left.length);
  for (const root of workspaceRoots) {
    const variants = dedupe([
      root,
      root.split(path.sep).join("/"),
      root.split(path.sep).join("\\")
    ]).filter(Boolean);
    for (const variant of variants) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      output = output.replace(
        new RegExp(`${escaped}[\\\\/]`, process.platform === "win32" ? "gi" : "g"),
        ""
      );
      output = output.replace(
        new RegExp(escaped, process.platform === "win32" ? "gi" : "g"),
        "."
      );
    }
  }
  const privateRoots = [
    [RUNTIME_DATA_DIR, "<lca-runtime-data>"],
    [DATA_DIR, "<lca-data>"],
    [REPOSITORY_DIR, "<lca-install>"],
    [os.tmpdir(), "<temp>"],
    [os.homedir(), "<home>"]
  ].sort((left, right) => String(right[0]).length - String(left[0]).length);
  for (const [root, replacement] of privateRoots) {
    if (!root || path.parse(root).root === root) continue;
    const variants = dedupe([root, root.split(path.sep).join("/"), root.split(path.sep).join("\\")]);
    for (const variant of variants) {
      output = output.replace(
        new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), process.platform === "win32" ? "gi" : "g"),
        replacement
      );
    }
  }
  return output;
}

export async function modelSafeToolError(error) {
  const raw = error instanceof ChangeJournalError
    ? error.toJSON()
    : {
        error: error?.code || "TOOL_FAILED",
        code: error?.code || "TOOL_FAILED",
        message: error?.message || String(error || "Tool failed."),
        ...(error?.details && typeof error.details === "object" && Object.keys(error.details).length
          ? { details: error.details }
          : {})
      };
  if (TEST_RUNTIME_DIAGNOSTICS) return raw;

  const workspaces = registry
    ? await registry.listWorkspaces({ refreshAvailability: false }).catch(() => [])
    : [];
  const replacements = [
    ...workspaces.map((workspace) => ({
      root: workspace.canonicalRoot,
      replacement: `<workspace:${workspace.id}>`
    })),
    { root: PRIMARY_ROOT, replacement: `<workspace:${primaryWorkspaceId}>` },
    { root: RUNTIME_DATA_DIR, replacement: "<lca-runtime-data>" },
    { root: DATA_DIR, replacement: "<lca-data>" },
    { root: REPOSITORY_DIR, replacement: "<lca-install>" },
    { root: os.tmpdir(), replacement: "<temp>" },
    { root: os.homedir(), replacement: "<home>" }
  ]
    .filter((entry) => entry.root && path.parse(entry.root).root !== entry.root)
    .sort((left, right) => right.root.length - left.root.length);

  const sanitizeString = (value) => {
    let output = String(value);
    for (const { root, replacement } of replacements) {
      const variants = dedupe([root, root.split(path.sep).join("/"), root.split(path.sep).join("\\")]);
      for (const variant of variants) {
        if (!variant) continue;
        output = output.replace(
          new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), process.platform === "win32" ? "gi" : "g"),
          replacement
        );
      }
    }
    return output;
  };
  const absolutePathKeys = new Set([
    "absolutepath",
    "canonicalroot",
    "requestedroot",
    "databasepath",
    "datadir",
    "root",
    "roots"
  ]);
  const sanitize = (value, key = "") => {
    if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
        childKey,
        sanitize(child, childKey)
      ]));
    }
    if (typeof value !== "string") return value;
    const sanitized = sanitizeString(value);
    const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
    const normalizedKey = key.replace(/[^a-z]/gi, "").toLowerCase();
    const carriesAbsolutePath = absolutePathKeys.has(normalizedKey);
    if (carriesAbsolutePath && (path.isAbsolute(value) || windowsAbsolute) && sanitized === value) {
      return "<absolute-path-redacted>";
    }
    return sanitized;
  };
  return sanitize(raw);
}

export function isWithinRoots(p, roots = ROOTS) {
  return roots.some((root) => {
    const target = comparePath(p);
    const base = comparePath(root);
    const withSep = base.endsWith(path.sep) ? base : base + path.sep;
    return target === base || target.startsWith(withSep);
  });
}

// Shorten output paths: relative to the primary root (posix slashes) when the
// file lives under it, otherwise the absolute path. Round-trips back through
// resolvePath() because relative inputs resolve against the primary root.
export function toRel(abs) {
  if (comparePath(abs) === comparePath(PRIMARY_ROOT)) return ".";
  const withSep = PRIMARY_ROOT.endsWith(path.sep) ? PRIMARY_ROOT : PRIMARY_ROOT + path.sep;
  if (comparePath(abs).startsWith(comparePath(withSep))) return abs.slice(withSep.length).split(path.sep).join("/");
  return abs;
}
