// Local Coding Agent workspace graph persistence and validation.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants as zlibConstants } from "node:zlib";
import {
  PackedRecordStoreBuilder,
  packedPersistenceIdentity,
  samePackedPersistenceIdentity
} from "./packed-store.mjs";
import {
  fingerprintMetadataRecordsCooperative,
  yieldToEventLoop
} from "./freshness.mjs";
import {
  boundedInteger,
  boundedNumber,
  buildRecord,
  compactRecord,
  detectLanguage,
  fingerprintCoverage,
  fingerprintRecordsCooperative,
  normalizeCoverage,
  normalizeRelativePath
} from "./scanner.mjs";

export const PERSISTED_INDEX_SCHEMA_VERSION = 3;
const LEGACY_PERSISTED_INDEX_SCHEMA_VERSION = 2;
const PERSISTED_SHARD_SCHEMA_VERSION = 1;
const PERSISTED_SHARD_RECORD_LIMIT = 500;
export const DEFAULT_PACKED_RECORD_THRESHOLD = 25_000;
export const DEFAULT_MAX_PERSISTED_COMPRESSED_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_PERSISTED_RAW_BYTES = 512 * 1024 * 1024;
const compressIndex = promisify(brotliCompress);
const decompressIndex = promisify(brotliDecompress);

export function persistedRootIdentity(rootDir) {
  return createHash("sha256").update(String(rootDir)).digest("hex");
}

export async function validateExternalPrewarmReceipt(graph, receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw persistenceError("EXTERNAL_INDEX_RECEIPT_INVALID", "External index receipt is invalid.");
  }
  const checkedAtMs = Date.parse(receipt.checked_at);
  const completedAtMs = Date.parse(receipt.completed_at);
  const status = graph.persistenceStatus();
  if (
    receipt.protocol_version !== 1 ||
    receipt.workspace_id !== graph.workspaceId ||
    receipt.root_identity !== persistedRootIdentity(graph.rootDir) ||
    receipt.workspace_fingerprint !== graph.workspaceFingerprint ||
    receipt.coverage_fingerprint !== graph.coverage?.coverage_fingerprint ||
    receipt.persistence_saved_at !== status.saved_at ||
    receipt.persistence_compressed_bytes !== status.compressed_bytes ||
    receipt.persistence_raw_bytes !== status.raw_bytes ||
    !Number.isInteger(receipt.child_pid) ||
    receipt.child_pid <= 0 ||
    !Number.isFinite(checkedAtMs) ||
    !Number.isFinite(completedAtMs) ||
    checkedAtMs > completedAtMs + 1_000 ||
    completedAtMs > Date.now() + 30_000
  ) {
    throw persistenceError(
      "EXTERNAL_INDEX_RECEIPT_MISMATCH",
      "External index receipt does not match the persisted workspace index."
    );
  }
  const expectedFile = receipt.file_identity;
  if (!expectedFile || typeof expectedFile !== "object" || Array.isArray(expectedFile)) {
    throw persistenceError("EXTERNAL_INDEX_RECEIPT_INVALID", "External index file receipt is invalid.");
  }
  const actual = await stat(graph.persistencePath, { bigint: true });
  const actualIdentity = persistedFileIdentity(actual);
  for (const field of ["device", "inode", "size", "mtime_ns"]) {
    if (String(expectedFile[field] ?? "") !== actualIdentity[field]) {
      throw persistenceError(
        "EXTERNAL_INDEX_FILE_CHANGED",
        "Persisted workspace index changed after the builder completed."
      );
    }
  }
}

export function persistedFileIdentity(info) {
  if (!info || typeof info !== "object") {
    throw new TypeError("A file stat result is required.");
  }
  const mtimeNs = typeof info.mtimeNs === "bigint"
    ? info.mtimeNs
    : BigInt(Math.round(Number(info.mtimeMs || 0) * 1_000_000));
  return {
    device: String(info.dev ?? 0),
    inode: String(info.ino ?? 0),
    size: String(info.size ?? 0),
    mtime_ns: String(mtimeNs)
  };
}

