// Local semantic-memory embedding worker.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parentPort, workerData } from "node:worker_threads";

const PROTOCOL = "lca-memory-embedding-v1";

if (!parentPort || workerData?.protocol !== PROTOCOL || !workerData?.nonce) {
  throw new Error("Invalid memory embedding worker bootstrap.");
}

const config = {
  modelId: String(workerData.modelId || "Xenova/multilingual-e5-small"),
  dtype: String(workerData.dtype || "q8"),
  cacheDir: String(workerData.cacheDir || ""),
  allowRemoteModels: workerData.allowRemoteModels !== false
};
let extractorPromise = null;

function serializeError(error) {
  return {
    code: String(error?.code || error?.name || "MEMORY_EMBEDDING_FAILED").slice(0, 120),
    message: String(error?.message || error || "Memory embedding failed.").slice(0, 1_000)
  };
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      if (config.cacheDir) env.cacheDir = config.cacheDir;
      env.allowRemoteModels = config.allowRemoteModels;
      env.allowLocalModels = true;
      return pipeline("feature-extraction", config.modelId, { dtype: config.dtype });
    })();
  }
  return extractorPromise;
}

async function embedText(text) {
  const source = String(text || "").trim();
  if (!source) {
    const error = new Error("Embedding text is required.");
    error.code = "MEMORY_EMBEDDING_TEXT_REQUIRED";
    throw error;
  }
  const extractor = await getExtractor();
  const output = await extractor(source, { pooling: "mean", normalize: true });
  const data = output?.data;
  if (!data || typeof data.length !== "number" || data.length < 1) {
    const error = new Error("Embedding model returned no vector.");
    error.code = "MEMORY_EMBEDDING_OUTPUT_INVALID";
    throw error;
  }
  const vector = Float32Array.from(data, Number);
  normalize(vector);
  return vector;
}

function normalize(vector) {
  let squared = 0;
  for (const value of vector) squared += value * value;
  const magnitude = Math.sqrt(squared);
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    const error = new Error("Embedding model returned an invalid vector.");
    error.code = "MEMORY_EMBEDDING_OUTPUT_INVALID";
    throw error;
  }
  for (let index = 0; index < vector.length; index++) vector[index] /= magnitude;
}

parentPort.on("message", async (message = {}) => {
  if (message.protocol !== PROTOCOL || message.nonce !== workerData.nonce) return;
  const id = Number(message.id);
  try {
    if (message.type === "preload") {
      await getExtractor();
      parentPort.postMessage({
        protocol: PROTOCOL,
        nonce: workerData.nonce,
        id,
        type: "result",
        value: { ready: true, model_id: config.modelId, dtype: config.dtype }
      });
      return;
    }
    if (message.type === "embed") {
      const vector = await embedText(message.text);
      const buffer = vector.buffer;
      parentPort.postMessage({
        protocol: PROTOCOL,
        nonce: workerData.nonce,
        id,
        type: "result",
        value: {
          model_id: config.modelId,
          dimensions: vector.length,
          vector: buffer
        }
      }, [buffer]);
      return;
    }
    const error = new Error(`Unsupported memory embedding request: ${message.type}`);
    error.code = "MEMORY_EMBEDDING_REQUEST_INVALID";
    throw error;
  } catch (error) {
    parentPort.postMessage({
      protocol: PROTOCOL,
      nonce: workerData.nonce,
      id,
      type: "error",
      error: serializeError(error)
    });
  }
});
