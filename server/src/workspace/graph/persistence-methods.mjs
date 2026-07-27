// Local Coding Agent workspace graph persistence lifecycle.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { lstat, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { brotliDecompress } from "node:zlib";
import {
  PackedRecordStore,
  packedPersistenceIdentity,
  takePackedRecordCache
} from "./packed-store.mjs";
import {
  PERSISTED_INDEX_SCHEMA_VERSION,
  decodePersistedPayload,
  normalizePersistenceError,
  persistShardedIndex,
  persistedRootIdentity,
  persistenceError,
  restorePersistedIndexPayload
} from "./persistence.mjs";
import { persistWorkspaceGraphInChild } from "./prewarm.mjs";
import { emptyChanges } from "./scanner.mjs";
import { summarizeRecordStateCooperative } from "./freshness.mjs";

const decompressIndex = promisify(brotliDecompress);

export class WorkspaceGraphPersistenceMethods {
  persistenceStatus() {
    return {
      enabled: Boolean(this.persistencePath),
      loaded: this._persistenceLoaded,
      saved_at: this._persistenceSavedAt,
      schema_version: this._persistenceSchemaVersion,
      shard_count: this._persistenceShardCount,
      compressed_bytes: this._persistenceCompressedBytes,
      raw_bytes: this._persistenceRawBytes,
      dirty: this._persistenceDirty,
      record_store: this.records instanceof PackedRecordStore ? "packed" : "map",
      error: this._persistenceError
        ? {
            code: this._persistenceError.code || null,
            message: this._persistenceError.message || String(this._persistenceError)
          }
        : null
    };
  }

  async flushPersistence() {
    this._assertOpen();
    return this._runExclusive(async () => {
      await this._initializeNow();
      if (this._persistenceTimer) clearTimeout(this._persistenceTimer);
      this._persistenceTimer = null;
      await this._persistIndexNow({ force: true });
      return this.persistenceStatus();
    });
  }

  async _loadPersistedIndexNow() {
    if (!this.persistencePath) return false;
    try {
      const info = await lstat(this.persistencePath);
      if (info.isSymbolicLink() || !info.isFile() || info.size > this.maxPersistedCompressedBytes) {
        throw persistenceError("PERSISTED_INDEX_SIZE_INVALID", "Persisted workspace index exceeds its compressed size budget.");
      }
      const persistenceIdentity = packedPersistenceIdentity(info);
      const cached = await takePackedRecordCache({
        persistencePath: this.persistencePath,
        rootDir: this.rootDir,
        workspaceId: this.workspaceId,
        identity: persistenceIdentity
      });
      if (cached) {
        this.records = cached.records;
        this._recordsArrayCache = null;
        this.coverage = cached.coverage;
        this.workspaceFingerprint = cached.workspaceFingerprint;
        this.workspaceMetadataFingerprint = cached.workspaceMetadataFingerprint;
        this.generation = cached.generation;
        this.checkedAt = cached.checkedAt;
        this.lastChanges = emptyChanges();
        this._derivedGraph = null;
        this._derivedGraphGeneration = -1;
        this._persistenceLoaded = true;
        this._persistedNeedsValidation = true;
        this._persistenceSavedAt = cached.savedAt;
        this._persistenceCompressedBytes = cached.compressedBytes;
        this._persistenceRawBytes = cached.rawBytes;
        this._persistenceSchemaVersion = cached.schemaVersion;
        this._persistenceShardCount = cached.shardCount;
        this._lastPersistedMetadataFingerprint = cached.workspaceMetadataFingerprint;
        this._lastPersistedCoverageFingerprint = cached.coverage.coverage_fingerprint;
        this._persistenceError = null;
        this._packedCacheIdentity = persistenceIdentity;
        this._packedCacheShardIdentities = cached.shardIdentities;
        return true;
      }
      const compressed = await readFile(this.persistencePath);
      const raw = await decompressIndex(compressed, {
        maxOutputLength: this.maxPersistedRawBytes
      });
      if (raw.length > this.maxPersistedRawBytes) {
        throw persistenceError("PERSISTED_INDEX_SIZE_INVALID", "Persisted workspace index exceeds its raw size budget.");
      }
      const parsed = decodePersistedPayload(raw);
      const restored = await restorePersistedIndexPayload(parsed, {
        workspaceId: this.workspaceId,
        rootDir: this.rootDir,
        rootIdentity: persistedRootIdentity(this.rootDir),
        maxRecords: this.defaults.max_files,
        persistencePath: this.persistencePath,
        maxCompressedBytes: this.maxPersistedCompressedBytes,
        maxRawBytes: this.maxPersistedRawBytes,
        manifestCompressedBytes: compressed.length,
        manifestRawBytes: raw.length,
        packedRecordThreshold: this.packedRecordThreshold
      });
      this.records = restored.records;
      this._recordsArrayCache = null;
      this.coverage = restored.coverage;
      this.workspaceFingerprint = restored.workspaceFingerprint;
      this.workspaceMetadataFingerprint = restored.workspaceMetadataFingerprint;
      this.generation = restored.generation;
      this.checkedAt = restored.checkedAt;
      this.lastChanges = emptyChanges();
      this._derivedGraph = null;
      this._derivedGraphGeneration = -1;
      this._persistenceLoaded = true;
      this._persistedNeedsValidation = true;
      this._persistenceSavedAt = restored.savedAt;
      this._persistenceCompressedBytes = restored.compressedBytes;
      this._persistenceRawBytes = restored.rawBytes;
      this._persistenceSchemaVersion = restored.schemaVersion;
      this._persistenceShardCount = restored.shardCount;
      this._lastPersistedMetadataFingerprint = restored.workspaceMetadataFingerprint;
      this._lastPersistedCoverageFingerprint = restored.coverage.coverage_fingerprint;
      this._persistenceError = null;
      this._packedCacheIdentity = persistenceIdentity;
      this._packedCacheShardIdentities = restored.shardIdentities || null;
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      this._persistenceError = normalizePersistenceError(error, "PERSISTED_INDEX_LOAD_FAILED");
      return false;
    }
  }

