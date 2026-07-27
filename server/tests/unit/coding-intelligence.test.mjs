// Local Coding Agent runtime coding-intelligence tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress } from "node:zlib";
import { CodeQueryEngine } from "../../src/coding/query-engine.mjs";
import { discoverBuiltinStructuralSemanticAdapter } from "../../src/coding/semantic/structural-adapter.mjs";
import { STRUCTURAL_SEMANTIC_ARTIFACT } from "../../src/coding/semantic/artifacts.mjs";
import { VerificationPlanner } from "../../src/verification/planner.mjs";
import { WorkspaceGraph } from "../../src/workspace/graph/workspace-graph.mjs";
import {
  createGitFixture,
  createIsolatedTestRoot,
  safeRemove
} from "../helpers/test-guard.mjs";

const execFileAsync = promisify(execFile);
const compressBrotli = promisify(brotliCompress);
const decompressBrotli = promisify(brotliDecompress);

function fakeWatcherHarness() {
  const watcher = new EventEmitter();
  let listener = null;
  watcher.closed = false;
  watcher.ready = true;
  watcher.coverageComplete = true;
  watcher.close = () => {
    watcher.closed = true;
  };
  return {
    watcher,
    factory(_rootDir, _options, nextListener) {
      listener = nextListener;
      return watcher;
    },
    emit(relativePath, eventType = "change") {
      listener?.(eventType, relativePath);
    }
  };
}

async function waitFor(predicate, { timeoutMs = 1_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  assert.fail("Timed out waiting for WorkspaceGraph state.");
}

test("WorkspaceGraph expands coverage and detects same-size external changes by fingerprint", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-graph-", protectedPaths: [path.resolve("..")] });
  const root = context.fixtureDir;
  try {
    await mkdir(path.join(root, "src", "deep"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
    await writeFile(path.join(root, "src", "index.js"), "export const alpha = 1;\n", "utf8");
    await writeFile(path.join(root, "src", "deep", "feature.custom"), "universal lexical fallback needle\n", "utf8");

    let clock = Date.now();
    const graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-test",
      maxDepth: 0,
      maxFiles: 100,
      maxFileBytes: 4_096,
      now: () => clock
    });
    const shallow = await graph.refresh();
    assert.equal(shallow.coverage.max_depth, 0);
    assert.equal(shallow.coverage.max_file_bytes, 4_096);
    assert.deepEqual(shallow.root, { workspace_id: "workspace-graph-test", path: "." });
    assert.equal(graph.getRecord("src/index.js"), null);
    assert.equal(graph.covers({ maxDepth: 2, maxFiles: 100, maxFileBytes: 4_096 }), false);

    const deep = await graph.ensureFresh({ maxDepth: 3 });
    assert.equal(deep.coverage.max_depth, 3);
    assert.ok(graph.getRecord("src/deep/feature.custom"));
    assert.equal(graph.covers({ maxDepth: 2, maxFiles: 100, maxFileBytes: 4_096 }), true);
    assert.ok(deep.changes.added.includes("src/index.js"));
    const cached = await graph.ensureFresh();
    assert.equal(cached.cache_hit, true);
    assert.equal(cached.changes.parsed_files, 0);
    clock += 501;
    assert.equal(graph.freshness().state, "stale");

    const target = path.join(root, "src", "index.js");
    const before = await stat(target);
    const oldFingerprint = graph.getRecord("src/index.js").fingerprint;
    await writeFile(target, "export const alpha = 2;\n", "utf8");
    await utimes(target, before.atime, before.mtime);
    const refreshed = await graph.ensureFresh({ force: true });
    assert.notEqual(graph.getRecord("src/index.js").fingerprint, oldFingerprint);
    assert.ok(refreshed.changes.changed.includes("src/index.js"));
    assert.ok(refreshed.changes.reused_files >= 1);
    assert.match((await graph.search("fallback needle"))[0].location.path, /feature\.custom$/);
  } finally {
    await safeRemove(root, context, { recursive: true, force: true });
  }
});

test("WorkspaceGraph query fingerprint invalidates changed, added, and removed files inside the cache TTL", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-graph-fingerprint-", protectedPaths: [path.resolve("..")] });
  const root = context.fixtureDir;
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    const target = path.join(root, "src", "index.js");
    await writeFile(target, "export const value = 1;\n", "utf8");
    const graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-fingerprint",
      maxDepth: 4,
      maxFiles: 100,
      reconcileIntervalMs: 60_000,
      queryFingerprintMaxFiles: 100,
      queryFingerprintIntervalMs: 0
    });
    await graph.refresh();

    await writeFile(target, "export const value = 2;\n", "utf8");
    const changed = await graph.ensureFresh();
    assert.equal(changed.cache_hit, false);
    assert.deepEqual(changed.changes.changed, ["src/index.js"]);
    assert.match(graph.getRecord("src/index.js").content, /value = 2/);
    assert.equal(graph.freshness().query_fingerprint.matched, true);
    assert.equal(graph.freshness().query_fingerprint.reconciled_changes, 1);

    const addedPath = path.join(root, "src", "added.js");
    await writeFile(addedPath, "export const added = true;\n", "utf8");
    const added = await graph.ensureFresh();
    assert.ok(added.changes.added.includes("src/added.js"));
    assert.match(graph.getRecord("src/added.js").content, /added = true/);
    assert.equal((await graph.ensureFresh()).cache_hit, true);

    await unlink(addedPath);
    const removed = await graph.ensureFresh();
    assert.ok(removed.changes.removed.includes("src/added.js"));
    assert.equal(graph.getRecord("src/added.js"), null);
  } finally {
    await safeRemove(root, context, { recursive: true, force: true });
  }
});

test("WorkspaceGraph search scans source before allocating line fragments", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-graph-search-",
    protectedPaths: [path.resolve("..")]
  });
  const root = context.fixtureDir;
  try {
    await writeFile(path.join(root, "search.txt"), "first line\nNeedle one\nneedle two\n", "utf8");
    const graph = new WorkspaceGraph({ rootDir: root, workspaceId: "workspace-graph-search" });
    await graph.refresh();
    const matches = await graph.search("needle", { caseSensitive: false, limit: 5 });
    assert.deepEqual(matches.map((entry) => [entry.location.line, entry.location.column]), [[2, 1], [3, 1]]);
    assert.deepEqual(matches.map((entry) => entry.snippet), ["Needle one", "needle two"]);
  } finally {
    await safeRemove(root, context, { recursive: true, force: true });
  }
});

test("WorkspaceGraph search prioritizes freshly reconciled exact paths", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-graph-search-reconciled-",
    protectedPaths: [path.resolve("..")] 
  });
  const root = context.fixtureDir;
  let graph;
  try {
    await writeFile(path.join(root, "a.txt"), "fresh priority needle in unchanged file\n", "utf8");
    await writeFile(path.join(root, "z.txt"), "no match yet\n", "utf8");
    graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-search-reconciled",
      queryFingerprintMaxFiles: 100,
      queryFingerprintIntervalMs: 0
    });
    await graph.refresh();
    await writeFile(path.join(root, "z.txt"), "fresh priority needle in newly changed file\n", "utf8");

    const matches = await graph.search("fresh priority needle", {
      caseSensitive: true,
      limit: 5
    });
    assert.equal(matches[0].location.path, "z.txt");
    assert.match(matches[0].snippet, /newly changed file/);
  } finally {
    await graph?.close();
    await safeRemove(root, context, { recursive: true, force: true });
  }
});

