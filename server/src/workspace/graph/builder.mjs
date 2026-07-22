// Local Coding Agent short-lived workspace index builder
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { WorkspaceGraph, persistedFileIdentity } from "./workspace-graph.mjs";

const PROTOCOL_VERSION = 1;
let handled = false;

if (process.env.LCA_WORKSPACE_GRAPH_BUILDER !== "1" || typeof process.send !== "function") {
  throw new Error("workspace-graph-builder must run as a private LCA child process.");
}

process.on("message", (message) => {
  if (handled) return;
  handled = true;
  void buildWorkspaceIndex(message).then(
    (receipt) => finish({ type: "result", nonce: message?.nonce, receipt }),
    (error) => finish({
      type: "error",
      nonce: message?.nonce,
      error: {
        code: safeCode(error?.code, "INDEX_BUILDER_FAILED"),
        message: safeMessage(error)
      }
    })
  );
});

process.send({ type: "ready", protocol_version: PROTOCOL_VERSION });

async function buildWorkspaceIndex(message) {
  const config = validateRequest(message);
  const started = performance.now();
  const rootDir = await validateWorkspaceRoot(config.root_dir);
  const persistencePath = await validatePersistenceTarget(
    config.persistence_path,
    config.persistence_root
  );
  let graph;
  try {
    graph = new WorkspaceGraph({
      rootDir,
      workspaceId: config.workspace_id,
      skipDirs: config.skip_dirs,
      maxFiles: config.coverage.max_files,
      maxDepth: config.coverage.max_depth,
      maxFileBytes: config.coverage.max_file_bytes,
      scanConcurrency: config.scan_concurrency,
      reconcileIntervalMs: 60_000,
      watch: false,
      queryFingerprint: false,
      persistencePath,
      persistenceDebounceMs: 0,
      maxPersistedCompressedBytes: config.max_persisted_compressed_bytes,
      maxPersistedRawBytes: config.max_persisted_raw_bytes
    });
    const snapshot = await graph.refresh({
      ...config.coverage,
      replaceCoverage: true
    });
    const persistence = await graph.flushPersistence();
    if (!persistence.saved_at || persistence.error) {
      const error = new Error("Workspace index builder could not persist its result.");
      error.code = persistence.error?.code || "INDEX_BUILDER_PERSIST_FAILED";
      throw error;
    }
    await graph.close({ flushPersistence: false });
    graph = null;
    const fileInfo = await stat(persistencePath, { bigint: true });
    const completedAt = new Date().toISOString();
    return {
      protocol_version: PROTOCOL_VERSION,
      child_pid: process.pid,
      workspace_id: config.workspace_id,
      root_identity: createHash("sha256").update(rootDir).digest("hex"),
      workspace_fingerprint: snapshot.fingerprint,
      coverage_fingerprint: snapshot.coverage.coverage_fingerprint,
      checked_at: snapshot.freshness.checked_at,
      completed_at: completedAt,
      duration_ms: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
      persistence_saved_at: persistence.saved_at,
      persistence_compressed_bytes: persistence.compressed_bytes,
      persistence_raw_bytes: persistence.raw_bytes,
      persistence_shard_count: persistence.shard_count,
      file_identity: persistedFileIdentity(fileInfo),
      counts: {
        files: snapshot.counts.files,
        parsed_files: snapshot.changes.parsed_files,
        reused_files: snapshot.changes.reused_files
      }
    };
  } finally {
    await graph?.close().catch(() => {});
  }
}

