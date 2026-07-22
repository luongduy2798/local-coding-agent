// Local Coding Agent runtime scale benchmark
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Default: node --expose-gc benchmarks/scale.mjs
// Large:   node --expose-gc benchmarks/scale.mjs --scale=100k --allow-large
// Custom:  node benchmarks/scale.mjs --files=1000 --packages=4

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat as statFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodeQueryEngine } from "../src/coding/query-engine.mjs";
import { PatchTransactionCoordinator } from "../src/mutation/patch-transaction.mjs";
import { TaskRouter, TaskRouterError } from "../src/workspace/task-router.mjs";
import { WorkspaceGraph } from "../src/workspace/graph/workspace-graph.mjs";
import { prewarmWorkspaceGraphInChild } from "../src/workspace/graph/prewarm.mjs";
import { WorkspaceRegistry } from "../src/workspace/registry.mjs";
import {
  createIsolatedTestRoot,
  safeRemove
} from "../tests/helpers/test-guard.mjs";
import {
  generateConsumerWorkspace,
  generateMonorepo,
  hotFileContent
} from "./scale-fixture.mjs";

const BENCHMARK_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(BENCHMARK_DIR, "../..");
const FIXTURE_BUILDER_PATH = path.join(BENCHMARK_DIR, "scale-fixture-builder.mjs");
const execFileAsync = promisify(execFile);
const config = parseArguments(process.argv.slice(2), process.env);
const runStarted = performance.now();
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
const phaseEventLoop = monitorEventLoopDelay({ resolution: 10 });
const eventLoopPhases = {};
const memorySamples = [];
let memoryTimer;
let context;
let registry;
let router;
let graph;
let secondaryGraph;
let report;
let coldBuilderMetrics = null;
let warmCallBaselineHeap = null;
let warmCallAfterHeap = null;

