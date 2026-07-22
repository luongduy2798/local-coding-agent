// Local Coding Agent workspace freshness and metadata reconciliation.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { mapWithConcurrency, normalizeRelativePath } from "./scanner.mjs";

const INCREMENTAL_SUMMARY_YIELD_RECORDS = 1_024;

export async function validateWorkspaceMetadataStreaming(rootDir, coverage, {
  records,
  skipDirs,
  maxFiles,
  concurrency
}) {
  const limit = Math.max(1, Math.min(maxFiles, coverage.max_files));
  const batchLimit = Math.max(1, concurrency);
  let selectedFiles = 0;
  let matched = true;
  let truncatedByFileLimit = false;
  let truncatedByDepth = false;
  let unreadableFiles = 0;
  let unreadableDirectories = 0;
  const metadataValidator = typeof records.createMetadataValidator === "function"
    ? records.createMetadataValidator()
    : null;

  const validateBatch = async (batch) => {
    if (!batch.length) return;
    const results = await mapWithConcurrency(batch, batchLimit, async ({ absolute, relative }) => {
      try {
        return { relative, info: await stat(absolute) };
      } catch (error) {
        if (!["ENOENT", "EACCES", "EPERM"].includes(error?.code)) throw error;
        unreadableFiles++;
        return null;
      }
    });
    for (const result of results) {
      if (!result) {
        matched = false;
        continue;
      }
      const matches = metadataValidator
        ? metadataValidator.matches(result.relative, result.info)
        : (() => {
            const record = typeof records.getMetadata === "function"
              ? records.getMetadata(result.relative)
              : records.get(result.relative);
            return Boolean(
              record &&
              record.size === result.info.size &&
              record.mtime_ms === result.info.mtimeMs &&
              record.ctime_ms === result.info.ctimeMs
            );
          })();
      if (!matches) {
        matched = false;
      }
    }
    await yieldToEventLoop();
  };

  const visit = async (directory, depth) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      unreadableDirectories++;
      matched = false;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    let batch = [];
    const flush = async () => {
      const pending = batch;
      batch = [];
      await validateBatch(pending);
    };
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await flush();
        if (skipDirs.has(entry.name)) continue;
        if (depth >= coverage.max_depth) {
          truncatedByDepth = true;
          continue;
        }
        if (selectedFiles >= limit) {
          truncatedByFileLimit = true;
          return;
        }
        await visit(absolute, depth + 1);
        if (truncatedByFileLimit) return;
        continue;
      }
      if (!entry.isFile()) continue;
      if (selectedFiles >= limit) {
        truncatedByFileLimit = true;
        await flush();
        return;
      }
      const relative = normalizeRelativePath(path.relative(rootDir, absolute));
      selectedFiles++;
      batch.push({ absolute, relative });
      if (batch.length >= batchLimit) await flush();
    }
    await flush();
  };

  await visit(rootDir, 0);
  const complete = !truncatedByFileLimit &&
    !truncatedByDepth &&
    unreadableFiles === 0 &&
    unreadableDirectories === 0;
  return {
    matched,
    count: selectedFiles - unreadableFiles,
    complete,
    truncatedByFileLimit,
    truncatedByDepth,
    unreadableFiles,
    unreadableDirectories
  };
}

