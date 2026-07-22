// Local Coding Agent durable workspace purge coordination.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import path from "node:path";

const PURGE_INTENT_VERSION = 1;
const TERMINAL_STATES = new Set(["complete", "rolled_back"]);

export class WorkspacePurgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkspacePurgeError";
    this.code = code;
    this.details = details;
  }
}

export async function inspectWorkspacePurge({ dataDir, registry, workspaceId, configuredRoot = "" }) {
  const root = await validateRuntimeRoot(dataDir);
  const inspection = await registry.inspectWorkspaceLifecycle(workspaceId);
  assertPurgeAllowed(inspection, configuredRoot);
  const taskIds = inspection.tasks.map((task) => task.task_id);
  const targets = purgeTargets(root, inspection.workspace.id, taskIds);
  const existingTargets = [];
  for (const target of targets) {
    const info = await lstat(target.source).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) continue;
    if (info.isSymbolicLink()) {
      throw new WorkspacePurgeError("PURGE_SYMLINK_REJECTED", "Workspace runtime data must not be a symlink.", {
        workspace_id: inspection.workspace.id,
        path: target.sourceRelative
      });
    }
    existingTargets.push(target);
  }
  const workspaceDir = path.join(root, "workspaces", inspection.workspace.id);
  const legacyDir = path.join(root, "workspaces", inspection.workspace.id.replace(/^ws_/, ""));
  const [totalBytes, journalBytes, blobBytes, indexBytes] = await Promise.all([
    sumSizes(existingTargets.map((target) => target.source)),
    sumSizes([path.join(workspaceDir, "changes"), path.join(legacyDir, "changes")]),
    sumSizes([path.join(workspaceDir, "changes", "blobs"), path.join(legacyDir, "changes", "blobs")]),
    sumSizes([path.join(workspaceDir, "index"), path.join(legacyDir, "index")])
  ]);
  return {
    ...inspection,
    task_ids: taskIds,
    task_count: taskIds.length,
    data_bytes: totalBytes,
    journal_bytes: journalBytes,
    blob_bytes: blobBytes,
    index_bytes: indexBytes,
    targets: existingTargets
  };
}

export async function purgeWorkspace(options) {
  assertFaultInjectionAllowed(options?.faultAt || "");
  const root = await validateRuntimeRoot(options?.dataDir);
  const release = await acquirePurgeLock(root);
  try {
    await recoverWorkspacePurgesLocked({ dataDir: root, registry: options.registry });
    return await purgeWorkspaceLocked(options, root);
  } finally {
    await release();
  }
}

async function purgeWorkspaceLocked({
  dataDir,
  registry,
  workspaceId,
  configuredRoot = "",
  faultAt = ""
}, root) {
  const summary = await inspectWorkspacePurge({
    dataDir: root,
    registry,
    workspaceId,
    configuredRoot
  });
  const nonce = randomUUID();
  const control = await ensurePurgeControl(root);
  const quarantineRoot = containedPath(control.quarantineDir, nonce);
  await mkdir(quarantineRoot, { recursive: false, mode: 0o700 });
  const targets = summary.targets.map((target) => ({
    source: target.sourceRelative,
    quarantine: relativeTo(root, containedPath(quarantineRoot, target.quarantineName))
  }));
  const intent = {
    version: PURGE_INTENT_VERSION,
    nonce,
    workspace_id: summary.workspace.id,
    workspace_label: String(summary.workspace.metadata?.label || path.basename(summary.workspace.canonicalRoot)),
    canonical_root: summary.workspace.canonicalRoot,
    task_ids: summary.task_ids,
    targets,
    staged: [],
    state: "prepared",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const intentPath = containedPath(control.intentsDir, `${nonce}.json`);
  await atomicWriteJson(intentPath, intent);
  injectFault(faultAt, "prepared");

  let databaseCommitted = false;
  try {
    intent.state = "staging";
    await persistIntent(intentPath, intent);
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      const source = containedRelative(root, target.source);
      const quarantine = containedRelative(root, target.quarantine);
      await rename(source, quarantine);
      intent.staged.push(target.source);
      await persistIntent(intentPath, intent);
      injectFault(faultAt, `staged:${index + 1}`);
    }
    intent.state = "staged";
    await persistIntent(intentPath, intent);
    injectFault(faultAt, "staged");

    await registry.deleteWorkspaceRecords(summary.workspace.id, summary);
    databaseCommitted = true;
    injectFault(faultAt, "database_committed_before_intent");
    intent.state = "database_committed";
    intent.database_committed_at = new Date().toISOString();
    await persistIntent(intentPath, intent);
    injectFault(faultAt, "database_committed");

    await removeQuarantine(root, nonce);
    intent.state = "complete";
    intent.completed_at = new Date().toISOString();
    await persistIntent(intentPath, intent);
    return {
      removed: true,
      workspace_id: summary.workspace.id,
      task_count: summary.task_count,
      data_bytes: summary.data_bytes,
      intent_id: nonce
    };
  } catch (error) {
    if (error?.code === "PURGE_FAULT_INJECTED") throw error;
    if (!databaseCommitted) {
      await restoreIntentTargets(root, intent);
      intent.state = "rolled_back";
      intent.rolled_back_at = new Date().toISOString();
      intent.error_code = String(error?.code || "PURGE_FAILED");
      await persistIntent(intentPath, intent).catch(() => {});
    } else {
      intent.state = "recovery_pending";
      intent.error_code = String(error?.code || "PURGE_CLEANUP_FAILED");
      await persistIntent(intentPath, intent).catch(() => {});
    }
    throw error;
  }
}

