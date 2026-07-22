// Local Coding Agent workspace graph facade.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  buildWorkspaceDependencyGraph,
  isTestFile,
  isWithin,
  packageForPath,
  qualifiedPath
} from "./dependency-graph.mjs";
import {
  fingerprintMetadataRecordsCooperative,
  validateWorkspaceMetadataStreaming,
  waitForWatcherOpportunity,
  yieldToEventLoop
} from "./freshness.mjs";
import {
  PackedRecordStore,
  summarizeRecordFacts
} from "./packed-store.mjs";
import {
  DEFAULT_MAX_PERSISTED_COMPRESSED_BYTES,
  DEFAULT_MAX_PERSISTED_RAW_BYTES,
  DEFAULT_PACKED_RECORD_THRESHOLD
} from "./persistence.mjs";
import { WorkspaceGraphPersistenceMethods } from "./persistence-methods.mjs";
import { WorkspaceGraphPrewarmMethods } from "./prewarm-methods.mjs";
import {
  appendRecordTextMatches,
  boundedInteger,
  buildRecord,
  cloneChanges,
  deepFreeze,
  emptyChanges,
  fingerprintCoverage,
  fingerprintRecordsCooperative,
  mergeCoverage,
  normalizeCoverage,
  normalizeRelativePath,
  recordLineSnippet,
  scanWorkspace,
  stableId
} from "./scanner.mjs";
import {
  cloneTextMatchCollection,
  collectWorkspaceTextMatches
} from "./text-search.mjs";
import { validateWorkspaceGraphInChild } from "./validation.mjs";
import {
  DEFAULT_SKIP_DIRS,
  DEFAULT_WATCH_DEBOUNCE_MS,
  DEFAULT_WATCH_RECONCILE_INTERVAL_MS,
  createWorkspaceWatcher
} from "./watcher.mjs";
import { WorkspaceGraphWatcherMethods } from "./watcher-methods.mjs";

const DEFAULT_QUERY_FINGERPRINT_MAX_FILES = 4_096;
const DEFAULT_QUERY_FINGERPRINT_INTERVAL_MS = 200;
const DEFAULT_QUERY_FINGERPRINT_CONCURRENCY = 16;