test("WorkspaceGraph lets a delayed watcher event preempt a large missing-needle scan", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-graph-search-watcher-opportunity-",
    protectedPaths: [path.resolve("..")]
  });
  const root = context.fixtureDir;
  const harness = fakeWatcherHarness();
  let graph;
  try {
    const target = path.join(root, "changed.js");
    await writeFile(target, "export const value = 'old';\n", "utf8");
    graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-search-watcher-opportunity",
      watch: true,
      watchDebounceMs: 50,
      watchReconcileIntervalMs: 0,
      queryFingerprint: false,
      searchWatcherOpportunityMinFiles: 0,
      watchFactory: harness.factory
    });
    await graph.refresh();

    const changed = (async () => {
      await delay(5);
      await writeFile(target, "export const value = 'delayed-watcher-needle';\n", "utf8");
      harness.emit("changed.js");
    })();
    const matches = await graph.search("delayed-watcher-needle", {
      caseSensitive: true,
      limit: 5
    });
    await changed;

    assert.equal(matches.length, 1);
    assert.equal(matches[0].location.path, "changed.js");
    assert.equal(graph.snapshot().changes.parsed_files, 1);
  } finally {
    await graph?.close();
    await safeRemove(root, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("WorkspaceGraph incrementally adopts an exact changed path from a bounded fingerprint sample", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-graph-bounded-fingerprint-",
    protectedPaths: [path.resolve("..")]
  });
  const root = context.fixtureDir;
  let graph;
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(
      path.join(root, "src", `file-${String(index).padStart(3, "0")}.js`),
      `export const value${index} = ${index};\n`,
      "utf8"
    )));
    graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-bounded-fingerprint",
      maxDepth: 4,
      maxFiles: 1_000,
      reconcileIntervalMs: 60_000,
      queryFingerprintMaxFiles: 100,
      queryFingerprintIntervalMs: 0
    });
    await graph.refresh();

    const target = path.join(root, "src", "file-010.js");
    await writeFile(target, "export const value10 = 999;\n", "utf8");
    const refreshed = await graph.ensureFresh({ returnSnapshot: false });

    assert.equal(refreshed.cache_hit, false);
    assert.deepEqual(refreshed.changes.changed, ["src/file-010.js"]);
    assert.match(graph.getRecord("src/file-010.js").content, /999/);
    assert.equal(graph.freshness().query_fingerprint.complete, false);
    assert.equal(graph.freshness().query_fingerprint.matched, true);
    assert.equal(graph.freshness().query_fingerprint.reconciled_changes, 1);
    assert.equal(graph.freshness().authoritative, false);
  } finally {
    await graph?.close();
    await safeRemove(root, context, { recursive: true, force: true });
  }
});

test("WorkspaceGraph watcher debounces path invalidations and stop cancels queued work", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-graph-watcher-", protectedPaths: [path.resolve("..")] });
  const root = context.fixtureDir;
  const harness = fakeWatcherHarness();
  let graph;
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    const target = path.join(root, "src", "index.js");
    await writeFile(target, "export const value = 1;\n", "utf8");
    graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-watcher",
      maxDepth: 4,
      watch: true,
      watchDebounceMs: 10,
      watchReconcileIntervalMs: 0,
      queryFingerprint: false,
      reconcileIntervalMs: 60_000,
      watchFactory: harness.factory
    });
    await graph.refresh();
    assert.equal(graph.watcherStatus().active, true);

    await writeFile(target, "export const value = 2;\n", "utf8");
    harness.emit("src/index.js");
    harness.emit("src/index.js");
    assert.equal(graph.watcherStatus().pending_events, 1);
    assert.equal(graph.freshness().state, "invalidated");
    await waitFor(() => graph.getRecord("src/index.js")?.content.includes("value = 2"));
    assert.equal(graph.watcherStatus().pending_events, 0);
    assert.deepEqual(graph.snapshot().changes.changed, ["src/index.js"]);
    assert.equal(graph.snapshot().changes.parsed_files, 1);

    await writeFile(target, "export const value = 3;\n", "utf8");
    harness.emit("src/index.js");
    const stopped = await graph.stopWatcher();
    assert.equal(stopped.active, false);
    assert.equal(harness.watcher.closed, true);
    await delay(30);
    assert.match(graph.getRecord("src/index.js").content, /value = 2/);
  } finally {
    await graph?.stopWatcher();
    await safeRemove(root, context, { recursive: true, force: true });
  }
});

test("WorkspaceGraph retains exact events from a resource-limited partial watcher", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-graph-partial-watcher-", protectedPaths: [path.resolve("..")] });
  const root = context.fixtureDir;
  const harness = fakeWatcherHarness();
  let graph;
  try {
    const target = path.join(root, "index.js");
    await writeFile(target, "export const value = 1;\n", "utf8");
    graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-partial-watcher",
      watch: true,
      watchDebounceMs: 5,
      watchReconcileIntervalMs: 0,
      queryFingerprint: false,
      reconcileIntervalMs: 60_000,
      watchFactory: harness.factory
    });
    await graph.refresh();

    const resourceError = new Error("synthetic watcher resource limit");
    resourceError.code = "EMFILE";
    harness.watcher.coverageComplete = false;
    harness.watcher.emit("degraded", resourceError);
    assert.equal(graph.watcherStatus().active, true);
    assert.equal(graph.watcherStatus().coverage_complete, false);
    assert.equal(graph.watcherStatus().error.code, "EMFILE");
    assert.equal(graph.freshness().state, "degraded");

    await writeFile(target, "export const value = 2;\n", "utf8");
    harness.emit("index.js");
    await waitFor(() => graph.getRecord("index.js")?.content.includes("value = 2"));
    assert.equal(graph.watcherStatus().active, true);
    assert.deepEqual(graph.snapshot().changes.changed, ["index.js"]);
  } finally {
    await graph?.stopWatcher();
    await safeRemove(root, context, { recursive: true, force: true });
  }
});

test("WorkspaceGraph watcher periodically reconciles events missed by the watcher", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-graph-reconcile-", protectedPaths: [path.resolve("..")] });
  const root = context.fixtureDir;
  const harness = fakeWatcherHarness();
  let graph;
  try {
    const target = path.join(root, "index.js");
    await writeFile(target, "export const value = 1;\n", "utf8");
    graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-reconcile",
      watch: true,
      watchReconcileIntervalMs: 20,
      queryFingerprint: false,
      reconcileIntervalMs: 60_000,
      watchFactory: harness.factory
    });
    await graph.refresh();
    const watchError = new Error("synthetic watcher failure");
    watchError.code = "EIO";
    harness.watcher.emit("error", watchError);
    await waitFor(() => graph.watcherStatus().active === false);
    assert.equal(graph.watcherStatus().error.code, "EIO");
    await writeFile(target, "export const value = 2;\n", "utf8");
    await waitFor(() => graph.getRecord("index.js")?.content.includes("value = 2"));
    assert.ok(graph.generation >= 2);
  } finally {
    await graph?.stopWatcher();
    await safeRemove(root, context, { recursive: true, force: true });
  }
});