try {
  context = await createIsolatedTestRoot({
    prefix: "lca-scale-",
    protectedPaths: [REPOSITORY_ROOT]
  });
  const workspaceA = path.join(context.fixtureDir, "workspace-a");
  const workspaceB = path.join(context.fixtureDir, "workspace-b");
  const extraWorkspaces = Array.from(
    { length: 8 },
    (_, index) => path.join(context.fixtureDir, `workspace-extra-${index + 1}`)
  );
  const runtimeDataDir = path.join(context.dataDir, "runtime");
  const graphPersistencePath = path.join(runtimeDataDir, "bench-index", "workspace-graph.json.br");
  const secondaryPersistencePath = path.join(runtimeDataDir, "bench-index", "workspace-graph-secondary.json.br");

  phaseEventLoop.enable();
  sampleMemory(memorySamples, "start");
  memoryTimer = setInterval(() => sampleMemory(memorySamples, "sample"), 25);
  memoryTimer.unref?.();

  const generation = await timed(async () => {
    await Promise.all([
      mkdir(workspaceA, { recursive: true }),
      mkdir(workspaceB, { recursive: true }),
      ...extraWorkspaces.map((root) => mkdir(root, { recursive: true }))
    ]);
    const primary = config.isolateFixtureGeneration
      ? await generateMonorepoInChild(workspaceA, {
          fileCount: config.files,
          packageCount: config.packages,
          concurrency: config.writeConcurrency,
          context
        })
      : await generateMonorepo(workspaceA, {
          fileCount: config.files,
          packageCount: config.packages,
          concurrency: config.writeConcurrency
        });
    await generateConsumerWorkspace(workspaceB);
    return primary;
  });
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    await delay(0);
  }
  sampleMemory(memorySamples, "generated");
  captureEventLoopPhase(eventLoopPhases, phaseEventLoop, "fixture_generation");

  // The runtime SLA starts after the synthetic repository exists. Including
  // 10k/100k file creation would measure the benchmark harness rather than LCA
  // indexing, storage, query, watcher, and transaction work.
  eventLoop.enable();

  const storageSetup = await timed(async () => {
    registry = await WorkspaceRegistry.open({
      dataDir: runtimeDataDir,
      maxOpenWorkspaces: 2
    });
    router = await TaskRouter.open({ dataDir: runtimeDataDir });
    const [registeredA, registeredB, ...registeredExtras] = await Promise.all([
      registry.registerWorkspace(workspaceA, {
        metadata: { label: "Scale workspace A", trusted: true, source: "benchmark" }
      }),
      registry.registerWorkspace(workspaceB, {
        metadata: { label: "Scale workspace B", trusted: true, source: "benchmark" }
      }),
      ...extraWorkspaces.map((root, index) => registry.registerWorkspace(root, {
        metadata: { label: `Scale idle workspace ${index + 1}`, trusted: true, source: "benchmark" }
      }))
    ]);
    return {
      workspaceAId: registeredA.workspace.id,
      workspaceBId: registeredB.workspace.id,
      registeredWorkspaceIds: [
        registeredA.workspace.id,
        registeredB.workspace.id,
        ...registeredExtras.map((entry) => entry.workspace.id)
      ]
    };
  });
  sampleMemory(memorySamples, "storage-ready");
  captureEventLoopPhase(eventLoopPhases, phaseEventLoop, "storage_setup");

  graph = new WorkspaceGraph({
    rootDir: workspaceA,
    workspaceId: storageSetup.value.workspaceAId,
    maxFiles: config.files,
    maxDepth: 16,
    maxFileBytes: 4 * 1024,
    scanConcurrency: config.scanConcurrency,
    reconcileIntervalMs: 60_000,
    watch: config.watch,
    watchDebounceMs: 25,
    queryFingerprint: true,
    queryFingerprintMaxFiles: Math.min(config.files, 4_096),
    queryFingerprintConcurrency: config.queryFingerprintConcurrency,
    queryFingerprintIntervalMs: config.queryFingerprintIntervalMs,
    persistencePath: graphPersistencePath
  });
  let fullIndex;
  if (config.coldBuilder) {
    const childEventLoop = monitorEventLoopDelay({ resolution: 1 });
    childEventLoop.enable();
    await delay(20);
    fullIndex = await timed(() => prewarmWorkspaceGraphInChild(graph, {
      persistenceRoot: runtimeDataDir,
      timeoutMs: config.builderTimeoutMs,
      fallbackToMain: false
    }));
    await delay(20);
    childEventLoop.disable();
    coldBuilderMetrics = {
      child_pid: fullIndex.value.external_builder.child_pid,
      child_duration_ms: fullIndex.value.external_builder.duration_ms,
      fallback: fullIndex.value.external_builder.fallback,
      main_event_loop: summarizeEventLoop(childEventLoop)
    };
    if (typeof globalThis.gc === "function") {
      globalThis.gc();
      await delay(0);
      sampleMemory(memorySamples, "cold-builder-after-gc");
    }
  } else {
    fullIndex = await timed(() => graph.refresh({
      maxFiles: config.files,
      maxDepth: 16,
      maxFileBytes: 4 * 1024,
      replaceCoverage: true
    }));
  }
  assert.equal(fullIndex.value.counts.files, config.files, "primary graph must index every generated file");
  assert.equal(fullIndex.value.coverage.complete, true, "primary graph coverage must be complete");
  sampleMemory(memorySamples, "indexed");
  captureEventLoopPhase(eventLoopPhases, phaseEventLoop, "full_index");

  const snapshotWarm = await timed(() => graph.snapshot());
  const persistedBytes = (await statFile(graphPersistencePath)).size;
  await graph.close();
  graph = null;
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    await delay(0);
    sampleMemory(memorySamples, "indexed-unloaded-after-gc");
  }
  graph = new WorkspaceGraph({
    rootDir: workspaceA,
    workspaceId: storageSetup.value.workspaceAId,
    maxFiles: config.files,
    maxDepth: 16,
    maxFileBytes: 4 * 1024,
    scanConcurrency: config.scanConcurrency,
    reconcileIntervalMs: 60_000,
    watch: config.watch,
    watchDebounceMs: 25,
    queryFingerprint: true,
    queryFingerprintMaxFiles: Math.min(config.files, 4_096),
    queryFingerprintConcurrency: config.queryFingerprintConcurrency,
    queryFingerprintIntervalMs: config.queryFingerprintIntervalMs,
    persistencePath: graphPersistencePath
  });
  const coldLoad = await timed(() => graph.initialize());
  const coldLoadStatus = graph.persistenceStatus();
  assert.equal(
    coldLoadStatus.loaded,
    true,
    `cold graph must load its persisted index: ${JSON.stringify(coldLoadStatus.error)}`
  );
  sampleMemory(memorySamples, "cold-loaded");
  captureEventLoopPhase(eventLoopPhases, phaseEventLoop, "cold_load");
  const coldPrewarm = await timed(() => graph.prewarm({
    maxFiles: config.files,
    maxDepth: 16,
    maxFileBytes: 4 * 1024
  }));
  assert.equal(coldPrewarm.value.persistence.loaded, true, "cold graph must retain its persisted index");
  assert.equal(coldPrewarm.value.changes.parsed_files, 0, "cold prewarm must reuse unchanged persisted records");
  secondaryGraph = new WorkspaceGraph({
    rootDir: workspaceB,
    workspaceId: storageSetup.value.workspaceBId,
    maxFiles: 100,
    maxDepth: 8,
    maxFileBytes: 4 * 1024,
    scanConcurrency: Math.min(config.scanConcurrency, 8),
    watch: false,
    queryFingerprint: true,
    queryFingerprintMaxFiles: 100,
    persistencePath: secondaryPersistencePath
  });
  await secondaryGraph.refresh({ replaceCoverage: true });
  const secondaryPersistence = secondaryGraph.persistenceStatus();
  sampleMemory(memorySamples, "cold-prewarmed");
  captureEventLoopPhase(eventLoopPhases, phaseEventLoop, "cold_prewarm");
  const dependencyGraph = graph.dependencyGraph();
  assert.ok(
    dependencyGraph.packages.length >= generation.value.packageCount,
    "package graph must include every generated workspace package"
  );
  assert.ok(dependencyGraph.import_edges.length > 0, "package graph must contain import edges");

  const queryEngine = new CodeQueryEngine({ graph });
  const queryWarmup = await timed(() => queryEngine.query({
    query: generation.value.queryNeedle,
    mode: "text",
    depth: "fast",
    limit: 20
  }));
  assert.ok(queryWarmup.value.count > 0, "warm-up query must find the seeded marker");
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    await delay(0);
    warmCallBaselineHeap = sampleMemory(memorySamples, "warm-calls-baseline-after-gc").heap_used;
  }
  const warmQueryDurations = [];
  let warmQueryResult;
  for (let index = 0; index < config.warmQueries; index++) {
    const measured = await timed(() => queryEngine.query({
      query: generation.value.queryNeedle,
      mode: "text",
      depth: "fast",
      limit: 20
    }));
    warmQueryDurations.push(measured.ms);
    warmQueryResult = measured.value;
  }
  assert.ok(warmQueryResult?.count > 0, "warm code query must find the seeded marker");
  sampleMemory(memorySamples, "warm-queries");
  captureEventLoopPhase(eventLoopPhases, phaseEventLoop, "warm_queries");
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    await delay(0);
    warmCallAfterHeap = sampleMemory(memorySamples, "warm-queries-after-gc").heap_used;
  }

  const incrementalMarker = `LCA_INCREMENTAL_${context.runId.replaceAll("-", "")}`;
  const incrementalStarted = performance.now();
  const incrementalWatcherRevision = graph.watcherStatus().revision;
  const incrementalGraphGeneration = graph.generation;
  const incrementalQueryDurations = [];
  let incrementalAttempts = 0;
  let watcherObservedMs = null;
  let graphUpdatedMs = null;
  await writeFile(
    path.join(workspaceA, generation.value.hotFile),
    hotFileContent(incrementalMarker),
    "utf8"
  );
  let incrementalResult = null;
  let incrementalDetectedBeforeFallback = false;
  const incrementalDeadline = performance.now() + config.freshnessTimeoutMs;
  while (performance.now() < incrementalDeadline) {
    incrementalAttempts++;
    if (watcherObservedMs === null && graph.watcherStatus().revision > incrementalWatcherRevision) {
      watcherObservedMs = roundMs(performance.now() - incrementalStarted);
    }
    const queryStarted = performance.now();
    const matches = await graph.search(incrementalMarker, { limit: 5, caseSensitive: true });
    incrementalQueryDurations.push(performance.now() - queryStarted);
    if (watcherObservedMs === null && graph.watcherStatus().revision > incrementalWatcherRevision) {
      watcherObservedMs = roundMs(performance.now() - incrementalStarted);
    }
    if (graphUpdatedMs === null && graph.generation > incrementalGraphGeneration) {
      graphUpdatedMs = roundMs(performance.now() - incrementalStarted);
    }
    if (matches.length > 0) {
      incrementalResult = matches;
      incrementalDetectedBeforeFallback = true;
      break;
    }
    await delay(20);
  }
  if (!incrementalResult) {
    await graph.refresh();
    incrementalResult = await graph.search(incrementalMarker, { limit: 5, caseSensitive: true });
  }
  const incrementalFreshnessMs = roundMs(performance.now() - incrementalStarted);
  const watcherStatus = graph.watcherStatus();
  assert.ok(incrementalResult.length > 0, "incremental marker must become searchable");
  sampleMemory(memorySamples, "incremental-search");
  captureEventLoopPhase(eventLoopPhases, phaseEventLoop, "incremental_search");

  const sessionId = `bench-${context.runId}`;
  const taskSetup = await timed(() => router.openTask({
    title: "Cross-workspace scale benchmark",
    primaryWorkspaceId: storageSetup.value.workspaceAId,
    attachedWorkspaceIds: [storageSetup.value.workspaceBId],
    ownerSessionId: sessionId
  }));
  const task = taskSetup.value;
  await router.freezeWorkspaceSet({ taskToken: task.task_token, sessionId });

  const coordinator = new PatchTransactionCoordinator({
    dataDir: path.join(runtimeDataDir, "patch-coordinator"),
    resolveWorkspace: async (workspaceId) => {
      const workspace = await registry.getWorkspace(workspaceId);
      if (workspace.availability !== "available") return null;
      return { id: workspace.id, root: workspace.canonicalRoot };
    },
    authorizeWorkspace: async ({ workspaceId, taskId, taskToken, sessionId: ownerSessionId }) => {
      const authorized = await router.assertWorkspaceAccess({
        workspaceId,
        taskToken,
        sessionId: ownerSessionId
      });
      if (taskId && authorized.id !== taskId) {
        throw new TaskRouterError(
          "TASK_CONTEXT_MISMATCH",
          "Patch transaction task does not match the authorized benchmark task."
        );
      }
      return authorized;
    }
  });
  await coordinator.init();
  const crossWorkspacePatch = await timed(() => coordinator.apply({
    taskId: task.id,
    taskToken: task.task_token,
    sessionId,
    operations: [
      {
        workspace_id: storageSetup.value.workspaceAId,
        op: "update",
        path: generation.value.hotFile,
        edits: [{ old_text: incrementalMarker, new_text: "LCA_PATCHED_PRIMARY" }]
      },
      {
        workspace_id: storageSetup.value.workspaceBId,
        op: "create",
        path: "src/cross-workspace-result.js",
        content: "export const crossWorkspaceResult = 'committed';\n"
      }
    ]
  }));
  assert.equal(crossWorkspacePatch.value.ok, true);
  assert.match(
    await readFile(path.join(workspaceA, generation.value.hotFile), "utf8"),
    /LCA_PATCHED_PRIMARY/
  );
  assert.match(
    await readFile(path.join(workspaceB, "src", "cross-workspace-result.js"), "utf8"),
    /committed/
  );
  await router.closeTask({ taskToken: task.task_token, sessionId });
  sampleMemory(memorySamples, "patched");
  captureEventLoopPhase(eventLoopPhases, phaseEventLoop, "cross_workspace_patch");
  if (typeof globalThis.gc === "function") {
    // A single major collection can leave the just-freed query/transaction
    // pages committed. Two quiet turns make the resident-set KPI repeatable
    // without changing the runtime workload being measured.
    for (let pass = 0; pass < 3; pass += 1) {
      globalThis.gc();
      await delay(10);
    }
    sampleMemory(memorySamples, "after-gc");
  }

  await graph.close();
  graph = null;
  await router.close();
  router = null;
  await registry.close();
  registry = null;
  sampleMemory(memorySamples, "closed");
  clearInterval(memoryTimer);
  memoryTimer = null;
  eventLoop.disable();
  phaseEventLoop.disable();

  const memory = summarizeMemory(memorySamples);
  const eventLoopMetrics = {
    scope: "runtime_after_fixture_generation",
    ...summarizeEventLoop(eventLoop)
  };
  const warmQuery = summarizeDurations(warmQueryDurations);
  const sla = {
    full_index_under_60s: fullIndex.ms < 60_000,
    warm_snapshot_under_500ms: snapshotWarm.ms < 500,
    warm_query_p95_under_300ms: warmQuery.p95_ms < 300,
    incremental_search_under_500ms: incrementalDetectedBeforeFallback && incrementalFreshnessMs < 500,
    event_loop_p99_under_20ms: eventLoopMetrics.p99_ms < 20,
    warm_calls_forced_gc_heap_growth_under_10pct: config.warmQueries < 1_000
      ? null
      : warmCallBaselineHeap === null || warmCallAfterHeap === null
        ? null
        : warmCallAfterHeap <= warmCallBaselineHeap * 1.1,
    rss_after_gc_under_128mb: memory.after_gc_rss_mb === null
      ? null
      : memory.after_gc_rss_mb < 128,
    ten_registered_two_hot_rss_under_128mb:
      storageSetup.value.registeredWorkspaceIds.length === 10 &&
      memory.after_gc_rss_mb !== null &&
      memory.after_gc_rss_mb < 128,
    two_hot_workspace_cache_under_64mb:
      ((coldPrewarm.value.persistence.raw_bytes || 0) + (secondaryPersistence.raw_bytes || 0)) < 64 * 1024 * 1024,
    ...(config.coldBuilder ? {
      cold_builder_main_event_loop_p99_under_20ms: coldBuilderMetrics.main_event_loop.p99_ms < 20,
      cold_builder_main_rss_under_128mb: memoryPhaseMb(memorySamples, "cold-builder-after-gc") < 128
    } : {})
  };
  const unmeasuredSla = Object.entries(sla).filter(([, passed]) => passed === null).map(([name]) => name);

  report = {
    benchmark: "lca-scale",
    version: 1,
    generated_at: new Date().toISOString(),
    config: {
      files: config.files,
      packages: generation.value.packageCount,
      write_concurrency: config.writeConcurrency,
      scan_concurrency: config.scanConcurrency,
      query_fingerprint_max_files: Math.min(config.files, 4_096),
      query_fingerprint_concurrency: config.queryFingerprintConcurrency,
      query_fingerprint_interval_ms: config.queryFingerprintIntervalMs,
      watch: config.watch,
      warm_queries: config.warmQueries,
      freshness_timeout_ms: config.freshnessTimeoutMs,
      large_scale_opt_in: config.largeScaleOptIn,
      cold_builder: config.coldBuilder,
      fixture_generation: config.isolateFixtureGeneration ? "isolated_child" : "inline"
    },
    fixture: {
      primary_files: generation.value.fileCount,
      secondary_files: 2,
      generated_bytes: generation.value.bytes,
      generation_ms: generation.ms,
      builder: generation.value.fixture_builder || { isolated: false }
    },
    storage: {
      setup_ms: storageSetup.ms,
      workspace_count: storageSetup.value.registeredWorkspaceIds.length,
      hot_workspace_graphs: 2,
      hot_cache_raw_bytes:
        (coldPrewarm.value.persistence.raw_bytes || 0) + (secondaryPersistence.raw_bytes || 0),
      task_open_ms: taskSetup.ms
    },
    index: {
      full_ms: fullIndex.ms,
      indexed_files: fullIndex.value.counts.files,
      complete: fullIndex.value.coverage.complete,
      content_complete: fullIndex.value.coverage.content_complete,
      parsed_files: config.coldBuilder
        ? fullIndex.value.external_builder.counts.parsed_files
        : fullIndex.value.changes.parsed_files,
      cold_builder: coldBuilderMetrics,
      package_count: dependencyGraph.packages.length,
      import_edges: dependencyGraph.import_edges.length,
      unresolved_local_imports: dependencyGraph.unresolved_local_imports.length,
      warm_snapshot_ms: snapshotWarm.ms,
      persistence: {
        compressed_bytes: persistedBytes,
        raw_bytes: coldPrewarm.value.persistence.raw_bytes,
        cold_load_ms: coldLoad.ms,
        cold_prewarm_ms: coldPrewarm.ms,
        loaded: coldPrewarm.value.persistence.loaded,
        reused_files: coldPrewarm.value.changes.reused_files,
        parsed_files: coldPrewarm.value.changes.parsed_files
      },
      watcher: {
        ...watcherStatus,
        initial_freshness: fullIndex.value.freshness.state,
        incremental_detected: incrementalDetectedBeforeFallback
      }
    },
    query: {
      ...warmQuery,
      warmup_ms: queryWarmup.ms,
      result_count: warmQueryResult.count,
      engine: warmQueryResult.engine,
      completeness: warmQueryResult.completeness,
      incremental_freshness_ms: incrementalFreshnessMs,
      incremental_detected_before_full_refresh: incrementalDetectedBeforeFallback,
      incremental_trace: {
        attempts: incrementalAttempts,
        watcher_observed_ms: watcherObservedMs,
        graph_updated_ms: graphUpdatedMs,
        search: summarizeDurations(incrementalQueryDurations)
      },
      forced_gc_heap: {
        baseline_mb: warmCallBaselineHeap === null ? null : bytesToMb(warmCallBaselineHeap),
        after_mb: warmCallAfterHeap === null ? null : bytesToMb(warmCallAfterHeap),
        growth_percent: warmCallBaselineHeap && warmCallAfterHeap !== null
          ? roundMs(((warmCallAfterHeap - warmCallBaselineHeap) / warmCallBaselineHeap) * 100)
          : null
      }
    },
    cross_workspace: {
      task_workspaces: task.workspace_ids.length,
      transaction_ms: crossWorkspacePatch.ms,
      transaction_status: crossWorkspacePatch.value.status,
      result_count: crossWorkspacePatch.value.results.length,
      coordinator: coordinator.status()
    },
    process: {
      memory,
      event_loop: eventLoopMetrics,
      event_loop_phases: eventLoopPhases,
      total_ms: roundMs(performance.now() - runStarted)
    },
    sla,
    sla_unmeasured: unmeasuredSla,
    sla_passed: Object.values(sla).filter((value) => value !== null).every(Boolean),
    diagnostic_limits: [
      "The workspace manager supplies WorkspaceGraph's workspace-scoped persistencePath.",
      "This benchmark reports aggregate graph timing rather than traversal, stat, parse, compression, and persistence sub-phases.",
      "This benchmark reports aggregate transaction timing rather than lock-wait, staging, commit, and recovery sub-phases.",
      "The benchmark composes registry, task routing, graph, and transaction subsystems through the same application-level boundaries as the runtime."
    ]
  };

  if (config.assertSla) {
    const failures = Object.entries(sla).filter(([, passed]) => passed !== true).map(([name]) => name);
    assert.deepEqual(failures, [], `SLA assertions failed: ${failures.join(", ")}`);
  }
} finally {
  if (memoryTimer) clearInterval(memoryTimer);
  eventLoop.disable();
  phaseEventLoop.disable();
  await graph?.close().catch(() => {});
  await secondaryGraph?.close().catch(() => {});
  await router?.close().catch(() => {});
  await registry?.close().catch(() => {});
  if (context) {
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
}

console.log(JSON.stringify(report, null, 2));

function parseArguments(args, env) {
  const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const scale = String(value("scale") || env.LCA_BENCH_SCALE || "").toLowerCase();
  if (scale && !["10k", "100k", "250k"].includes(scale)) {
    throw new Error("--scale must be one of: 10k, 100k, 250k.");
  }
  const scaleFiles = { "10k": 10_000, "100k": 100_000, "250k": 250_000 }[scale];
  const files = boundedInteger(
    value("files") || env.LCA_BENCH_FILES || scaleFiles || 10_000,
    10_000,
    100,
    250_000
  );
  const largeScaleOptIn = args.includes("--allow-large") || env.LCA_BENCH_ALLOW_LARGE === "1";
  if (files > 10_000 && !largeScaleOptIn) {
    throw new Error(
      "100k/250k benchmarks are opt-in. Pass --scale=100k|250k --allow-large (or LCA_BENCH_ALLOW_LARGE=1)."
    );
  }
  const requestedPackages = boundedInteger(
    value("packages") || env.LCA_BENCH_PACKAGES || Math.ceil(files / 500),
    Math.ceil(files / 500),
    2,
    64
  );
  const packages = Math.min(requestedPackages, Math.max(2, Math.floor((files - 1) / 3)));
  return {
    files,
    packages,
    largeScaleOptIn,
    assertSla: args.includes("--assert-sla") || env.LCA_BENCH_ASSERT_SLA === "1",
    coldBuilder: args.includes("--cold-builder") || env.LCA_BENCH_COLD_BUILDER === "1",
    isolateFixtureGeneration: !args.includes("--inline-fixture") && env.LCA_BENCH_ISOLATE_FIXTURE !== "0",
    builderTimeoutMs: boundedInteger(
      value("builder-timeout-ms") || env.LCA_BENCH_BUILDER_TIMEOUT_MS,
      120_000,
      1_000,
      600_000
    ),
    writeConcurrency: boundedInteger(value("write-concurrency") || env.LCA_BENCH_WRITE_CONCURRENCY, 64, 1, 256),
    scanConcurrency: boundedInteger(value("scan-concurrency") || env.LCA_BENCH_SCAN_CONCURRENCY, 64, 1, 64),
    queryFingerprintConcurrency: boundedInteger(
      value("query-fingerprint-concurrency") || env.LCA_BENCH_QUERY_FINGERPRINT_CONCURRENCY,
      16,
      1,
      64
    ),
    queryFingerprintIntervalMs: boundedInteger(
      value("query-fingerprint-interval-ms") || env.LCA_BENCH_QUERY_FINGERPRINT_INTERVAL_MS,
      200,
      0,
      5_000
    ),
    warmQueries: boundedInteger(value("warm-queries") || env.LCA_BENCH_WARM_QUERIES, 1_000, 5, 2_000),
    freshnessTimeoutMs: boundedInteger(
      value("freshness-timeout-ms") || env.LCA_BENCH_FRESHNESS_TIMEOUT_MS,
      2_000,
      100,
      30_000
    ),
    watch: String(value("watch") || env.LCA_BENCH_WATCH || "true").toLowerCase() !== "false"
  };
}

async function generateMonorepoInChild(root, {
  fileCount,
  packageCount,
  concurrency,
  context
}) {
  const started = performance.now();
  const { stdout } = await execFileAsync(process.execPath, [FIXTURE_BUILDER_PATH], {
    cwd: BENCHMARK_DIR,
    env: {
      ...process.env,
      LCA_BENCH_FIXTURE_SPEC: JSON.stringify({
        root,
        test_root: context.testRoot,
        run_id: context.runId,
        file_count: fileCount,
        package_count: packageCount,
        concurrency
      })
    },
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024
  });
  const result = JSON.parse(String(stdout || "").trim());
  return {
    ...result,
    fixture_builder: {
      isolated: true,
      duration_ms: roundMs(performance.now() - started)
    }
  };
}

async function timed(operation) {
  const started = performance.now();
  const value = await operation();
  return { value, ms: roundMs(performance.now() - started) };
}

function sampleMemory(samples, phase) {
  const usage = process.memoryUsage();
  const sample = {
    phase,
    rss: usage.rss,
    heap_total: usage.heapTotal,
    heap_used: usage.heapUsed,
    external: usage.external,
    array_buffers: usage.arrayBuffers
  };
  samples.push(sample);
  return sample;
}

function summarizeMemory(samples) {
  const first = samples[0] || { rss: 0, heap_used: 0, external: 0 };
  const last = samples.at(-1) || first;
  const afterGc = [...samples].reverse().find((sample) => sample.phase === "after-gc") || null;
  return {
    start_rss_mb: bytesToMb(first.rss),
    end_rss_mb: bytesToMb(last.rss),
    peak_rss_mb: bytesToMb(Math.max(...samples.map((sample) => sample.rss), 0)),
    start_heap_used_mb: bytesToMb(first.heap_used),
    end_heap_used_mb: bytesToMb(last.heap_used),
    peak_heap_used_mb: bytesToMb(Math.max(...samples.map((sample) => sample.heap_used), 0)),
    peak_external_mb: bytesToMb(Math.max(...samples.map((sample) => sample.external), 0)),
    gc_available: afterGc !== null,
    after_gc_rss_mb: afterGc ? bytesToMb(afterGc.rss) : null,
    after_gc_heap_used_mb: afterGc ? bytesToMb(afterGc.heap_used) : null,
    phases: samples
      .filter((sample) => sample.phase !== "sample")
      .map((sample) => ({
        phase: sample.phase,
        rss_mb: bytesToMb(sample.rss),
        heap_total_mb: bytesToMb(sample.heap_total),
        heap_used_mb: bytesToMb(sample.heap_used),
        external_mb: bytesToMb(sample.external),
        array_buffers_mb: bytesToMb(sample.array_buffers)
      }))
  };
}

function captureEventLoopPhase(output, histogram, name) {
  output[name] = summarizeEventLoop(histogram);
  histogram.reset();
}

function summarizeEventLoop(histogram) {
  const nanosecondsToMs = (value) => Number.isFinite(value) ? roundMs(value / 1e6) : null;
  return {
    mean_ms: nanosecondsToMs(histogram.mean),
    max_ms: nanosecondsToMs(histogram.max),
    p50_ms: nanosecondsToMs(histogram.percentile(50)),
    p95_ms: nanosecondsToMs(histogram.percentile(95)),
    p99_ms: nanosecondsToMs(histogram.percentile(99))
  };
}

function summarizeDurations(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    calls: sorted.length,
    min_ms: roundMs(sorted[0] || 0),
    median_ms: roundMs(percentile(sorted, 50)),
    p95_ms: roundMs(percentile(sorted, 95)),
    max_ms: roundMs(sorted.at(-1) || 0)
  };
}

function percentile(sorted, value) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((value / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.trunc(parsed)))
    : fallback;
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function bytesToMb(value) {
  return Math.round((Number(value || 0) / 1024 / 1024) * 100) / 100;
}

function memoryPhaseMb(samples, phase) {
  const sample = [...samples].reverse().find((candidate) => candidate.phase === phase);
  return sample ? bytesToMb(sample.rss) : Number.POSITIVE_INFINITY;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
