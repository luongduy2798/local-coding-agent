// Local Coding Agent change-journal replay and snapshot restoration
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliDecompress } from "node:zlib";
import { ChangeJournalError } from "./journal-contract.mjs";
import {
  atomicWriteBuffer,
  conflictItem,
  hashBuffer,
  resolveContainedPath,
  snapshotMatches
} from "./journal-helpers.mjs";

const decompressBrotli = promisify(brotliDecompress);

export function createJournalReplayService({
  blobsDir,
  capturePath,
  dataDir,
  validatePath
}) {
  async function preflightFiles(files, expectedSide) {
    const conflicts = [];
    for (const file of files) {
      if (!file.undoable) continue;
      const current = await capturePath(file.path, { persist: false });
      const expected = file[expectedSide];
      if (!snapshotMatches(current, expected)) conflicts.push(conflictItem(file.path, expected, current));
    }
    return conflicts;
  }

  async function applyUndoGroup(group) {
    if (group.rename) return applyRenameState(group.files, "before");
    for (const file of group.files) {
      if (!file.undoable) continue;
      await restoreSnapshot(file.path, file.before);
    }
  }

  async function applyReapplyGroup(group) {
    if (group.rename) return applyRenameState(group.files, "after");
    for (const file of group.files) {
      if (!file.undoable) continue;
      await restoreSnapshot(file.path, file.after);
    }
  }

  async function applyRenameState(files, side) {
    const desiredExisting = files.filter((file) => file[side]?.exists);
    const desiredMissing = files.filter((file) => !file[side]?.exists);
    if (desiredExisting.length === 1 && desiredMissing.length === 1) {
      const fromFile = desiredMissing[0];
      const toFile = desiredExisting[0];
      const from = validatePath(fromFile.path);
      const to = validatePath(toFile.path);
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
      const desired = toFile[side];
      if (desired?.type === "file" && desired.undoable) {
        const current = await capturePath(toFile.path, { persist: false });
        if (!snapshotMatches(current, desired)) await restoreSnapshot(toFile.path, desired);
      }
      return;
    }
    for (const file of files) await restoreSnapshot(file.path, file[side]);
  }

  async function restoreSnapshot(filePath, snapshot) {
    const abs = validatePath(filePath);
    if (!snapshot?.exists) {
      await rm(abs, { recursive: true, force: true });
      return;
    }
    if (snapshot.type !== "file" || !snapshot.undoable) {
      throw new ChangeJournalError(
        "change_not_undoable",
        `Path is not automatically restorable: ${filePath}`,
        { path: filePath },
        409
      );
    }
    const buffer = await readSnapshotBuffer(snapshot);
    await mkdir(path.dirname(abs), { recursive: true });
    await atomicWriteBuffer(abs, buffer, {
      mode: Number.isInteger(snapshot.mode) ? snapshot.mode : 0o666
    });
  }

  async function readSnapshotBuffer(snapshot) {
    if (!snapshot.snapshot) throw new Error("Snapshot content is missing.");
    const metadataPath = resolveContainedPath(dataDir, snapshot.snapshot);
    const payload = JSON.parse(await readFile(metadataPath, "utf8"));
    if (!payload.blob) {
      return Buffer.from(payload.content || "", payload.encoding || "base64");
    }
    const blobPath = resolveContainedPath(blobsDir, path.relative("blobs", payload.blob));
    const compressed = await readFile(blobPath);
    const buffer = payload.compression === "brotli"
      ? await decompressBrotli(compressed)
      : compressed;
    const expectedHash = String(payload.contentHash || payload.version || "");
    const actualHash = hashBuffer(buffer);
    if (
      !expectedHash ||
      actualHash !== expectedHash ||
      (Number.isFinite(Number(payload.size)) && buffer.length !== Number(payload.size))
    ) {
      throw new ChangeJournalError(
        "snapshot_corrupt",
        "Snapshot blob failed its content hash or size check.",
        { expectedHash, actualHash },
        409
      );
    }
    return buffer;
  }

  async function readSnapshotText(snapshot) {
    return (await readSnapshotBuffer(snapshot)).toString("utf8");
  }

  return {
    applyReapplyGroup,
    applyUndoGroup,
    preflightFiles,
    readSnapshotText
  };
}
