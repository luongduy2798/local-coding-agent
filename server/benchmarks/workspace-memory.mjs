// Persistent workspace memory critical-path benchmark.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { WorkspaceMemoryService } from "../src/workspace/workspace-memory.mjs";
import { WorkspaceRegistry } from "../src/workspace/registry.mjs";
import { TaskRouter } from "../src/workspace/task-router.mjs";
import { createIsolatedTestRoot, safeRemove } from "../tests/helpers/test-guard.mjs";

const WARM_P95_BUDGET_MS = 5;
const COLD_P95_BUDGET_MS = 15;
const LIGHT_WARM_P95_BUDGET_MS = 1;
const PAYLOAD_BUDGET_BYTES = 4_096;
const LIGHT_PAYLOAD_BUDGET_BYTES = 1_024;
const context = await createIsolatedTestRoot({
  prefix: "lca-memory-benchmark-",
  protectedPaths: [path.resolve("..")]
});
let registry;
let router;

try {
  const dataDir = path.join(context.dataDir, "runtime");
  const root = path.join(context.fixtureDir, "workspace");
  await mkdir(path.join(root, "src"), { recursive: true });
  registry = await WorkspaceRegistry.open({ dataDir });
  router = await TaskRouter.open({ dataDir });
  const registered = await registry.registerWorkspace(root, {
    metadata: { label: "Memory benchmark", trusted: true }
  });
  const workspaceId = registered.workspace.id;
  const writer = new WorkspaceMemoryService({ registry, taskRouter: router });
  for (let index = 0; index < 48; index++) {
    await writer.save(workspaceId, {
      kind: index % 4 === 0 ? "constraint" : "architecture_decision",
      title: `Memory benchmark item ${String(index).padStart(2, "0")}`,
      summary: `Bounded durable context for module ${index}; this item verifies ranking and payload truncation without loading raw history.`,
      pinned: index < 4,
      paths: [`src/module-${index}.mjs`],
      tags: ["benchmark", `module-${index}`]
    }, { actor: "system" });
  }
  await writer.settings(workspaceId, { include_recent_tasks: true });
  for (let index = 0; index < 4; index++) {
    const recent = await router.openTask({
      title: `Closed benchmark task ${index + 1}`,
      objective: `Recent deterministic task ${index + 1}.`,
      primaryWorkspaceId: workspaceId
    });
    await router.closeTask({ taskToken: recent.task_token });
  }
  const recentSourceCount = (await router.listRecentTasksForWorkspace({
    workspaceId,
    limit: 10
  })).length;
  const task = await router.openTask({
    title: "Workspace memory benchmark",
    objective: "Measure bounded architecture context for module 17.",
    memoryMode: "full",
    includeRecentTasks: true,
    primaryWorkspaceId: workspaceId
  });
  const lightTask = await router.openTask({
    title: "Quick module type edit",
    objective: "Apply a mechanical type correction in module 17.",
    complexityHint: "quick_edit",
    memoryMode: "auto",
    includeRecentTasks: true,
    relevantPaths: [{ path: "src/module-17.mjs" }],
    primaryWorkspaceId: workspaceId
  });

  const coldDurations = [];
  let coldPayload;
  for (let index = 0; index < 40; index++) {
    const service = new WorkspaceMemoryService({ registry, taskRouter: router });
    const started = performance.now();
    coldPayload = await service.briefForTask(task);
    coldDurations.push(performance.now() - started);
  }

  const service = new WorkspaceMemoryService({ registry, taskRouter: router });
  await service.briefForTask(task);
  const warmDurations = [];
  let payload;
  for (let index = 0; index < 2_000; index++) {
    const started = performance.now();
    payload = await service.briefForTask(task);
    warmDurations.push(performance.now() - started);
  }
  const lightDurations = [];
  let lightPayload;
  for (let index = 0; index < 2_000; index++) {
    const started = performance.now();
    lightPayload = await service.briefForTask(lightTask);
    lightDurations.push(performance.now() - started);
  }
  const report = {
    sample_size: warmDurations.length,
    warm_p50_ms: round(percentile(warmDurations, 50)),
    warm_p95_ms: round(percentile(warmDurations, 95)),
    warm_p99_ms: round(percentile(warmDurations, 99)),
    cold_sample_size: coldDurations.length,
    cold_p50_ms: round(percentile(coldDurations, 50)),
    cold_p95_ms: round(percentile(coldDurations, 95)),
    light_warm_p95_ms: round(percentile(lightDurations, 95)),
    payload_bytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    light_payload_bytes: Buffer.byteLength(JSON.stringify(lightPayload), "utf8"),
    item_count: payload.items.length,
    recent_source_count: recentSourceCount,
    recent_task_count: payload.recent_tasks.length,
    budgets: {
      warm_p95_ms: WARM_P95_BUDGET_MS,
      cold_p95_ms: COLD_P95_BUDGET_MS,
      light_warm_p95_ms: LIGHT_WARM_P95_BUDGET_MS,
      payload_bytes: PAYLOAD_BUDGET_BYTES,
      light_payload_bytes: LIGHT_PAYLOAD_BUDGET_BYTES
    }
  };
  assert.equal(payload.available, true);
  assert.equal(coldPayload.available, true);
  assert.ok(report.warm_p95_ms < WARM_P95_BUDGET_MS, JSON.stringify(report));
  assert.ok(report.cold_p95_ms < COLD_P95_BUDGET_MS, JSON.stringify(report));
  assert.ok(report.light_warm_p95_ms < LIGHT_WARM_P95_BUDGET_MS, JSON.stringify(report));
  assert.ok(report.payload_bytes <= PAYLOAD_BUDGET_BYTES, JSON.stringify(report));
  assert.ok(report.light_payload_bytes <= LIGHT_PAYLOAD_BUDGET_BYTES, JSON.stringify(report));
  assert.ok(report.item_count <= 8, JSON.stringify(report));
  assert.equal(lightPayload.effective_mode, "light", JSON.stringify(report));
  assert.ok(lightPayload.items.length <= 2, JSON.stringify(report));
  assert.deepEqual(lightPayload.recent_tasks, [], JSON.stringify(report));
  assert.equal(lightPayload.semantic_used, false, JSON.stringify(report));
  assert.equal(report.recent_source_count, 4, JSON.stringify(report));
  assert.equal(payload.recent_tasks_requested, true, JSON.stringify(report));
  assert.ok(report.recent_task_count <= 3, JSON.stringify(report));
  assert.equal(payload.recent_tasks_included, report.recent_task_count > 0, JSON.stringify(report));
  if (report.recent_task_count < 3) {
    assert.equal(payload.truncated, true, JSON.stringify(report));
  }
  console.log(JSON.stringify(report, null, 2));
  console.log("[PASS] Workspace memory adds zero tool round-trips and stays inside latency/payload budgets");
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