export async function probeWorkspaceMetadata(
  rootDir,
  coverage,
  { skipDirs, maxFiles, concurrency, shouldAbort = null }
) {
  const candidates = [];
  const limit = Math.max(1, Math.min(maxFiles, coverage.max_files));
  const traversalLimit = limit + 1;
  let truncatedByFileLimit = false;
  let truncatedByDepth = false;
  let unreadableFiles = 0;
  let unreadableDirectories = 0;
  let aborted = false;

  async function visit(directory, depth) {
    let directoryEntries;
    try {
      directoryEntries = await readdir(directory, { withFileTypes: true });
    } catch {
      unreadableDirectories++;
      return;
    }
    directoryEntries = directoryEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of directoryEntries) {
      if (shouldAbort?.()) {
        aborted = true;
        return;
      }
      if (candidates.length >= traversalLimit) {
        truncatedByFileLimit = true;
        return;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (depth >= coverage.max_depth) {
          truncatedByDepth = true;
          continue;
        }
        await visit(absolute, depth + 1);
        if (candidates.length >= traversalLimit) {
          truncatedByFileLimit = true;
          return;
        }
        continue;
      }
      if (!entry.isFile()) continue;
      candidates.push(normalizeRelativePath(path.relative(rootDir, absolute)));
    }
  }

  await visit(rootDir, 0);
  if (aborted) {
    return {
      aborted: true,
      entries: [],
      limit,
      complete: false,
      fingerprint: null
    };
  }
  if (candidates.length > limit) truncatedByFileLimit = true;
  const selectedEntries = await mapWithConcurrency(
    candidates.slice(0, limit),
    concurrency,
    async (relative) => {
      if (shouldAbort?.()) {
        aborted = true;
        return null;
      }
      try {
        const info = await stat(path.join(rootDir, ...relative.split("/")));
        return {
          path: relative,
          size: info.size,
          mtime_ms: info.mtimeMs,
          ctime_ms: info.ctimeMs
        };
      } catch (error) {
        if (!["ENOENT", "EACCES", "EPERM"].includes(error?.code)) throw error;
        unreadableFiles++;
        return null;
      }
    }
  ).then((items) => items.filter(Boolean));
  if (aborted) {
    return {
      aborted: true,
      entries: [],
      limit,
      complete: false,
      fingerprint: null
    };
  }
  const complete = !truncatedByFileLimit &&
    !truncatedByDepth &&
    unreadableFiles === 0 &&
    unreadableDirectories === 0;
  return {
    aborted: false,
    entries: selectedEntries,
    limit,
    complete,
    fingerprint: await fingerprintMetadataEntriesCooperative(selectedEntries, { alreadySorted: true })
  };
}

export async function metadataEntriesFromRecordsCooperative(records, limit = Number.POSITIVE_INFINITY) {
  if (typeof records.metadataEntriesCooperative === "function") {
    return records.metadataEntriesCooperative(limit);
  }
  const entries = [];
  for (const record of records.values()) {
    if (entries.length >= limit) break;
    entries.push({
      path: record.path,
      size: record.size,
      mtime_ms: record.mtime_ms,
      ctime_ms: record.ctime_ms
    });
    if (entries.length % 1_024 === 0) await yieldToEventLoop();
  }
  return entries;
}

export async function fingerprintMetadataRecordPrefixCooperative(records, limit) {
  if (typeof records.metadataPrefixFingerprintCooperative === "function") {
    return records.metadataPrefixFingerprintCooperative(limit);
  }
  const hash = createHash("sha256");
  let count = 0;
  for (const record of records.values()) {
    if (count >= limit) break;
    hash.update(record.path);
    hash.update("\0");
    hash.update(String(record.size));
    hash.update("\0");
    hash.update(String(record.mtime_ms));
    hash.update("\0");
    hash.update(String(record.ctime_ms));
    hash.update("\0");
    count++;
    if (count % 1_024 === 0) await yieldToEventLoop();
  }
  return hash.digest("hex");
}

export function metadataEntriesFromRecords(records, limit = Number.POSITIVE_INFINITY) {
  return [...records.values()]
    .slice(0, limit)
    .map((record) => ({
      path: record.path,
      size: record.size,
      mtime_ms: record.mtime_ms,
      ctime_ms: record.ctime_ms
    }));
}

export function fingerprintMetadataRecords(records) {
  return fingerprintMetadataEntries(metadataEntriesFromRecords(records), { alreadySorted: true });
}

export async function fingerprintMetadataRecordsCooperative(records) {
  if (typeof records.metadataFingerprintCooperative === "function") {
    return records.metadataFingerprintCooperative();
  }
  const hash = createHash("sha256");
  let count = 0;
  for (const record of records.values()) {
    hash.update(record.path);
    hash.update("\0");
    hash.update(String(record.size));
    hash.update("\0");
    hash.update(String(record.mtime_ms));
    hash.update("\0");
    hash.update(String(record.ctime_ms));
    hash.update("\0");
    count++;
    if (count % 1_024 === 0) await yieldToEventLoop();
  }
  return hash.digest("hex");
}

