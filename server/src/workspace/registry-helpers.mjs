// Local Coding Agent workspace canonicalization and persistence mapping helpers.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { WorkspaceRegistryError } from "./registry-contract.mjs";

export const DEFAULT_SELECTION_SCOPE = "default";
export const MAX_ATTACHMENTS = 200;

export function nowIso() {
  return new Date().toISOString();
}

export function normalizedPathKey(value) {
  let key = path.resolve(value).split(path.sep).join("/");
  if (key.length > 1) key = key.replace(/\/+$/, "");
  if (process.platform === "win32" || process.platform === "darwin") key = key.toLowerCase();
  return key;
}

export function isInsideOrEqual(candidate, root) {
  const target = normalizedPathKey(candidate);
  const base = normalizedPathKey(root);
  return target === base || target.startsWith(`${base}/`);
}

export function normalizeRelative(value) {
  const normalized = String(value || ".").split(path.sep).join("/").replace(/^\.\//, "");
  return normalized || ".";
}

export function safeJsonParse(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function workspaceFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    root: row.root,
    canonicalRoot: row.canonical_root,
    availability: row.availability,
    registrationState: row.registration_state || "active",
    archivedAt: row.archived_at || null,
    metadata: safeJsonParse(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSelectedAt: row.last_selected_at || null
  };
}

export function attachmentFromRow(row) {
  return {
    path: row.path,
    canonicalPath: row.canonical_path,
    version: row.version ?? null,
    access: row.access,
    exists: Boolean(row.exists_at_attach),
    type: row.type,
    size: row.size === null || row.size === undefined ? null : Number(row.size),
    attachedAt: row.attached_at
  };
}

export function noteFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    workspace_id: row.workspace_id,
    title: row.title,
    body: row.body,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function taskFromRow(row, attachments = []) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status,
    token: Number(row.token),
    ownerSessionId: row.owner_session_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    frozenAt: row.frozen_at || null,
    closedAt: row.closed_at || null,
    attachments
  };
}

export function transactionFromRow(row) {
  if (!row) return null;
  const workspaceIds = safeJsonParse(row.workspace_ids_json, []);
  return {
    id: row.id,
    status: row.status,
    task_id: row.task_id || null,
    workspace_ids: Array.isArray(workspaceIds) ? workspaceIds.map(String) : [],
    manifest_version: Number(row.manifest_version),
    manifest_file: row.manifest_file,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || null,
    error_code: row.error_code || null
  };
}

export function validateWorkspaceId(value) {
  const id = String(value || "");
  if (!/^ws_[a-z0-9]{16,64}$/i.test(id)) {
    throw new WorkspaceRegistryError("INVALID_WORKSPACE_ID", "Invalid workspace ID.", { workspaceId: id });
  }
  return id;
}

export function validateTaskId(value) {
  const id = String(value || "");
  if (!/^task_[A-Za-z0-9_-]{8,160}$/.test(id)) {
    throw new WorkspaceRegistryError("INVALID_TASK_ID", "Invalid task ID.", { taskId: id });
  }
  return id;
}

export function validateToken(value) {
  const token = Number(value);
  if (!Number.isSafeInteger(token) || token < 1) {
    throw new WorkspaceRegistryError("INVALID_TASK_TOKEN", "Task token must be a positive integer.");
  }
  return token;
}

export function validateScope(value) {
  const scope = String(value || DEFAULT_SELECTION_SCOPE).trim();
  if (!scope || scope.length > 160 || !/^[A-Za-z0-9_.:-]+$/.test(scope)) {
    throw new WorkspaceRegistryError("INVALID_SELECTION_SCOPE", "Invalid workspace selection scope.");
  }
  return scope;
}

