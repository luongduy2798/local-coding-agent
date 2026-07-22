// Local Coding Agent short-lived workspace index validator
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";
import { WorkspaceGraph } from "./workspace-graph.mjs";

const PROTOCOL_VERSION = 1;
let handled = false;

if (process.env.LCA_WORKSPACE_GRAPH_VALIDATOR !== "1" || typeof process.send !== "function") {
  throw new Error("workspace-graph-validator must run as a private LCA child process.");
}

process.on("message", (message) => {
  if (handled) return;
  handled = true;
  void validate(message).then(
    (receipt) => finish({ type: "result", nonce: message?.nonce, receipt }),
    (error) => finish({
      type: "error",
      nonce: message?.nonce,
      error: {
        code: safeCode(error?.code, "INDEX_VALIDATOR_FAILED"),
        message: String(error?.message || "Workspace index validation failed.").slice(0, 500)
      }
    })
  );
});

process.send({ type: "ready", protocol_version: PROTOCOL_VERSION });

async function validate(message) {
  const config = validateRequest(message);
  let graph;
  try {
    graph = new WorkspaceGraph({
      rootDir: config.root_dir,
      workspaceId: config.workspace_id,
      skipDirs: config.skip_dirs,
      maxFiles: config.coverage.max_files,
      maxDepth: config.coverage.max_depth,
      maxFileBytes: config.coverage.max_file_bytes,
      scanConcurrency: config.scan_concurrency,
      reconcileIntervalMs: 60_000,
      watch: false,
      queryFingerprint: false,
      persistencePath: config.persistence_path,
      packedRecordThreshold: config.packed_record_threshold,
      maxPersistedCompressedBytes: config.max_persisted_compressed_bytes,
      maxPersistedRawBytes: config.max_persisted_raw_bytes
    });
    await graph.initialize();
    if (!graph.persistenceStatus().loaded) {
      const error = new Error("Workspace index validator could not load the persisted index.");
      error.code = graph.persistenceStatus().error?.code || "INDEX_VALIDATOR_LOAD_FAILED";
      throw error;
    }
    const probe = await graph.validatePersistedStateLocal();
    return {
      protocol_version: PROTOCOL_VERSION,
      workspace_id: config.workspace_id,
      root_dir: graph.rootDir,
      probe
    };
  } finally {
    await graph?.close({ flushPersistence: false }).catch(() => {});
  }
}

function validateRequest(message) {
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    message.type !== "validate" ||
    message.protocol_version !== PROTOCOL_VERSION ||
    typeof message.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(message.nonce) ||
    typeof message.root_dir !== "string" ||
    !path.isAbsolute(message.root_dir) ||
    typeof message.persistence_path !== "string" ||
    !path.isAbsolute(message.persistence_path) ||
    typeof message.workspace_id !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(message.workspace_id)
  ) invalidRequest();
  const coverage = message.coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) invalidRequest();
  const skipDirs = Array.isArray(message.skip_dirs)
    ? [...new Set(message.skip_dirs.map(String))]
    : [];
  if (
    skipDirs.length > 256 ||
    skipDirs.some((entry) => !entry || entry.length > 255 || entry.includes("/") || entry.includes("\\"))
  ) invalidRequest();
  return {
    root_dir: path.resolve(message.root_dir),
    workspace_id: message.workspace_id,
    persistence_path: path.resolve(message.persistence_path),
    coverage: {
      max_files: boundedInteger(coverage.max_files, 1, 250_000),
      max_depth: boundedInteger(coverage.max_depth, 0, 64),
      max_file_bytes: boundedInteger(coverage.max_file_bytes, 64, 8 * 1024 * 1024)
    },
    skip_dirs: skipDirs,
    scan_concurrency: boundedInteger(message.scan_concurrency, 1, 64),
    packed_record_threshold: boundedInteger(message.packed_record_threshold, 1, 250_000),
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

function invalidRequest() {
  const error = new Error("Workspace index validator request is invalid.");
  error.code = "INDEX_VALIDATOR_REQUEST_INVALID";
  throw error;
}

function boundedInteger(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) invalidRequest();
  return parsed;
}

function safeCode(value, fallback) {
  const selected = String(value || fallback);
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(selected) ? selected : fallback;
}

function finish(message) {
  process.send?.(message, () => process.exit(message.type === "result" ? 0 : 1));
}
