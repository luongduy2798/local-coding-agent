// Local Coding Agent preemptible TypeScript semantic worker
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parentPort, workerData } from "node:worker_threads";
import { TypeScriptSemanticAdapter } from "./typescript-adapter.mjs";

if (!parentPort || !workerData || workerData.protocol !== "lca-typescript-semantic-v1") {
  throw new Error("Invalid TypeScript semantic worker bootstrap.");
}

const nonce = String(workerData.nonce || "");
const adapter = new TypeScriptSemanticAdapter(workerData.adapter);
let snapshot = null;

parentPort.on("message", async (message) => {
  if (!message || message.protocol !== "lca-typescript-semantic-v1" || message.nonce !== nonce) return;
  if (message.type === "close") {
    await adapter.close().catch(() => {});
    process.exit(0);
  }
  if (message.type !== "query") return;
  const id = Number(message.id);
  try {
    if (message.snapshot) snapshot = normalizeSnapshot(message.snapshot);
    if (!snapshot || snapshot.generation !== Number(message.generation)) {
      throw workerError("TYPESCRIPT_WORKER_SNAPSHOT_REQUIRED", "Semantic source snapshot is unavailable.");
    }
    const graph = {
      rootDir: workerData.adapter.rootDir,
      workspaceId: snapshot.workspaceId,
      generation: snapshot.generation,
      semanticIncompleteReasons: snapshot.incompleteReasons,
      getRecords() {
        return snapshot.records;
      }
    };
    const value = await adapter.query({
      graph,
      query: message.query,
      mode: message.mode,
      limit: message.limit
    });
    parentPort.postMessage({
      protocol: "lca-typescript-semantic-v1",
      nonce,
      type: "result",
      id,
      value
    });
  } catch (error) {
    parentPort.postMessage({
      protocol: "lca-typescript-semantic-v1",
      nonce,
      type: "error",
      id,
      error: {
        code: String(error?.code || error?.name || "TYPESCRIPT_WORKER_FAILED").slice(0, 120),
        message: String(error?.message || error || "TypeScript semantic worker failed.").slice(0, 1_000)
      }
    });
  }
});

function normalizeSnapshot(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.records)) {
    throw workerError("TYPESCRIPT_WORKER_SNAPSHOT_INVALID", "Semantic source snapshot is invalid.");
  }
  return {
    workspaceId: String(value.workspaceId || ""),
    generation: Number(value.generation || 0),
    incompleteReasons: Array.isArray(value.incompleteReasons)
      ? value.incompleteReasons.map((reason) => String(reason).slice(0, 160)).slice(0, 32)
      : [],
    records: value.records.map((record) => ({
      path: String(record.path || ""),
      language: String(record.language || ""),
      fingerprint: String(record.fingerprint || ""),
      mtime_ms: Number(record.mtime_ms || 0),
      content: typeof record.content === "string" ? record.content : null,
      content_complete: record.content_complete === true,
      symbols: Array.isArray(record.symbols) ? record.symbols : []
    }))
  };
}

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
