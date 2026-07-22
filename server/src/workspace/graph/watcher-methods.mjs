// Local Coding Agent workspace graph watcher lifecycle.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { lstat } from "node:fs/promises";
import path from "node:path";
import { cachePackedRecordStore } from "./packed-store.mjs";
import { buildRecord, emptyChanges, fingerprintFile } from "./scanner.mjs";
import {
  cloneMapCooperative,
  diffMetadataEntries,
  fingerprintMetadataRecordPrefixCooperative,
  isSkippedRelativePath,
  metadataEntriesFromRecordsCooperative,
  normalizeWatchedPath,
  probeWorkspaceMetadata,
  relativeDirectoryDepth,
  summarizeRecordStateCooperative
} from "./freshness.mjs";

export class WorkspaceGraphWatcherMethods {
  async startWatcher() {
    this._assertOpen();
    return this._runExclusive(async () => {
      this._assertOpen();
      this.watchRequested = true;
      await this._initializeNow();
      if (!this._watcher) {
        this._watchError = null;
        this._watchDegradedAt = null;
        this._startWatcherNow();
      }
      return this.watcherStatus();
    });
  }

  async stopWatcher() {
    this._assertOpen();
    return this._runExclusive(() => this._stopWatcherNow());
  }

  async _stopWatcherNow() {
    this.watchRequested = false;
    this._watchEpoch++;
    if (this._watchDebounceTimer) clearTimeout(this._watchDebounceTimer);
    if (this._watchReconcileTimer) clearInterval(this._watchReconcileTimer);
    this._watchDebounceTimer = null;
    this._watchReconcileTimer = null;
    this._pendingWatchPaths.clear();
    this._pendingFullInvalidationRevision = 0;
    this._watchAbortController?.abort();
    this._watchAbortController = null;
    const watcher = this._watcher;
    this._watcher = null;
    try {
      watcher?.close?.();
    } catch {
      // Aborting the watcher may have closed it already.
    }
    await this._watchDrainPromise?.catch(() => {});
    return this.watcherStatus();
  }

  async close({ flushPersistence = true } = {}) {
    if (this._closePromise) return this._closePromise;
    this._closing = true;
    this._closePromise = (async () => {
      if (this._persistenceTimer) clearTimeout(this._persistenceTimer);
      this._persistenceTimer = null;
      await this._stopWatcherNow();

      // Operations accepted before close() remain ordered ahead of this
      // barrier. They may dirty persistence, so stop a watcher they started
      // and clear a newly scheduled debounce timer after they settle.
      await this._operationTail.catch(() => {});
      const watcher = await this._stopWatcherNow();
      if (this._persistenceTimer) clearTimeout(this._persistenceTimer);
      this._persistenceTimer = null;

      const result = await this._runExclusive(async () => {
        if (flushPersistence && this._persistenceDirty) {
          await this._persistIndexNow({ force: true });
        }
        this._closed = true;
        const closed = {
          ...watcher,
          persistence: this.persistenceStatus()
        };
        cachePackedRecordStore(this);
        // Watcher implementations can retain their listener closure briefly
        // after close. Drop all heavyweight graph state explicitly so a cold
        // reload reuses memory instead of temporarily retaining two indexes.
        this.records = new Map();
        this._recordsArrayCache = null;
        this._derivedGraph = null;
        this._derivedGraphGeneration = -1;
        this._textQueryCache.clear();
        return closed;
      });
      return result;
    })();
    return this._closePromise;
  }

  watcherStatus() {
    return {
      requested: this.watchRequested,
      active: Boolean(this._watcher),
      implementation: this._watcher?.implementation || null,
      coverage_complete: typeof this._watcher?.coverageComplete === "boolean"
        ? this._watcher.coverageComplete
        : null,
      watched_directories: Number.isFinite(this._watcher?.watchedDirectoryCount)
        ? this._watcher.watchedDirectoryCount
        : null,
      ready: typeof this._watcher?.ready === "boolean" ? this._watcher.ready : null,
      revision: this._watchRevision,
      pending_events: this._pendingWatchPaths.size + (this._pendingFullInvalidationRevision ? 1 : 0),
      debounce_ms: this.watchDebounceMs,
      reconcile_interval_ms: this.watchReconcileIntervalMs,
      degraded_at: this._watchDegradedAt,
      error: this._watchError
        ? {
            code: this._watchError.code || null,
            message: this._watchError.message || String(this._watchError)
          }
        : null
    };
  }

