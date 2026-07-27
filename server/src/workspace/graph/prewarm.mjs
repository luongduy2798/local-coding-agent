// Local Coding Agent workspace graph cold-start orchestration
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = 1;
const BUILDER_PATH = fileURLToPath(new URL("./builder.mjs", import.meta.url));
const ACTIVE_BUILD_RECEIPTS = new Map();

export async function prewarmWorkspaceGraphInChild(graph, {
  persistenceRoot,
  timeoutMs = 120_000,
  fallbackToMain = true,
  builderPath = BUILDER_PATH,
  signal = null
} = {}) {
  assertGraph(graph);
  if (!graph.persistencePath) {
    throw builderError(
      "INDEX_BUILDER_PERSISTENCE_REQUIRED",
      "Child-process prewarm requires a workspace-scoped persistence path."
    );
  }
  const allowedPersistenceRoot = path.resolve(String(persistenceRoot || ""));
  if (!persistenceRoot || !path.isAbsolute(allowedPersistenceRoot)) {
    throw builderError(
      "INDEX_BUILDER_PERSISTENCE_ROOT_REQUIRED",
      "Child-process prewarm requires an absolute persistence root."
    );
  }
  timeoutMs = boundedInteger(timeoutMs, 120_000, 1_000, 600_000);
  await mkdir(allowedPersistenceRoot, { recursive: true, mode: 0o700 });

  try {
    // Start the parent watcher without loading or validating a possibly stale
    // index. Events collected while the child scans are retained and applied
    // by adoptExternalPrewarm() before this promise resolves.
    await graph.initialize({ loadPersistence: false });
    await waitForWatcherInitialization(graph, Math.min(5_000, timeoutMs / 4), signal);
    const watcherRevisionAtBuildStart = Number(graph.watcherStatus?.().revision || 0);
    const request = createBuilderRequest(graph, allowedPersistenceRoot);
    const key = `${graph.rootDir}\0${graph.persistencePath}\0${coverageKey(request.coverage)}`;
    let build = ACTIVE_BUILD_RECEIPTS.get(key);
    if (!build) {
      build = runBuilderProcess(request, {
        timeoutMs,
        builderPath: path.resolve(String(builderPath)),
        signal
      });
      ACTIVE_BUILD_RECEIPTS.set(key, build);
      void build.finally(() => {
        if (ACTIVE_BUILD_RECEIPTS.get(key) === build) ACTIVE_BUILD_RECEIPTS.delete(key);
      }).catch(() => {});
    }
    const receipt = await build;
    const adopted = await graph.adoptExternalPrewarm(receipt, {
      ...request.coverage,
      externalConsumeWatchThrough: watcherRevisionAtBuildStart
    });
    return {
      ...adopted,
      external_builder: {
        ...adopted.external_builder,
        fallback: adopted.external_builder?.main_reconciliation === "full",
        counts: receipt.counts
      }
    };
  } catch (error) {
    if (!fallbackToMain || signal?.aborted) throw error;
    const fallback = await graph.prewarm();
    return {
      ...fallback,
      external_builder: {
        fallback: true,
        code: safeCode(error?.code, "INDEX_BUILDER_FAILED")
      }
    };
  }
}

export async function persistWorkspaceGraphInChild(graph, {
  timeoutMs = 120_000,
  builderPath = BUILDER_PATH,
  signal = null
} = {}) {
  assertGraph(graph);
  if (!graph.rootDir || !graph.persistencePath) {
    throw builderError(
      "INDEX_BUILDER_PERSISTENCE_REQUIRED",
      "Child-process persistence requires an initialized workspace graph and persistence path."
    );
  }
  const persistenceRoot = path.dirname(graph.persistencePath);
  await mkdir(persistenceRoot, { recursive: true, mode: 0o700 });
  const request = createBuilderRequest(graph, persistenceRoot);
  return runBuilderProcess(request, {
    timeoutMs: boundedInteger(timeoutMs, 120_000, 1_000, 600_000),
    builderPath: path.resolve(String(builderPath)),
    signal
  });
}

export function activeWorkspaceGraphBuildCount() {
  return ACTIVE_BUILD_RECEIPTS.size;
}

function createBuilderRequest(graph, persistenceRoot) {
  return {
    type: "build",
    protocol_version: PROTOCOL_VERSION,
    nonce: randomBytes(32).toString("hex"),
    root_dir: graph.rootDir,
    root_identity: createHash("sha256").update(String(graph.rootDir)).digest("hex"),
    workspace_id: graph.workspaceId,
    persistence_path: graph.persistencePath,
    persistence_root: persistenceRoot,
    coverage: {
      max_files: graph.defaults.max_files,
      max_depth: graph.defaults.max_depth,
      max_file_bytes: graph.defaults.max_file_bytes
    },
    skip_dirs: [...graph.skipDirs],
    scan_concurrency: graph.scanConcurrency,
    max_persisted_compressed_bytes: graph.maxPersistedCompressedBytes,
    max_persisted_raw_bytes: graph.maxPersistedRawBytes
  };
}

