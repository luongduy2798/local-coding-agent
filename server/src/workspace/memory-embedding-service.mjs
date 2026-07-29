// Non-blocking local semantic-memory embedding service.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

const PROTOCOL = "lca-memory-embedding-v1";
const DEFAULT_MODEL_ID = "Xenova/multilingual-e5-small";

export class MemoryEmbeddingService {
  constructor({
    enabled = false,
    modelId = DEFAULT_MODEL_ID,
    dtype = "q8",
    cacheDir = "",
    allowRemoteModels = true,
    deadlineMs = 10,
    preloadDelayMs = 2_000,
    maxPending = 16,
    workerMaxOldGenerationMb = 512,
    retryDelayMs = 60_000
  } = {}) {
    this.enabled = enabled === true;
    this.modelId = String(modelId || DEFAULT_MODEL_ID).slice(0, 240);
    this.dtype = String(dtype || "q8").slice(0, 32);
    this.cacheDir = String(cacheDir || "");
    this.allowRemoteModels = allowRemoteModels !== false;
    this.deadlineMs = boundedInteger(deadlineMs, 10, 1, 100);
    this.preloadDelayMs = boundedInteger(preloadDelayMs, 2_000, 0, 120_000);
    this.maxPending = boundedInteger(maxPending, 16, 1, 128);
    this.workerMaxOldGenerationMb = boundedInteger(workerMaxOldGenerationMb, 512, 128, 2_048);
    this.retryDelayMs = boundedInteger(retryDelayMs, 60_000, 1_000, 600_000);
    this.state = this.enabled ? "idle" : "disabled";
    this.worker = null;
    this.workerNonce = null;
    this.pending = new Map();
    this.sequence = 0;
    this.preloadPromise = null;
    this.preloadTimer = null;
    this.failedAt = 0;
    this.lastErrorCode = null;
    this.closed = false;
    this.queryCache = new Map();
    this.metrics = {
      preloads: 0,
      embeddings: 0,
      query_hits: 0,
      query_misses: 0,
      timeouts: 0,
      failures: 0
    };
  }

  preload({ delayMs = this.preloadDelayMs } = {}) {
    if (!this.enabled || this.closed || this.state === "ready" || this.preloadTimer) return;
    const delay = boundedInteger(delayMs, this.preloadDelayMs, 0, 120_000);
    this.preloadTimer = setTimeout(() => {
      this.preloadTimer = null;
      this.preloadNow().catch(() => {});
    }, delay);
    this.preloadTimer.unref?.();
  }