  _startWatcherNow() {
    if (this._watcher || !this.rootDir) return;
    const epoch = ++this._watchEpoch;
    const abortController = new AbortController();
    let watcher;
    try {
      watcher = this.watchFactory(
        this.rootDir,
        {
          recursive: true,
          persistent: false,
          signal: abortController.signal
        },
        (eventType, filename) => this._handleWatchEvent(epoch, eventType, filename)
      );
    } catch (error) {
      abortController.abort();
      this._watchError = error;
      throw error;
    }
    this._watchAbortController = abortController;
    this._watcher = watcher;
    this._watchError = null;
    this._watchDegradedAt = null;
    watcher?.on?.("error", (error) => {
      if (epoch !== this._watchEpoch) return;
      this._deactivateWatcherAfterError(epoch, error);
    });
    watcher?.on?.("degraded", (error) => {
      if (epoch !== this._watchEpoch || this._watcher !== watcher) return;
      this._watchError = error;
      this._watchDegradedAt = new Date(this.now()).toISOString();
    });
    if (this.watchReconcileIntervalMs > 0) {
      this._watchReconcileTimer = setInterval(() => {
        if (epoch !== this._watchEpoch || !this.watchRequested) return;
        const revision = this._watchRevision;
        const run = this._runExclusive(() => this._refreshNow({ returnSnapshot: false }, {
          consumeWatchThrough: revision,
          watchEpoch: epoch
        }));
        this._watchDrainPromise = run;
        void run.catch((error) => {
          if (epoch === this._watchEpoch) this._watchError = error;
        });
      }, this.watchReconcileIntervalMs);
      this._watchReconcileTimer.unref?.();
    }
  }

  _deactivateWatcherAfterError(epoch, error) {
    if (epoch !== this._watchEpoch) return;
    const watcher = this._watcher;
    this._watcher = null;
    this._watchError = error;
    this._watchDegradedAt = new Date(this.now()).toISOString();
    this._watchAbortController?.abort();
    this._watchAbortController = null;
    try {
      watcher?.close?.();
    } catch {
      // The watcher may already have closed itself before emitting the error.
    }
    const revision = ++this._watchRevision;
    this._pendingFullInvalidationRevision = revision;
    this._pendingWatchPaths.clear();
    this._scheduleWatchDrain(epoch);
  }

  _handleWatchEvent(epoch, _eventType, filename) {
    if (epoch !== this._watchEpoch || !this._watcher) return;
    if (filename === null || filename === undefined || String(filename).length === 0) {
      this._markWatchInvalidation(null, epoch);
      return;
    }
    const relative = normalizeWatchedPath(this.rootDir, filename);
    if (relative === null || relative === "") {
      this._markWatchInvalidation(null, epoch);
      return;
    }
    if (isSkippedRelativePath(relative, this.skipDirs)) return;
    this._markWatchInvalidation(relative, epoch);
  }

  _markWatchInvalidation(relativePath, epoch) {
    if (epoch !== this._watchEpoch || !this._watcher) return;
    const revision = ++this._watchRevision;
    if (relativePath === null) {
      this._pendingFullInvalidationRevision = revision;
      this._pendingWatchPaths.clear();
    } else if (this._pendingFullInvalidationRevision) {
      this._pendingFullInvalidationRevision = revision;
    } else {
      this._pendingWatchPaths.set(relativePath, revision);
    }
    this._scheduleWatchDrain(epoch);
  }