export function persistedPayloadHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function encodePersistedPayload(value) {
  let body;
  try {
    body = Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Workspace index payload could not be serialized.");
  }
  const payloadHash = persistedPayloadHash(body);
  return {
    payloadHash,
    raw: Buffer.concat([Buffer.from(`${payloadHash}\n`, "ascii"), body])
  };
}

export async function compressPersistedPayload(raw) {
  return compressIndex(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      [zlibConstants.BROTLI_PARAM_LGWIN]: 18
    }
  });
}

export function decodePersistedPayload(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 66 || raw[64] !== 0x0a) {
    throw persistenceError("PERSISTED_INDEX_INTEGRITY_FAILED", "Persisted workspace index envelope is invalid.");
  }
  const expectedHash = raw.subarray(0, 64).toString("ascii");
  const body = raw.subarray(65);
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || persistedPayloadHash(body) !== expectedHash) {
    throw persistenceError("PERSISTED_INDEX_INTEGRITY_FAILED", "Persisted workspace index payload hash is invalid.");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace index JSON is invalid.");
  }
}

export function persistedEnvelopeHash(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 66 || raw[64] !== 0x0a) return null;
  const value = raw.subarray(0, 64).toString("ascii");
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export async function persistShardedIndex({
  persistencePath,
  records,
  manifest,
  maxCompressedBytes,
  maxRawBytes
}) {
  if (
    !records ||
    typeof records.size !== "number" ||
    typeof records.values !== "function" ||
    records.size > manifest?.coverage?.max_files
  ) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Workspace index record count exceeds its coverage.");
  }
  const shardDirectory = await ensurePersistedShardDirectory(persistencePath, { create: true });
  const descriptors = [];
  let totalCompressedBytes = 0;
  let totalRawBytes = 0;
  let previousPath = null;
  let pendingRecords = [];

  const flushShard = async () => {
    if (pendingRecords.length === 0) return;
    const firstPath = persistedRecordPath(pendingRecords[0]);
    const lastPath = persistedRecordPath(pendingRecords[pendingRecords.length - 1]);
    const encoded = encodePersistedPayload({
      schema_version: PERSISTED_SHARD_SCHEMA_VERSION,
      workspace_id: manifest.workspace_id,
      root_identity: manifest.root_identity,
      records: pendingRecords
    });
    const compressed = await compressPersistedPayload(encoded.raw);
    totalRawBytes += encoded.raw.length;
    totalCompressedBytes += compressed.length;
    assertPersistedBudget(totalCompressedBytes, totalRawBytes, {
      maxCompressedBytes,
      maxRawBytes
    });
    const file = `${encoded.payloadHash}.br`;
    await validatePersistedShardDirectory(shardDirectory);
    await atomicWritePrivateFile(path.join(shardDirectory, file), compressed);
    descriptors.push({
      file,
      payload_hash: encoded.payloadHash,
      record_count: pendingRecords.length,
      first_path: firstPath,
      last_path: lastPath,
      raw_bytes: encoded.raw.length,
      compressed_bytes: compressed.length
    });
    pendingRecords = [];
    await yieldToEventLoop();
  };

  for (const record of records.values()) {
    const relativePath = normalizeRelativePath(record?.path);
    if (!relativePath || (previousPath !== null && previousPath.localeCompare(relativePath) >= 0)) {
      throw persistenceError(
        "PERSISTED_INDEX_RECORD_ORDER_INVALID",
        "Workspace index records must have unique paths in stable sorted order."
      );
    }
    previousPath = relativePath;
    pendingRecords.push(serializePersistedRecord(record));
    if (pendingRecords.length >= PERSISTED_SHARD_RECORD_LIMIT) await flushShard();
  }
  await flushShard();

  const encodedManifest = encodePersistedPayload({
    ...manifest,
    shard_schema_version: PERSISTED_SHARD_SCHEMA_VERSION,
    shard_record_limit: PERSISTED_SHARD_RECORD_LIMIT,
    record_count: records.size,
    shards: descriptors
  });
  const compressedManifest = await compressPersistedPayload(encodedManifest.raw);
  totalRawBytes += encodedManifest.raw.length;
  totalCompressedBytes += compressedManifest.length;
  assertPersistedBudget(totalCompressedBytes, totalRawBytes, {
    maxCompressedBytes,
    maxRawBytes
  });

  // Shards are immutable and content-addressed. Publishing the manifest last
  // makes a crash expose either the complete previous generation or the
  // complete new generation. Unreferenced shards are retained deliberately so
  // a concurrent reader can finish without a cleanup race.
  await validatePersistedShardDirectory(shardDirectory);
  await atomicWritePrivateFile(persistencePath, compressedManifest);
  return {
    compressedBytes: totalCompressedBytes,
    rawBytes: totalRawBytes,
    shardCount: descriptors.length
  };
}