test("WorkspaceGraph persists a compressed atomic index and validates it before cold prewarm", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-graph-persist-", protectedPaths: [path.resolve("..")] });
  const root = context.fixtureDir;
  const persistencePath = path.join(context.dataDir, "index", "workspace-graph.json.br");
  const legacyPersistencePath = path.join(context.dataDir, "index", "workspace-graph-v2.json.br");
  let graph;
  let legacyGraph;
  let undercoveredGraph;
  let coldGraph;
  let flushedGraph;
  let shardCorruptGraph;
  let corruptGraph;
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    const target = path.join(root, "src", "index.js");
    await writeFile(target, "export const persistedNeedle = 1;\n", "utf8");
    graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-persist",
      persistencePath,
      queryFingerprintMaxFiles: 100,
      queryFingerprintIntervalMs: 0
    });
    const indexed = await graph.refresh();
    assert.equal(indexed.persistence.enabled, true);
    assert.equal(indexed.persistence.error, null);
    assert.equal(indexed.persistence.schema_version, 3);
    assert.ok(indexed.persistence.shard_count > 0);
    assert.ok(indexed.persistence.compressed_bytes > 0);
    assert.match(graph.getRecord("src/index.js").fingerprint, /^[a-f0-9]{32}$/);
    const compressed = await readFile(persistencePath);
    assert.equal(compressed.includes(Buffer.from("persistedNeedle")), false);
    const shardDirectory = `${persistencePath}.shards`;
    const initialShards = (await readdir(shardDirectory)).filter((name) => name.endsWith(".br"));
    assert.ok(initialShards.length > 0);
    assert.equal(initialShards.every((name) => /^[a-f0-9]{64}\.br$/.test(name)), true);
    assert.deepEqual(
      (await readdir(path.dirname(persistencePath))).filter((name) => name.endsWith(".tmp")),
      []
    );
    assert.deepEqual(
      (await readdir(shardDirectory)).filter((name) => name.endsWith(".tmp")),
      []
    );
    await graph.close();
    graph = null;

    const manifest = await readPersistedTestPayload(persistencePath);
    const undercoveredPersistencePath = path.join(
      context.dataDir,
      "index",
      "workspace-graph-undercovered.json.br"
    );
    const sourceDescriptor = manifest.shards[0];
    const sourceShard = await readPersistedTestPayload(path.join(shardDirectory, sourceDescriptor.file));
    sourceShard.records[0][7] = 64;
    const undercoveredShard = await encodePersistedTestPayload(sourceShard);
    const undercoveredShardDirectory = `${undercoveredPersistencePath}.shards`;
    await mkdir(undercoveredShardDirectory, { recursive: true });
    const undercoveredShardFile = `${undercoveredShard.payloadHash}.br`;
    await writeFile(
      path.join(undercoveredShardDirectory, undercoveredShardFile),
      undercoveredShard.compressed
    );
    await writePersistedTestPayload(undercoveredPersistencePath, {
      ...manifest,
      shards: [{
        ...sourceDescriptor,
        file: undercoveredShardFile,
        payload_hash: undercoveredShard.payloadHash,
        raw_bytes: undercoveredShard.raw.length,
        compressed_bytes: undercoveredShard.compressed.length
      }]
    });
    undercoveredGraph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-persist",
      persistencePath: undercoveredPersistencePath,
      queryFingerprintMaxFiles: 100
    });
    await undercoveredGraph.initialize();
    assert.equal(undercoveredGraph.getRecords().length, 0);
    assert.equal(undercoveredGraph.persistenceStatus().error?.code, "PERSISTED_INDEX_INVALID");
    await undercoveredGraph.close();
    undercoveredGraph = null;

    const legacyRecords = [];
    for (const shard of manifest.shards) {
      const payload = await readPersistedTestPayload(path.join(shardDirectory, shard.file));
      legacyRecords.push(...payload.records);
    }
    const legacyWorkspaceFingerprint = createHash("sha256");
    for (const record of legacyRecords) {
      record[4] = createHash("sha256").update(String(record[6] || "")).digest("hex");
      legacyWorkspaceFingerprint.update(String(record[0]));
      legacyWorkspaceFingerprint.update("\0");
      legacyWorkspaceFingerprint.update(record[4]);
      legacyWorkspaceFingerprint.update("\0");
    }
    const legacyPayload = {
      ...manifest,
      schema_version: 2,
      workspace_fingerprint: legacyWorkspaceFingerprint.digest("hex"),
      records: legacyRecords
    };
    delete legacyPayload.shard_schema_version;
    delete legacyPayload.shard_record_limit;
    delete legacyPayload.record_count;
    delete legacyPayload.shards;
    await writePersistedTestPayload(legacyPersistencePath, legacyPayload);
    legacyGraph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-persist",
      persistencePath: legacyPersistencePath,
      queryFingerprintMaxFiles: 100
    });
    await legacyGraph.initialize();
    assert.equal(legacyGraph.persistenceStatus().loaded, true);
    assert.equal(legacyGraph.persistenceStatus().schema_version, 2);
    assert.equal(legacyGraph.persistenceStatus().shard_count, 0);
    assert.match(legacyGraph.getRecord("src/index.js").content, /persistedNeedle = 1/);
    assert.match(legacyGraph.getRecord("src/index.js").fingerprint, /^[a-f0-9]{64}$/);
    await legacyGraph.close();
    legacyGraph = null;

    coldGraph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-persist",
      persistencePath,
      packedRecordThreshold: 1,
      workerRecordThreshold: 1,
      queryFingerprintMaxFiles: 100,
      queryFingerprintIntervalMs: 0
    });
    await coldGraph.initialize();
    assert.equal(coldGraph.persistenceStatus().loaded, true);
    assert.equal(coldGraph.persistenceStatus().record_store, "packed");
    assert.match(coldGraph.getRecord("src/index.js").content, /persistedNeedle/);
    assert.equal("workspace_id" in coldGraph.getRecord("src/index.js"), false);
    assert.equal("checked_at" in coldGraph.getRecord("src/index.js"), false);
    assert.equal(Object.isFrozen(coldGraph.getRecord("src/index.js").imports), true);
    assert.equal(Object.isFrozen(coldGraph.getRecord("src/index.js").calls), true);
    const validated = await coldGraph.prewarm();
    assert.equal(validated.cache_hit, true);
    assert.equal(validated.changes.reused_files, 1);
    assert.equal(validated.changes.parsed_files, 0);
    assert.deepEqual(validated.changes.unchanged, []);
    const packedTextQuery = await new CodeQueryEngine({ graph: coldGraph }).query({
      query: "PERSISTEDneedle",
      mode: "text",
      depth: "fast",
      limit: 5
    });
    assert.equal(packedTextQuery.count, 1);
    assert.equal(packedTextQuery.results[0].location.path, "src/index.js");

    await writeFile(target, "export const persistedNeedle = 2;\n", "utf8");
    const prewarmed = await coldGraph.prewarm();
    assert.equal(prewarmed.prewarmed, true);
    assert.deepEqual(prewarmed.changes.changed, ["src/index.js"]);
    assert.match(coldGraph.getRecord("src/index.js").content, /persistedNeedle = 2/);
    assert.equal("workspace_id" in coldGraph.getRecord("src/index.js"), false);
    assert.equal("checked_at" in coldGraph.getRecord("src/index.js"), false);
    assert.equal(prewarmed.freshness.authoritative, true);
    assert.equal(coldGraph.persistenceStatus().dirty, true);

    await coldGraph.close();
    coldGraph = null;
    flushedGraph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-persist",
      persistencePath,
      packedRecordThreshold: 1,
      workerRecordThreshold: 1,
      queryFingerprintMaxFiles: 100
    });
    await flushedGraph.initialize();
    assert.equal(flushedGraph.persistenceStatus().loaded, true);
    assert.match(flushedGraph.getRecord("src/index.js").content, /persistedNeedle = 2/);
    await flushedGraph.close();
    flushedGraph = null;

    for (const shardName of (await readdir(shardDirectory)).filter((name) => name.endsWith(".br"))) {
      await writeFile(path.join(shardDirectory, shardName), "corrupt-shard", "utf8");
    }
    shardCorruptGraph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-persist",
      persistencePath,
      queryFingerprintMaxFiles: 100
    });
    await shardCorruptGraph.initialize();
    assert.equal(shardCorruptGraph.getRecords().length, 0);
    assert.ok(shardCorruptGraph.persistenceStatus().error);
    const shardRecovered = await shardCorruptGraph.refresh();
    assert.equal(shardRecovered.counts.files, 1);
    assert.equal(shardRecovered.persistence.error, null);
    await shardCorruptGraph.close();
    shardCorruptGraph = null;

    await writeFile(persistencePath, "not-a-brotli-index", "utf8");
    corruptGraph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-persist",
      persistencePath,
      queryFingerprintMaxFiles: 100
    });
    await corruptGraph.initialize();
    assert.equal(corruptGraph.getRecords().length, 0);
    assert.ok(corruptGraph.persistenceStatus().error);
    const recovered = await corruptGraph.refresh();
    assert.equal(recovered.counts.files, 1);
    assert.equal(recovered.persistence.error, null);
  } finally {
    await graph?.close();
    await legacyGraph?.close();
    await undercoveredGraph?.close();
    await coldGraph?.close();
    await flushedGraph?.close();
    await shardCorruptGraph?.close();
    await corruptGraph?.close();
    await safeRemove(root, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("WorkspaceGraph keeps canonical fingerprints across rapid replacements, flush, and restart", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-graph-canonical-fingerprint-",
    protectedPaths: [path.resolve("..")] 
  });
  const root = context.fixtureDir;
  const persistencePath = path.join(context.dataDir, "index", "workspace-graph.json.br");
  const target = path.join(root, "src", "index.js");
  let graph;
  let restoredGraph;
  let independentGraph;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    const versionA = "export const canonicalValue = 'a';\n";
    const versionB = "export const canonicalValue = 'version-b-is-longer';\n";
    const versionC = "export const canonicalValue = 'version-c-is-longer-than-b';\n";
    await writeFile(target, versionA, "utf8");

    graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-canonical-fingerprint",
      persistencePath,
      persistenceDebounceMs: 60_000,
      queryFingerprintMaxFiles: 100,
      queryFingerprintIntervalMs: 0
    });
    await graph.refresh();
    const initialFingerprint = graph.snapshot().fingerprint;
    const initialSavedAt = graph.persistenceStatus().saved_at;

    await writeFile(target, versionB, "utf8");
    const versionBResult = await graph.ensureFresh({ returnSnapshot: false });
    assert.deepEqual(versionBResult.changes.changed, ["src/index.js"]);
    assert.notEqual(graph.snapshot().fingerprint, initialFingerprint);
    assert.equal(graph.persistenceStatus().dirty, true);
    assert.equal(graph.persistenceStatus().saved_at, initialSavedAt);

    await writeFile(target, versionA, "utf8");
    await graph.ensureFresh({ returnSnapshot: false });
    assert.equal(
      graph.snapshot().fingerprint,
      initialFingerprint,
      "returning to identical content must restore the canonical content fingerprint"
    );

    await writeFile(target, versionC, "utf8");
    await graph.ensureFresh({ returnSnapshot: false });
    const finalFingerprint = graph.snapshot().fingerprint;
    const finalMetadataFingerprint = graph.workspaceMetadataFingerprint;
    assert.notEqual(finalFingerprint, initialFingerprint);
    assert.match(graph.getRecord("src/index.js").content, /version-c-is-longer-than-b/);
    assert.equal(graph.persistenceStatus().dirty, true);
    assert.equal(graph.persistenceStatus().saved_at, initialSavedAt);

    const closed = await graph.close();
    graph = null;
    assert.equal(closed.persistence.dirty, false);
    assert.equal(closed.persistence.error, null);

    const manifest = await readPersistedTestPayload(persistencePath);
    assert.equal(manifest.workspace_fingerprint, finalFingerprint);
    assert.equal(manifest.workspace_metadata_fingerprint, finalMetadataFingerprint);

    restoredGraph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-canonical-fingerprint",
      persistencePath,
      queryFingerprintMaxFiles: 100,
      queryFingerprintIntervalMs: 0
    });
    await restoredGraph.initialize();
    assert.equal(restoredGraph.persistenceStatus().loaded, true);
    assert.equal(restoredGraph.persistenceStatus().error, null);
    assert.equal(restoredGraph.snapshot().fingerprint, finalFingerprint);
    assert.match(restoredGraph.getRecord("src/index.js").content, /version-c-is-longer-than-b/);
    const prewarmed = await restoredGraph.prewarm();
    assert.equal(prewarmed.cache_hit, true);
    assert.equal(prewarmed.changes.parsed_files, 0);

    independentGraph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-independent-fingerprint",
      queryFingerprint: false
    });
    const independentlyRefreshed = await independentGraph.refresh();
    assert.equal(
      independentlyRefreshed.fingerprint,
      finalFingerprint,
      "incremental and full refresh paths must produce the same content fingerprint"
    );
  } finally {
    await graph?.close();
    await restoredGraph?.close();
    await independentGraph?.close();
    await safeRemove(root, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("WorkspaceGraph close waits for accepted mutations and blocks post-close work", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-graph-close-barrier-",
    protectedPaths: [path.resolve("..")] 
  });
  const root = context.fixtureDir;
  const persistencePath = path.join(context.dataDir, "index", "workspace-graph.json.br");
  const target = path.join(root, "index.js");
  let graph;
  let restoredGraph;
  try {
    await writeFile(target, "export const closeBarrier = 1;\n", "utf8");
    graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-close-barrier",
      persistencePath,
      persistenceDebounceMs: 60_000,
      queryFingerprint: false
    });
    await graph.refresh();
    await writeFile(target, "export const closeBarrier = 22222;\n", "utf8");

    let refreshSettled = false;
    const refreshing = graph.refresh().then((value) => {
      refreshSettled = true;
      return value;
    }, (error) => {
      refreshSettled = true;
      throw error;
    });
    const closed = await graph.close();
    assert.equal(refreshSettled, true, "close must wait for already accepted graph mutations");
    const refreshed = await refreshing;
    assert.match(refreshed.changes.changed.join("\n"), /index\.js/);
    assert.equal(closed.persistence.dirty, false);
    assert.equal(closed.persistence.error, null);
    await assert.rejects(
      graph.ensureFresh(),
      (error) => error?.code === "WORKSPACE_GRAPH_CLOSED"
    );

    restoredGraph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-graph-close-barrier",
      persistencePath,
      queryFingerprint: false
    });
    await restoredGraph.initialize();
    assert.equal(restoredGraph.persistenceStatus().loaded, true);
    assert.match(restoredGraph.getRecord("index.js").content, /22222/);
  } finally {
    await graph?.close();
    await restoredGraph?.close();
    await safeRemove(root, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

async function readPersistedTestPayload(filePath) {
  const raw = await decompressBrotli(await readFile(filePath));
  assert.equal(raw[64], 0x0a);
  const expectedHash = raw.subarray(0, 64).toString("ascii");
  const body = raw.subarray(65);
  assert.equal(createHash("sha256").update(body).digest("hex"), expectedHash);
  return JSON.parse(body.toString("utf8"));
}

async function writePersistedTestPayload(filePath, value) {
  const encoded = await encodePersistedTestPayload(value);
  await writeFile(filePath, encoded.compressed);
  return encoded;
}

async function encodePersistedTestPayload(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const raw = Buffer.concat([
    Buffer.from(`${payloadHash}\n`, "ascii"),
    body
  ]);
  return {
    payloadHash,
    raw,
    compressed: await compressBrotli(raw)
  };
}

test("CodeQueryEngine keeps the globally best bounded text matches and reports truncation", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-query-top-k-", protectedPaths: [path.resolve("..")] });
  const root = context.fixtureDir;
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    for (let index = 0; index < 20; index++) {
      await writeFile(
        path.join(root, "src", `partial-${String(index).padStart(2, "0")}.txt`),
        `prefix boundedNeedle suffix ${index}\n`,
        "utf8"
      );
    }
    await writeFile(path.join(root, "src", "z-exact.txt"), "boundedNeedle\n", "utf8");

    const graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-query-top-k",
      queryFingerprintIntervalMs: 0,
      queryFingerprintMaxFiles: 100
    });
    const engine = new CodeQueryEngine({ graph });
    const result = await engine.query({
      query: "boundedNeedle",
      mode: "text",
      depth: "fast",
      limit: 3
    });

    assert.equal(result.count, 3);
    assert.equal(result.results[0].location.path, "src/z-exact.txt");
    assert.equal(result.results[0].score, 1);
    assert.deepEqual(
      result.results.slice(1).map((entry) => entry.location.path),
      ["src/partial-00.txt", "src/partial-01.txt"]
    );
    assert.equal(result.completeness.result_truncated, true);
    assert.equal(result.completeness.state, "partial");
    assert.equal(result.cache_hit, false);
    const cached = await engine.query({
      query: "boundedNeedle",
      mode: "text",
      depth: "fast",
      limit: 3
    });
    assert.equal(cached.cache_hit, true);
    assert.strictEqual(cached.results, result.results);
    assert.equal(Object.isFrozen(cached.results), true);

    await writeFile(path.join(root, "src", "a-exact.txt"), "boundedNeedle\n", "utf8");
    const invalidated = await engine.query({
      query: "boundedNeedle",
      mode: "text",
      depth: "fast",
      limit: 3
    });
    assert.equal(invalidated.cache_hit, false);
    assert.equal(invalidated.results[0].location.path, "src/a-exact.txt");
    assert.notStrictEqual(invalidated.results, cached.results);
  } finally {
    await safeRemove(root, context, { recursive: true, force: true });
  }
});

