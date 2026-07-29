// Durable task-close workspace Memory outbox enqueue benchmark.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createIsolatedTestRoot, safeRemove } from "../tests/helpers/test-guard.mjs";
import { WorkspaceRegistry } from "../src/workspace/registry.mjs";
import { TaskRouter } from "../src/workspace/task-router.mjs";
import { prepareTaskMemoryOutbox } from "../src/workspace/task-memory-outbox-policy.mjs";

const SAMPLE_SIZE = 200;
const WARMUP_SIZE = 20;
const ENQUEUE_P95_BUDGET_MS = 5;
const context = await createIsolatedTestRoot({
  prefix: "lca-memory-outbox-benchmark-",
  protectedPaths: [path.resolve("..")] 
});
let registry;
let router;

try {
  const dataDir = path.join(context.dataDir, "runtime");
  const root = path.join(context.fixtureDir, "workspace");
  await mkdir(root, { recursive: true });
  registry = await WorkspaceRegistry.open({ dataDir });
  router = await TaskRouter.open({ dataDir });
  const registered = await registry.registerWorkspace(root, {
    metadata: { label: "Memory outbox benchmark", trusted: true }
  });
  const workspaceId = registered.workspace.id;
  const baselineDurations = [];
  const enqueueDurations = [];
  const enqueueOverheads = [];

  for (let index = 0; index < SAMPLE_SIZE + WARMUP_SIZE; index++) {
    const baselineTask = await router.openTask({
      title: `Outbox baseline ${index}`,
      complexityHint: "normal",
      primaryWorkspaceId: workspaceId
    });
    let started = performance.now();
    await router.closeTask({ taskToken: baselineTask.task_token });
    const baselineMs = performance.now() - started;

    const queuedTask = await router.openTask({
      title: `Outbox enqueue ${index}`,
      complexityHint: "normal",
      primaryWorkspaceId: workspaceId
    });
    const prepared = prepareTaskMemoryOutbox(queuedTask, [{
      kind: "constraint",
      title: `Outbox benchmark item ${index}`,
      summary: "Accepted task-close Memory is durably queued before close success returns.",
      paths: ["src/runtime.mjs"],
      tags: ["benchmark", "outbox"]
    }]);
    started = performance.now();
    await router.closeTask({
      taskToken: queuedTask.task_token,
      memoryJobs: prepared.jobs
    });
    const enqueueMs = performance.now() - started;

    if (index >= WARMUP_SIZE) {
      baselineDurations.push(baselineMs);
      enqueueDurations.push(enqueueMs);
      enqueueOverheads.push(Math.max(0, enqueueMs - baselineMs));
    }
  }

  const report = {
    scope: "TaskRouter close transaction with one durable outbox row; excludes journal/completion-guard and background persistence.",
    sample_size: SAMPLE_SIZE,
    baseline_p50_ms: round(percentile(baselineDurations, 50)),
    baseline_p95_ms: round(percentile(baselineDurations, 95)),
    enqueue_p50_ms: round(percentile(enqueueDurations, 50)),
    enqueue_p95_ms: round(percentile(enqueueDurations, 95)),
    enqueue_overhead_p95_ms: round(percentile(enqueueOverheads, 95)),
    budget: {
      enqueue_p95_ms: ENQUEUE_P95_BUDGET_MS
    }
  };
  assert.ok(report.enqueue_p95_ms < ENQUEUE_P95_BUDGET_MS, JSON.stringify(report));
  console.log(JSON.stringify(report, null, 2));
  console.log("[PASS] Durable Memory enqueue stays inside the task-close core latency budget");
} finally {
  await router?.close().catch(() => {});
  await registry?.close().catch(() => {});
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true }).catch(() => {});
  await safeRemove(context.dataDir, context, { recursive: true, force: true }).catch(() => {});
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)];
}

function round(value) {
  return Math.round(Number(value) * 1_000) / 1_000;
}