export async function restorePersistedIndexPayload(value, {
  workspaceId,
  rootDir,
  rootIdentity,
  maxRecords,
  persistencePath,
  maxCompressedBytes,
  maxRawBytes,
  manifestCompressedBytes,
  manifestRawBytes,
  packedRecordThreshold
}) {
  if (value?.schema_version === LEGACY_PERSISTED_INDEX_SCHEMA_VERSION) {
    const restored = await restorePersistedIndex(value, { workspaceId, rootIdentity, maxRecords });
    assertPersistedBudget(manifestCompressedBytes, manifestRawBytes, {
      maxCompressedBytes,
      maxRawBytes
    });
    return {
      ...restored,
      compressedBytes: manifestCompressedBytes,
      rawBytes: manifestRawBytes,
      schemaVersion: LEGACY_PERSISTED_INDEX_SCHEMA_VERSION,
      shardCount: 0
    };
  }
  validatePersistedManifest(value, { workspaceId, rootIdentity, maxRecords });
  const shardDirectory = await ensurePersistedShardDirectory(persistencePath, { create: false });
  const usePackedStore = value.record_count >= packedRecordThreshold;
  const packedBuilder = usePackedStore
    ? new PackedRecordStoreBuilder(value.record_count, rootDir)
    : null;
  const mutableRecords = usePackedStore ? null : new Map();
  let totalCompressedBytes = manifestCompressedBytes;
  let totalRawBytes = manifestRawBytes;
  let previousPath = null;
  let restoredCount = 0;
  const shardIdentities = [];

  assertPersistedBudget(totalCompressedBytes, totalRawBytes, {
    maxCompressedBytes,
    maxRawBytes
  });
  for (const descriptor of value.shards) {
    validatePersistedShardDescriptor(descriptor, {
      remainingRecords: value.record_count - restoredCount,
      previousPath
    });
    const shardPath = path.join(shardDirectory, descriptor.file);
    let info;
    try {
      info = await lstat(shardPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw persistenceError("PERSISTED_INDEX_SHARD_MISSING", "Persisted workspace shard file is missing.");
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile() || info.size !== descriptor.compressed_bytes) {
      throw persistenceError("PERSISTED_INDEX_SHARD_INVALID", "Persisted workspace shard file is invalid.");
    }
    shardIdentities.push({
      file: descriptor.file,
      identity: packedPersistenceIdentity(info)
    });
    totalCompressedBytes += info.size;
    totalRawBytes += descriptor.raw_bytes;
    assertPersistedBudget(totalCompressedBytes, totalRawBytes, {
      maxCompressedBytes,
      maxRawBytes
    });
    const compressed = await readFile(shardPath);
    let raw;
    try {
      raw = await decompressIndex(compressed, { maxOutputLength: descriptor.raw_bytes });
    } catch {
      throw persistenceError("PERSISTED_INDEX_SHARD_INVALID", "Persisted workspace shard could not be decompressed.");
    }
    if (raw.length !== descriptor.raw_bytes || persistedEnvelopeHash(raw) !== descriptor.payload_hash) {
      throw persistenceError("PERSISTED_INDEX_SHARD_INTEGRITY_FAILED", "Persisted workspace shard integrity check failed.");
    }
    const shard = decodePersistedPayload(raw);
    if (
      !shard ||
      typeof shard !== "object" ||
      Array.isArray(shard) ||
      shard.schema_version !== PERSISTED_SHARD_SCHEMA_VERSION ||
      shard.workspace_id !== workspaceId ||
      shard.root_identity !== rootIdentity ||
      !Array.isArray(shard.records) ||
      shard.records.length !== descriptor.record_count
    ) {
      throw persistenceError("PERSISTED_INDEX_SHARD_INVALID", "Persisted workspace shard payload is invalid.");
    }
    let firstRestoredPath = null;
    for (let index = 0; index < shard.records.length; index++) {
      const rawRecord = shard.records[index];
      const rawPath = persistedRecordPath(rawRecord);
      if (
        !rawPath ||
        (previousPath !== null && previousPath.localeCompare(rawPath) >= 0)
      ) {
        throw persistenceError("PERSISTED_INDEX_RECORD_ORDER_INVALID", "Persisted workspace shard paths are not strictly ordered.");
      }
      const record = restorePersistedRecord(rawRecord, value.coverage.max_file_bytes);
      shard.records[index] = null;
      if (record.path !== rawPath || mutableRecords?.has(record.path)) {
        throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace index contains duplicate or invalid paths.");
      }
      if (packedBuilder) packedBuilder.add(record);
      else mutableRecords.set(record.path, record);
      firstRestoredPath ||= record.path;
      previousPath = record.path;
      restoredCount++;
    }
    if (
      firstRestoredPath !== descriptor.first_path ||
      previousPath !== descriptor.last_path
    ) {
      throw persistenceError("PERSISTED_INDEX_SHARD_INVALID", "Persisted workspace shard bounds do not match its records.");
    }
    shard.records = null;
    await yieldToEventLoop();
  }
  const records = packedBuilder ? packedBuilder.finish() : mutableRecords;
  if (restoredCount !== value.record_count || records.size !== value.record_count) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace shard record count is incomplete.");
  }
  const restored = await restorePersistedMetadata(value, records);
  return {
    ...restored,
    compressedBytes: totalCompressedBytes,
    rawBytes: totalRawBytes,
    schemaVersion: PERSISTED_INDEX_SCHEMA_VERSION,
    shardCount: value.shards.length,
    shardIdentities
  };
}