test("CodeQueryEngine supports every fast query mode and exposes semantic fallback metadata", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-query-", protectedPaths: [path.resolve("..")] });
  const root = context.fixtureDir;
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src", "helper.ts"),
      [
        "export interface Person { name: string; }",
        "export function helper(value: string) { return value.toUpperCase(); }",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "src", "api.ts"),
      [
        'import { helper } from "./helper.js";',
        "export function greet(name: string) { return helper(name); }",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "src", "run.ts"),
      [
        'import { greet } from "./api.js";',
        'export function run() { return greet("Ada"); }',
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(root, "notes.unknown"), "fallback text works for unknown extensions\n", "utf8");

    const graph = new WorkspaceGraph({ rootDir: root, workspaceId: "workspace-query-test", maxDepth: 4 });
    const engine = new CodeQueryEngine({ graph });

    const text = await engine.query({ query: "unknown extensions", mode: "text", depth: "fast" });
    assert.equal(text.results[0].location.path, "notes.unknown");
    const symbol = await engine.query({ query: "greet", mode: "symbol", depth: "fast" });
    assert.equal(symbol.results[0].name, "greet");
    assert.match(symbol.results[0].signature, /export function greet/);
    assert.equal(Object.hasOwn(graph.getRecord("src/api.ts").symbols[0], "signature"), false);
    const definition = await engine.query({ query: "greet", mode: "definition", depth: "fast" });
    assert.equal(definition.results[0].location.path, "src/api.ts");
    const references = await engine.query({ query: "greet", mode: "references", depth: "fast" });
    assert.ok(references.results.some((result) => result.location.path === "src/run.ts"));
    const imports = await engine.query({ query: "helper", mode: "imports", depth: "fast" });
    assert.equal(imports.results[0].module, "./helper.js");
    const callers = await engine.query({ query: "greet", mode: "callers", depth: "fast" });
    assert.ok(callers.results.some((result) => result.name === "run"));
    const callees = await engine.query({ query: "greet", mode: "callees", depth: "fast" });
    assert.ok(callees.results.some((result) => result.name === "helper"));
    const type = await engine.query({ query: "Person", mode: "type", depth: "fast" });
    assert.equal(type.results[0].symbol_kind, "interface");

    for (const result of [text, symbol, definition, references, imports, callers, callees, type]) {
      assert.ok(["lexical", "lexical+dependency_graph"].includes(result.engine));
      assert.equal(result.freshness.state, "fresh");
      assert.ok(["complete", "partial"].includes(result.completeness.state));
      assert.equal(typeof result.confidence, "number");
      assert.ok(result.results.every((item) =>
        item.location.workspace_id === "workspace-query-test" &&
        !path.isAbsolute(item.location.path)
      ));
    }

    const unavailable = await engine.query({ query: "greet", mode: "references", depth: "semantic" });
    assert.equal(unavailable.engine, "lexical+dependency_graph");
    assert.equal(unavailable.fallback_reason, "semantic_adapter_unavailable");
    assert.equal(unavailable.completeness.semantic_used, false);
    assert.equal(unavailable.completeness.semantic_attempted, 0);
    assert.equal(unavailable.completeness.state, "partial");

    const semanticEngine = new CodeQueryEngine({
      graph,
      semanticAdapters: {
        typescript: {
          kind: "lsp",
          warm: true,
          async query() {
            return {
              engine: "test-lsp",
              complete: true,
              confidence: 0.98,
              results: [{
                kind: "reference",
                name: "greet",
                path: "src/run.ts",
                line: 2,
                column: 32,
                score: 0.99
              }]
            };
          }
        }
      }
    });
    const semantic = await semanticEngine.query({ query: "greet", mode: "references", depth: "auto" });
    assert.equal(semantic.completeness.semantic_used, true);
    assert.equal(semantic.completeness.semantic_complete, true);
    assert.ok(["semantic", "test-lsp", "lexical+test-lsp"].includes(semantic.engine));
    assert.equal(semantic.fallback_reason, null);
    assert.ok(semantic.results.every((result) => !Object.hasOwn(result, "path")));
  } finally {
    await safeRemove(root, context, { recursive: true, force: true });
  }
});