function validateRequest(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) invalidRequest();
  if (
    message.type !== "build" ||
    message.protocol_version !== PROTOCOL_VERSION ||
    typeof message.nonce !== "string" ||
    !/^[a-f0-9]{32,128}$/.test(message.nonce) ||
    typeof message.root_dir !== "string" ||
    !path.isAbsolute(message.root_dir) ||
    typeof message.persistence_path !== "string" ||
    !path.isAbsolute(message.persistence_path) ||
    typeof message.persistence_root !== "string" ||
    !path.isAbsolute(message.persistence_root) ||
    typeof message.workspace_id !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(message.workspace_id) ||
    typeof message.root_identity !== "string" ||
    !/^[a-f0-9]{64}$/.test(message.root_identity)
  ) invalidRequest();
  const coverage = message.coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) invalidRequest();
  const normalizedCoverage = {
    max_files: boundedInteger(coverage.max_files, 1, 250_000),
    max_depth: boundedInteger(coverage.max_depth, 1, 64),
    max_file_bytes: boundedInteger(coverage.max_file_bytes, 64, 8 * 1024 * 1024)
  };
  const skipDirs = Array.isArray(message.skip_dirs)
    ? [...new Set(message.skip_dirs.map(String))]
    : [];
  if (
    skipDirs.length > 256 ||
    skipDirs.some((entry) => !entry || entry.length > 255 || entry.includes("/") || entry.includes("\\") || entry === "." || entry === "..")
  ) invalidRequest();
  return {
    root_dir: path.resolve(message.root_dir),
    persistence_path: path.resolve(message.persistence_path),
    persistence_root: path.resolve(message.persistence_root),
    workspace_id: message.workspace_id,
    root_identity: message.root_identity,
    coverage: normalizedCoverage,
    skip_dirs: skipDirs,
    scan_concurrency: boundedInteger(message.scan_concurrency, 1, 64),
    max_persisted_compressed_bytes: boundedInteger(
      message.max_persisted_compressed_bytes,
      64 * 1024,
      2 * 1024 * 1024 * 1024
    ),
    max_persisted_raw_bytes: boundedInteger(
      message.max_persisted_raw_bytes,
      64 * 1024,
      2 * 1024 * 1024 * 1024
    )
  };
}

async function validateWorkspaceRoot(requestedRoot) {
  const info = await lstat(requestedRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    const error = new Error("Workspace root must be a real directory.");
    error.code = "INDEX_BUILDER_ROOT_INVALID";
    throw error;
  }
  const canonical = await realpath(requestedRoot);
  if (!sameCanonicalPath(canonical, path.resolve(requestedRoot))) {
    const error = new Error("Workspace root must already be canonical.");
    error.code = "INDEX_BUILDER_ROOT_NOT_CANONICAL";
    throw error;
  }
  return canonical;
}

async function validatePersistenceTarget(requestedTarget, requestedRoot) {
  const rootInfo = await lstat(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    const error = new Error("Index persistence root must be a real directory.");
    error.code = "INDEX_BUILDER_PERSISTENCE_ROOT_INVALID";
    throw error;
  }
  const canonicalRoot = await realpath(requestedRoot);
  if (!sameCanonicalPath(canonicalRoot, path.resolve(requestedRoot))) {
    const error = new Error("Index persistence root must already be canonical.");
    error.code = "INDEX_BUILDER_PERSISTENCE_ROOT_NOT_CANONICAL";
    throw error;
  }
  const target = path.resolve(requestedTarget);
  const relative = path.relative(canonicalRoot, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    const error = new Error("Index persistence path must stay inside its configured root.");
    error.code = "INDEX_BUILDER_PERSISTENCE_ESCAPE";
    throw error;
  }
  await createPrivateDirectoryChain(canonicalRoot, path.dirname(target));
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      const error = new Error("Existing index persistence target is not a regular file.");
      error.code = "INDEX_BUILDER_PERSISTENCE_TARGET_INVALID";
      throw error;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

async function createPrivateDirectoryChain(rootDir, targetDirectory) {
  const relative = path.relative(rootDir, targetDirectory);
  let current = rootDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        const error = new Error("Index persistence directory chain is unsafe.");
        error.code = "INDEX_BUILDER_PERSISTENCE_DIRECTORY_INVALID";
        throw error;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

function boundedInteger(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) invalidRequest();
  return parsed;
}

function sameCanonicalPath(left, right) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function invalidRequest() {
  const error = new Error("Workspace index builder request is invalid.");
  error.code = "INDEX_BUILDER_REQUEST_INVALID";
  throw error;
}

function safeCode(value, fallback) {
  const code = String(value || fallback).toUpperCase();
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : fallback;
}

function safeMessage(error) {
  const message = String(error?.message || "Workspace index builder failed.")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
  return message || "Workspace index builder failed.";
}

function finish(message) {
  try {
    process.send(message, () => {
      process.disconnect();
    });
  } catch {
    process.exitCode = 1;
    process.disconnect?.();
  }
}
