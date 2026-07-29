// Background processor for durable task-close workspace Memory jobs.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";

const RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 30_000, 120_000, 600_000]);
const EMPTY_SUMMARY = Object.freeze({
  pending: 0,
  processing: 0,
  retrying: 0,
  failed: 0,
  last_completed_at: null
});

export class WorkspaceMemoryOutbox {
  constructor({
    store,
    memoryService,
    pollMs = 5_000,
    leaseMs = 30_000,
    maxAttempts = 5,
    onChange
  } = {}) {
    if (!store || !memoryService) {
      throw new TypeError("WorkspaceMemoryOutbox requires a store and Memory service.");
    }
    this.store = store;
    this.memoryService = memoryService;
    this.pollMs = Math.max(500, Number(pollMs) || 5_000);
    this.leaseMs = Math.max(5_000, Number(leaseMs) || 30_000);
    this.maxAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 5));
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.leaseOwner = `memory_outbox_${randomUUID().replaceAll("-", "")}`;
    this.timer = null;
    this.drainPromise = null;
    this.closed = false;
    this.started = false;
    this.cachedSummary = { ...EMPTY_SUMMARY };
    this.metrics = {
      claimed: 0,
      completed: 0,
      partial: 0,
      retried: 0,
      failed: 0,
      recovered_leases: 0
    };
  }

  async start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.metrics.recovered_leases += await this.store.recoverExpiredLeases();
    await this.#refreshSummary();
    this.timer = setInterval(() => this.wake(), this.pollMs);
    this.timer.unref?.();
    this.wake();
  }

  wake() {
    if (this.closed || this.drainPromise) return this.drainPromise;
    this.drainPromise = this.#drain().catch(() => {}).finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  status() {
    return {
      available: this.started && !this.closed,
      ...this.cachedSummary,
      metrics: { ...this.metrics }
    };
  }

  async summary(workspaceId) {
    return this.store.summary(workspaceId);
  }

  async retryFailed(workspaceId) {
    const retried = await this.store.retryFailed(workspaceId);
    await this.#refreshSummary();
    if (retried) {
      this.onChange({ type: "workspace_memory_outbox", workspace_id: workspaceId });
      this.wake();
    }
    return retried;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
    await this.drainPromise?.catch(() => {});
  }

  async #drain() {
    this.metrics.recovered_leases += await this.store.recoverExpiredLeases();
    while (!this.closed) {
      const job = await this.store.claimNext({
        leaseOwner: this.leaseOwner,
        leaseMs: this.leaseMs
      });
      if (!job) break;
      this.metrics.claimed++;
      await this.#process(job);
    }
    await this.#refreshSummary();
  }

  async #process(job) {
    const payload = job.payload;
    if (
      payload?.version !== 1 ||
      payload.workspace_id !== job.workspace_id ||
      payload.task?.id !== job.task_id ||
      !Array.isArray(payload.updates)
    ) {
      await this.store.fail(job, {
        errorCode: "MEMORY_OUTBOX_PAYLOAD_INVALID",
        result: { status: "failed", error_code: "MEMORY_OUTBOX_PAYLOAD_INVALID" }
      });
      this.metrics.failed++;
      this.onChange({ type: "workspace_memory_outbox", workspace_id: job.workspace_id });
      return;
    }
    try {
      const result = await this.memoryService.applyTaskCloseUpdates(
        payload.task,
        payload.updates,
        { workspaceId: job.workspace_id, idempotent: true }
      );
      const failures = result.results.filter((item) => !item.ok);
      const retryableFailure = failures.find((item) => item.retryable === true);
      if (retryableFailure && job.attempts < this.maxAttempts) {
        await this.store.retry(
          job,
          retryableFailure.error_code,
          RETRY_DELAYS_MS[Math.min(job.attempts - 1, RETRY_DELAYS_MS.length - 1)]
        );
        this.metrics.retried++;
      } else if (result.status === "complete") {
        await this.store.complete(job, { result: summarizeResult(result) });
        this.metrics.completed++;
      } else if (result.status === "partial") {
        await this.store.complete(job, { status: "partial", result: summarizeResult(result) });
        this.metrics.partial++;
      } else {
        await this.store.fail(job, {
          errorCode: failures[0]?.error_code || "WORKSPACE_MEMORY_PERSIST_FAILED",
          result: summarizeResult(result)
        });
        this.metrics.failed++;
      }
    } catch (error) {
      const errorCode = error?.code || "WORKSPACE_MEMORY_PERSIST_FAILED";
      if (retryableCode(errorCode) && job.attempts < this.maxAttempts) {
        await this.store.retry(
          job,
          errorCode,
          RETRY_DELAYS_MS[Math.min(job.attempts - 1, RETRY_DELAYS_MS.length - 1)]
        );
        this.metrics.retried++;
      } else {
        await this.store.fail(job, {
          errorCode,
          result: { status: "failed", error_code: errorCode }
        });
        this.metrics.failed++;
      }
    }
    this.onChange({ type: "workspace_memory_outbox", workspace_id: job.workspace_id });
  }

  async #refreshSummary() {
    this.cachedSummary = await this.store.summary().catch(() => ({ ...EMPTY_SUMMARY }));
  }
}

function summarizeResult(result) {
  return {
    status: result.status,
    results: result.results.map((item) => ({
      ok: item.ok,
      action: item.action,
      workspace_id: item.workspace_id,
      memory_id: item.item?.id || null,
      error_code: item.error_code || null
    }))
  };
}

function retryableCode(code) {
  return /^(?:SQLITE_BUSY|SQLITE_LOCKED|SQLITE_DATABASE_CLOSED|WORKSPACE_UNAVAILABLE|WORKSPACE_MEMORY_UNAVAILABLE|WORKSPACE_MEMORY_CACHE_REBUILD_FAILED|STORAGE_WORKER_|SQLITE_IOERR)/.test(String(code || ""));
}