export function validatePersistedManifest(value, { workspaceId, rootIdentity, maxRecords }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace index must be an object.");
  }
  if (value.schema_version !== PERSISTED_INDEX_SCHEMA_VERSION) {
    throw persistenceError("PERSISTED_INDEX_SCHEMA_MISMATCH", "Persisted workspace index schema is not supported.");
  }
  if (value.workspace_id !== workspaceId || value.root_identity !== rootIdentity) {
    throw persistenceError("PERSISTED_INDEX_IDENTITY_MISMATCH", "Persisted workspace index belongs to another workspace root.");
  }
  if (
    value.shard_schema_version !== PERSISTED_SHARD_SCHEMA_VERSION ||
    value.shard_record_limit !== PERSISTED_SHARD_RECORD_LIMIT ||
    !Number.isInteger(value.record_count) ||
    value.record_count < 0 ||
    value.record_count > maxRecords ||
    !Array.isArray(value.shards) ||
    value.shards.length !== Math.ceil(value.record_count / PERSISTED_SHARD_RECORD_LIMIT)
  ) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace index shard manifest is invalid.");
  }
  restorePersistedCoverage(value.coverage, value.record_count);
}

export function validatePersistedShardDescriptor(value, { remainingRecords, previousPath }) {
  const expectedFile = `${value?.payload_hash}.br`;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.payload_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.payload_hash) ||
    value.file !== expectedFile ||
    !Number.isInteger(value.record_count) ||
    value.record_count < 1 ||
    value.record_count > Math.min(PERSISTED_SHARD_RECORD_LIMIT, remainingRecords) ||
    !Number.isInteger(value.raw_bytes) ||
    value.raw_bytes < 66 ||
    !Number.isInteger(value.compressed_bytes) ||
    value.compressed_bytes < 1
  ) {
    throw persistenceError("PERSISTED_INDEX_SHARD_INVALID", "Persisted workspace shard descriptor is invalid.");
  }
  let firstPath;
  let lastPath;
  try {
    firstPath = normalizeRelativePath(value.first_path);
    lastPath = normalizeRelativePath(value.last_path);
  } catch {
    throw persistenceError("PERSISTED_INDEX_SHARD_INVALID", "Persisted workspace shard bounds are invalid.");
  }
  if (
    !firstPath ||
    !lastPath ||
    firstPath !== value.first_path ||
    lastPath !== value.last_path ||
    firstPath.localeCompare(lastPath) > 0 ||
    (previousPath !== null && previousPath.localeCompare(firstPath) >= 0)
  ) {
    throw persistenceError("PERSISTED_INDEX_SHARD_INVALID", "Persisted workspace shard bounds are not ordered.");
  }
}

