// Local Coding Agent packed workspace record store.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readSync
} from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { yieldToEventLoop } from "./freshness.mjs";
import { compactRecord } from "./scanner.mjs";

const EMPTY_FACTS = Object.freeze([]);
const INCREMENTAL_SUMMARY_YIELD_RECORDS = 1_024;
const PACKED_RECORD_CACHE = new Map();
const MAX_PACKED_RECORD_CACHE_ENTRIES = 2;

export class PackedRecordStore {
  constructor(columns) {
    this._columns = columns;
    this._overlay = new Map();
    this._removed = new Set();
    this._size = columns.paths.offsets.length - 1;
    this._summaryCache = null;
  }

  get size() {
    return this._size;
  }

  isPristine() {
    return this._overlay.size === 0 && this._removed.size === 0;
  }

  has(relativePath) {
    const key = String(relativePath);
    if (this._overlay.has(key)) return true;
    if (this._removed.has(key)) return false;
    return this._baseIndex(key) >= 0;
  }

  get(relativePath) {
    const key = String(relativePath);
    if (this._overlay.has(key)) return this._overlay.get(key);
    if (this._removed.has(key)) return undefined;
    const index = this._baseIndex(key);
    return index < 0 ? undefined : this._materialize(index);
  }

  getMetadata(relativePath) {
    const key = String(relativePath);
    if (this._overlay.has(key)) return recordMetadata(this._overlay.get(key));
    if (this._removed.has(key)) return null;
    const index = this._baseIndex(key);
    if (index < 0) return null;
    return {
      path: this._path(index),
      size: this._columns.sizes[index],
      mtime_ms: this._columns.mtimes[index],
      ctime_ms: this._columns.ctimes[index]
    };
  }

  getLanguage(relativePath) {
    const key = String(relativePath);
    if (this._overlay.has(key)) return this._overlay.get(key).language;
    if (this._removed.has(key)) return null;
    const index = this._baseIndex(key);
    return index < 0
      ? null
      : this._columns.languageTable[this._columns.languageCodes[index]];
  }

  createMetadataValidator() {
    let index = 0;
    return {
      matches: (relativePath, info) => {
        const selected = index++;
        if (selected >= this._baseSize()) return false;
        if (!packedStringEquals(this._columns.paths, selected, relativePath)) return false;
        return this._columns.sizes[selected] === info.size &&
          this._columns.mtimes[selected] === info.mtimeMs &&
          this._columns.ctimes[selected] === info.ctimeMs;
      }
    };
  }

  set(relativePath, record) {
    const key = String(relativePath);
    const existed = this.has(key);
    this._overlay.set(key, record);
    this._removed.delete(key);
    if (!existed) this._size++;
    this._summaryCache = null;
    return this;
  }

  delete(relativePath) {
    const key = String(relativePath);
    if (!this.has(key)) return false;
    this._overlay.delete(key);
    if (this._baseIndex(key) >= 0) this._removed.add(key);
    this._size--;
    this._summaryCache = null;
    return true;
  }

  *keys() {
    const overlayPaths = [...this._overlay.keys()].sort((left, right) => left.localeCompare(right));
    let overlayIndex = 0;
    for (let baseIndex = 0; baseIndex < this._baseSize(); baseIndex++) {
      const basePath = this._path(baseIndex);
      while (
        overlayIndex < overlayPaths.length &&
        overlayPaths[overlayIndex].localeCompare(basePath) < 0
      ) {
        const overlayPath = overlayPaths[overlayIndex++];
        if (this._baseIndex(overlayPath) < 0) yield overlayPath;
      }
      if (overlayIndex < overlayPaths.length && overlayPaths[overlayIndex] === basePath) {
        yield overlayPaths[overlayIndex++];
      } else if (!this._removed.has(basePath)) {
        yield basePath;
      }
    }
    while (overlayIndex < overlayPaths.length) {
      const overlayPath = overlayPaths[overlayIndex++];
      if (this._baseIndex(overlayPath) < 0) yield overlayPath;
    }
  }

  *values() {
    for (const [, record] of this.entries()) yield record;
  }