export async function recoverWorkspacePurges({ dataDir, registry }) {
  const root = await validateRuntimeRoot(dataDir);
  const release = await acquirePurgeLock(root);
  try {
    return await recoverWorkspacePurgesLocked({ dataDir: root, registry });
  } finally {
    await release();
  }
}

async function recoverWorkspacePurgesLocked({ dataDir, registry }) {
  const root = path.resolve(dataDir);
  const control = await ensurePurgeControl(root);
  const names = (await readdir(control.intentsDir).catch(() => []))
    .filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name))
    .sort();
  const recovered = [];
  for (const name of names) {
    const intentPath = containedPath(control.intentsDir, name);
    const intent = await readIntent(intentPath, root);
    if (TERMINAL_STATES.has(intent.state)) continue;
    const workspaceExists = await registry.getWorkspace(intent.workspace_id, {
      refreshAvailability: false,
      allowArchived: true
    }).then(() => true, (error) => {
      if (error?.code === "WORKSPACE_NOT_FOUND") return false;
      throw error;
    });
    if (workspaceExists) {
      await restoreIntentTargets(root, intent);
      intent.state = "rolled_back";
      intent.rolled_back_at = new Date().toISOString();
      intent.recovery_action = "restore_all_before";
    } else {
      await removeQuarantine(root, intent.nonce);
      intent.state = "complete";
      intent.completed_at = new Date().toISOString();
      intent.recovery_action = "finish_all_deleted";
    }
    await persistIntent(intentPath, intent);
    recovered.push({ intent_id: intent.nonce, workspace_id: intent.workspace_id, state: intent.state });
  }
  return recovered;
}

function assertPurgeAllowed(inspection, configuredRoot) {
  if (inspection.selections.some((selection) => selection.scope === "default")) {
    throw new WorkspacePurgeError(
      "WORKSPACE_DEFAULT",
      "Select another default workspace before removing this workspace permanently.",
      { workspace_id: inspection.workspace.id }
    );
  }
  if (configuredRoot && pathKey(configuredRoot) === pathKey(inspection.workspace.canonicalRoot)) {
    throw new WorkspacePurgeError(
      "WORKSPACE_CONFIGURED_STARTUP",
      "Configure another startup workspace before removing this workspace permanently.",
      { workspace_id: inspection.workspace.id }
    );
  }
  if (inspection.multi_workspace_tasks.length) {
    throw new WorkspacePurgeError(
      "WORKSPACE_MULTI_TASK_HISTORY",
      "A workspace referenced by a multi-workspace task cannot be removed permanently.",
      {
        workspace_id: inspection.workspace.id,
        task_ids: inspection.multi_workspace_tasks.map((task) => task.task_id)
      }
    );
  }
  if (inspection.incomplete_transactions.length) {
    throw new WorkspacePurgeError(
      "WORKSPACE_TRANSACTION_INCOMPLETE",
      "Recover incomplete patch transactions before removing this workspace permanently.",
      {
        workspace_id: inspection.workspace.id,
        transaction_ids: inspection.incomplete_transactions.map((transaction) => transaction.id)
      }
    );
  }
}