export async function restorePersistedMetadata(value, records) {
  const coverage = restorePersistedCoverage(value.coverage, records.size);
  const workspaceFingerprint = await fingerprintRecordsCooperative(records);
  if (workspaceFingerprint !== value.workspace_fingerprint) {
    throw persistenceError("PERSISTED_INDEX_INTEGRITY_FAILED", "Persisted workspace index fingerprint does not match its records.");
  }
  const workspaceMetadataFingerprint = await fingerprintMetadataRecordsCooperative(records);
  if (workspaceMetadataFingerprint !== value.workspace_metadata_fingerprint) {
    throw persistenceError("PERSISTED_INDEX_INTEGRITY_FAILED", "Persisted workspace metadata fingerprint does not match its records.");
  }
  const checkedAtMs = Date.parse(value.checked_at);
  const savedAtMs = Date.parse(value.saved_at);
  if (!Number.isFinite(checkedAtMs) || !Number.isFinite(savedAtMs)) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace index timestamps are invalid.");
  }
  return {
    records,
    coverage,
    workspaceFingerprint,
    workspaceMetadataFingerprint,
    checkedAt: new Date(checkedAtMs).toISOString(),
    savedAt: new Date(savedAtMs).toISOString(),
    generation: boundedInteger(value.generation, 0, 0, Number.MAX_SAFE_INTEGER)
  };
}

export function assertPersistedBudget(compressedBytes, rawBytes, { maxCompressedBytes, maxRawBytes }) {
  if (compressedBytes > maxCompressedBytes || rawBytes > maxRawBytes) {
    throw persistenceError("PERSISTED_INDEX_SIZE_INVALID", "Persisted workspace index exceeds its size budget.");
  }
}

export function persistedShardDirectory(persistencePath) {
  return `${persistencePath}.shards`;
}

export async function ensurePersistedShardDirectory(persistencePath, { create }) {
  const directory = persistedShardDirectory(persistencePath);
  if (create) {
    await mkdir(path.dirname(persistencePath), { recursive: true, mode: 0o700 });
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  await validatePersistedShardDirectory(directory);
  return directory;
}

export async function validatePersistedShardDirectory(directory) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw persistenceError("PERSISTED_INDEX_SHARD_MISSING", "Persisted workspace shard directory is missing.");
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw persistenceError("PERSISTED_INDEX_SHARD_INVALID", "Persisted workspace shard directory is unsafe.");
  }
}

