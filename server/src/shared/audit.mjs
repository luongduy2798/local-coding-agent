// Local Coding Agent rotating audit log
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createWriteStream } from "node:fs";
import { appendFile, rename, rm, stat } from "node:fs/promises";

export function createAuditLog({
  auditPath,
  enabled,
  rotateBytes,
  rotateFiles,
  now = () => new Date().toISOString()
}) {
  let stream = null;
  let bytes = 0;
  let lastEntryAt = null;
  let rotationPromise = null;
  const pendingLines = [];

  function log(message) {
    console.log(`${now()} ${message}`);
  }

  function openStream() {
    const next = createWriteStream(auditPath, { flags: "a", mode: 0o600 });
    next.on("error", () => {
      if (stream === next) stream = null;
    });
    stream = next;
  }

  async function closeStream(target = stream) {
    if (!target || target.destroyed || target.closed) return;
    if (stream === target) stream = null;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      target.once("error", finish);
      target.end(finish);
    });
  }

  async function rotate({ force = false } = {}) {
    const info = await stat(auditPath).catch(() => null);
    if (!info || info.size === 0 || (!force && info.size < rotateBytes)) return false;
    await rm(`${auditPath}.${rotateFiles}`, { force: true }).catch(() => {});
    for (let index = rotateFiles - 1; index >= 1; index--) {
      await rename(`${auditPath}.${index}`, `${auditPath}.${index + 1}`).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    await rename(auditPath, `${auditPath}.1`);
    return true;
  }

  function scheduleRotation() {
    if (!enabled || rotationPromise) return rotationPromise;
    rotationPromise = (async () => {
      await closeStream();
      await rotate({ force: true });
      bytes = 0;
      openStream();
      while (pendingLines.length) {
        const line = pendingLines.shift();
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (bytes > 0 && bytes + lineBytes > rotateBytes) {
          await closeStream();
          await rotate({ force: true });
          bytes = 0;
          openStream();
        }
        bytes += lineBytes;
        stream.write(line);
      }
    })().catch(async (error) => {
      const pending = pendingLines.splice(0);
      stream = null;
      for (const line of pending) {
        await appendFile(auditPath, line, { encoding: "utf8", mode: 0o600 }).catch(() => {});
      }
      console.error(`Audit rotation failed: ${error?.message || error}`);
    }).finally(() => {
      rotationPromise = null;
      if (pendingLines.length) scheduleRotation();
    });
    return rotationPromise;
  }

  function audit(entry) {
    if (!enabled) return;
    lastEntryAt = String(entry?.ts || now());
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (rotationPromise || !stream || stream.destroyed || (bytes > 0 && bytes + lineBytes > rotateBytes)) {
      pendingLines.push(line);
      scheduleRotation();
      return;
    }
    bytes += lineBytes;
    stream.write(line);
  }

  async function init() {
    if (!enabled) return;
    await rotate();
    bytes = Number((await stat(auditPath).catch(() => null))?.size || 0);
    openStream();
  }

  async function close() {
    await rotationPromise?.catch(() => {});
    if (pendingLines.length) {
      scheduleRotation();
      await rotationPromise?.catch(() => {});
    }
    await closeStream();
  }

  function status() {
    return {
      enabled,
      path: auditPath,
      bytes,
      last_entry_at: lastEntryAt,
      rotating: Boolean(rotationPromise),
      queued_entries: pendingLines.length,
      rotate_bytes: rotateBytes,
      retained_files: rotateFiles
    };
  }

  return { audit, close, init, log, status };
}