export async function summarizeRecordStateCooperative(records, overrides = null) {
  if (typeof records.summarizeStateCooperative === "function") {
    return records.summarizeStateCooperative(overrides);
  }
  const workspaceHash = createHash("sha256");
  const metadataHash = createHash("sha256");
  let indexedFiles = 0;
  let contentTruncatedFiles = 0;
  let binaryFiles = 0;
  for (const [relativePath, current] of records) {
    const record = overrides?.get(relativePath) || current;
    workspaceHash.update(record.path);
    workspaceHash.update("\0");
    workspaceHash.update(record.fingerprint);
    workspaceHash.update("\0");
    metadataHash.update(record.path);
    metadataHash.update("\0");
    metadataHash.update(String(record.size));
    metadataHash.update("\0");
    metadataHash.update(String(record.mtime_ms));
    metadataHash.update("\0");
    metadataHash.update(String(record.ctime_ms));
    metadataHash.update("\0");
    if (!record.content_complete && !record.binary) contentTruncatedFiles++;
    if (record.binary) binaryFiles++;
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

export function fingerprintMetadataEntries(entries, { alreadySorted = false } = {}) {
  const hash = createHash("sha256");
  const ordered = alreadySorted ? entries : [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of ordered) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(entry.size));
    hash.update("\0");
    hash.update(String(entry.mtime_ms));
    hash.update("\0");
    hash.update(String(entry.ctime_ms));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function fingerprintMetadataEntriesCooperative(entries, { alreadySorted = false } = {}) {
  const hash = createHash("sha256");
  const ordered = alreadySorted ? entries : [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index];
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(entry.size));
    hash.update("\0");
    hash.update(String(entry.mtime_ms));
    hash.update("\0");
    hash.update(String(entry.ctime_ms));
    hash.update("\0");
    if ((index + 1) % 1_024 === 0) await yieldToEventLoop();
  }
  return hash.digest("hex");
}

export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function waitForWatcherOpportunity(debounceMs) {
  const waitMs = Math.max(1, Math.min(25, Number(debounceMs) || 1));
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

export function diffMetadataEntries(current, probed) {
  const currentByPath = new Map(current.map((entry) => [entry.path, entry]));
  const probedByPath = new Map(probed.map((entry) => [entry.path, entry]));
  const changed = new Set();
  for (const relativePath of new Set([...currentByPath.keys(), ...probedByPath.keys()])) {
    const before = currentByPath.get(relativePath);
    const after = probedByPath.get(relativePath);
    if (
      !before ||
      !after ||
      before.size !== after.size ||
      before.mtime_ms !== after.mtime_ms ||
      before.ctime_ms !== after.ctime_ms
    ) {
      changed.add(relativePath);
    }
  }
  return [...changed].sort();
}

export async function cloneMapCooperative(source) {
  const cloned = new Map();
  let count = 0;
  for (const entry of source) {
    cloned.set(entry[0], entry[1]);
    count++;
    if (count % 1_024 === 0) await yieldToEventLoop();
  }
  return cloned;
}

export async function updateIncrementalCoverageCooperative(coverage, records) {
  let contentTruncatedFiles = 0;
  let binaryFiles = 0;
  let count = 0;
  for (const record of records.values()) {
    if (!record.content_complete && !record.binary) contentTruncatedFiles++;
    if (record.binary) binaryFiles++;
    count++;
    if (count % 1_024 === 0) await yieldToEventLoop();
  }
  return {
    ...coverage,
    indexed_files: records.size,
    visited_files: Math.max(records.size, Number(coverage.visited_files || 0)),
    content_truncated_files: contentTruncatedFiles,
    binary_files: binaryFiles,
    content_complete: contentTruncatedFiles === 0
  };
}

export function normalizeWatchedPath(rootDir, filename) {
  const raw = Buffer.isBuffer(filename) ? filename.toString("utf8") : String(filename);
  const absolute = path.resolve(rootDir, raw);
  const relative = path.relative(rootDir, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return relative === "" ? "" : null;
  }
  return normalizeRelativePath(relative);
}

export function isSkippedRelativePath(relativePath, skipDirs) {
  return String(relativePath)
    .split("/")
    .filter(Boolean)
    .some((segment) => skipDirs.has(segment));
}

export function relativeDirectoryDepth(relativePath) {
  return Math.max(0, String(relativePath).split("/").filter(Boolean).length - 1);
}