  _scheduleWatchDrain(epoch) {
    if (this._watchDebounceTimer) clearTimeout(this._watchDebounceTimer);
    this._watchDebounceTimer = setTimeout(() => {
      this._watchDebounceTimer = null;
      if (epoch !== this._watchEpoch || !this.watchRequested) return;
      const run = this._runExclusive(() => this._applyPendingWatchEventsNow({ returnSnapshot: false }, epoch));
      this._watchDrainPromise = run;
      void run.catch((error) => {
        if (epoch === this._watchEpoch) this._watchError = error;
      });
    }, this.watchDebounceMs);
    this._watchDebounceTimer.unref?.();
  }

  _hasPendingWatchEvents() {
    return this._pendingFullInvalidationRevision > 0 || this._pendingWatchPaths.size > 0;
  }

  async _applyPendingWatchEventsNow(options = {}, watchEpoch = null) {
    if (watchEpoch !== null && watchEpoch !== this._watchEpoch) {
      return this._freshnessResult(options, { cache_hit: true, cancelled: true });
    }
    const capturedRevision = this._watchRevision;
    const fullInvalidation = this._pendingFullInvalidationRevision > 0 &&
      this._pendingFullInvalidationRevision <= capturedRevision;
    const paths = [...this._pendingWatchPaths.entries()]
      .filter(([, revision]) => revision <= capturedRevision)
      .map(([relativePath]) => relativePath);
    if (!fullInvalidation && paths.length === 0) {
      return this._freshnessResult(options, { cache_hit: true, changes: emptyChanges() });
    }
    if (fullInvalidation || !this.coverage || !this.covers(options)) {
      return this._refreshNow(options, {
        consumeWatchThrough: capturedRevision,
        watchEpoch
      });
    }
    return this._applyPathInvalidationsNow(paths, {
      consumeWatchThrough: capturedRevision,
      watchEpoch,
      freshnessOptions: options
    });
  }

  async _checkQueryFingerprintNow(options = {}) {
    if (!this.coverage || !this.workspaceMetadataFingerprint) {
      return this._freshnessResult(options, { cache_hit: true, changes: emptyChanges() });
    }
    const probe = await probeWorkspaceMetadata(this.rootDir, this.coverage, {
      skipDirs: this.skipDirs,
      maxFiles: Math.min(this.coverage.max_files, this.queryFingerprintMaxFiles),
      concurrency: this.queryFingerprintConcurrency,
      shouldAbort: () => this._hasPendingWatchEvents()
    });
    if (probe.aborted && this._hasPendingWatchEvents()) {
      return this._applyPendingWatchEventsNow(options);
    }
    const currentFingerprint = await fingerprintMetadataRecordPrefixCooperative(this.records, probe.limit);
    const matches = currentFingerprint === probe.fingerprint;
    this.lastQueryFingerprint = {
      checked_at: new Date(this.now()).toISOString(),
      checked_files: probe.entries.length,
      complete: probe.complete,
      matched: matches
    };
    this._lastQueryFingerprintAtMs = this.now();
    if (matches && (probe.complete || (this._watcher && !this._watchError))) {
      return this._freshnessResult(options, { cache_hit: true, changes: emptyChanges() });
    }
    if (matches) {
      const age = this.checkedAt
        ? Math.max(0, this.now() - new Date(this.checkedAt).getTime())
        : Number.POSITIVE_INFINITY;
      if (age < this.reconcileIntervalMs) {
        // A bounded sample cannot prove whole-workspace freshness without a
        // healthy watcher. Serve the indexed result within the reconciliation
        // window, but freshness() explicitly marks it degraded/non-authoritative.
        return this._freshnessResult(options, { cache_hit: true, changes: emptyChanges() });
      }
      return this._refreshNow(options, {
        consumeWatchThrough: this._watchRevision
      });
    }
    const current = await metadataEntriesFromRecordsCooperative(this.records, probe.limit);
    const changedPaths = diffMetadataEntries(current, probe.entries);
    // A bounded probe can still identify a small, exact changed-path set. Apply
    // that set incrementally even when the probe does not cover the whole repo;
    // freshness() remains non-authoritative without a healthy watcher, while a
    // hot workspace avoids a multi-second 100k-file rescan for one known edit.
    // Large path-set shifts (typically add/remove ordering changes) retain the
    // conservative full reconciliation path.
    if (changedPaths.length > 0 && changedPaths.length <= 128) {
      const applied = await this._applyPathInvalidationsNow(changedPaths, {
        consumeWatchThrough: this._watchRevision,
        freshnessOptions: options
      });
      if (!this.lastQueryFingerprint) return applied;
      this.lastQueryFingerprint = {
        ...this.lastQueryFingerprint,
        matched: true,
        reconciled_changes: changedPaths.length
      };
      return this._freshnessResult(options, { cache_hit: false });
    }
    if (!probe.complete || !this.coverage.complete || changedPaths.length === 0) {
      return this._refreshNow(options, {
        consumeWatchThrough: this._watchRevision
      });
    }
    return this._refreshNow(options, {
      consumeWatchThrough: this._watchRevision
    });
  }