export async function restorePersistedIndex(value, { workspaceId, rootIdentity, maxRecords }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace index must be an object.");
  }
  if (value.schema_version !== LEGACY_PERSISTED_INDEX_SCHEMA_VERSION) {
    throw persistenceError("PERSISTED_INDEX_SCHEMA_MISMATCH", "Persisted workspace index schema is not supported.");
  }
  if (value.workspace_id !== workspaceId || value.root_identity !== rootIdentity) {
    throw persistenceError("PERSISTED_INDEX_IDENTITY_MISMATCH", "Persisted workspace index belongs to another workspace root.");
  }
  if (!Array.isArray(value.records) || value.records.length > maxRecords) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace index record count is invalid.");
  }
  const coverage = restorePersistedCoverage(value.coverage, value.records.length);
  const records = new Map();
  let persistedRecords = value.records;
  for (let index = 1; index < persistedRecords.length; index++) {
    if (persistedRecordPath(persistedRecords[index - 1]).localeCompare(persistedRecordPath(persistedRecords[index])) > 0) {
      persistedRecords = [...persistedRecords].sort((left, right) =>
        persistedRecordPath(left).localeCompare(persistedRecordPath(right))
      );
      break;
    }
  }
  for (const raw of persistedRecords) {
    const record = restorePersistedRecord(raw, coverage.max_file_bytes);
    if (records.has(record.path)) {
      throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace index contains duplicate paths.");
    }
    records.set(record.path, record);
  }
  return restorePersistedMetadata({ ...value, coverage }, records);
}

export function restorePersistedCoverage(value, recordCount) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace coverage is invalid.");
  }
  const normalized = normalizeCoverage(value);
  if (recordCount > normalized.max_files || value.coverage_fingerprint !== fingerprintCoverage(normalized)) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace coverage fingerprint is invalid.");
  }
  return {
    ...normalized,
    visited_files: boundedInteger(value.visited_files, recordCount, recordCount, 250_000),
    indexed_files: recordCount,
    visited_directories: boundedInteger(value.visited_directories, 0, 0, 10_000_000),
    skipped_symlinks: boundedInteger(value.skipped_symlinks, 0, 0, 10_000_000),
    skipped_directories: boundedInteger(value.skipped_directories, 0, 0, 10_000_000),
    unreadable_files: boundedInteger(value.unreadable_files, 0, 0, 250_000),
    unreadable_directories: boundedInteger(value.unreadable_directories, 0, 0, 10_000_000),
    content_truncated_files: boundedInteger(value.content_truncated_files, 0, 0, recordCount),
    binary_files: boundedInteger(value.binary_files, 0, 0, recordCount),
    truncated_by_file_limit: value.truncated_by_file_limit === true,
    truncated_by_depth: value.truncated_by_depth === true,
    complete: value.complete === true,
    content_complete: value.content_complete === true,
    coverage_fingerprint: value.coverage_fingerprint
  };
}

export function restorePersistedRecord(value, coverageContentLimit) {
  value = expandPersistedRecord(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace record is invalid.");
  }
  const relativePath = normalizeRelativePath(value.path);
  if (
    !relativePath ||
    typeof value.fingerprint !== "string" ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/i.test(value.fingerprint)
  ) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace record identity is invalid.");
  }
  const contentLimit = boundedInteger(value.content_limit, coverageContentLimit, 64, 8 * 1024 * 1024);
  if (contentLimit < coverageContentLimit) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace record has insufficient content coverage.");
  }
  const content = value.content === null ? null : String(value.content ?? "");
  if (content !== null && Buffer.byteLength(content) > contentLimit) {
    throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace record content exceeds its declared limit.");
  }
  const language = detectLanguage(relativePath, content || "");
  validatePersistedFacts(value, content);
  value.path = relativePath;
  value.size = boundedInteger(value.size, 0, 0, Number.MAX_SAFE_INTEGER);
  value.mtime_ms = boundedNumber(value.mtime_ms, 0, 0, Number.MAX_SAFE_INTEGER);
  value.ctime_ms = boundedNumber(value.ctime_ms, 0, 0, Number.MAX_SAFE_INTEGER);
  value.fingerprint = value.fingerprint.toLowerCase();
  value.content = content;
  delete value.workspace_id;
  delete value.checked_at;
  return compactRecord(value, {
    contentLimit,
    contentComplete: value.content_complete === true,
    binary: value.binary === true,
    language,
    symbols: value.symbols,
    imports: value.imports,
    calls: value.calls
  });
}