export class WorkspaceGraph {
  constructor({
    rootDir,
    workspaceId,
    skipDirs = DEFAULT_SKIP_DIRS,
    maxFiles = 10_000,
    maxDepth = 16,
    maxFileBytes = 512 * 1024,
    scanConcurrency = 16,
    reconcileIntervalMs = 500,
    watch = false,
    watchDebounceMs = DEFAULT_WATCH_DEBOUNCE_MS,
    watchReconcileIntervalMs = DEFAULT_WATCH_RECONCILE_INTERVAL_MS,
    queryFingerprint = true,
    queryFingerprintMaxFiles = DEFAULT_QUERY_FINGERPRINT_MAX_FILES,
    queryFingerprintIntervalMs = DEFAULT_QUERY_FINGERPRINT_INTERVAL_MS,
    queryFingerprintConcurrency = DEFAULT_QUERY_FINGERPRINT_CONCURRENCY,
    searchWatcherOpportunityMinFiles = 50_000,
    persistencePath = null,
    persistenceDebounceMs = 1_000,
    maxPersistedCompressedBytes = DEFAULT_MAX_PERSISTED_COMPRESSED_BYTES,
    maxPersistedRawBytes = DEFAULT_MAX_PERSISTED_RAW_BYTES,
    packedRecordThreshold = DEFAULT_PACKED_RECORD_THRESHOLD,
    workerRecordThreshold = DEFAULT_PACKED_RECORD_THRESHOLD,
    watchFactory = createWorkspaceWatcher,
    now = () => Date.now()
  } = {}) {
    if (!rootDir) throw new TypeError("WorkspaceGraph requires rootDir.");
    this.requestedRoot = path.resolve(String(rootDir));
    this.rootDir = null;
    this.workspaceId = workspaceId || stableId(this.requestedRoot);
    this.skipDirs = new Set(skipDirs);
    this.defaults = normalizeCoverage({ maxFiles, maxDepth, maxFileBytes });
    this.scanConcurrency = boundedInteger(scanConcurrency, 16, 1, 64);
    this.reconcileIntervalMs = boundedInteger(reconcileIntervalMs, 500, 0, 60_000);
    this.watchRequested = Boolean(watch);
    this.watchDebounceMs = boundedInteger(watchDebounceMs, DEFAULT_WATCH_DEBOUNCE_MS, 0, 5_000);
    this.watchReconcileIntervalMs = boundedInteger(
      watchReconcileIntervalMs,
      DEFAULT_WATCH_RECONCILE_INTERVAL_MS,
      0,
      3_600_000
    );
    this.queryFingerprintEnabled = queryFingerprint !== false;
    this.queryFingerprintMaxFiles = boundedInteger(
      queryFingerprintMaxFiles,
      DEFAULT_QUERY_FINGERPRINT_MAX_FILES,
      1,
      250_000
    );
    this.queryFingerprintIntervalMs = boundedInteger(
      queryFingerprintIntervalMs,
      DEFAULT_QUERY_FINGERPRINT_INTERVAL_MS,
      0,
      5_000
    );
    this.queryFingerprintConcurrency = boundedInteger(
      queryFingerprintConcurrency,
      DEFAULT_QUERY_FINGERPRINT_CONCURRENCY,
      1,
      64
    );
    this.searchWatcherOpportunityMinFiles = boundedInteger(
      searchWatcherOpportunityMinFiles,
      50_000,
      0,
      250_000
    );
    this.persistencePath = persistencePath ? path.resolve(String(persistencePath)) : null;
    this.persistenceDebounceMs = boundedInteger(persistenceDebounceMs, 1_000, 0, 60_000);
    this.maxPersistedCompressedBytes = boundedInteger(
      maxPersistedCompressedBytes,
      DEFAULT_MAX_PERSISTED_COMPRESSED_BYTES,
      64 * 1024,
      2 * 1024 * 1024 * 1024
    );
    this.maxPersistedRawBytes = boundedInteger(
      maxPersistedRawBytes,
      DEFAULT_MAX_PERSISTED_RAW_BYTES,
      64 * 1024,
      2 * 1024 * 1024 * 1024
    );
    this.packedRecordThreshold = boundedInteger(
      packedRecordThreshold,
      DEFAULT_PACKED_RECORD_THRESHOLD,
      1,
      250_000
    );
    this.workerRecordThreshold = boundedInteger(
      workerRecordThreshold,
      DEFAULT_PACKED_RECORD_THRESHOLD,
      1,
      250_000
    );
    if (typeof watchFactory !== "function") throw new TypeError("watchFactory must be a function.");
    this.watchFactory = watchFactory;
    this.now = now;
    this.records = new Map();
    this._recordsArrayCache = null;
    this._textQueryCache = new Map();
    this._packedCacheIdentity = null;
    this._packedCacheShardIdentities = null;
    this.coverage = null;
    this.workspaceFingerprint = null;
    this.workspaceMetadataFingerprint = null;
    this.generation = 0;
    this.checkedAt = null;
    this._lastFullReconcileAt = null;
    this.lastChanges = emptyChanges();
    this.lastQueryFingerprint = null;
    this._lastQueryFingerprintAtMs = 0;
    this._operationTail = Promise.resolve();
    this._closing = false;
    this._closed = false;
    this._closePromise = null;
    this._watcher = null;
    this._watchAbortController = null;
    this._watchEpoch = 0;
    this._watchRevision = 0;
    this._pendingWatchPaths = new Map();
    this._pendingFullInvalidationRevision = 0;
    this._watchDebounceTimer = null;
    this._watchReconcileTimer = null;
    this._watchDrainPromise = null;
    this._watchError = null;
    this._watchDegradedAt = null;
    this._derivedGraphGeneration = -1;
    this._derivedGraph = null;
    this._persistenceLoadAttempted = false;
    this._persistenceLoaded = false;
    this._persistedNeedsValidation = false;
    this._persistenceSavedAt = null;
    this._persistenceError = null;
    this._persistenceCompressedBytes = 0;
    this._persistenceRawBytes = 0;
    this._persistenceSchemaVersion = null;
    this._persistenceShardCount = 0;
    this._lastPersistedMetadataFingerprint = null;
    this._lastPersistedCoverageFingerprint = null;
    this._persistenceTimer = null;
    this._persistenceDirty = false;
  }