  *entries() {
    const overlayEntries = [...this._overlay.entries()]
      .sort(([left], [right]) => left.localeCompare(right));
    let overlayIndex = 0;
    for (let baseIndex = 0; baseIndex < this._baseSize(); baseIndex++) {
      const basePath = this._path(baseIndex);
      while (
        overlayIndex < overlayEntries.length &&
        overlayEntries[overlayIndex][0].localeCompare(basePath) < 0
      ) {
        const entry = overlayEntries[overlayIndex++];
        if (this._baseIndex(entry[0]) < 0) yield entry;
      }
      if (
        overlayIndex < overlayEntries.length &&
        overlayEntries[overlayIndex][0] === basePath
      ) {
        yield overlayEntries[overlayIndex++];
      } else if (!this._removed.has(basePath)) {
        yield [basePath, this._materialize(baseIndex)];
      }
    }
    while (overlayIndex < overlayEntries.length) {
      const entry = overlayEntries[overlayIndex++];
      if (this._baseIndex(entry[0]) < 0) yield entry;
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  languages() {
    return Object.keys(this.summary().languages).sort();
  }

  summary() {
    if (this._summaryCache) return this._summaryCache;
    const languages = {};
    let symbols = 0;
    let imports = 0;
    const add = (language, symbolCount, importCount) => {
      languages[language] = (languages[language] || 0) + 1;
      symbols += symbolCount;
      imports += importCount;
    };
    const hasMutations = this._removed.size > 0 || this._overlay.size > 0;
    for (let index = 0; index < this._baseSize(); index++) {
      if (hasMutations) {
        const relativePath = this._path(index);
        if (this._removed.has(relativePath) || this._overlay.has(relativePath)) continue;
      }
      add(
        this._columns.languageTable[this._columns.languageCodes[index]],
        this._columns.symbolOffsets[index + 1] - this._columns.symbolOffsets[index],
        this._columns.importOffsets[index + 1] - this._columns.importOffsets[index]
      );
    }
    for (const record of this._overlay.values()) {
      add(record.language, record.symbols.length, record.imports.length);
    }
    this._summaryCache = { languages, symbols, imports };
    return this._summaryCache;
  }

  *dependencyValues() {
    for (let index = 0; index < this._baseSize(); index++) {
      const hasImports = this._columns.importOffsets[index + 1] > this._columns.importOffsets[index];
      if (!hasImports && !(this._columns.flags[index] & 8)) continue;
      const relativePath = this._path(index);
      if (this._removed.has(relativePath) || this._overlay.has(relativePath)) continue;
      yield this._materialize(index);
    }
    for (const record of this._overlay.values()) {
      if (record.imports.length || isDependencyManifest(record.path)) yield record;
    }
  }

  async summarizeStateCooperative(overrides = null) {
    if (this._overlay.size === 0 && this._removed.size === 0) {
      const overrideByIndex = new Map();
      if (overrides) {
        for (const [relativePath, record] of overrides) {
          const index = this._baseIndex(relativePath);
          if (index < 0) return this._summarizeMaterializedStateCooperative(overrides);
          overrideByIndex.set(index, record);
        }
      }
      const workspaceHash = createHash("sha256");
      const metadataHash = createHash("sha256");
      let contentTruncatedFiles = 0;
      let binaryFiles = 0;
      for (let index = 0; index < this._baseSize(); index++) {
        const override = overrideByIndex.get(index);
        const state = override ? recordState(override) : {
          fingerprint: this._fingerprint(index),
          size: this._columns.sizes[index],
          mtime_ms: this._columns.mtimes[index],
          ctime_ms: this._columns.ctimes[index],
          content_complete: Boolean(this._columns.flags[index] & 1),
          binary: Boolean(this._columns.flags[index] & 2)
        };
        updateHashWithPackedPath(workspaceHash, this._columns.paths, index);
        workspaceHash.update("\0");
        workspaceHash.update(state.fingerprint);
        workspaceHash.update("\0");
        updateHashWithPackedPath(metadataHash, this._columns.paths, index);
        metadataHash.update("\0");
        metadataHash.update(String(state.size));
        metadataHash.update("\0");
        metadataHash.update(String(state.mtime_ms));
        metadataHash.update("\0");
        metadataHash.update(String(state.ctime_ms));
        metadataHash.update("\0");
        if (!state.content_complete && !state.binary) contentTruncatedFiles++;
        if (state.binary) binaryFiles++;
        if ((index + 1) % INCREMENTAL_SUMMARY_YIELD_RECORDS === 0) await yieldToEventLoop();
      }
      return {
        workspaceFingerprint: workspaceHash.digest("hex"),
        workspaceMetadataFingerprint: metadataHash.digest("hex"),
        indexedFiles: this._baseSize(),
        contentTruncatedFiles,
        binaryFiles
      };
    }
    return this._summarizeMaterializedStateCooperative(overrides);
  }

  async _summarizeMaterializedStateCooperative(overrides = null) {
    const workspaceHash = createHash("sha256");
    const metadataHash = createHash("sha256");
    let indexedFiles = 0;
    let contentTruncatedFiles = 0;
    let binaryFiles = 0;
    for (const relativePath of this.keys()) {
      const override = overrides?.get(relativePath);
      const state = override ? recordState(override) : this._state(relativePath);
      if (!state) continue;
      workspaceHash.update(relativePath);
      workspaceHash.update("\0");
      workspaceHash.update(state.fingerprint);
      workspaceHash.update("\0");
      metadataHash.update(relativePath);
      metadataHash.update("\0");
      metadataHash.update(String(state.size));
      metadataHash.update("\0");
      metadataHash.update(String(state.mtime_ms));
      metadataHash.update("\0");
      metadataHash.update(String(state.ctime_ms));
      metadataHash.update("\0");
      if (!state.content_complete && !state.binary) contentTruncatedFiles++;
      if (state.binary) binaryFiles++;
      indexedFiles++;
      if (indexedFiles % INCREMENTAL_SUMMARY_YIELD_RECORDS === 0) await yieldToEventLoop();
    }
    return {
      workspaceFingerprint: workspaceHash.digest("hex"),
      workspaceMetadataFingerprint: metadataHash.digest("hex"),
      indexedFiles,
      contentTruncatedFiles,
      binaryFiles
    };
  }

  async fingerprintCooperative() {
    return (await this.summarizeStateCooperative()).workspaceFingerprint;
  }

  async metadataFingerprintCooperative() {
    return (await this.summarizeStateCooperative()).workspaceMetadataFingerprint;
  }

  async metadataPrefixFingerprintCooperative(limit) {
    if (this._overlay.size === 0 && this._removed.size === 0) {
      const hash = createHash("sha256");
      const selected = Math.min(this._baseSize(), limit);
      for (let index = 0; index < selected; index++) {
        updateHashWithPackedPath(hash, this._columns.paths, index);
        hash.update("\0");
        hash.update(String(this._columns.sizes[index]));
        hash.update("\0");
        hash.update(String(this._columns.mtimes[index]));
        hash.update("\0");
        hash.update(String(this._columns.ctimes[index]));
        hash.update("\0");
        if ((index + 1) % 1_024 === 0) await yieldToEventLoop();
      }
      return hash.digest("hex");
    }
    const hash = createHash("sha256");
    let count = 0;
    for (const relativePath of this.keys()) {
      if (count >= limit) break;
      const state = this._state(relativePath);
      hash.update(relativePath);
      hash.update("\0");
      hash.update(String(state.size));
      hash.update("\0");
      hash.update(String(state.mtime_ms));
      hash.update("\0");
      hash.update(String(state.ctime_ms));
      hash.update("\0");
      count++;
      if (count % 1_024 === 0) await yieldToEventLoop();
    }
    return hash.digest("hex");
  }

  async metadataEntriesCooperative(limit = Number.POSITIVE_INFINITY) {
    const entries = [];
    for (const relativePath of this.keys()) {
      if (entries.length >= limit) break;
      entries.push(this.getMetadata(relativePath));
      if (entries.length % 1_024 === 0) await yieldToEventLoop();
    }
    return entries;
  }

  _state(relativePath) {
    if (this._overlay.has(relativePath)) return recordState(this._overlay.get(relativePath));
    if (this._removed.has(relativePath)) return null;
    const index = this._baseIndex(relativePath);
    if (index < 0) return null;
    return {
      fingerprint: this._fingerprint(index),
      size: this._columns.sizes[index],
      mtime_ms: this._columns.mtimes[index],
      ctime_ms: this._columns.ctimes[index],
      content_complete: Boolean(this._columns.flags[index] & 1),
      binary: Boolean(this._columns.flags[index] & 2)
    };
  }

  _baseIndex(relativePath) {
    const encoded = Buffer.from(relativePath, "utf8");
    let low = 0;
    let high = this._baseSize() - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const comparison = this._columns.paths.byteOrdered
        ? comparePackedStringBytes(this._columns.paths, middle, encoded)
        : this._path(middle).localeCompare(relativePath);
      if (comparison === 0) return middle;
      if (comparison < 0) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }

  _fingerprint(index) {
    const byteLength = this._columns.fingerprintLengths[index];
    const start = index * 32;
    return Buffer.from(
      this._columns.fingerprints.buffer,
      this._columns.fingerprints.byteOffset + start,
      byteLength
    ).toString("hex");
  }

  _baseSize() {
    return this._columns.paths.offsets.length - 1;
  }

  _path(index) {
    return packedStringAt(this._columns.paths, index);
  }

  _materialize(index) {
    const symbolStart = this._columns.symbolOffsets[index];
    const symbolEnd = this._columns.symbolOffsets[index + 1];
    const symbols = symbolStart === symbolEnd ? EMPTY_FACTS : [];
    for (let cursor = symbolStart; cursor < symbolEnd; cursor++) {
      symbols.push({
        name: packedStringAt(this._columns.symbolNames, cursor),
        kind: this._columns.symbolKindTable[this._columns.symbolKindCodes[cursor]],
        line: this._columns.symbolLines[cursor],
        column: this._columns.symbolColumns[cursor]
      });
    }

    const importStart = this._columns.importOffsets[index];
    const importEnd = this._columns.importOffsets[index + 1];
    const imports = importStart === importEnd ? EMPTY_FACTS : [];
    for (let cursor = importStart; cursor < importEnd; cursor++) {
      imports.push({
        module: this._columns.importModules[cursor],
        names: this._columns.importNames.slice(
          this._columns.importNameOffsets[cursor],
          this._columns.importNameOffsets[cursor + 1]
        ),
        line: this._columns.importLines[cursor],
        column: this._columns.importColumns[cursor],
        raw: this._columns.importRaw[cursor]
      });
    }

    const callStart = this._columns.callOffsets[index];
    const callEnd = this._columns.callOffsets[index + 1];
    const calls = callStart === callEnd ? EMPTY_FACTS : [];
    for (let cursor = callStart; cursor < callEnd; cursor++) {
      calls.push({
        name: this._columns.callNames[cursor],
        expression: this._columns.callExpressions[cursor],
        line: this._columns.callLines[cursor],
        column: this._columns.callColumns[cursor]
      });
    }

    const flags = this._columns.flags[index];
    const compact = compactRecord({
      path: this._path(index),
      size: this._columns.sizes[index],
      mtime_ms: this._columns.mtimes[index],
      ctime_ms: this._columns.ctimes[index],
      fingerprint: this._fingerprint(index),
      content: null
    }, {
      contentLimit: this._columns.contentLimits[index],
      contentComplete: Boolean(flags & 1),
      binary: Boolean(flags & 2),
      language: this._columns.languageTable[this._columns.languageCodes[index]],
      symbols,
      imports,
      calls
    });
    Object.defineProperty(compact, "content", {
      enumerable: true,
      configurable: true,
      get: () => {
        const content = readPackedWorkspaceContent(this._columns, index);
        Object.defineProperty(compact, "content", {
          value: content,
          writable: true,
          enumerable: true,
          configurable: true
        });
        return content;
      }
    });
    return compact;
  }
}

export class PackedRecordStoreBuilder {
  constructor(recordCount, rootDir) {
    this.recordCount = recordCount;
    this.rootDir = rootDir;
    this.index = 0;
    this.paths = new PackedStringColumnBuilder(recordCount);
    this.previousPath = null;
    this.pathsByteOrdered = true;
    this.sizes = new Float64Array(recordCount);
    this.mtimes = new Float64Array(recordCount);
    this.ctimes = new Float64Array(recordCount);
    this.fingerprints = new Uint8Array(recordCount * 32);
    this.fingerprintLengths = new Uint8Array(recordCount);
    this.contentLimits = new Uint32Array(recordCount);
    this.flags = new Uint8Array(recordCount);
    this.languageTable = [];
    this.languageLookup = new Map();
    this.languageCodes = new Uint16Array(recordCount);
    this.symbolOffsets = new Uint32Array(recordCount + 1);
    this.symbolNames = new PackedStringColumnBuilder(null);
    this.symbolKindTable = [];
    this.symbolKindLookup = new Map();
    this.symbolKindCodes = new GrowableUint16(recordCount);
    this.symbolLines = new GrowableUint32(recordCount);
    this.symbolColumns = new GrowableUint32(recordCount);
    this.importOffsets = new Uint32Array(recordCount + 1);
    this.importModules = [];
    this.importNameOffsets = new GrowableUint32(1_024);
    this.importNameOffsets.push(0);
    this.importNames = [];
    this.importLines = new GrowableUint32(1_024);
    this.importColumns = new GrowableUint32(1_024);
    this.importRaw = [];
    this.callOffsets = new Uint32Array(recordCount + 1);
    this.callNames = [];
    this.callExpressions = [];
    this.callLines = new GrowableUint32(1_024);
    this.callColumns = new GrowableUint32(1_024);
  }

  add(record) {
    const index = this.index++;
    if (index >= this.recordCount) {
      throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace index contains too many records.");
    }
    if (
      this.previousPath !== null &&
      Buffer.compare(Buffer.from(this.previousPath), Buffer.from(record.path)) >= 0
    ) {
      this.pathsByteOrdered = false;
    }
    this.paths.add(record.path);
    this.previousPath = record.path;
    this.sizes[index] = record.size;
    this.mtimes[index] = record.mtime_ms;
    this.ctimes[index] = record.ctime_ms;
    writePackedFingerprint(
      this.fingerprints,
      this.fingerprintLengths,
      index,
      record.fingerprint
    );
    this.contentLimits[index] = record.content_limit;
    const asciiContent = record.content === null || /^[\x00-\x7f]*$/.test(record.content);
    this.flags[index] = Number(record.content_complete) |
      (Number(record.binary) << 1) |
      (Number(asciiContent) << 2) |
      (Number(isDependencyManifest(record.path)) << 3);
    this.languageCodes[index] = internPackedValue(
      this.languageLookup,
      this.languageTable,
      record.language
    );

    this.symbolOffsets[index] = this.symbolNames.index;
    for (const symbol of record.symbols) {
      this.symbolNames.add(symbol.name);
      this.symbolKindCodes.push(internPackedValue(
        this.symbolKindLookup,
        this.symbolKindTable,
        symbol.kind
      ));
      this.symbolLines.push(symbol.line);
      this.symbolColumns.push(symbol.column);
    }
    this.symbolOffsets[index + 1] = this.symbolNames.index;

    this.importOffsets[index] = this.importModules.length;
    for (const imported of record.imports) {
      this.importModules.push(imported.module);
      this.importNames.push(...imported.names);
      this.importNameOffsets.push(this.importNames.length);
      this.importLines.push(imported.line);
      this.importColumns.push(imported.column);
      this.importRaw.push(imported.raw ?? null);
    }
    this.importOffsets[index + 1] = this.importModules.length;

    this.callOffsets[index] = this.callNames.length;
    for (const call of record.calls) {
      this.callNames.push(call.name);
      this.callExpressions.push(call.expression);
      this.callLines.push(call.line);
      this.callColumns.push(call.column);
    }
    this.callOffsets[index + 1] = this.callNames.length;
  }

  finish() {
    if (this.index !== this.recordCount) {
      throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace index record count is incomplete.");
    }
    const packedPaths = this.paths.finish();
    packedPaths.byteOrdered = this.pathsByteOrdered;
    return new PackedRecordStore({
      rootDir: this.rootDir,
      paths: packedPaths,
      sizes: this.sizes,
      mtimes: this.mtimes,
      ctimes: this.ctimes,
      fingerprints: this.fingerprints,
      fingerprintLengths: this.fingerprintLengths,
      contentLimits: this.contentLimits,
      flags: this.flags,
      languageTable: this.languageTable,
      languageCodes: this.languageCodes,
      symbolOffsets: this.symbolOffsets,
      symbolNames: this.symbolNames.finish(),
      symbolKindTable: this.symbolKindTable,
      symbolKindCodes: this.symbolKindCodes.finish(),
      symbolLines: this.symbolLines.finish(),
      symbolColumns: this.symbolColumns.finish(),
      importOffsets: this.importOffsets,
      importModules: this.importModules,
      importNameOffsets: this.importNameOffsets.finish(),
      importNames: this.importNames,
      importLines: this.importLines.finish(),
      importColumns: this.importColumns.finish(),
      importRaw: this.importRaw,
      callOffsets: this.callOffsets,
      callNames: this.callNames,
      callExpressions: this.callExpressions,
      callLines: this.callLines.finish(),
      callColumns: this.callColumns.finish()
    });
  }
}

export class GrowableUint32 {
  constructor(capacity) {
    this.buffer = new Uint32Array(Math.max(1, capacity));
    this.length = 0;
  }

  push(value) {
    if (this.length >= this.buffer.length) this._grow();
    this.buffer[this.length++] = value;
  }

  finish() {
    return this.length === this.buffer.length
      ? this.buffer
      : this.buffer.slice(0, this.length);
  }

  _grow() {
    const next = new Uint32Array(Math.max(1, this.buffer.length * 2));
    next.set(this.buffer);
    this.buffer = next;
  }
}

export class GrowableUint16 extends GrowableUint32 {
  constructor(capacity) {
    super(1);
    this.buffer = new Uint16Array(Math.max(1, capacity));
  }

  _grow() {
    const next = new Uint16Array(Math.max(1, this.buffer.length * 2));
    next.set(this.buffer);
    this.buffer = next;
  }
}

export class PackedStringColumnBuilder {
  constructor(valueCount, { nullable = false, chunkBytes = 1024 * 1024 } = {}) {
    this.dynamic = valueCount === null;
    this.valueCount = valueCount;
    this.nullable = nullable;
    this.chunkBytes = chunkBytes;
    this.offsets = this.dynamic
      ? new GrowableUint32(1_024)
      : new Uint32Array(valueCount + 1);
    if (this.dynamic) this.offsets.push(0);
    this.nulls = nullable ? new Uint8Array(valueCount) : null;
    this.chunks = [];
    this.current = null;
    this.currentOffset = 0;
    this.totalBytes = 0;
    this.index = 0;
  }

  add(value) {
    const index = this.index++;
    if (!this.dynamic && index >= this.valueCount) {
      throw persistenceError("PERSISTED_INDEX_INVALID", "Packed string column contains too many values.");
    }
    if (!this.dynamic) this.offsets[index] = this.totalBytes;
    if (value === null || value === undefined) {
      if (!this.nullable) {
        throw persistenceError("PERSISTED_INDEX_INVALID", "Packed string column contains an invalid null value.");
      }
      this.nulls[index] = 1;
      if (this.dynamic) this.offsets.push(this.totalBytes);
      else this.offsets[index + 1] = this.totalBytes;
      return;
    }
    const source = String(value);
    const byteLength = Buffer.byteLength(source);
    if (byteLength > 0) this._write(source, byteLength);
    if (this.dynamic) this.offsets.push(this.totalBytes);
    else this.offsets[index + 1] = this.totalBytes;
  }

  finish() {
    if (!this.dynamic && this.index !== this.valueCount) {
      throw persistenceError("PERSISTED_INDEX_INVALID", "Packed string column is incomplete.");
    }
    this._flushCurrent();
    return {
      data: this.chunks.length === 1
        ? this.chunks[0]
        : Buffer.concat(this.chunks, this.totalBytes),
      offsets: this.dynamic ? this.offsets.finish() : this.offsets,
      nulls: this.nulls
    };
  }

  _write(source, byteLength) {
    if (byteLength > this.chunkBytes) {
      this._flushCurrent();
      const chunk = Buffer.allocUnsafe(byteLength);
      chunk.write(source, 0, byteLength, "utf8");
      this.chunks.push(chunk);
      this.totalBytes += byteLength;
      return;
    }
    if (!this.current || this.current.length - this.currentOffset < byteLength) {
      this._flushCurrent();
      this.current = Buffer.allocUnsafe(this.chunkBytes);
      this.currentOffset = 0;
    }
    this.current.write(source, this.currentOffset, byteLength, "utf8");
    this.currentOffset += byteLength;
    this.totalBytes += byteLength;
  }

  _flushCurrent() {
    if (!this.current) return;
    if (this.currentOffset > 0) this.chunks.push(this.current.subarray(0, this.currentOffset));
    this.current = null;
    this.currentOffset = 0;
  }
}

export function packedStringAt(column, index) {
  if (column.nulls?.[index]) return null;
  return column.data.toString("utf8", column.offsets[index], column.offsets[index + 1]);
}

export function comparePackedStringBytes(column, index, right) {
  const start = column.offsets[index];
  const end = column.offsets[index + 1];
  const length = Math.min(end - start, right.length);
  for (let offset = 0; offset < length; offset++) {
    const difference = column.data[start + offset] - right[offset];
    if (difference !== 0) return difference;
  }
  return end - start - right.length;
}

export function packedStringEquals(column, index, value) {
  const start = column.offsets[index];
  const end = column.offsets[index + 1];
  if (/^[\x00-\x7f]*$/.test(value)) {
    if (value.length !== end - start) return false;
    for (let offset = 0; offset < value.length; offset++) {
      if (column.data[start + offset] !== value.charCodeAt(offset)) return false;
    }
    return true;
  }
  const encoded = Buffer.from(value, "utf8");
  return comparePackedStringBytes(column, index, encoded) === 0;
}

export function updateHashWithPackedPath(hash, column, index) {
  hash.update(column.data.subarray(column.offsets[index], column.offsets[index + 1]));
}

export function readPackedWorkspaceContent(columns, index) {
  if (columns.flags[index] & 2) return null;
  const relativePath = packedStringAt(columns.paths, index);
  const absolutePath = path.join(columns.rootDir, ...relativePath.split("/"));
  let descriptor = null;
  try {
    const info = lstatSync(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const byteLength = Math.min(info.size, columns.contentLimits[index]);
    const buffer = Buffer.allocUnsafe(byteLength);
    const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
    descriptor = openSync(absolutePath, fsConstants.O_RDONLY | noFollow);
    let offset = 0;
    while (offset < byteLength) {
      const bytesRead = readSync(descriptor, buffer, offset, byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The lazy content read is best-effort; freshness metadata remains the
        // authority when a file disappears during materialization.
      }
    }
  }
}

export function packedPersistenceIdentity(info) {
  return {
    dev: Number(info.dev || 0),
    ino: Number(info.ino || 0),
    size: Number(info.size || 0),
    mtime_ms: Number(info.mtimeMs || 0),
    ctime_ms: Number(info.ctimeMs || 0)
  };
}

export function samePackedPersistenceIdentity(left, right) {
  return Boolean(
    left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtime_ms === right.mtime_ms &&
    left.ctime_ms === right.ctime_ms
  );
}

export function packedRecordCacheKey({ persistencePath, rootDir, workspaceId }) {
  return `${persistencePath}\0${rootDir}\0${workspaceId}`;
}

export async function takePackedRecordCache({ persistencePath, rootDir, workspaceId, identity }) {
  const key = packedRecordCacheKey({ persistencePath, rootDir, workspaceId });
  const cached = PACKED_RECORD_CACHE.get(key);
  if (!cached) return null;
  PACKED_RECORD_CACHE.delete(key);
  if (!samePackedPersistenceIdentity(cached.identity, identity)) return null;
  const shardDirectory = `${persistencePath}.shards`;
  try {
    const matches = await Promise.all(cached.shardIdentities.map(async (shard) => {
      const info = await lstat(path.join(shardDirectory, shard.file));
      return info.isFile() &&
        !info.isSymbolicLink() &&
        samePackedPersistenceIdentity(shard.identity, packedPersistenceIdentity(info));
    }));
    return matches.every(Boolean) ? cached : null;
  } catch {
    return null;
  }
}

export function cachePackedRecordStore(graph) {
  if (
    !(graph.records instanceof PackedRecordStore) ||
    !graph.records.isPristine() ||
    !graph._packedCacheIdentity ||
    !graph._persistenceLoaded ||
    graph._persistenceDirty ||
    graph._persistenceError ||
    !Array.isArray(graph._packedCacheShardIdentities) ||
    graph._packedCacheShardIdentities.length !== graph._persistenceShardCount
  ) {
    return;
  }
  const key = packedRecordCacheKey({
    persistencePath: graph.persistencePath,
    rootDir: graph.rootDir,
    workspaceId: graph.workspaceId
  });
  PACKED_RECORD_CACHE.delete(key);
  PACKED_RECORD_CACHE.set(key, {
    identity: graph._packedCacheIdentity,
    records: graph.records,
    coverage: graph.coverage,
    workspaceFingerprint: graph.workspaceFingerprint,
    workspaceMetadataFingerprint: graph.workspaceMetadataFingerprint,
    generation: graph.generation,
    checkedAt: graph.checkedAt,
    savedAt: graph._persistenceSavedAt,
    compressedBytes: graph._persistenceCompressedBytes,
    rawBytes: graph._persistenceRawBytes,
    schemaVersion: graph._persistenceSchemaVersion,
    shardCount: graph._persistenceShardCount,
    shardIdentities: graph._packedCacheShardIdentities
  });
  while (PACKED_RECORD_CACHE.size > MAX_PACKED_RECORD_CACHE_ENTRIES) {
    PACKED_RECORD_CACHE.delete(PACKED_RECORD_CACHE.keys().next().value);
  }
}

export function escapeRipgrepGlob(value) {
  return String(value).replace(/[\\?*{}\[\]]/g, "\\$&");
}

export function writePackedFingerprint(target, lengths, index, fingerprint) {
  const byteLength = fingerprint.length / 2;
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 32) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace fingerprint is invalid.");
  }
  const offset = index * 32;
  for (let cursor = 0; cursor < byteLength; cursor++) {
    target[offset + cursor] = Number.parseInt(fingerprint.slice(cursor * 2, cursor * 2 + 2), 16);
  }
  lengths[index] = byteLength;
}

export function internPackedValue(lookup, table, value) {
  const existing = lookup.get(value);
  if (existing !== undefined) return existing;
  if (table.length >= 65_535) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace value table is too large.");
  }
  const index = table.length;
  table.push(value);
  lookup.set(value, index);
  return index;
}