function runBuilderProcess(request, { timeoutMs, builderPath, signal }) {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const child = fork(builderPath, [], {
      cwd: path.dirname(builderPath),
      env: childEnvironment(),
      execArgv: [],
      serialization: "advanced",
      silent: true,
      windowsHide: true
    });
    let settled = false;
    let requestSent = false;
    let receipt = null;
    let reportedError = null;
    let stderr = "";
    let terminateTimer = null;

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(terminateTimer);
      signal?.removeEventListener?.("abort", onAbort);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      child.stderr?.removeAllListeners("data");
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      terminateTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      terminateTimer.unref?.();
    };
    const onAbort = () => {
      reportedError = abortError();
      terminate();
    };
    const timeout = setTimeout(() => {
      reportedError = builderError(
        "INDEX_BUILDER_TIMEOUT",
        `Workspace index builder exceeded its ${timeoutMs}ms deadline.`
      );
      terminate();
    }, timeoutMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.stderr?.on("data", (chunk) => {
      if (stderr.length >= 16_384) return;
      stderr += String(chunk).slice(0, 16_384 - stderr.length);
    });
    child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "ready") {
        if (requestSent || message.protocol_version !== PROTOCOL_VERSION) {
          reportedError = builderError("INDEX_BUILDER_PROTOCOL_ERROR", "Workspace index builder protocol mismatch.");
          terminate();
          return;
        }
        requestSent = true;
        child.send(request);
        return;
      }
      if (message.nonce !== request.nonce) {
        reportedError = builderError("INDEX_BUILDER_PROTOCOL_ERROR", "Workspace index builder returned an invalid nonce.");
        terminate();
        return;
      }
      if (message.type === "result") {
        if (!validReceiptShape(message.receipt, request)) {
          reportedError = builderError("INDEX_BUILDER_PROTOCOL_ERROR", "Workspace index builder returned an invalid receipt.");
          terminate();
          return;
        }
        receipt = message.receipt;
      } else if (message.type === "error") {
        reportedError = builderError(
          safeCode(message.error?.code, "INDEX_BUILDER_FAILED"),
          String(message.error?.message || "Workspace index builder failed.").slice(0, 500)
        );
      }
    });
    child.once("error", (error) => {
      finish(builderError("INDEX_BUILDER_SPAWN_FAILED", error?.message || "Workspace index builder could not start."));
    });
    child.once("exit", (code, childSignal) => {
      if (reportedError) {
        finish(reportedError);
      } else if (code !== 0 || childSignal || !receipt) {
        const suffix = stderr.trim() ? ` (${stderr.trim().slice(0, 300)})` : "";
        finish(builderError(
          "INDEX_BUILDER_EXIT_FAILED",
          `Workspace index builder exited before returning a valid result${suffix}.`
        ));
      } else {
        finish(null, receipt);
      }
    });
  });
}

function validReceiptShape(receipt, request) {
  return Boolean(
    receipt &&
    typeof receipt === "object" &&
    !Array.isArray(receipt) &&
    receipt.protocol_version === PROTOCOL_VERSION &&
    receipt.workspace_id === request.workspace_id &&
    receipt.root_identity === request.root_identity &&
    Number.isInteger(receipt.child_pid) &&
    receipt.child_pid > 0 &&
    receipt.child_pid !== process.pid &&
    typeof receipt.workspace_fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(receipt.workspace_fingerprint) &&
    typeof receipt.coverage_fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(receipt.coverage_fingerprint) &&
    typeof receipt.persistence_saved_at === "string" &&
    Number.isFinite(Date.parse(receipt.persistence_saved_at)) &&
    Number.isInteger(receipt.persistence_compressed_bytes) &&
    receipt.persistence_compressed_bytes > 0 &&
    Number.isInteger(receipt.persistence_raw_bytes) &&
    receipt.persistence_raw_bytes > 0 &&
    Number.isInteger(receipt.persistence_shard_count) &&
    receipt.persistence_shard_count > 0 &&
    receipt.file_identity &&
    typeof receipt.file_identity === "object"
  );
}

function childEnvironment() {
  const environment = { LCA_WORKSPACE_GRAPH_BUILDER: "1" };
  for (const key of [
    "PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
    "LANG", "LC_ALL", "LC_CTYPE"
  ]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  return environment;
}

async function waitForWatcherInitialization(graph, timeoutMs, signal) {
  if (typeof graph.watcherStatus !== "function") return;
  const initial = graph.watcherStatus();
  if (!initial.requested || initial.ready === true || initial.error || !initial.active) return;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = graph.watcherStatus();
    if (status.ready === true || status.error || !status.active) return;
  }
}

function assertGraph(graph) {
  if (
    !graph ||
    typeof graph.initialize !== "function" ||
    typeof graph.adoptExternalPrewarm !== "function" ||
    typeof graph.prewarm !== "function"
  ) {
    throw new TypeError("prewarmWorkspaceGraphInChild requires a WorkspaceGraph instance.");
  }
}

function coverageKey(coverage) {
  return `${coverage.max_files}:${coverage.max_depth}:${coverage.max_file_bytes}`;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function abortError() {
  return builderError("INDEX_BUILDER_ABORTED", "Workspace index builder was aborted.");
}

function builderError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeCode(value, fallback) {
  const code = String(value || fallback).toUpperCase();
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : fallback;
}