test("WorkspaceGraph builds package/import edges and conservative impacted tests", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-dependency-graph-", protectedPaths: [path.resolve("..")] });
  const root = context.fixtureDir;
  try {
    await mkdir(path.join(root, "packages", "core", "src"), { recursive: true });
    await mkdir(path.join(root, "packages", "core", "test"), { recursive: true });
    await mkdir(path.join(root, "packages", "app", "src"), { recursive: true });
    await mkdir(path.join(root, "packages", "app", "test"), { recursive: true });
    await writeFile(path.join(root, "packages", "core", "package.json"), JSON.stringify({
      name: "@fixture/core",
      scripts: { test: "node --test" }
    }), "utf8");
    await writeFile(path.join(root, "packages", "core", "src", "index.ts"), "export function core() { return 1; }\n", "utf8");
    await writeFile(path.join(root, "packages", "core", "test", "core.test.ts"), 'import { core } from "../src/index.js";\ncore();\n', "utf8");
    await writeFile(path.join(root, "packages", "app", "package.json"), JSON.stringify({
      name: "@fixture/app",
      dependencies: { "@fixture/core": "workspace:*" },
      scripts: { test: "node --test" }
    }), "utf8");
    await writeFile(path.join(root, "packages", "app", "src", "use.ts"), 'import { core } from "@fixture/core";\nexport function use() { return core(); }\n', "utf8");
    await writeFile(path.join(root, "packages", "app", "test", "use.test.ts"), 'import { use } from "../src/use.js";\nuse();\n', "utf8");
    await writeFile(path.join(root, "settings.yaml"), "service:\n  timeout: 5\n", "utf8");

    const graph = new WorkspaceGraph({ rootDir: root, workspaceId: "workspace-dependency-test", maxDepth: 8 });
    await graph.refresh();
    const dependency = graph.dependencyGraph();
    assert.equal(dependency.completeness, "complete");
    assert.equal(dependency.packages.length, 2);
    const corePackage = dependency.packages.find((pkg) => pkg.name === "@fixture/core");
    const appPackage = dependency.packages.find((pkg) => pkg.name === "@fixture/app");
    assert.deepEqual(appPackage.internal_dependencies, [corePackage.id]);
    assert.deepEqual(corePackage.dependents, [appPackage.id]);
    assert.ok(dependency.import_edges.some((edge) =>
      edge.from.path === "packages/app/src/use.ts" &&
      edge.to?.path === "packages/core/src/index.ts" &&
      edge.kind === "workspace_package"
    ));
    assert.equal(dependency.unresolved_local_imports.length, 0);

    const definitions = graph.definitionCandidates("packages/app/src/use.ts", "core");
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].source, "static_import");
    assert.equal(definitions[0].location.path, "packages/core/src/index.ts");

    const impact = graph.impactedTests(["packages/core/src/index.ts"], {
      packageCwds: ["packages/app"]
    });
    assert.equal(impact.completeness, "complete");
    assert.deepEqual(impact.required_tests.map((entry) => entry.path), ["packages/app/test/use.test.ts"]);
    assert.deepEqual(impact.directly_impacted_tests.map((entry) => entry.path), ["packages/app/test/use.test.ts"]);

    assert.ok(graph.getRecord("settings.yaml").symbols.some((symbol) =>
      symbol.name === "timeout" && symbol.kind === "property"
    ));
    assert.equal(graph.getRecord("settings.yaml").analysis_engine, "structural_lexical");
  } finally {
    await safeRemove(root, context, { recursive: true, force: true });
  }
});

