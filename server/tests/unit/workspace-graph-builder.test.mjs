// Local Coding Agent runtime workspace graph child-builder tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  activeWorkspaceGraphBuildCount,
  prewarmWorkspaceGraphInChild
} from "../../src/workspace/graph/prewarm.mjs";
import {
  fingerprintRecords,
  fingerprintRecordsCooperative
} from "../../src/workspace/graph/scanner.mjs";
import { WorkspaceGraph } from "../../src/workspace/graph/workspace-graph.mjs";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";

test("large record fingerprints yield cooperatively without changing the digest", async () => {
  const records = new Map(Array.from({ length: 2_048 }, (_, index) => {
    const filePath = `src/module-${String(index).padStart(4, "0")}.js`;
    return [filePath, { path: filePath, fingerprint: `fingerprint-${index}` }];
  }));

  assert.equal(await fingerprintRecordsCooperative(records), fingerprintRecords(records));
});

test("packed graph cache reload validates persisted shards", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-packed-cache-",
    protectedPaths: [path.resolve("../..")]
  });
  const persistencePath = path.join(context.dataDir, "runtime", "index", "workspace-graph.json.br");
  let writer;
  let firstReader;
  let cachedReader;
  try {
    await Promise.all(Array.from({ length: 4 }, (_, index) => writeFile(
      path.join(context.fixtureDir, `packed-${index}.js`),
      `export const packed${index} = ${index};\n`,
      "utf8"
    )));
    writer = createGraph(context.fixtureDir, persistencePath, { packedRecordThreshold: 2 });
    await writer.refresh({ replaceCoverage: true });
    await writer.flushPersistence();
    await writer.close();
    writer = null;

    firstReader = createGraph(context.fixtureDir, persistencePath, { packedRecordThreshold: 2 });
    await firstReader.initialize();
    assert.equal(firstReader.persistenceStatus().loaded, true);
    assert.equal(firstReader.persistenceStatus().record_store, "packed");
    await firstReader.close();
    firstReader = null;

    cachedReader = createGraph(context.fixtureDir, persistencePath, { packedRecordThreshold: 2 });
    await cachedReader.initialize();
    assert.equal(cachedReader.persistenceStatus().loaded, true);
    assert.equal(cachedReader.persistenceStatus().record_store, "packed");
    assert.match(cachedReader.getRecord("packed-2.js").content, /packed2/);
  } finally {
    await writer?.close().catch(() => {});
    await firstReader?.close().catch(() => {});
    await cachedReader?.close().catch(() => {});
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("cold WorkspaceGraph build runs in one short-lived child and is adopted by concurrent callers", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-graph-builder-",
    protectedPaths: [path.resolve("../..")]
  });
  const persistencePath = path.join(context.dataDir, "runtime", "index", "workspace-graph.json.br");
  let first;
  let second;
  try {
    await mkdir(path.join(context.fixtureDir, "src"), { recursive: true });
    await Promise.all(Array.from({ length: 250 }, (_, index) => writeFile(
      path.join(context.fixtureDir, "src", `module-${String(index).padStart(3, "0")}.js`),
      `export const childBuilderNeedle${index} = ${index};\n`,
      "utf8"
    )));
    first = createGraph(context.fixtureDir, persistencePath);
    second = createGraph(context.fixtureDir, persistencePath);

    const [firstResult, secondResult] = await Promise.all([
      prewarmWorkspaceGraphInChild(first, { persistenceRoot: context.dataDir }),
      prewarmWorkspaceGraphInChild(second, { persistenceRoot: context.dataDir })
    ]);

    assert.equal(firstResult.external_builder.fallback, false);
    assert.equal(secondResult.external_builder.fallback, false);
    assert.equal(firstResult.external_builder.child_pid, secondResult.external_builder.child_pid);
    assert.notEqual(firstResult.external_builder.child_pid, process.pid);
    assert.equal(firstResult.external_builder.counts.files, 250);
    assert.equal(firstResult.external_builder.counts.parsed_files, 250);
    assert.equal(first.getRecords().length, 250);
    assert.equal(second.getRecords().length, 250);
    assert.match(first.getRecord("src/module-042.js").content, /childBuilderNeedle42/);
    assert.equal(first.persistenceStatus().loaded, true);
    assert.equal(first.freshness().authoritative, true);
    assert.equal(activeWorkspaceGraphBuildCount(), 0);
  } finally {
    await first?.close().catch(() => {});
    await second?.close().catch(() => {});
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("child-builder failure is reported as an honest main-process fallback", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-graph-builder-fallback-",
    protectedPaths: [path.resolve("../..")]
  });
  const persistencePath = path.join(context.dataDir, "runtime", "index", "workspace-graph.json.br");
  let graph;
  try {
    await writeFile(path.join(context.fixtureDir, "fallback.js"), "export const honestFallback = true;\n", "utf8");
    graph = createGraph(context.fixtureDir, persistencePath);
    const result = await prewarmWorkspaceGraphInChild(graph, {
      persistenceRoot: context.dataDir,
      builderPath: path.join(context.fixtureDir, "missing-builder.mjs"),
      timeoutMs: 5_000,
      fallbackToMain: true
    });
    assert.equal(result.external_builder.fallback, true);
    assert.equal(result.external_builder.code, "INDEX_BUILDER_EXIT_FAILED");
    assert.equal(result.counts.files, 1);
    assert.match(graph.getRecord("fallback.js").content, /honestFallback/);
  } finally {
    await graph?.close().catch(() => {});
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

function createGraph(rootDir, persistencePath, options = {}) {
  return new WorkspaceGraph({
    rootDir,
    workspaceId: "workspace-child-builder-test",
    maxFiles: 1_000,
    maxDepth: 8,
    maxFileBytes: 4_096,
    scanConcurrency: 8,
    reconcileIntervalMs: 60_000,
    watch: false,
    queryFingerprint: false,
    persistencePath,
    ...options
  });
}
