// Local Coding Agent workspace graph validation orchestration
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = 1;
const VALIDATOR_PATH = fileURLToPath(new URL("./validator.mjs", import.meta.url));

export function validateWorkspaceGraphInChild(graph, { timeoutMs = 120_000 } = {}) {
  if (!graph?.rootDir || !graph?.persistencePath || !graph?.coverage) {
    throw new TypeError("Child validation requires an initialized persisted WorkspaceGraph.");
  }
  const request = {
    type: "validate",
    protocol_version: PROTOCOL_VERSION,
    nonce: randomBytes(32).toString("hex"),
    root_dir: graph.rootDir,
    workspace_id: graph.workspaceId,
    persistence_path: graph.persistencePath,
    coverage: {
      max_files: graph.coverage.max_files,
      max_depth: graph.coverage.max_depth,
      max_file_bytes: graph.coverage.max_file_bytes
    },
    skip_dirs: [...graph.skipDirs],
    scan_concurrency: graph.scanConcurrency,
    packed_record_threshold: graph.packedRecordThreshold,
    max_persisted_compressed_bytes: graph.maxPersistedCompressedBytes,
    max_persisted_raw_bytes: graph.maxPersistedRawBytes
  };
  return new Promise((resolve, reject) => {
    const child = fork(VALIDATOR_PATH, [], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env: validatorEnvironment(),
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
      child.removeAllListeners();
      child.stderr?.removeAllListeners();
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
    const timeout = setTimeout(() => {
      reportedError = validatorError(
        "INDEX_VALIDATOR_TIMEOUT",
        `Workspace index validation exceeded its ${timeoutMs}ms deadline.`
      );
      terminate();
    }, boundedInteger(timeoutMs, 120_000, 1_000, 600_000));
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += String(chunk).slice(0, 16_384 - stderr.length);
    });
    child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "ready") {
        if (requestSent || message.protocol_version !== PROTOCOL_VERSION) {
          reportedError = validatorError("INDEX_VALIDATOR_PROTOCOL_ERROR", "Workspace index validator protocol mismatch.");
          terminate();
          return;
        }
        requestSent = true;
        child.send(request);
        return;
      }
      if (message.nonce !== request.nonce) {
        reportedError = validatorError("INDEX_VALIDATOR_PROTOCOL_ERROR", "Workspace index validator returned an invalid nonce.");
        terminate();
        return;
      }
      if (message.type === "result") {
        if (!validReceipt(message.receipt, request)) {
          reportedError = validatorError("INDEX_VALIDATOR_PROTOCOL_ERROR", "Workspace index validator returned an invalid receipt.");
          terminate();
          return;
        }
        receipt = message.receipt;
      } else if (message.type === "error") {
        reportedError = validatorError(
          safeCode(message.error?.code, "INDEX_VALIDATOR_FAILED"),
          String(message.error?.message || "Workspace index validation failed.").slice(0, 500)
        );
      }
    });
    child.once("error", (error) => {
      finish(validatorError("INDEX_VALIDATOR_SPAWN_FAILED", error?.message || "Workspace index validator could not start."));
    });
    child.once("exit", (code, signal) => {
      if (reportedError) finish(reportedError);
      else if (code !== 0 || signal || !receipt) {
        const suffix = stderr.trim() ? ` (${stderr.trim().slice(0, 300)})` : "";
        finish(validatorError(
          "INDEX_VALIDATOR_EXIT_FAILED",
          `Workspace index validator exited before returning a valid result${suffix}.`
        ));
      } else finish(null, receipt.probe);
    });
  });
}

function validReceipt(receipt, request) {
  const probe = receipt?.probe;
  return Boolean(
    receipt &&
    receipt.protocol_version === PROTOCOL_VERSION &&
    receipt.workspace_id === request.workspace_id &&
    receipt.root_dir === request.root_dir &&
    probe &&
    typeof probe === "object" &&
    typeof probe.matched === "boolean" &&
    Number.isInteger(probe.count) &&
    probe.count >= 0 &&
    typeof probe.complete === "boolean" &&
    typeof probe.truncatedByFileLimit === "boolean" &&
    typeof probe.truncatedByDepth === "boolean" &&
    Number.isInteger(probe.unreadableFiles) &&
    Number.isInteger(probe.unreadableDirectories)
  );
}

function validatorEnvironment() {
  const output = { LCA_WORKSPACE_GRAPH_VALIDATOR: "1" };
  for (const key of [
    "PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
    "LANG", "LC_ALL", "LC_CTYPE"
  ]) {
    if (typeof process.env[key] === "string") output[key] = process.env[key];
  }
  return output;
}

function validatorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeCode(value, fallback) {
  const selected = String(value || fallback);
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(selected) ? selected : fallback;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