test("CodeQueryEngine runs all relevant adapters and reports partial semantic coverage honestly", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-query-adapters-", protectedPaths: [path.resolve("..")] });
  const root = context.fixtureDir;
  try {
    await writeFile(path.join(root, "api.ts"), "export function shared() { return 1; }\nshared();\n", "utf8");
    await writeFile(path.join(root, "api.py"), "def shared():\n    return 1\nshared()\n", "utf8");
    const graph = new WorkspaceGraph({ rootDir: root, workspaceId: "workspace-query-adapters" });
    const engine = new CodeQueryEngine({
      graph,
      semanticAdapters: {
        typescript: {
          kind: "ast",
          async query() {
            return { engine: "ts-ast", complete: true, confidence: 0.98, results: [] };
          }
        }
      }
    });
    const result = await engine.query({ query: "shared", mode: "references", depth: "semantic" });
    assert.equal(result.completeness.semantic_attempted, 1);
    assert.equal(result.completeness.semantic_used, true);
    assert.equal(result.completeness.semantic_complete, false);
    assert.equal(result.completeness.state, "partial");
    assert.match(result.fallback_reason, /semantic_adapter_unavailable_for:python/);
    assert.ok(result.confidence <= 0.94);
  } finally {
    await safeRemove(root, context, { recursive: true, force: true });
  }
});

