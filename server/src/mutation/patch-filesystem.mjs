// Local Coding Agent patch filesystem, lease and recovery helpers.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { PATCH_MANIFEST_VERSION, PatchTransactionError } from "./patch-contract.mjs";

export function registerOccupiedPath(occupied, candidate, displayPath) {
  const conflict = occupied.find((existing) =>
    candidate === existing ||
    candidate.startsWith(`${existing}${path.sep}`) ||
    existing.startsWith(`${candidate}${path.sep}`)
  );
  if (conflict) {
    throw new PatchTransactionError(
      "OVERLAPPING_PATCH",
      `Patch target overlaps another operation: ${displayPath}`
    );
  }
  occupied.push(candidate);
}

export async function inspectParentState(root, target) {
  const missingParents = [];
  let cursor = path.dirname(target);
  while (comparePath(cursor) !== comparePath(root)) {
    const snapshot = await snapshotPath(cursor);
    if (snapshot.exists) {
      if (snapshot.type !== "directory") {
        throw new PatchTransactionError(
          "PARENT_NOT_DIRECTORY",
          `Patch parent is not a directory: ${cursor}`
        );
      }
      return { existingParent: cursor, missingParents };
    }
    missingParents.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const rootSnapshot = await snapshotPath(root);
  if (!rootSnapshot.exists || rootSnapshot.type !== "directory") {
    throw new PatchTransactionError("WORKSPACE_UNAVAILABLE", `Workspace root is unavailable: ${root}`);
  }
  return { existingParent: root, missingParents };
}

export async function createMissingParents(item) {
  item.created_parents ||= [];
  for (const parent of [...(item.missing_parents || [])].reverse()) {
    try {
      await mkdir(parent);
      item.created_parents.unshift(parent);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const snapshot = await snapshotPath(parent);
      if (!snapshot.exists || snapshot.type !== "directory") {
        throw new PatchTransactionError(
          "PARENT_NOT_DIRECTORY",
          `Patch parent changed before commit: ${parent}`
        );
      }
    }
  }
}

export async function removeCreatedParents(item) {
  // `missing_parents` is persisted before commit, whereas `created_parents`
  // is only an in-memory progress hint. A process can die after mkdir(2) and
  // before that hint reaches disk, so recovery must use the durable preflight
  // set as the source of truth. rmdir is intentionally non-recursive: if an
  // outside actor populated a directory, recovery fails closed instead of
  // deleting their data.
  const candidates = [...new Set([
    ...(item.created_parents || []),
    ...(item.missing_parents || [])
  ])].sort((left, right) => pathDepth(right) - pathDepth(left));
  for (const parent of candidates) {
    try {
      await rmdir(parent);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  item.created_parents = [];
}

export async function acquireLease({ lockDir, workspaceId, owner, leaseMs, timeoutMs }) {
  const safeId = workspaceId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const lockPath = path.join(lockDir, `${safeId}.lock`);
  const fencePath = path.join(lockDir, `${safeId}.fence`);
  const token = randomUUID();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const now = Date.now();
    const record = { workspace_id: workspaceId, owner, token, acquired_at: isoNow(), expires_at_ms: now + leaseMs };
    let handle;
    let createdLock = false;
    try {
      handle = await open(lockPath, "wx", 0o600);
      createdLock = true;
      record.fencing_token = await nextFencingToken(fencePath);
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
      await handle.close();
      const heartbeat = setInterval(async () => {
        const renewed = await renewLease(lockPath, token, record, leaseMs).catch(() => false);
        if (!renewed) clearInterval(heartbeat);
      }, Math.max(1_000, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();
      return {
        workspaceId,
        token,
        fencingToken: record.fencing_token,
        async assertOwned() {
          const current = await readJson(lockPath).catch(() => null);
          if (
            current?.token !== token ||
            Number(current.fencing_token || 0) !== record.fencing_token ||
            Number(current.expires_at_ms || 0) <= Date.now()
          ) {
            throw new PatchTransactionError(
              "FENCING_TOKEN_EXPIRED",
              `Workspace lock ownership was lost: ${workspaceId}`
            );
          }
        },
        async release() {
          clearInterval(heartbeat);
          const current = await readJson(lockPath).catch(() => null);
          if (
            current?.token === token &&
            Number(current.fencing_token || 0) === record.fencing_token &&
            Number(current.expires_at_ms || 0) > Date.now()
          ) {
            await unlink(lockPath).catch(() => {});
          }
        }
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (createdLock) await unlink(lockPath).catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      const current = await readJson(lockPath).catch(() => null);
      if (!current || Number(current.expires_at_ms || 0) <= now) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      await delay(25);
    }
  }
  throw new PatchTransactionError("WORKSPACE_BUSY", `Timed out waiting for workspace lock: ${workspaceId}`);
}

export async function renewLease(lockPath, token, record, leaseMs) {
  let handle;
  try {
    handle = await open(lockPath, "r+");
    const current = JSON.parse(await handle.readFile("utf8"));
    if (
      current?.token !== token ||
      Number(current.fencing_token || 0) !== Number(record.fencing_token || 0)
    ) return false;
    record.expires_at_ms = Date.now() + leaseMs;
    const payload = Buffer.from(JSON.stringify(record));
    await handle.truncate(0);
    await handle.write(payload, 0, payload.length, 0);
    await handle.sync();
    return true;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function nextFencingToken(fencePath) {
  const current = Number(String(await readFile(fencePath, "utf8").catch(() => "0")).trim() || 0);
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new PatchTransactionError(
      "FENCING_COUNTER_INVALID",
      "Workspace fencing counter is invalid or exhausted."
    );
  }
  const next = current + 1;
  const temp = `${fencePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(`${next}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, fencePath);
    const directory = await open(path.dirname(fencePath), "r").catch(() => null);
    if (directory) {
      try {
        await directory.sync();
      } finally {
        await directory.close().catch(() => {});
      }
    }
    return next;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function operationResult(item) {
  const outputPath = item.op === "rename" ? item.destination : item.target;
  const after = await snapshotPath(outputPath);
  return {
    workspace_id: item.workspace_id,
    op: item.op,
    path: item.path,
    ...(item.rename_to ? { rename_to: item.rename_to } : {}),
    version: after.version,
    ok: true
  };
}

export async function snapshotPath(target) {
  const info = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { exists: false, type: "missing", version: "missing", content: null, mode: null };
  if (info.isSymbolicLink()) throw new PatchTransactionError("SYMLINK_REJECTED", `Refusing to mutate symlink: ${target}`);
  if (info.isDirectory()) {
    return {
      exists: true,
      type: "directory",
      version: `dir:${info.dev}:${info.ino}:${Math.trunc(info.mtimeMs)}`,
      content: null,
      mode: info.mode
    };
  }
  if (!info.isFile()) throw new PatchTransactionError("UNSUPPORTED_PATH", `Unsupported filesystem entry: ${target}`);
  const content = await readFile(target);
  return { exists: true, type: "file", version: sha256(content), content, mode: info.mode };
}

export function serializableSnapshot(snapshot) {
  return {
    exists: snapshot.exists,
    type: snapshot.type,
    version: snapshot.version,
    mode: snapshot.mode
  };
}

export async function resolveInside(root, relativePath) {
  const raw = String(relativePath || "").trim();
  if (!raw || path.isAbsolute(raw)) throw new PatchTransactionError("INVALID_PATH", "Patch paths must be non-empty and relative");
  const target = path.resolve(root, raw);
  const canonical = await canonicalizeMissing(target);
  if (!isInsideOrEqual(canonical, root)) {
    throw new PatchTransactionError("PATH_OUTSIDE_WORKSPACE", `Path resolves outside workspace: ${relativePath}`);
  }
  return target;
}

export async function canonicalizeMissing(target) {
  let cursor = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return tail.length ? path.join(existing, ...tail.reverse()) : existing;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function atomicJsonWrite(target, value, { replacer = null } = {}) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, replacer, 2), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, target);
    // fsync the parent where supported so the rename itself is durable across
    // a process/host crash, not merely visible in the page cache.
    const directory = await open(path.dirname(target), "r").catch(() => null);
    if (directory) {
      try {
        await directory.sync();
      } finally {
        await directory.close().catch(() => {});
      }
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

export async function pathExists(target) {
  return Boolean(await stat(target).catch(() => null));
}

export function normalizeRelative(value) {
  return String(value).split(path.sep).join("/").replace(/^\.\//, "");
}

export function comparePath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

export function pathDepth(value) {
  return path.resolve(value).split(path.sep).filter(Boolean).length;
}

export function isInsideOrEqual(candidate, root) {
  const target = comparePath(candidate);
  const base = comparePath(root);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

export function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function isoNow() {
  return new Date().toISOString();
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateTransactionId(value) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(id)) {
    throw new PatchTransactionError("INVALID_TRANSACTION_ID", "Invalid transaction ID.");
  }
  return id;
}

export function validateRecoveryManifest(manifest, fileName) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be an object");
  }
  const expectedId = String(fileName || "").replace(/\.json$/i, "");
  if (validateTransactionId(manifest.id) !== expectedId) {
    throw new Error("manifest ID does not match its filename");
  }
  if (Number(manifest.manifest_version) !== PATCH_MANIFEST_VERSION) {
    throw new Error(`unsupported manifest version: ${manifest.manifest_version}`);
  }
  if (!["preparing", "staged", "committing", "committed", "complete", "in_doubt", "rolled_back"].includes(manifest.status)) {
    throw new Error(`invalid transaction status: ${manifest.status}`);
  }
  if (!Array.isArray(manifest.workspace_ids) || manifest.workspace_ids.length === 0) {
    throw new Error("workspace_ids must be a non-empty array");
  }
  if (!Array.isArray(manifest.operations) || manifest.operations.length === 0) {
    throw new Error("operations must be a non-empty array");
  }
}