export function serializePersistedRecord(record) {
  return [
    record.path,
    record.size,
    record.mtime_ms,
    record.ctime_ms,
    record.fingerprint,
    null,
    record.content,
    record.content_limit,
    record.content_complete ? 1 : 0,
    record.binary ? 1 : 0,
    record.language,
    record.analysis_engine,
    record.symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.line,
      symbol.column,
      null
    ]),
    record.imports.map((imported) => [
      imported.module,
      imported.names,
      imported.line,
      imported.column,
      imported.raw
    ]),
    record.calls.map((call) => [
      call.name,
      call.expression,
      call.line,
      call.column
    ])
  ];
}

export function persistedRecordPath(value) {
  return String(Array.isArray(value) ? value[0] : value?.path || "");
}

export function expandPersistedRecord(value) {
  if (!Array.isArray(value) || value.length !== 15) return value;
  const [
    recordPath,
    size,
    mtimeMs,
    ctimeMs,
    fingerprint,
    _checkedAt,
    content,
    contentLimit,
    contentComplete,
    binary,
    language,
    analysisEngine,
    rawSymbols,
    rawImports,
    rawCalls
  ] = value;
  if (!Array.isArray(rawSymbols) || !Array.isArray(rawImports) || !Array.isArray(rawCalls)) {
    return null;
  }
  return {
    path: recordPath,
    size,
    mtime_ms: mtimeMs,
    ctime_ms: ctimeMs,
    fingerprint,
    content,
    content_limit: contentLimit,
    content_complete: contentComplete === 1,
    binary: binary === 1,
    language,
    analysis_engine: analysisEngine,
    symbols: rawSymbols.map((symbol) => ({
      name: symbol?.[0],
      kind: symbol?.[1],
      line: symbol?.[2],
      column: symbol?.[3]
    })),
    imports: rawImports.map((imported) => ({
      module: imported?.[0],
      names: imported?.[1],
      line: imported?.[2],
      column: imported?.[3],
      raw: imported?.[4]
    })),
    calls: rawCalls.map((call) => ({
      name: call?.[0],
      expression: call?.[1],
      line: call?.[2],
      column: call?.[3]
    }))
  };
}

export function validatePersistedFacts(record, content) {
  const maximumFacts = Math.max(1_000, Math.min(1_000_000, String(content || "").length * 2 + 100));
  for (const [key, requiredStrings] of [
    ["symbols", ["name", "kind"]],
    ["imports", ["module"]],
    ["calls", ["name", "expression"]]
  ]) {
    const values = record[key];
    if (!Array.isArray(values) || values.length > maximumFacts) {
      throw persistenceError("PERSISTED_INDEX_INVALID", `Persisted workspace record ${key} are invalid.`);
    }
    for (const fact of values) {
      if (!fact || typeof fact !== "object" || Array.isArray(fact)) {
        throw persistenceError("PERSISTED_INDEX_INVALID", `Persisted workspace record ${key} contain an invalid fact.`);
      }
      if (requiredStrings.some((field) => typeof fact[field] !== "string" || fact[field].length > 10_000)) {
        throw persistenceError("PERSISTED_INDEX_INVALID", `Persisted workspace record ${key} contain invalid text.`);
      }
      if (!Number.isInteger(fact.line) || fact.line < 1 || !Number.isInteger(fact.column) || fact.column < 1) {
        throw persistenceError("PERSISTED_INDEX_INVALID", `Persisted workspace record ${key} contain an invalid location.`);
      }
      if (key === "imports" && (!Array.isArray(fact.names) || fact.names.some((name) => typeof name !== "string"))) {
        throw persistenceError("PERSISTED_INDEX_INVALID", "Persisted workspace import names are invalid.");
      }
    }
  }
}

export async function atomicWritePrivateFile(targetPath, content) {
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  let handle = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, targetPath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!(["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error?.code))) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function persistenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizePersistenceError(error, fallbackCode) {
  if (error instanceof Error) {
    if (!error.code) error.code = fallbackCode;
    return error;
  }
  return persistenceError(fallbackCode, String(error || "Workspace index persistence failed."));
}