test("built-in structural AST adapter covers the initial multi-language set", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-structural-ast-",
    protectedPaths: [path.resolve("..")]
  });
  const root = context.fixtureDir;
  let graph;
  let adapter;
  let recoveredAdapter;
  try {
    const sources = {
      "shared.js": "export function shared() { return 1; }\nshared();\n",
      "shared.ts": "export function shared(): number { return 1; }\nshared();\n",
      "shared.py": "def shared():\n    return 1\nshared()\n",
      "shared.go": "package fixture\nfunc shared() int { return 1 }\nfunc run() { shared() }\n",
      "shared.rs": "fn shared() -> i32 { 1 }\nfn run() { shared(); }\n",
      "Shared.java": "final class Shared { static int shared() { return 1; } static void run() { shared(); } }\n",
      "Shared.kt": "fun shared(): Int = 1\nfun run() { shared() }\n",
      "Shared.cs": "class Shared { static int shared() { return 1; } static void Run() { shared(); } }\n",
      "shared.dart": "int shared() => 1;\nvoid run() { shared(); }\n"
    };
    for (const [file, content] of Object.entries(sources)) {
      await writeFile(path.join(root, file), content, "utf8");
    }
    graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-structural-ast",
      maxFiles: 100,
      maxDepth: 4,
      maxFileBytes: 128 * 1024
    });
    await graph.refresh();
    adapter = await discoverBuiltinStructuralSemanticAdapter({
      rootDir: root,
      dataDir: context.dataDir
    });
    const semanticAdapters = Object.fromEntries(
      ["javascript", "typescript", "python", "go", "rust", "java", "kotlin", "csharp", "dart"]
        .map((language) => [language, adapter])
    );
    const engine = new CodeQueryEngine({ graph, semanticAdapters });
    const references = await engine.query({
      query: "shared",
      mode: "references",
      depth: "semantic",
      limit: 100
    });

    assert.equal(adapter.kind, "ast");
    assert.equal(adapter.hardPreemptible, true);
    assert.equal(adapter.artifact.origin, "data_dir");
    assert.equal(adapter.artifact.sha256, STRUCTURAL_SEMANTIC_ARTIFACT.sha256);
    assert.equal(
      createHash("sha256").update(await readFile(adapter.artifact.path)).digest("hex"),
      STRUCTURAL_SEMANTIC_ARTIFACT.sha256
    );
    assert.equal(references.completeness.semantic_attempted, 1);
    assert.equal(references.completeness.semantic_used, true);
    assert.equal(references.completeness.semantic_complete, true);
    assert.match(references.engine, /builtin-structural-ast-v1/);
    assert.equal(references.fallback_reason, null);
    assert.deepEqual(
      [...new Set(references.results.map((entry) => entry.language))].sort(),
      ["csharp", "dart", "go", "java", "javascript", "kotlin", "python", "rust", "typescript"]
    );

    await writeFile(adapter.artifact.path, "tampered-artifact", "utf8");
    recoveredAdapter = await discoverBuiltinStructuralSemanticAdapter({
      rootDir: root,
      dataDir: context.dataDir
    });
    assert.equal(
      createHash("sha256").update(await readFile(recoveredAdapter.artifact.path)).digest("hex"),
      STRUCTURAL_SEMANTIC_ARTIFACT.sha256,
      "a regular corrupt artifact must be replaced from the release-pinned bundle"
    );
  } finally {
    await recoveredAdapter?.close();
    await adapter?.close();
    await graph?.close();
    await safeRemove(root, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("VerificationPlanner includes staged and untracked files and never passes missing or skipped gates", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-verify-", protectedPaths: [path.resolve("..")] });
  const fixture = await createGitFixture(context, {
    initialFiles: {
      "fixture/package.json": JSON.stringify({
        name: "verification-fixture",
        scripts: { test: "node --test", lint: "eslint ." }
      }, null, 2),
      "fixture/src/index.js": "export const value = 1;\n"
    }
  });
  try {
    await writeFile(path.join(fixture.fixtureDir, "src", "index.js"), "export const value = 2;\n", "utf8");
    await writeFile(path.join(fixture.fixtureDir, "src", "new.js"), "export const added = true;\n", "utf8");
    await execFileAsync("git", ["add", "fixture/src/index.js"], { cwd: fixture.root, windowsHide: true });

    const planner = new VerificationPlanner({
      rootDir: fixture.fixtureDir,
      workspaceId: "workspace-verification-test"
    });
    const changes = await planner.inspectChanges();
    assert.equal(changes.summary.staged, 1);
    assert.equal(changes.summary.untracked, 1);
    assert.deepEqual(changes.staged[0], {
      workspace_id: "workspace-verification-test",
      path: "src/index.js"
    });
    assert.equal(Object.hasOwn(changes.files[0], "path"), false);
    assert.ok(changes.untracked.some((location) => location.path === "src/new.js"));

    const missing = await planner.plan({ include: ["test", "typecheck"] });
    assert.equal(missing.status, "INCOMPLETE");
    assert.ok(missing.reasons.includes("REQUIRED_GATE_MISSING"));
    assert.ok(missing.reasons.includes("REQUIRED_GATE_NOT_RUN"));
    assert.equal(missing.changes.summary.staged, 1);
    assert.equal(missing.changes.summary.untracked, 1);
    assert.deepEqual(missing.gates[0].cwd, {
      workspace_id: "workspace-verification-test",
      path: "."
    });

    const skipped = await planner.plan({
      include: ["test", "typecheck"],
      results: {
        test: { status: "pass", command: "npm test", exit_code: 0 },
        typecheck: { status: "skipped", summary: "not configured" }
      }
    });
    assert.equal(skipped.status, "INCOMPLETE");
    assert.ok(skipped.reasons.includes("REQUIRED_GATE_SKIPPED"));

    const complete = await planner.plan({
      include: ["test"],
      results: { test: { status: "pass", command: "npm test", exit_code: 0 } }
    });
    assert.equal(complete.status, "PASS");
    assert.equal(complete.gate_summary.pass, 1);

    const inconsistent = planner.evaluate(complete, {
      test: { status: "pass", command: "npm test", exit_code: 1 }
    });
    assert.equal(inconsistent.status, "FAIL");
    assert.ok(inconsistent.reasons.includes("REQUIRED_GATE_FAILED"));

    const limitedPlanner = new VerificationPlanner({
      rootDir: fixture.fixtureDir,
      workspaceId: "workspace-verification-limited",
      maxFiles: 1
    });
    const incompleteCoverage = await limitedPlanner.plan({
      include: ["test"],
      results: { test: { status: "pass", command: "npm test", exit_code: 0 } }
    });
    assert.equal(incompleteCoverage.status, "INCOMPLETE");
    assert.ok(incompleteCoverage.reasons.includes("INDEX_COVERAGE_INCOMPLETE"));

    const unmanaged = planner.evaluate(complete, {}, { unmanaged_changes: true });
    assert.equal(unmanaged.status, "INCOMPLETE");
    assert.ok(unmanaged.reasons.includes("UNMANAGED_CHANGES"));

    const inDoubt = planner.evaluate(complete, {}, { transaction_in_doubt: true });
    assert.equal(inDoubt.status, "INCOMPLETE");
    assert.equal(inDoubt.transaction_in_doubt, true);
    assert.ok(inDoubt.reasons.includes("TRANSACTION_IN_DOUBT"));

    const cleanInDoubt = planner.evaluate({
      ...complete,
      changes: {
        ...complete.changes,
        clean: true,
        dirty_unknown: false,
        files: [],
        staged: [],
        unstaged: [],
        untracked: [],
        summary: { changed_files: 0, staged: 0, unstaged: 0, untracked: 0 }
      },
      gates: []
    }, {}, { transaction_in_doubt: true });
    assert.equal(cleanInDoubt.status, "INCOMPLETE");
    assert.ok(cleanInDoubt.reasons.includes("TRANSACTION_IN_DOUBT"));

    const unknownUnmanagedState = planner.evaluate(complete, {}, {
      unmanaged_state_unknown: true
    });
    assert.equal(unknownUnmanagedState.status, "INCOMPLETE");
    assert.equal(unknownUnmanagedState.unmanaged_state_unknown, true);
    assert.ok(unknownUnmanagedState.reasons.includes("UNMANAGED_STATE_UNKNOWN"));
  } finally {
    await safeRemove(fixture.fixtureDir, context, { recursive: true, force: true });
  }
});

test("VerificationPlanner verifies committed changes and HEAD movement from the persisted task baseline", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-verify-baseline-", protectedPaths: [path.resolve("..")] });
  const fixture = await createGitFixture(context, {
    initialFiles: {
      "fixture/package.json": JSON.stringify({
        name: "baseline-fixture",
        scripts: { test: "node --test" }
      }),
      "fixture/src/index.js": "export const value = 1;\n"
    }
  });
  try {
    const baseHead = (await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.root,
      windowsHide: true
    })).stdout.trim();
    await writeFile(path.join(fixture.fixtureDir, "src", "index.js"), "export const value = 2;\n", "utf8");
    await execFileAsync("git", ["add", "fixture/src/index.js"], { cwd: fixture.root, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "committed task change"], { cwd: fixture.root, windowsHide: true });

    const planner = new VerificationPlanner({
      rootDir: fixture.fixtureDir,
      workspaceId: "workspace-verification-baseline"
    });
    const committed = await planner.plan({
      include: ["test"],
      base_head: baseHead,
      require_baseline: true,
      results: { test: { status: "pass", command: "npm test", exit_code: 0 } }
    });
    assert.equal(committed.status, "PASS");
    assert.equal(committed.changes.head_changed, true);
    assert.equal(committed.changes.summary.committed, 1);
    assert.ok(committed.changes.files.some((entry) =>
      entry.location.path === "src/index.js" && entry.committed === true
    ));

    const nextBase = committed.changes.head;
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "head only movement"], {
      cwd: fixture.root,
      windowsHide: true
    });
    const headOnly = await planner.plan({
      include: ["test"],
      base_head: nextBase,
      require_baseline: true
    });
    assert.equal(headOnly.changes.head_changed, true);
    assert.equal(headOnly.changes.files.length, 0);
    assert.equal(headOnly.status, "INCOMPLETE");
    assert.ok(headOnly.gates.some((gate) => gate.kind === "test" && gate.status === "pending"));

    const missingBaseline = await planner.plan({ include: ["test"], require_baseline: true });
    assert.equal(missingBaseline.status, "INCOMPLETE");
    assert.ok(missingBaseline.reasons.includes("TASK_BASELINE_UNKNOWN"));
  } finally {
    await safeRemove(fixture.fixtureDir, context, { recursive: true, force: true });
  }
});