  async _persistIndexNow({ force = false } = {}) {
    if (!this.persistencePath || !this.coverage || !this.rootDir) return false;
    if (
      !force &&
      !this._persistenceError &&
      this._persistenceSavedAt &&
      !this._persistenceDirty
    ) {
      return false;
    }
    try {
      if (
        this.records instanceof PackedRecordStore &&
        this.records.size >= this.workerRecordThreshold
      ) {
        const receipt = await persistWorkspaceGraphInChild(this);
        this._persistenceSavedAt = receipt.persistence_saved_at;
        this._persistenceCompressedBytes = receipt.persistence_compressed_bytes;
        this._persistenceRawBytes = receipt.persistence_raw_bytes;
        this._persistenceSchemaVersion = PERSISTED_INDEX_SCHEMA_VERSION;
        this._persistenceShardCount = receipt.persistence_shard_count;
        this._lastPersistedMetadataFingerprint = null;
        this._lastPersistedCoverageFingerprint = receipt.coverage_fingerprint;
        this._packedCacheIdentity = null;
        this._packedCacheShardIdentities = null;
        this._persistenceDirty = false;
        this._persistenceError = null;
        return true;
      }
      const savedAt = new Date(this.now()).toISOString();
      const persistedSummary = await summarizeRecordStateCooperative(this.records);
      const persisted = await persistShardedIndex({
        persistencePath: this.persistencePath,
        records: this.records,
        manifest: {
          schema_version: PERSISTED_INDEX_SCHEMA_VERSION,
          workspace_id: this.workspaceId,
          root_identity: persistedRootIdentity(this.rootDir),
          saved_at: savedAt,
          checked_at: this.checkedAt,
          generation: this.generation,
          workspace_fingerprint: persistedSummary.workspaceFingerprint,
          workspace_metadata_fingerprint: persistedSummary.workspaceMetadataFingerprint,
          coverage: this.coverage
        },
        maxCompressedBytes: this.maxPersistedCompressedBytes,
        maxRawBytes: this.maxPersistedRawBytes
      });
      this._persistenceSavedAt = savedAt;
      this._persistenceCompressedBytes = persisted.compressedBytes;
      this._persistenceRawBytes = persisted.rawBytes;
      this._persistenceSchemaVersion = PERSISTED_INDEX_SCHEMA_VERSION;
      this._persistenceShardCount = persisted.shardCount;
      this._lastPersistedMetadataFingerprint = persistedSummary.workspaceMetadataFingerprint;
      this._lastPersistedCoverageFingerprint = this.coverage.coverage_fingerprint;
      this._persistenceDirty = false;
      this._persistenceError = null;
      return true;
    } catch (error) {
      this._persistenceError = normalizePersistenceError(error, "PERSISTED_INDEX_SAVE_FAILED");
      this._persistenceDirty = true;
      return false;
    }
  }

  _schedulePersistence() {
    if (!this.persistencePath || !this.coverage) return;
    this._persistenceDirty = true;
    if (this._persistenceTimer) clearTimeout(this._persistenceTimer);
    this._persistenceTimer = setTimeout(() => {
      this._persistenceTimer = null;
      const run = this._runExclusive(() => this._persistIndexNow());
      void run.catch((error) => {
        this._persistenceError = normalizePersistenceError(error, "PERSISTED_INDEX_SAVE_FAILED");
        this._persistenceDirty = true;
      });
    }, this.persistenceDebounceMs);
    this._persistenceTimer.unref?.();
  }

}