  async initialize(options = {}) {
    this._assertOpen();
    return this._runExclusive(() => this._initializeNow(options));
  }

  async _initializeNow({ loadPersistence = true } = {}) {
    if (!this.rootDir) {
      const info = await lstat(this.requestedRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Workspace root must be a real directory: ${this.requestedRoot}`);
      }
      this.rootDir = await realpath(this.requestedRoot);
    }
    if (loadPersistence && !this._persistenceLoadAttempted) {
      this._persistenceLoadAttempted = true;
      await this._loadPersistedIndexNow();
    }
    if (this.watchRequested && !this._watcher && !this._watchError) {
      try {
        this._startWatcherNow();
      } catch (error) {
        // Watch support varies by filesystem/platform. Query-time fingerprint
        // and periodic reconciliation remain the correctness fallback.
        this._watchError = error;
      }
    }
    return this.rootDir;
  }

  async refresh(options = {}) {
    this._assertOpen();
    return this._runExclusive(() => this._refreshNow(options, {
      consumeWatchThrough: this._watchRevision
    }));
  }

  async _refreshNow(options = {}, {
    consumeWatchThrough = 0,
    watchEpoch = null
  } = {}) {
    const rootDir = await this._initializeNow();
    const requested = normalizeCoverage({ ...this.defaults, ...options });
    const coverageRequest = options.replaceCoverage
      ? requested
      : mergeCoverage(this.coverage, requested);
    const previous = this.records;
    const scanned = await scanWorkspace(rootDir, coverageRequest, {
      skipDirs: this.skipDirs,
      previous,
      concurrency: this.scanConcurrency
    });
    const nextRecords = new Map();
    const changes = emptyChanges();

    for (const scannedRecord of scanned.records) {
      const prior = previous.get(scannedRecord.path);
      if (
        prior &&
        prior.fingerprint === scannedRecord.fingerprint &&
        prior.content_limit >= coverageRequest.max_file_bytes
      ) {
        prior.size = scannedRecord.size;
        prior.mtime_ms = scannedRecord.mtime_ms;
        prior.ctime_ms = scannedRecord.ctime_ms;
        nextRecords.set(prior.path, prior);
        changes.unchanged.push(prior.path);
        changes.reused_files++;
      } else {
        const next = buildRecord(scannedRecord);
        nextRecords.set(next.path, next);
        if (prior) changes.changed.push(next.path);
        else changes.added.push(next.path);
        changes.parsed_files++;
      }
    }
    for (const priorPath of previous.keys()) {
      if (!nextRecords.has(priorPath)) changes.removed.push(priorPath);
    }

    const nextFingerprint = await fingerprintRecordsCooperative(nextRecords);
    const nextCoverage = {
      ...coverageRequest,
      visited_files: scanned.visitedFiles,
      indexed_files: nextRecords.size,
      visited_directories: scanned.visitedDirectories,
      skipped_symlinks: scanned.skippedSymlinks,
      skipped_directories: scanned.skippedDirectories,
      unreadable_files: scanned.unreadableFiles,
      unreadable_directories: scanned.unreadableDirectories,
      content_truncated_files: scanned.contentTruncatedFiles,
      binary_files: scanned.binaryFiles,
      truncated_by_file_limit: scanned.truncatedByFileLimit,
      truncated_by_depth: scanned.truncatedByDepth,
      complete: !scanned.truncatedByFileLimit &&
        !scanned.truncatedByDepth &&
        scanned.unreadableFiles === 0 &&
        scanned.unreadableDirectories === 0,
      content_complete: scanned.contentTruncatedFiles === 0,
      coverage_fingerprint: fingerprintCoverage(coverageRequest)
    };
    const coverageChanged = this.coverage?.coverage_fingerprint !== nextCoverage.coverage_fingerprint;
    if (watchEpoch !== null && watchEpoch !== this._watchEpoch) {
      return {
        ...this.snapshot(),
        cancelled: true
      };
    }
    if (this.workspaceFingerprint !== nextFingerprint || coverageChanged) this.generation++;
    this.records = nextRecords;
    this._recordsArrayCache = null;
    this.coverage = nextCoverage;
    this.workspaceFingerprint = nextFingerprint;
    this.workspaceMetadataFingerprint = await fingerprintMetadataRecordsCooperative(nextRecords);
    this.checkedAt = new Date(this.now()).toISOString();
    this._lastFullReconcileAt = this.checkedAt;
    this._persistedNeedsValidation = false;
    this.lastQueryFingerprint = null;
    // A full reconciliation has just proved the complete metadata set. Start
    // the bounded query-fingerprint interval here instead of immediately
    // repeating thousands of stats on the first query.
    this._lastQueryFingerprintAtMs = this.now();
    this.lastChanges = changes;
    if (consumeWatchThrough > 0) this._consumeWatchEventsThrough(consumeWatchThrough);
    if (!this._persistenceSavedAt) await this._persistIndexNow();
    else this._schedulePersistence();
    return this._freshnessResult(options, { cache_hit: false });
  }

  async ensureFresh(options = {}) {
    this._assertOpen();
    return this._runExclusive(() => this._ensureFreshNow(options));
  }

  async _ensureFreshNow(options = {}) {
    await this._initializeNow();
    if (
      options.force === true ||
      !this.coverage ||
      !this.covers(options)
    ) {
      return this._refreshNow(options, {
        consumeWatchThrough: this._watchRevision
      });
    }
    if (this._persistedNeedsValidation) {
      return this._validatePersistedIndexNow(options);
    }

    let changed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const watcherHealthy = Boolean(
        this._watcher &&
        this._watcher.ready !== false &&
        this._watcher.coverageComplete !== false &&
        !this._watchError
      );
      const queryFingerprintDue = this.queryFingerprintEnabled && (
        !this.lastQueryFingerprint ||
        this.queryFingerprintIntervalMs === 0 ||
        this.now() - this._lastQueryFingerprintAtMs >= this.queryFingerprintIntervalMs
      );
      if (watcherHealthy && queryFingerprintDue && !this._hasPendingWatchEvents()) {
        // fs.watch/FSEvents delivery can arrive a few milliseconds after the
        // write syscall resolves. Give the healthy watcher one bounded chance
        // to publish its exact path before starting a 4k-stat fingerprint
        // probe. This keeps changed files searchable within the SLA even in a
        // 250k-file workspace while retaining the query-time fingerprint as a
        // watcher-miss backstop.
        await waitForWatcherOpportunity(this.watchDebounceMs);
      }
      const revisionBefore = this._watchRevision;
      if (this._hasPendingWatchEvents()) {
        const result = await this._applyPendingWatchEventsNow(options);
        changed ||= !result.cache_hit;
      }
      if (
        this.queryFingerprintEnabled &&
        (
          !this.lastQueryFingerprint ||
          this.queryFingerprintIntervalMs === 0 ||
          this.now() - this._lastQueryFingerprintAtMs >= this.queryFingerprintIntervalMs
        )
      ) {
        const result = await this._checkQueryFingerprintNow(options);
        changed ||= !result.cache_hit;
      }
      if (
        revisionBefore === this._watchRevision &&
        !this._hasPendingWatchEvents()
      ) break;
    }

    if (this._hasPendingWatchEvents()) {
      return this._refreshNow(options, {
        consumeWatchThrough: this._watchRevision
      });
    }
    if (changed) return this._freshnessResult(options, { cache_hit: false });

    const age = this.checkedAt ? this.now() - new Date(this.checkedAt).getTime() : Number.POSITIVE_INFINITY;
    if (
      options.force !== true &&
      this.coverage &&
      age < this.reconcileIntervalMs &&
      this.covers(options)
    ) {
      return this._freshnessResult(options, { cache_hit: true, changes: emptyChanges() });
    }
    return this._refreshNow(options, {
      consumeWatchThrough: this._watchRevision
    });
  }

  async _validatePersistedIndexNow(options = {}) {
    const revisionBefore = this._watchRevision;
    let probe;
    if (
      this.records instanceof PackedRecordStore &&
      this.records.size >= this.workerRecordThreshold
    ) {
      try {
        probe = await validateWorkspaceGraphInChild(this);
      } catch {
        probe = await this._validatePersistedStateLocalNow();
      }
    } else {
      probe = await this._validatePersistedStateLocalNow();
    }
    const coverageMatches =
      probe.count === this.records.size &&
      probe.truncatedByFileLimit === Boolean(this.coverage.truncated_by_file_limit) &&
      probe.truncatedByDepth === Boolean(this.coverage.truncated_by_depth) &&
      probe.unreadableFiles === 0 &&
      probe.unreadableDirectories === 0 &&
      Number(this.coverage.unreadable_files || 0) === 0 &&
      Number(this.coverage.unreadable_directories || 0) === 0;
    if (
      probe.matched &&
      coverageMatches &&
      revisionBefore === this._watchRevision &&
      !this._hasPendingWatchEvents()
    ) {
      const checkedAt = new Date(this.now()).toISOString();
      const changes = emptyChanges();
      changes.reused_files = this.records.size;
      this.checkedAt = checkedAt;
      this._lastFullReconcileAt = checkedAt;
      this._persistedNeedsValidation = false;
      this.lastChanges = changes;
      this.lastQueryFingerprint = {
        checked_at: checkedAt,
        checked_files: probe.count,
        complete: probe.complete,
        matched: true
      };
      this._lastQueryFingerprintAtMs = this.now();
      return this._freshnessResult(options, { cache_hit: true, changes });
    }
    return this._refreshNow(options, {
      consumeWatchThrough: this._watchRevision
    });
  }

  async validatePersistedStateLocal() {
    this._assertOpen();
    return this._runExclusive(async () => {
      await this._initializeNow();
      return this._validatePersistedStateLocalNow();
    });
  }

  async _validatePersistedStateLocalNow() {
    return validateWorkspaceMetadataStreaming(this.rootDir, this.coverage, {
      records: this.records,
      skipDirs: this.skipDirs,
      maxFiles: this.coverage.max_files,
      concurrency: this.scanConcurrency
    });
  }

  covers(requested = {}) {
    if (!this.coverage) return false;
    const need = normalizeCoverage({ ...this.defaults, ...requested });
    return this.coverage.max_files >= need.max_files &&
      this.coverage.max_depth >= need.max_depth &&
      this.coverage.max_file_bytes >= need.max_file_bytes &&
      (!this.coverage.truncated_by_file_limit || this.coverage.indexed_files >= need.max_files);
  }

  _freshnessResult(options, extra = {}) {
    if (options?.returnSnapshot !== false) {
      return {
        ...this.snapshot(),
        ...extra
      };
    }
    return {
      workspace_id: this.workspaceId,
      cache_hit: extra.cache_hit === true,
      freshness: this.freshness(),
      coverage: this.coverage,
      changes: extra.changes || cloneChanges(this.lastChanges),
      ...(extra.cancelled ? { cancelled: true } : {})
    };
  }

  snapshot() {
    const summary = typeof this.records.summary === "function"
      ? this.records.summary()
      : summarizeRecordFacts(this.records);
    const dependencyGraph = this.dependencyGraph();
    return {
      workspace_id: this.workspaceId,
      cache_hit: false,
      root: { workspace_id: this.workspaceId, path: "." },
      generation: this.generation,
      fingerprint: this.workspaceFingerprint,
      freshness: this.freshness(),
      coverage: this.coverage ? { ...this.coverage } : null,
      counts: {
        files: this.records.size,
        symbols: summary.symbols,
        imports: summary.imports,
        import_edges: dependencyGraph.import_edges.length,
        unresolved_local_imports: dependencyGraph.unresolved_local_imports.length,
        packages: dependencyGraph.packages.length,
        languages: summary.languages
      },
      changes: cloneChanges(this.lastChanges),
      persistence: this.persistenceStatus()
    };
  }

  freshness() {
    if (!this.checkedAt) return { state: "uninitialized", checked_at: null, age_ms: null, generation: 0 };
    const age = Math.max(0, this.now() - new Date(this.checkedAt).getTime());
    const pending = this._hasPendingWatchEvents();
    const watcherHealthy = Boolean(
      this._watcher &&
      this._watcher.ready !== false &&
      this._watcher.coverageComplete !== false &&
      !this._watchError
    );
    const fullQueryFingerprint = Boolean(
      this.lastQueryFingerprint?.complete && this.lastQueryFingerprint?.matched
    );
    const degraded = this.watchRequested && !watcherHealthy && Boolean(this._watchError);
    return {
      state: pending
        ? "invalidated"
        : degraded && !fullQueryFingerprint ? "degraded"
          : age <= this.reconcileIntervalMs ? "fresh" : "stale",
      checked_at: this.checkedAt,
      age_ms: age,
      generation: this.generation,
      fingerprint: this.workspaceFingerprint,
      authoritative: !pending && (!degraded || fullQueryFingerprint) && (
        watcherHealthy ||
        fullQueryFingerprint ||
        (!this.lastQueryFingerprint && this._lastFullReconcileAt === this.checkedAt)
      ),
      verification: pending
        ? "invalidated"
        : fullQueryFingerprint ? "full_metadata_fingerprint"
          : watcherHealthy ? "watcher_and_query_fingerprint"
            : this.lastQueryFingerprint ? "sampled_metadata_fingerprint"
              : this._lastFullReconcileAt ? "full_reconciliation" : "persisted_unverified",
      query_fingerprint: this.lastQueryFingerprint
        ? { ...this.lastQueryFingerprint }
        : null
    };
  }

  getRecords() {
    // Query bursts previously allocated a new 10k/100k element array on every
    // call. Keep one immutable view per graph mutation so callers retain the
    // convenient array API without creating avoidable GC pressure.
    if (!this._recordsArrayCache) {
      this._recordsArrayCache = Object.freeze([...this.records.values()]);
    }
    return this._recordsArrayCache;
  }

  iterateRecords() {
    return this.records.values();
  }

  async collectTextMatches(options) {
    if (!(this.records instanceof PackedRecordStore)) return null;
    const key = JSON.stringify([
      this.generation,
      options.needle,
      Boolean(options.caseSensitive),
      options.limit
    ]);
    const cached = this._textQueryCache.get(key);
    if (cached) {
      this._textQueryCache.delete(key);
      this._textQueryCache.set(key, cached);
      return cloneTextMatchCollection(cached);
    }
    const collected = await collectWorkspaceTextMatches({
      rootDir: this.rootDir,
      workspaceId: this.workspaceId,
      records: this.records,
      skipDirs: this.skipDirs,
      ...options
    });
    this._textQueryCache.set(key, collected);
    while (this._textQueryCache.size > 32) {
      this._textQueryCache.delete(this._textQueryCache.keys().next().value);
    }
    return cloneTextMatchCollection(collected);
  }

  getRecord(relativePath) {
    return this.records.get(normalizeRelativePath(relativePath)) || null;
  }

  languages() {
    if (typeof this.records.languages === "function") return this.records.languages();
    return [...new Set([...this.records.values()].map((record) => record.language))].sort();
  }

  dependencyGraph() {
    if (this._derivedGraph && this._derivedGraphGeneration === this.generation) {
      return this._derivedGraph;
    }
    this._derivedGraph = buildWorkspaceDependencyGraph(
      this.records,
      this.coverage,
      this.workspaceId
    );
    this._derivedGraph.generation = this.generation;
    deepFreeze(this._derivedGraph);
    this._derivedGraphGeneration = this.generation;
    return this._derivedGraph;
  }

  resolveImport(fromPath, moduleSpecifier) {
    const normalizedFrom = normalizeRelativePath(fromPath);
    const graph = this.dependencyGraph();
    const edge = graph.import_edges.find((candidate) =>
      candidate.from.path === normalizedFrom && candidate.module === moduleSpecifier
    );
    return edge ? { ...edge, from: { ...edge.from }, to: edge.to ? { ...edge.to } : null } : null;
  }

  definitionCandidates(fromPath, symbolName) {
    const normalizedFrom = normalizeRelativePath(fromPath);
    const record = this.records.get(normalizedFrom);
    if (!record) return [];
    const candidates = [];
    const addRecordSymbols = (target, source) => {
      if (!target) return;
      for (const symbol of target.symbols) {
        if (symbol.name !== symbolName) continue;
        candidates.push({
          source,
          location: {
            workspace_id: this.workspaceId,
            path: target.path,
            line: symbol.line,
            column: symbol.column
          },
          symbol_kind: symbol.kind,
          signature: recordLineSnippet(target, symbol.line, 300)
        });
      }
    };
    addRecordSymbols(record, "same_file");
    for (const imported of record.imports) {
      if (imported.names.length && !imported.names.includes(symbolName)) continue;
      const edge = this.resolveImport(record.path, imported.module);
      if (edge?.to?.path) addRecordSymbols(this.records.get(edge.to.path), "static_import");
    }
    if (!candidates.length) {
      const global = [...this.records.values()].filter((candidate) =>
        candidate.symbols.some((symbol) => symbol.name === symbolName)
      );
      if (global.length === 1) addRecordSymbols(global[0], "unique_workspace_symbol");
    }
    return candidates;
  }

  impactedTests(changedPaths, { packageCwds = null } = {}) {
    const graph = this.dependencyGraph();
    const normalizedChanges = [...new Set((changedPaths || []).map(normalizeRelativePath).filter(Boolean))];
    const selectedPackageCwds = packageCwds
      ? new Set([...packageCwds].map((value) => value === "." ? "." : normalizeRelativePath(value)))
      : null;
    const testFiles = [...this.records.values()]
      .filter((record) => isTestFile(record.path))
      .filter((record) => {
        if (!selectedPackageCwds) return true;
        const owner = packageForPath(graph.packages, record.path);
        if (owner) return selectedPackageCwds.has(owner.cwd);
        return [...selectedPackageCwds].some((cwd) => isWithin(record.path, cwd));
      })
      .map((record) => record.path)
      .sort();
    const reverse = new Map();
    for (const edge of graph.import_edges) {
      if (!edge.to?.path) continue;
      const importers = reverse.get(edge.to.path) || new Set();
      importers.add(edge.from.path);
      reverse.set(edge.to.path, importers);
    }
    const reachable = new Set(normalizedChanges);
    const queue = [...normalizedChanges];
    while (queue.length) {
      const current = queue.shift();
      for (const importer of reverse.get(current) || []) {
        if (reachable.has(importer)) continue;
        reachable.add(importer);
        queue.push(importer);
      }
    }
    const directlyImpacted = testFiles.filter((testPath) => reachable.has(testPath));
    const changedTests = normalizedChanges.filter((changedPath) => testFiles.includes(changedPath));
    const requiredTests = [...new Set([...testFiles, ...changedTests])].sort();
    const coverageComplete = Boolean(this.coverage?.complete && this.coverage?.content_complete);
    const unresolvedRelevant = graph.unresolved_local_imports.filter((edge) =>
      reachable.has(edge.from.path) || normalizedChanges.some((changedPath) =>
        isWithin(changedPath, packageForPath(graph.packages, edge.from.path)?.cwd || ".")
      )
    );
    const complete = coverageComplete && unresolvedRelevant.length === 0;
    return {
      workspace_id: this.workspaceId,
      strategy: "package_conservative_static_graph",
      changed_files: normalizedChanges.map((filePath) => qualifiedPath(this.workspaceId, filePath)),
      required_tests: requiredTests.map((filePath) => qualifiedPath(this.workspaceId, filePath)),
      directly_impacted_tests: directlyImpacted.map((filePath) => qualifiedPath(this.workspaceId, filePath)),
      package_test_count: testFiles.length,
      completeness: complete ? "complete" : "partial",
      confidence: complete ? 0.9 : coverageComplete ? 0.72 : 0.5,
      fallback_reason: complete
        ? null
        : !coverageComplete ? "index_coverage_incomplete" : "unresolved_local_imports",
      unresolved_local_imports: unresolvedRelevant.length
    };
  }

  async search(query, {
    limit = 50,
    caseSensitive = false,
    retryOnInvalidation = true
  } = {}) {
    this._assertOpen();
    // Search only needs the reconciled records. Returning a full snapshot here
    // rebuilt the dependency graph after every one-file invalidation, turning
    // an otherwise incremental update into an O(workspace) query-path cost.
    const needle = String(query || "");
    if (!needle) return [];
    const normalizedNeedle = caseSensitive ? needle : needle.toLowerCase();
    // A large lexical scan can overlap a watcher event. Abort that stale pass
    // at the next cooperative yield and let ensureFresh() apply the exact path
    // before retrying. This prevents a 100k-file scan from competing with the
    // canonical aggregate-fingerprint update on the freshness critical path.
    const attempts = retryOnInvalidation ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const generationBeforeOpportunity = this.generation;
      if (
        attempt === 0 &&
        this.records.size >= this.searchWatcherOpportunityMinFiles &&
        this._watcher &&
        this._watcher.ready !== false &&
        this._watcher.coverageComplete !== false &&
        !this._watchError &&
        !this._hasPendingWatchEvents()
      ) {
        // A missing needle in a packed graph otherwise requires materializing
        // every record before a just-written file can be observed. Give a hot,
        // authoritative watcher one bounded turn first; unchanged searches pay
        // at most the debounce-sized opportunity, while a changed path avoids
        // both the full scan and its transient allocation spike.
        await waitForWatcherOpportunity(this.watchDebounceMs);
      }
      const freshness = await this.ensureFresh({ returnSnapshot: false });
      const generation = this.generation;
      const matches = [];
      const opportunityChanges = this.generation !== generationBeforeOpportunity
        ? this.lastChanges
        : null;
      const reconciledPaths = freshness.cache_hit === false || opportunityChanges
        ? [...new Set([
            ...(freshness.cache_hit === false ? freshness.changes?.changed || [] : []),
            ...(freshness.cache_hit === false ? freshness.changes?.added || [] : []),
            ...(opportunityChanges?.changed || []),
            ...(opportunityChanges?.added || [])
          ])]
        : [];
      const prioritizedPaths = reconciledPaths.length > 0 && reconciledPaths.length <= 128
        ? new Set(reconciledPaths)
        : null;

      // Exact-path reconciliation already paid the cost to read these files.
      // Surface matching fresh evidence immediately; code_query owns the
      // exhaustive/ranked text-query contract when callers need global top-k.
      if (prioritizedPaths) {
        for (const relativePath of prioritizedPaths) {
          const record = this.records.get(relativePath);
          if (record) appendRecordTextMatches(record, {
            workspaceId: this.workspaceId,
            normalizedNeedle,
            caseSensitive,
            limit,
            matches
          });
          if (matches.length >= limit) return matches;
        }
        if (matches.length) return matches;
      }

      let scanned = 0;
      let invalidated = false;
      for (const record of this.records.values()) {
        if (!prioritizedPaths?.has(record.path)) {
          appendRecordTextMatches(record, {
            workspaceId: this.workspaceId,
            normalizedNeedle,
            caseSensitive,
            limit,
            matches
          });
          if (matches.length >= limit) return matches;
        }
        scanned++;
        if (scanned % 256 === 0) {
          await yieldToEventLoop();
          if (
            retryOnInvalidation &&
            (this.generation !== generation || this._hasPendingWatchEvents())
          ) {
            invalidated = true;
            break;
          }
        }
      }
      if (!invalidated) return matches;
    }
    // Sustained writes must not cause unbounded retries. One final reconciled
    // pass returns a bounded point-in-time result while the normal freshness
    // metadata continues to expose any later invalidation.
    await this.ensureFresh({ returnSnapshot: false });
    return this.search(needle, { limit, caseSensitive, retryOnInvalidation: false });
  }

  _assertOpen() {
    if (!this._closing && !this._closed) return;
    const error = new Error(
      this._closed
        ? "WorkspaceGraph is closed."
        : "WorkspaceGraph is closing."
    );
    error.code = this._closed ? "WORKSPACE_GRAPH_CLOSED" : "WORKSPACE_GRAPH_CLOSING";
    throw error;
  }

  _runExclusive(operation) {
    const run = this._operationTail.then(operation, operation);
    this._operationTail = run.catch(() => {});
    return run;
  }
}


installPrototypeMethods(WorkspaceGraph.prototype, WorkspaceGraphWatcherMethods.prototype);
installPrototypeMethods(WorkspaceGraph.prototype, WorkspaceGraphPrewarmMethods.prototype);
installPrototypeMethods(WorkspaceGraph.prototype, WorkspaceGraphPersistenceMethods.prototype);

function installPrototypeMethods(target, source) {
  for (const name of Object.getOwnPropertyNames(source)) {
    if (name === "constructor") continue;
    Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name));
  }
}

export {
  TYPE_KINDS,
  coverageSatisfies,
  detectLanguage,
  extractLexicalFacts,
  recordLineSnippet
} from "./scanner.mjs";
export { persistedFileIdentity } from "./persistence.mjs";