test("VerificationPlanner expands internal dependents and scopes conservative package tests", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-verify-monorepo-", protectedPaths: [path.resolve("..")] });
  const unrelatedPackages = {};
  for (let index = 0; index < 6; index++) {
    const packageRoot = `fixture/packages/unrelated-${index}`;
    unrelatedPackages[`${packageRoot}/package.json`] = JSON.stringify({
      name: `@fixture/unrelated-${index}`,
      scripts: { test: "node --test" }
    });
    unrelatedPackages[`${packageRoot}/src/index.ts`] = `export const unrelated${index} = true;\n`;
    unrelatedPackages[`${packageRoot}/test/index.test.ts`] = "export const unrelatedTest = true;\n";
  }
  const fixture = await createGitFixture(context, {
    initialFiles: {
      "fixture/packages/core/package.json": JSON.stringify({
        name: "@fixture/core",
        scripts: { test: "node --test" }
      }),
      "fixture/packages/core/src/index.ts": "export function core() { return 1; }\n",
      "fixture/packages/core/test/core.test.ts": 'import { core } from "../src/index.js";\ncore();\n',
      "fixture/packages/app/package.json": JSON.stringify({
        name: "@fixture/app",
        dependencies: { "@fixture/core": "workspace:*" },
        scripts: { test: "node --test" }
      }),
      "fixture/packages/app/src/use.ts": 'import { core } from "@fixture/core";\nexport function use() { return core(); }\n',
      "fixture/packages/app/test/use.test.ts": 'import { use } from "../src/use.js";\nuse();\n',
      ...unrelatedPackages
    }
  });
  try {
    await writeFile(
      path.join(fixture.fixtureDir, "packages", "core", "src", "index.ts"),
      "export function core() { return 2; }\n",
      "utf8"
    );
    const planner = new VerificationPlanner({
      rootDir: fixture.fixtureDir,
      workspaceId: "workspace-verification-monorepo"
    });
    const plan = await planner.plan({ include: ["test"] });
    assert.equal(plan.status, "INCOMPLETE");
    assert.equal(plan.packages.length, 2);
    const corePackage = plan.packages.find((pkg) => pkg.name === "@fixture/core");
    const appPackage = plan.packages.find((pkg) => pkg.name === "@fixture/app");
    assert.equal(corePackage.impact_reason, "direct_change");
    assert.equal(appPackage.impact_reason, "internal_dependency_change");
    assert.deepEqual(appPackage.dependency_source_packages, [corePackage.package_id]);

    const coreGate = plan.gates.find((gate) => gate.cwd.path === "packages/core");
    const appGate = plan.gates.find((gate) => gate.cwd.path === "packages/app");
    assert.equal(coreGate.command_scope, "package_impacted_tests");
    assert.equal(coreGate.command, "npm test -- test/core.test.ts");
    assert.deepEqual(coreGate.impact.required_tests.map((entry) => entry.path), ["packages/core/test/core.test.ts"]);
    assert.equal(appGate.command_scope, "package_impacted_tests");
    assert.equal(appGate.command, "npm test -- test/use.test.ts");
    assert.deepEqual(appGate.impact.directly_impacted_tests.map((entry) => entry.path), ["packages/app/test/use.test.ts"]);

    const expectedTests = new Set([
      "packages/core/test/core.test.ts",
      "packages/app/test/use.test.ts"
    ]);
    const selectedTests = new Set(plan.gates.flatMap((gate) =>
      (gate.impact?.required_tests || []).map((entry) => entry.path)
    ));
    const truePositives = [...expectedTests].filter((testPath) => selectedTests.has(testPath)).length;
    const fullSuiteSize = planner.graph.getRecords().filter((record) => /\.test\.ts$/.test(record.path)).length;
    assert.ok(truePositives / expectedTests.size >= 0.95, "seeded impacted-test recall must be at least 95%");
    assert.ok(
      selectedTests.size / fullSuiteSize <= 0.25,
      `targeted suite ratio must be <=25%; selected=${selectedTests.size}, full=${fullSuiteSize}`
    );
  } finally {
    await safeRemove(fixture.fixtureDir, context, { recursive: true, force: true });
  }
});

test("VerificationPlanner falls back to the full package command when targeted tests exceed limits", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-runtime-verify-target-cap-", protectedPaths: [path.resolve("..")] });
  const longTestPath = `fixture/test/${"long-segment-".repeat(16)}value.test.js`;
  const fixture = await createGitFixture(context, {
    initialFiles: {
      "fixture/package.json": JSON.stringify({
        name: "target-cap-fixture",
        scripts: { test: "node --test" }
      }),
      "fixture/src/index.js": "export function value() { return 1; }\n",
      "fixture/test/one.test.js": 'import { value } from "../src/index.js";\nvalue();\n',
      "fixture/test/two.test.js": 'import { value } from "../src/index.js";\nvalue();\n',
      [longTestPath]: 'import { value } from "../src/index.js";\nvalue();\n'
    }
  });
  try {
    await writeFile(path.join(fixture.fixtureDir, "src", "index.js"), "export function value() { return 2; }\n", "utf8");
    const planner = new VerificationPlanner({
      rootDir: fixture.fixtureDir,
      workspaceId: "workspace-verification-target-cap",
      maxTargetedTestFiles: 1
    });
    const plan = await planner.plan({ include: ["test"] });
    assert.equal(plan.gates.length, 1);
    assert.equal(plan.gates[0].command, "npm test");
    assert.equal(plan.gates[0].command_scope, "full_package");
    assert.equal(plan.gates[0].targeted_test_fallback_reason, "targeted_test_file_limit_exceeded");
    assert.equal(plan.gates[0].impact.required_tests.length, 3);

    const lengthPlanner = new VerificationPlanner({
      rootDir: fixture.fixtureDir,
      workspaceId: "workspace-verification-target-length-cap",
      maxTargetedTestFiles: 10,
      maxTargetedCommandLength: 256
    });
    const lengthPlan = await lengthPlanner.plan({ include: ["test"] });
    assert.equal(lengthPlan.gates[0].command, "npm test");
    assert.equal(lengthPlan.gates[0].targeted_test_fallback_reason, "targeted_test_command_length_exceeded");
  } finally {
    await safeRemove(fixture.fixtureDir, context, { recursive: true, force: true });
  }
});
