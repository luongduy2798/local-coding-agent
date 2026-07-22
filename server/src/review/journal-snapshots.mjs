// Local Coding Agent change journal snapshot and blob store.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { access, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants } from "node:zlib";
import {
  atomicWriteBufferIfAbsent,
  atomicWriteJson,
  hashBuffer,
  isLikelyBinary,
  metadataVersion,
  normalizeForMap,
  normalizeRelative,
  snapshotFileName
} from "./journal-helpers.mjs";
import { JOURNAL_SCHEMA_VERSION } from "./journal-contract.mjs";

const compressBrotli = promisify(brotliCompress);

export function createJournalSnapshotStore({
  blobsDir,
  dataDir,
  knownVersions,
  maxSnapshotBytes,
  snapshotsDir,
  toRelativePath,
  validatePath
}) {
  function normalizeAbsolute(filePath) {
    return normalizeForMap(path.resolve(filePath));
  }

  function rememberRead(filePath, buffer) {
    const version = hashBuffer(buffer);
    knownVersions.set(normalizeAbsolute(filePath), version);
    return version;
  }

  function forgetRead(filePath) {
    knownVersions.delete(normalizeAbsolute(filePath));
  }

  async function capturePath(filePath, { changeId, side, persist = true } = {}) {
    const abs = validatePath(filePath);
    const rel = normalizeRelative(toRelativePath(abs));
    let info;
    try {
      info = await lstat(abs);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          path: rel,
          absolutePath: abs,
          exists: false,
          type: "missing",
          size: 0,
          version: null,
          snapshot: null,
          undoable: true
        };
      }
      throw error;
    }

    if (info.isSymbolicLink()) {
      return {
        path: rel,
        absolutePath: abs,
        exists: true,
        type: "symlink",
        size: info.size,
        version: metadataVersion(info, "symlink"),
        snapshot: null,
        undoable: false,
        reason: "symlink"
      };
    }

    if (info.isDirectory()) {
      return {
        path: rel,
        absolutePath: abs,
        exists: true,
        type: "directory",
        size: info.size,
        version: metadataVersion(info, "directory"),
        snapshot: null,
        undoable: false,
        reason: "directory_metadata_only"
      };
    }

    if (!info.isFile()) {
      return {
        path: rel,
        absolutePath: abs,
        exists: true,
        type: "other",
        size: info.size,
        version: metadataVersion(info, "other"),
        snapshot: null,
        undoable: false,
        reason: "unsupported_type"
      };
    }

    const buffer = await readFile(abs);
    const version = hashBuffer(buffer);
    const binary = isLikelyBinary(buffer);
    const withinLimit = buffer.length <= maxSnapshotBytes;
    const undoable = withinLimit && !binary;
    let snapshot = null;

    if (persist && undoable && changeId && side) {
      const blob = await persistSnapshotBlob(buffer, version);
      const snapshotPath = path.join(snapshotsDir, changeId, side, snapshotFileName(rel));
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await atomicWriteJson(snapshotPath, {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        exists: true,
        type: "file",
        size: buffer.length,
        mode: info.mode,
        version,
        contentHash: version,
        compression: "brotli",
        blob: normalizeRelative(path.relative(dataDir, blob)),
        undoable: true
      });
      snapshot = normalizeRelative(path.relative(dataDir, snapshotPath));
    }

    return {
      path: rel,
      absolutePath: abs,
      exists: true,
      type: "file",
      size: buffer.length,
      mode: info.mode,
      version,
      snapshot,
      undoable,
      reason: undoable ? null : binary ? "binary_file" : "snapshot_limit",
      buffer: !binary ? buffer : undefined,
      text: !binary ? buffer.toString("utf8") : undefined
    };
  }

  async function persistSnapshotBlob(buffer, version) {
    const blobDir = path.join(blobsDir, version.slice(0, 2));
    const blobPath = path.join(blobDir, `${version}.br`);
    try {
      await access(blobPath);
      return blobPath;
    } catch {
      // Content-addressed blob is not present yet.
    }
    const compressed = await compressBrotli(buffer, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4
      }
    });
    await atomicWriteBufferIfAbsent(blobPath, compressed);
    return blobPath;
  }

  return { capturePath, forgetRead, normalizeAbsolute, rememberRead };
}