  async preloadNow() {
    if (!this.enabled || this.closed) return false;
    if (this.state === "ready") return true;
    if (this.preloadPromise) return this.preloadPromise;
    if (this.state === "failed" && Date.now() - this.failedAt < this.retryDelayMs) return false;
    this.state = "loading";
    this.metrics.preloads++;
    this.preloadPromise = this.#request("preload").then(() => {
      this.state = "ready";
      this.lastErrorCode = null;
      return true;
    }).catch((error) => {
      if (this.worker) this.#terminateWorker(error);
      else this.#markFailed(error);
      return false;
    }).finally(() => {
      this.preloadPromise = null;
    });
    return this.preloadPromise;
  }

  async embedQuery(text, { deadlineMs = this.deadlineMs } = {}) {
    if (!this.enabled || this.closed) return null;
    const source = compactText(text, 2_000);
    if (!source) return null;
    const key = hashText(source);
    const cached = this.queryCache.get(key);
    if (cached) {
      this.queryCache.delete(key);
      this.queryCache.set(key, cached);
      this.metrics.query_hits++;
      return cached;
    }
    this.metrics.query_misses++;
    if (this.state !== "ready" || this.pending.size >= this.maxPending) return null;

    const request = this.#request("embed", { text: source }).then((value) => {
      const vector = decodeVector(value);
      this.#cacheQuery(key, vector);
      this.metrics.embeddings++;
      return vector;
    }).catch((error) => {
      this.metrics.failures++;
      this.lastErrorCode = error?.code || "MEMORY_EMBEDDING_FAILED";
      return null;
    });

    const deadline = boundedInteger(deadlineMs, this.deadlineMs, 1, 100);
    return new Promise((resolve) => {
      let returned = false;
      const timer = setTimeout(() => {
        if (returned) return;
        returned = true;
        this.metrics.timeouts++;
        resolve(null);
      }, deadline);
      timer.unref?.();
      request.then((vector) => {
        if (returned) return;
        returned = true;
        clearTimeout(timer);
        resolve(vector);
      });
    });
  }

  async embedPassage(text) {
    if (!this.enabled || this.closed) return null;
    const source = compactText(text, 3_000);
    if (!source) return null;
    if (this.state === "idle" && this.preloadDelayMs > 0) {
      await delay(this.preloadDelayMs);
    }
    if (this.state !== "ready" && !(await this.preloadNow())) return null;
    if (this.pending.size >= this.maxPending) return null;
    try {
      const vector = decodeVector(await this.#request("embed", { text: source }));
      this.metrics.embeddings++;
      return vector;
    } catch (error) {
      this.metrics.failures++;
      this.lastErrorCode = error?.code || "MEMORY_EMBEDDING_FAILED";
      return null;
    }
  }

  status() {
    return {
      enabled: this.enabled,
      state: this.state,
      ready: this.state === "ready",
      model_id: this.modelId,
      dtype: this.dtype,
      deadline_ms: this.deadlineMs,
      allow_remote_models: this.allowRemoteModels,
      in_flight: this.pending.size,
      last_error_code: this.lastErrorCode,
      metrics: { ...this.metrics }
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.state = "closed";
    clearTimeout(this.preloadTimer);
    this.preloadTimer = null;
    const error = embeddingError("MEMORY_EMBEDDING_CLOSED", "Memory embedding service is closed.");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    const worker = this.worker;
    this.worker = null;
    this.workerNonce = null;
    await worker?.terminate?.().catch(() => {});
  }

  #cacheQuery(key, vector) {
    this.queryCache.set(key, vector);
    while (this.queryCache.size > 128) this.queryCache.delete(this.queryCache.keys().next().value);
  }

  #request(type, payload = {}) {
    if (this.closed) return Promise.reject(
      embeddingError("MEMORY_EMBEDDING_CLOSED", "Memory embedding service is closed.")
    );
    if (this.pending.size >= this.maxPending) return Promise.reject(
      embeddingError("MEMORY_EMBEDDING_BUSY", "Memory embedding worker queue is full.")
    );
    const worker = this.#ensureWorker();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({
          protocol: PROTOCOL,
          nonce: this.workerNonce,
          id,
          type,
          ...payload
        });
      } catch (error) {
        this.pending.delete(id);
        reject(embeddingError(
          "MEMORY_EMBEDDING_SEND_FAILED",
          "Unable to send work to the memory embedding worker.",
          error
        ));
      }
    });
  }

  #ensureWorker() {
    if (this.worker) return this.worker;
    const nonce = randomUUID();
    const worker = new Worker(new URL("./memory-embedding-worker.mjs", import.meta.url), {
      workerData: {
        protocol: PROTOCOL,
        nonce,
        modelId: this.modelId,
        dtype: this.dtype,
        cacheDir: this.cacheDir,
        allowRemoteModels: this.allowRemoteModels
      },
      env: {
        ...process.env,
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || "1",
        ORT_NUM_THREADS: process.env.ORT_NUM_THREADS || "1"
      },
      resourceLimits: { maxOldGenerationSizeMb: this.workerMaxOldGenerationMb }
    });
    this.worker = worker;
    this.workerNonce = nonce;
    worker.on("message", (message) => this.#handleMessage(worker, message));
    worker.on("error", (error) => this.#terminateWorker(embeddingError(
      "MEMORY_EMBEDDING_WORKER_FAILED",
      "Memory embedding worker failed.",
      error
    )));
    worker.on("exit", (code) => {
      if (this.worker === worker && !this.closed) this.#terminateWorker(embeddingError(
        "MEMORY_EMBEDDING_WORKER_EXITED",
        `Memory embedding worker exited before completing its work (${code}).`
      ));
    });
    return worker;
  }

  #handleMessage(worker, message) {
    if (this.worker !== worker || message?.protocol !== PROTOCOL ||
        message?.nonce !== this.workerNonce) return;
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    if (message.type === "result") pending.resolve(message.value);
    else pending.reject(embeddingError(
      message.error?.code || "MEMORY_EMBEDDING_FAILED",
      message.error?.message || "Memory embedding worker failed."
    ));
  }

  #terminateWorker(error) {
    const worker = this.worker;
    this.worker = null;
    this.workerNonce = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    worker?.terminate?.().catch(() => {});
    this.#markFailed(error);
  }

  #markFailed(error) {
    this.state = this.closed ? "closed" : "failed";
    this.failedAt = Date.now();
    this.lastErrorCode = error?.code || "MEMORY_EMBEDDING_FAILED";
    this.metrics.failures++;
  }
}

function decodeVector(value) {
  const buffer = value?.vector;
  const vector = buffer instanceof ArrayBuffer
    ? new Float32Array(buffer)
    : ArrayBuffer.isView(buffer)
      ? Float32Array.from(buffer, Number)
      : null;
  if (!vector?.length || Number(value?.dimensions) !== vector.length) {
    throw embeddingError("MEMORY_EMBEDDING_OUTPUT_INVALID", "Memory embedding vector is invalid.");
  }
  return vector;
}

function compactText(value, max) {
  return String(value || "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

function hashText(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function embeddingError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "MemoryEmbeddingError";
  error.code = code;
  return error;
}