export function validateTransactionState(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new WorkspaceRegistryError(
      "INVALID_TRANSACTION_STATE",
      "Transaction state must be an object."
    );
  }
  const id = String(record.id || "");
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(id)) {
    throw new WorkspaceRegistryError(
      "INVALID_TRANSACTION_ID",
      "Invalid transaction ID.",
      { transactionId: id }
    );
  }
  const status = String(record.status || "");
  if (![
    "preparing",
    "staged",
    "committing",
    "committed",
    "complete",
    "in_doubt",
    "rolled_back"
  ].includes(status)) {
    throw new WorkspaceRegistryError(
      "INVALID_TRANSACTION_STATE",
      `Invalid transaction status: ${status || "missing"}.`,
      { transactionId: id }
    );
  }
  const workspaceIds = Array.isArray(record.workspace_ids)
    ? [...new Set(record.workspace_ids.map((value) => String(value || "").trim()).filter(Boolean))].sort()
    : [];
  if (!workspaceIds.length) {
    throw new WorkspaceRegistryError(
      "INVALID_TRANSACTION_STATE",
      "Transaction state requires at least one workspace ID.",
      { transactionId: id }
    );
  }
  const manifestVersion = Number(record.manifest_version);
  if (!Number.isSafeInteger(manifestVersion) || manifestVersion < 1) {
    throw new WorkspaceRegistryError(
      "INVALID_TRANSACTION_STATE",
      "Transaction manifest version must be a positive integer.",
      { transactionId: id }
    );
  }
  const manifestFile = String(record.manifest_file || "");
  if (manifestFile !== `${id}.json`) {
    throw new WorkspaceRegistryError(
      "INVALID_TRANSACTION_STATE",
      "Transaction manifest filename must match its transaction ID.",
      { transactionId: id }
    );
  }
  const createdAt = String(record.created_at || "");
  const updatedAt = String(record.updated_at || "");
  if (!createdAt || !updatedAt) {
    throw new WorkspaceRegistryError(
      "INVALID_TRANSACTION_STATE",
      "Transaction timestamps are required.",
      { transactionId: id }
    );
  }
  return {
    id,
    status,
    taskId: record.task_id ? String(record.task_id).slice(0, 256) : null,
    workspaceIds,
    manifestVersion,
    manifestFile,
    createdAt,
    updatedAt,
    completedAt: record.completed_at ? String(record.completed_at) : null,
    errorCode: record.error_code ? String(record.error_code).slice(0, 160) : null
  };
}

export async function canonicalWorkspaceRoot(input) {
  let requested = path.resolve(String(input || ""));
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    throw new WorkspaceRegistryError(
      "WORKSPACE_UNAVAILABLE",
      `Workspace root is unavailable: ${requested}`,
      { root: requested, cause: error?.code || null }
    );
  }
  let info = await stat(canonical).catch(() => null);
  if (!info?.isDirectory()) {
    throw new WorkspaceRegistryError(
      "WORKSPACE_NOT_DIRECTORY",
      `Workspace root is not a directory: ${canonical}`,
      { root: canonical }
    );
  }
  if (normalizedPathKey(canonical) === normalizedPathKey(path.parse(canonical).root)) {
    throw new WorkspaceRegistryError(
      "WORKSPACE_ROOT_FORBIDDEN",
      "A filesystem root cannot be registered as a coding workspace.",
      { root: canonical }
    );
  }
  const git = await discoverGitWorkspace(canonical);
  if (git && normalizedPathKey(git.root) !== normalizedPathKey(canonical)) {
    // A path inside a repository is registered as the repository worktree
    // root. This avoids treating an arbitrary subdirectory as an independent
    // workspace and makes package/task routing deterministic.
    requested = git.root;
    canonical = git.root;
    info = await stat(canonical).catch(() => null);
    if (!info?.isDirectory()) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_UNAVAILABLE",
        `Workspace root is unavailable: ${canonical}`,
        { root: canonical }
      );
    }
  }
  return {
    requested,
    canonical,
    key: normalizedPathKey(canonical),
    rootIdentity: filesystemIdentity(info, canonical),
    git: git
      ? { is_repository: true, identity: git.identity }
      : { is_repository: false, identity: null }
  };
}