function purgeTargets(root, workspaceId, taskIds) {
  const workspaceSuffix = workspaceId.replace(/^ws_/, "");
  const specs = [
    { source: path.join(root, "workspaces", workspaceId), quarantineName: `workspace-${workspaceId}` },
    { source: path.join(root, "workspaces", workspaceSuffix), quarantineName: `legacy-workspace-${workspaceSuffix}` },
    ...taskIds.map((taskId) => ({
      source: path.join(root, "tasks", safeSegment(taskId, "task ID")),
      quarantineName: `task-${taskId}`
    }))
  ];
  return specs.map((item) => ({
    ...item,
    source: containedPath(root, path.relative(root, item.source)),
    sourceRelative: relativeTo(root, item.source)
  }));
}

async function restoreIntentTargets(root, intent) {
  for (const target of [...intent.targets].reverse()) {
    const source = containedRelative(root, target.source);
    const quarantine = containedRelative(root, target.quarantine);
    const [sourceInfo, quarantineInfo] = await Promise.all([
      lstat(source).catch(() => null),
      lstat(quarantine).catch(() => null)
    ]);
    if (!quarantineInfo) continue;
    if (quarantineInfo.isSymbolicLink()) {
      throw new WorkspacePurgeError("PURGE_SYMLINK_REJECTED", "Purge quarantine is a symlink.");
    }
    if (sourceInfo) {
      throw new WorkspacePurgeError(
        "PURGE_RESTORE_CONFLICT",
        "Both staged and original workspace data exist; recovery stopped without deleting either copy.",
        { source: target.source, quarantine: target.quarantine }
      );
    }
    await mkdir(path.dirname(source), { recursive: true });
    await rename(quarantine, source);
  }
  await removeQuarantine(root, intent.nonce);
}

async function removeQuarantine(root, nonce) {
  const quarantine = containedPath(path.join(root, "workspace-purges", "quarantine"), safeNonce(nonce));
  const info = await lstat(quarantine).catch(() => null);
  if (!info) return;
  if (info.isSymbolicLink()) {
    throw new WorkspacePurgeError("PURGE_SYMLINK_REJECTED", "Purge quarantine is a symlink.");
  }
  await rm(quarantine, { recursive: true, force: false });
}

async function readIntent(intentPath, root) {
  let intent;
  try {
    intent = JSON.parse(await readFile(intentPath, "utf8"));
  } catch {
    throw new WorkspacePurgeError("PURGE_INTENT_CORRUPT", "Workspace purge intent is unreadable.", {
      intent: path.basename(intentPath)
    });
  }
  if (intent?.version !== PURGE_INTENT_VERSION || safeNonce(intent.nonce) !== path.basename(intentPath, ".json") ||
      !/^ws_[A-Za-z0-9_-]{8,160}$/.test(String(intent.workspace_id || "")) ||
      !Array.isArray(intent.task_ids) || !Array.isArray(intent.targets)) {
    throw new WorkspacePurgeError("PURGE_INTENT_CORRUPT", "Workspace purge intent failed validation.");
  }
  const expected = new Set(purgeTargets(root, intent.workspace_id, intent.task_ids).map((item) => item.sourceRelative));
  const quarantinePrefix = `workspace-purges/quarantine/${intent.nonce}/`;
  for (const target of intent.targets) {
    if (!expected.has(String(target?.source || "")) || !String(target?.quarantine || "").startsWith(quarantinePrefix)) {
      throw new WorkspacePurgeError("PURGE_INTENT_ESCAPE", "Workspace purge intent contains an unexpected path.");
    }
    containedRelative(root, target.source);
    containedRelative(root, target.quarantine);
  }
  return intent;
}

async function validateRuntimeRoot(dataDir) {
  if (!dataDir) throw new TypeError("Workspace purge requires dataDir.");
  const root = path.resolve(dataDir);
  const info = await lstat(root).catch(() => null);
  if (!info) await mkdir(root, { recursive: true, mode: 0o700 });
  else if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkspacePurgeError("PURGE_RUNTIME_ROOT_INVALID", "Runtime data root must be a real directory.");
  }
  return root;
}

