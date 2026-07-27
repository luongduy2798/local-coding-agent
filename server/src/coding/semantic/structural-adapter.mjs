// Local Coding Agent built-in structural semantic adapter
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { prepareStructuralSemanticArtifact } from "./artifacts.mjs";

export const STRUCTURAL_AST_LANGUAGES = Object.freeze([
  "javascript", "typescript", "python", "go", "rust", "java", "kotlin", "csharp", "dart"
]);

const SUPPORTED_MODES = new Set([
  "symbol", "definition", "references", "imports", "callers", "callees", "type"
]);

export async function discoverBuiltinStructuralSemanticAdapter({ rootDir, dataDir, ...options } = {}) {
  if (!rootDir) throw adapterError("STRUCTURAL_WORKSPACE_REQUIRED", "Structural adapter requires rootDir.");
  const requested = path.resolve(String(rootDir));
  const info = await lstat(requested).catch((error) => {
    throw adapterError("STRUCTURAL_WORKSPACE_UNAVAILABLE", "Workspace root is unavailable.", error);
  });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw adapterError("STRUCTURAL_WORKSPACE_INVALID", "Workspace root must be a real directory.");
  }
  const artifact = await prepareStructuralSemanticArtifact({ dataDir });
  return new BuiltinStructuralSemanticAdapter({
    rootDir: await realpath(requested),
    artifact,
    ...options
  });
}

/**
 * The parser runs in a disposable worker. It tokenizes source while tracking
 * comments, strings, declarations and lexical scopes; it never executes a
 * project binary or installs a grammar. Terminating the worker is a hard AST
 * timeout, so the lexical graph remains available under pathological input.
 */
export class BuiltinStructuralSemanticAdapter {
  constructor({
    rootDir,
    artifact,
    maxFiles = 100_000,
    maxSourceBytes = 64 * 1024 * 1024,
    maxFileBytes = 2 * 1024 * 1024,
    maxResults = 10_000,
    workerMaxOldGenerationMb = 192
  } = {}) {
    if (!rootDir) throw adapterError("STRUCTURAL_WORKSPACE_REQUIRED", "Structural adapter requires rootDir.");
    this.rootDir = path.resolve(String(rootDir));
    this.artifact = artifact;
    this.workerUrl = artifact?.workerUrl || new URL("./structural-worker.mjs", import.meta.url);
    this.maxFiles = boundedInteger(maxFiles, 100_000, 1, 250_000);
    this.maxSourceBytes = boundedInteger(maxSourceBytes, 64 * 1024 * 1024, 64 * 1024, 512 * 1024 * 1024);
    this.maxFileBytes = boundedInteger(maxFileBytes, 2 * 1024 * 1024, 8 * 1024, 8 * 1024 * 1024);
    this.maxResults = boundedInteger(maxResults, 10_000, 100, 100_000);
    this.workerMaxOldGenerationMb = boundedInteger(workerMaxOldGenerationMb, 192, 64, 1_024);
    this.kind = "ast";
    this.engine = "builtin-structural-ast-v1";
    this.discovery = "builtin";
    this.packageVersion = "1";
    this.hardPreemptible = true;
    this.warm = true;
    this._closed = false;
    this._workers = new Set();
  }

  async query({ graph, query, mode, limit = 50, signal, languages } = {}) {
    if (this._closed) throw adapterError("STRUCTURAL_ADAPTER_CLOSED", "Structural adapter is closed.");
    if (!graph || path.resolve(String(graph.rootDir || "")) !== this.rootDir) {
      throw adapterError("STRUCTURAL_WORKSPACE_MISMATCH", "Structural adapter is bound to a different workspace.");
    }
    if (!SUPPORTED_MODES.has(mode)) {
      return {
        engine: this.engine,
        complete: false,
        confidence: 0.5,
        fallback_reason: "structural_mode_unsupported",
        results: []
      };
    }
    if (signal?.aborted) throw abortError(signal.reason);
    const selectedLanguages = [...new Set(
      (Array.isArray(languages) && languages.length ? languages : STRUCTURAL_AST_LANGUAGES)
        .map(String)
        .filter((language) => STRUCTURAL_AST_LANGUAGES.includes(language))
    )];
    if (!selectedLanguages.length) {
      return {
        engine: this.engine,
        complete: false,
        confidence: 0.5,
        fallback_reason: "structural_language_unsupported",
        results: []
      };
    }
    const nonce = randomUUID();
    const worker = new Worker(this.workerUrl, {
      workerData: {
        protocol: "lca-structural-semantic-v1",
        nonce,
        rootDir: this.rootDir,
        workspaceId: String(graph.workspaceId || ""),
        query: String(query || ""),
        mode: String(mode),
        limit: boundedInteger(limit, 50, 1, 500),
        languages: selectedLanguages,
        graphComplete: graph.coverage?.complete === true,
        contentComplete: graph.coverage?.content_complete === true,
        maxFiles: this.maxFiles,
        maxSourceBytes: this.maxSourceBytes,
        maxFileBytes: this.maxFileBytes,
        maxResults: this.maxResults
      },
      resourceLimits: { maxOldGenerationSizeMb: this.workerMaxOldGenerationMb }
    });
    this._workers.add(worker);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.("abort", onAbort);
        this._workers.delete(worker);
        worker.terminate().catch(() => {});
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => finish(abortError(signal?.reason));
      signal?.addEventListener?.("abort", onAbort, { once: true });
      worker.once("message", (message) => {
        if (!message || message.protocol !== "lca-structural-semantic-v1" || message.nonce !== nonce) {
          finish(adapterError("STRUCTURAL_WORKER_PROTOCOL_INVALID", "Structural worker returned an invalid response."));
          return;
        }
        if (message.error) {
          finish(adapterError(
            String(message.error.code || "STRUCTURAL_WORKER_FAILED"),
            String(message.error.message || "Structural worker failed.")
          ));
          return;
        }
        finish(null, message.value);
      });
      worker.once("error", (error) => finish(
        adapterError("STRUCTURAL_WORKER_FAILED", "Structural worker failed.", error)
      ));
      worker.once("exit", (code) => {
        if (!settled) finish(adapterError(
          "STRUCTURAL_WORKER_EXITED",
          `Structural worker exited before completing its query (${code}).`
        ));
      });
    });
  }

  async close() {
    this._closed = true;
    const workers = [...this._workers];
    this._workers.clear();
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function adapterError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "StructuralSemanticAdapterError";
  error.code = code;
  return error;
}

function abortError(reason) {
  const error = new Error(reason instanceof Error ? reason.message : "Structural semantic query was cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}