function filesystemIdentity(info, canonical) {
  const inode = Number(info?.ino || 0);
  const device = Number(info?.dev || 0);
  const birthtime = Number(info?.birthtimeMs || 0);
  const material = inode > 0
    ? `${device}:${inode}`
    : `${normalizedPathKey(canonical)}:${birthtime}`;
  return `fs_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

export async function discoverGitWorkspace(start) {
  let cursor = path.resolve(start);
  for (let depth = 0; depth < 256; depth++) {
    const marker = path.join(cursor, ".git");
    const markerInfo = await lstat(marker).catch((error) => {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      throw error;
    });
    if (markerInfo?.isSymbolicLink()) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_GIT_LINK_UNSAFE",
        "The repository .git marker must not be a symbolic link."
      );
    }
    let gitDirectory = null;
    if (markerInfo?.isDirectory()) {
      gitDirectory = await realpath(marker);
    } else if (markerInfo?.isFile()) {
      if (markerInfo.size > 4_096) {
        throw new WorkspaceRegistryError(
          "WORKSPACE_GIT_MARKER_INVALID",
          "The repository .git marker is unexpectedly large."
        );
      }
      const markerText = await readFile(marker, "utf8");
      const target = markerText.match(/^gitdir:\s*(.+?)\s*$/im)?.[1];
      if (!target) {
        throw new WorkspaceRegistryError(
          "WORKSPACE_GIT_MARKER_INVALID",
          "The repository .git marker is invalid."
        );
      }
      gitDirectory = await realpath(path.resolve(cursor, target));
    }
    if (gitDirectory) {
      let commonDirectory = gitDirectory;
      const commonMarker = path.join(gitDirectory, "commondir");
      const commonInfo = await lstat(commonMarker).catch(() => null);
      if (commonInfo?.isFile() && commonInfo.size <= 4_096) {
        const commonTarget = (await readFile(commonMarker, "utf8")).trim();
        if (commonTarget) commonDirectory = await realpath(path.resolve(gitDirectory, commonTarget));
      }
      const identityInfo = await stat(commonDirectory);
      const stableMaterial = `${identityInfo.dev}:${identityInfo.ino}`;
      const fallbackMaterial = `${stableMaterial}:${normalizedPathKey(commonDirectory)}`;
      const material = Number(identityInfo.ino) > 0 ? stableMaterial : fallbackMaterial;
      return {
        root: cursor,
        identity: `git_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`
      };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

export async function workspaceAvailable(canonicalRoot, requestedRoot = canonicalRoot) {
  try {
    const [resolved, requested] = await Promise.all([
      realpath(canonicalRoot),
      realpath(requestedRoot)
    ]);
    const info = await stat(resolved);
    return info.isDirectory()
      && normalizedPathKey(resolved) === normalizedPathKey(canonicalRoot)
      && normalizedPathKey(requested) === normalizedPathKey(canonicalRoot);
  } catch {
    return false;
  }
}

export async function workspaceIdentityAvailable({
  canonicalRoot,
  requestedRoot = canonicalRoot,
  metadata = {}
}) {
  if (!(await workspaceAvailable(canonicalRoot, requestedRoot))) return false;
  try {
    const current = await canonicalWorkspaceRoot(requestedRoot);
    if (current.key !== normalizedPathKey(canonicalRoot)) return false;
    if (metadata.root_identity && metadata.root_identity !== current.rootIdentity) return false;
    const expectedGit = metadata.git;
    if (expectedGit && (
      Boolean(expectedGit.is_repository) !== Boolean(current.git.is_repository) ||
      String(expectedGit.identity || "") !== String(current.git.identity || "")
    )) return false;
    return true;
  } catch {
    return false;
  }
}

export async function canonicalizeTarget(root, input) {
  const requested = path.isAbsolute(String(input || ""))
    ? path.resolve(String(input))
    : path.resolve(root, String(input || ""));
  const tail = [];
  let cursor = requested;
  let canonicalBase = null;
  let exists = false;

  for (let depth = 0; depth < 256; depth++) {
    try {
      canonicalBase = await realpath(cursor);
      exists = tail.length === 0;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const cursorInfo = await lstat(cursor).catch(() => null);
      if (cursorInfo?.isSymbolicLink()) {
        throw new WorkspaceRegistryError(
          "ATTACHMENT_SYMLINK_UNAVAILABLE",
          `Attachment path contains an unavailable symbolic link: ${input}`,
          { path: String(input) }
        );
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }

  if (!canonicalBase) {
    throw new WorkspaceRegistryError(
      "ATTACHMENT_PATH_UNAVAILABLE",
      `Could not canonicalize attachment path: ${input}`,
      { path: String(input) }
    );
  }
  const canonicalPath = tail.length ? path.join(canonicalBase, ...tail) : canonicalBase;
  if (!isInsideOrEqual(canonicalPath, root)) {
    throw new WorkspaceRegistryError(
      "ATTACHMENT_OUTSIDE_WORKSPACE",
      `Attachment resolves outside the workspace: ${input}`,
      { path: String(input), canonicalPath, workspaceRoot: root }
    );
  }
  return {
    requestedPath: normalizeRelative(path.relative(root, requested)),
    canonicalPath,
    exists
  };
}

export function metadataVersion(info, type) {
  return createHash("sha256")
    .update(`${type}:${info.size}:${info.mode}:${info.mtimeMs}`)
    .digest("hex");
}

export async function inspectAttachment(root, attachment) {
  if (!attachment || typeof attachment !== "object") {
    throw new WorkspaceRegistryError("INVALID_ATTACHMENT", "Attachment must be an object.");
  }
  const access = attachment.access === "write" ? "write" : "read";
  const target = await canonicalizeTarget(root, attachment.path);
  let info = null;
  if (target.exists) info = await stat(target.canonicalPath).catch(() => null);
  if (!info && access === "read") {
    throw new WorkspaceRegistryError(
      "ATTACHMENT_UNAVAILABLE",
      `Read attachment does not exist: ${attachment.path}`,
      { path: String(attachment.path) }
    );
  }

  let type = "missing";
  let size = null;
  let version = null;
  if (info?.isFile()) {
    const buffer = await readFile(target.canonicalPath);
    type = "file";
    size = buffer.length;
    version = createHash("sha256").update(buffer).digest("hex");
  } else if (info?.isDirectory()) {
    type = "directory";
    size = info.size;
    version = metadataVersion(info, "directory");
  } else if (info) {
    throw new WorkspaceRegistryError(
      "ATTACHMENT_TYPE_UNSUPPORTED",
      `Attachment must be a file or directory: ${attachment.path}`,
      { path: String(attachment.path) }
    );
  }

  if (
    attachment.version !== undefined
    && attachment.version !== null
    && String(attachment.version) !== String(version)
  ) {
    throw new WorkspaceRegistryError(
      "ATTACHMENT_VERSION_MISMATCH",
      `Attachment version does not match current content: ${attachment.path}`,
      {
        path: String(attachment.path),
        expectedVersion: String(attachment.version),
        currentVersion: version
      }
    );
  }
  return {
    path: target.requestedPath,
    canonicalPath: target.canonicalPath,
    version,
    access,
    exists: Boolean(info),
    type,
    size
  };
}

export async function inspectAttachments(root, attachments = []) {
  if (!Array.isArray(attachments)) {
    throw new WorkspaceRegistryError("INVALID_ATTACHMENTS", "attachments must be an array.");
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new WorkspaceRegistryError(
      "TOO_MANY_ATTACHMENTS",
      `A task may attach at most ${MAX_ATTACHMENTS} paths.`
    );
  }
  const inspected = await Promise.all(attachments.map((item) => inspectAttachment(root, item)));
  const deduped = new Map();
  for (const item of inspected) deduped.set(normalizedPathKey(item.canonicalPath), item);
  return [...deduped.values()];
}

export function attachmentInsertStep(taskId, item, attachedAt, { conditionalToken = null } = {}) {
  if (conditionalToken === null) {
    return {
      mode: "get",
      sql: `
        INSERT INTO task_attachments(
          task_id, path, canonical_path, version, access,
          exists_at_attach, type, size, attached_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, canonical_path) DO UPDATE SET
          path = excluded.path,
          version = excluded.version,
          access = excluded.access,
          exists_at_attach = excluded.exists_at_attach,
          type = excluded.type,
          size = excluded.size,
          attached_at = excluded.attached_at
        RETURNING *
      `,
      params: [
        taskId,
        item.path,
        item.canonicalPath,
        item.version,
        item.access,
        item.exists ? 1 : 0,
        item.type,
        item.size,
        attachedAt
      ]
    };
  }
  return {
    mode: "get",
    sql: `
      INSERT INTO task_attachments(
        task_id, path, canonical_path, version, access,
        exists_at_attach, type, size, attached_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM tasks
        WHERE id = ? AND status = 'open' AND token = ?
      )
      ON CONFLICT(task_id, canonical_path) DO UPDATE SET
        path = excluded.path,
        version = excluded.version,
        access = excluded.access,
        exists_at_attach = excluded.exists_at_attach,
        type = excluded.type,
        size = excluded.size,
        attached_at = excluded.attached_at
      RETURNING *
    `,
    params: [
      taskId,
      item.path,
      item.canonicalPath,
      item.version,
      item.access,
      item.exists ? 1 : 0,
      item.type,
      item.size,
      attachedAt,
      taskId,
      conditionalToken
    ]
  };
}