async function ensurePurgeControl(root) {
  const purgeDir = containedPath(root, "workspace-purges");
  const intentsDir = containedPath(purgeDir, "intents");
  const quarantineDir = containedPath(purgeDir, "quarantine");
  await Promise.all([
    mkdir(intentsDir, { recursive: true, mode: 0o700 }),
    mkdir(quarantineDir, { recursive: true, mode: 0o700 })
  ]);
  for (const directory of [purgeDir, intentsDir, quarantineDir]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new WorkspacePurgeError("PURGE_CONTROL_INVALID", "Workspace purge control path is not a real directory.");
    }
  }
  return { purgeDir, intentsDir, quarantineDir };
}

async function acquirePurgeLock(root) {
  const control = await ensurePurgeControl(root);
  const lockDir = containedPath(control.purgeDir, "lock");
  const ownerPath = containedPath(lockDir, "owner.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lockDir, { recursive: false, mode: 0o700 });
      const nonce = randomUUID();
      await atomicWriteJson(ownerPath, {
        version: 1,
        nonce,
        pid: process.pid,
        created_at: new Date().toISOString()
      });
      return async () => {
        const owner = await readJson(ownerPath);
        if (owner?.nonce !== nonce) return;
        await rm(lockDir, { recursive: true, force: false }).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await lstat(lockDir).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) {
        throw new WorkspacePurgeError("PURGE_LOCK_INVALID", "Workspace purge lock is not a real directory.");
      }
      const owner = await readJson(ownerPath);
      const ownerPid = Number(owner?.pid);
      const lockIsFresh = Date.now() - info.mtimeMs < 5_000;
      if ((Number.isInteger(ownerPid) && processAlive(ownerPid)) || (!owner && lockIsFresh)) {
        throw new WorkspacePurgeError("PURGE_BUSY", "Another workspace purge or recovery is already running.");
      }
      await rm(lockDir, { recursive: true, force: false });
    }
  }
  throw new WorkspacePurgeError("PURGE_BUSY", "Could not acquire the workspace purge lock.");
}

async function readJson(target) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function persistIntent(intentPath, intent) {
  intent.updated_at = new Date().toISOString();
  await atomicWriteJson(intentPath, intent);
}

async function atomicWriteJson(target, value) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    const directory = await open(path.dirname(target), "r").catch(() => null);
    await directory?.sync().catch(() => {});
    await directory?.close().catch(() => {});
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function sumSizes(targets) {
  let total = 0;
  for (const target of targets) total += await pathSize(target);
  return total;
}

async function pathSize(target) {
  const info = await lstat(target).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory() || info.isSymbolicLink()) return Number(info.size || 0);
  let total = Number(info.size || 0);
  for (const entry of await readdir(target)) total += await pathSize(path.join(target, entry));
  return total;
}

function containedRelative(root, relative) {
  if (path.isAbsolute(String(relative || ""))) {
    throw new WorkspacePurgeError("PURGE_PATH_ESCAPE", "Purge paths must be relative to runtime data.");
  }
  return containedPath(root, relative);
}

function containedPath(root, ...parts) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts.map(String));
  if (target === base || !target.startsWith(`${base}${path.sep}`)) {
    throw new WorkspacePurgeError("PURGE_PATH_ESCAPE", "Workspace purge path escapes runtime data.");
  }
  return target;
}

function relativeTo(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function safeNonce(value) {
  const nonce = String(value || "");
  if (!/^[a-f0-9-]{36}$/i.test(nonce)) {
    throw new WorkspacePurgeError("PURGE_INTENT_CORRUPT", "Invalid workspace purge nonce.");
  }
  return nonce;
}

function safeSegment(value, label) {
  const segment = String(value || "");
  if (!/^[A-Za-z0-9_-]{8,180}$/.test(segment)) {
    throw new WorkspacePurgeError("PURGE_IDENTIFIER_INVALID", `Invalid ${label}.`);
  }
  return segment;
}

function pathKey(value) {
  let key = path.resolve(String(value || "")).split(path.sep).join("/").replace(/\/+$/, "");
  if (process.platform === "win32" || process.platform === "darwin") key = key.toLowerCase();
  return key;
}

function assertFaultInjectionAllowed(faultAt) {
  if (faultAt && !process.env.LCA_TEST_RUN_ID) {
    throw new WorkspacePurgeError("PURGE_FAULT_FORBIDDEN", "Purge fault injection is test-only.");
  }
}

function injectFault(requested, point) {
  if (!requested || requested !== point) return;
  const error = new WorkspacePurgeError("PURGE_FAULT_INJECTED", `Injected workspace purge fault at ${point}.`);
  throw error;
}