  async _applyPathInvalidationsNow(relativePaths, {
    consumeWatchThrough = 0,
    watchEpoch = null,
    freshnessOptions = {}
  } = {}) {
    const stagedRecords = new Map();
    const removedPaths = new Set();
    const changes = emptyChanges();
    const contentLimit = this.coverage.max_file_bytes;
    let requiresFullRefresh = false;
    let stagedAddedCount = 0;
    const stageRemoval = (candidate) => {
      if (!this.records.has(candidate) || removedPaths.has(candidate)) return;
      removedPaths.add(candidate);
      changes.removed.push(candidate);
    };

    for (const relativePath of [...new Set(relativePaths)].sort()) {
      if (!relativePath || isSkippedRelativePath(relativePath, this.skipDirs)) continue;
      const absolute = path.join(this.rootDir, ...relativePath.split("/"));
      let info;
      try {
        info = await lstat(absolute);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          if (["EACCES", "EPERM"].includes(error?.code)) {
            requiresFullRefresh = true;
            break;
          }
          throw error;
        }
      }
      if (!info) {
        for (const candidate of this.records.keys()) {
          if (candidate === relativePath || candidate.startsWith(`${relativePath}/`)) {
            stageRemoval(candidate);
          }
        }
        continue;
      }
      if (info.isSymbolicLink()) {
        stageRemoval(relativePath);
        continue;
      }
      if (info.isDirectory()) {
        requiresFullRefresh = true;
        break;
      }
      if (!info.isFile()) continue;
      if (relativeDirectoryDepth(relativePath) > this.coverage.max_depth) continue;
      const prior = removedPaths.has(relativePath)
        ? null
        : this.records.get(relativePath) || null;
      if (
        !prior &&
        (
          this.coverage.truncated_by_file_limit ||
          this.records.size - removedPaths.size + stagedAddedCount >= this.coverage.max_files
        )
      ) {
        requiresFullRefresh = true;
        break;
      }
      let scanned;
      try {
        scanned = await fingerprintFile(absolute, contentLimit, prior);
      } catch (error) {
        if (error?.code === "ENOENT") {
          stageRemoval(relativePath);
          continue;
        }
        if (["EACCES", "EPERM"].includes(error?.code)) {
          requiresFullRefresh = true;
          break;
        }
        throw error;
      }
      const next = buildRecord({
        path: relativePath,
        ...scanned
      });
      stagedRecords.set(relativePath, next);
      if (!prior) {
        stagedAddedCount++;
        changes.added.push(relativePath);
        changes.parsed_files++;
      } else if (prior.fingerprint !== next.fingerprint) {
        changes.changed.push(relativePath);
        changes.parsed_files++;
      } else {
        changes.unchanged.push(relativePath);
        changes.reused_files++;
      }
    }

    if (requiresFullRefresh) {
      return this._refreshNow({}, {
        consumeWatchThrough,
        watchEpoch
      });
    }
    if (watchEpoch !== null && watchEpoch !== this._watchEpoch) {
      return { ...this.snapshot(), cache_hit: true, cancelled: true };
    }