export function recordMetadata(record) {
  if (!record) return null;
  return {
    path: record.path,
    size: record.size,
    mtime_ms: record.mtime_ms,
    ctime_ms: record.ctime_ms
  };
}

export function recordState(record) {
  return {
    fingerprint: record.fingerprint,
    size: record.size,
    mtime_ms: record.mtime_ms,
    ctime_ms: record.ctime_ms,
    content_complete: record.content_complete,
    binary: record.binary
  };
}

export function summarizeRecordFacts(records) {
  const languages = {};
  let symbols = 0;
  let imports = 0;
  for (const record of records.values()) {
    languages[record.language] = (languages[record.language] || 0) + 1;
    symbols += record.symbols.length;
    imports += record.imports.length;
  }
  return { languages, symbols, imports };
}

export function isDependencyManifest(relativePath) {
  const name = path.posix.basename(relativePath);
  return name === "package.json" ||
    name === "pyproject.toml" ||
    name === "go.mod" ||
    name === "Cargo.toml" ||
    name === "pubspec.yaml" ||
    name === "pom.xml" ||
    name.endsWith(".csproj");
}

export function comparePackedMatches(left, right) {
  return Number(right.score || 0) - Number(left.score || 0) ||
    String(left.location?.path || "").localeCompare(String(right.location?.path || "")) ||
    Number(left.location?.line || 0) - Number(right.location?.line || 0);
}

export function comparePackedRankToMatch(rank, match) {
  return Number(match.score || 0) - Number(rank.score || 0) ||
    String(rank.path || "").localeCompare(String(match.location?.path || "")) ||
    Number(rank.line || 0) - Number(match.location?.line || 0);
}

export function findWorstPackedMatchIndex(matches) {
  let worst = 0;
  for (let index = 1; index < matches.length; index++) {
    if (comparePackedMatches(matches[index], matches[worst]) > 0) worst = index;
  }
  return worst;
}