    const replacementOnly = changes.added.length === 0 && changes.removed.length === 0;
    let orderedRecords;
    let nextFingerprint;
    let nextMetadataFingerprint;
    let nextCoverage;
    if (replacementOnly) {
      orderedRecords = this.records;
      let contentTruncatedFiles = Number(this.coverage.content_truncated_files || 0);
      let binaryFiles = Number(this.coverage.binary_files || 0);
      for (const [relativePath, next] of stagedRecords) {
        const previous = orderedRecords.get(relativePath);
        if (!previous) {
          return this._refreshNow({}, { consumeWatchThrough, watchEpoch });
        }
        contentTruncatedFiles += Number(!next.content_complete && !next.binary) -
          Number(!previous.content_complete && !previous.binary);
        binaryFiles += Number(next.binary) - Number(previous.binary);
      }
      const summary = await summarizeRecordStateCooperative(orderedRecords, stagedRecords);
      nextFingerprint = summary.workspaceFingerprint;
      nextMetadataFingerprint = summary.workspaceMetadataFingerprint;
      nextCoverage = {
        ...this.coverage,
        content_truncated_files: Math.max(0, contentTruncatedFiles),
        binary_files: Math.max(0, binaryFiles),
        content_complete: contentTruncatedFiles <= 0
      };
    } else {
      const nextRecords = await cloneMapCooperative(this.records);
      for (const relativePath of removedPaths) nextRecords.delete(relativePath);
      for (const [relativePath, record] of stagedRecords) nextRecords.set(relativePath, record);
      orderedRecords = changes.added.length > 0
        ? new Map([...nextRecords.entries()].sort(([left], [right]) => left.localeCompare(right)))
        : nextRecords;
      const summary = await summarizeRecordStateCooperative(orderedRecords);
      nextFingerprint = summary.workspaceFingerprint;
      nextMetadataFingerprint = summary.workspaceMetadataFingerprint;
      nextCoverage = {
        ...this.coverage,
        indexed_files: summary.indexedFiles,
        visited_files: Math.max(summary.indexedFiles, Number(this.coverage.visited_files || 0)),
        content_truncated_files: summary.contentTruncatedFiles,
        binary_files: summary.binaryFiles,
        content_complete: summary.contentTruncatedFiles === 0
      };
    }
    if (watchEpoch !== null && watchEpoch !== this._watchEpoch) {
      return { ...this.snapshot(), cache_hit: true, cancelled: true };
    }
    if (nextFingerprint !== this.workspaceFingerprint) this.generation++;
    if (replacementOnly) {
      for (const [relativePath, record] of stagedRecords) orderedRecords.set(relativePath, record);
    } else {
      this.records = orderedRecords;
    }
    this._recordsArrayCache = null;
    this.workspaceFingerprint = nextFingerprint;
    this.workspaceMetadataFingerprint = nextMetadataFingerprint;
    this.coverage = nextCoverage;
    this.checkedAt = new Date(this.now()).toISOString();
    this.lastChanges = changes;
    // An exact watcher/path reconciliation is already authoritative for this
    // request. Avoid immediately allocating a second 4k-file stat probe; the
    // normal fingerprint interval and periodic full reconciliation still
    // cover watcher misses.
    this._lastQueryFingerprintAtMs = this.now();
    if (consumeWatchThrough > 0) this._consumeWatchEventsThrough(consumeWatchThrough);
    this._schedulePersistence();
    return this._freshnessResult(freshnessOptions, { cache_hit: false });
  }

  _consumeWatchEventsThrough(revision) {
    if (
      this._pendingFullInvalidationRevision > 0 &&
      this._pendingFullInvalidationRevision <= revision
    ) {
      this._pendingFullInvalidationRevision = 0;
    }
    for (const [relativePath, eventRevision] of this._pendingWatchPaths) {
      if (eventRevision <= revision) this._pendingWatchPaths.delete(relativePath);
    }
  }

}

