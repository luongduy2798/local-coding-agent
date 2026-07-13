// Atomic-ish multi-file mutation engine with full-batch validation and rollback.
// Writes use temporary files + rename; any commit failure restores every target.

import path from "node:path";
import {
  mkdir, readFile, writeFile, stat, lstat, readlink, symlink, open, rm, rename, copyFile, cp, readdir
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

function now() { return new Date().toISOString(); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function occurrenceCount(content, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(needle, index)) !== -1) {
    count += 1;
    index += Math.max(1, needle.length);
  }
  return count;
}

function parseDiff(diffText) {
  const lines = String(diffText || "").split(/\r?\n/);
  const files = [];
  let current = null;
  const strip = (value) => String(value || "").replace(/^["']|["']$/g, "").replace(/^[ab]\//, "").trim();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("--- ")) {
      const next = lines[i + 1] || "";
      current = { minus: strip(line.slice(4)), plus: next.startsWith("+++ ") ? strip(next.slice(4)) : "", hunks: [], hunk: null };
      files.push(current);
      if (next.startsWith("+++ ")) i += 1;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      current.hunk = { before: [], after: [] };
      current.hunks.push(current.hunk);
      continue;
    }
    if (!current.hunk) continue;
    const tag = line[0];
    const body = line.slice(1);
    if (tag === " ") { current.hunk.before.push(body); current.hunk.after.push(body); }
    else if (tag === "-") current.hunk.before.push(body);
    else if (tag === "+") current.hunk.after.push(body);
  }
  if (!files.length) throw new Error("No file sections found in diff (need ---/+++ headers).");
  return files;
}

export function createAtomicMutationEngine({ dataDir, resolvePath, toRel, maxHistory = 100 }) {
  const backupsDir = path.join(dataDir, "transactions");
  const locksDir = path.join(dataDir, "mutation-locks");
  const historyPath = path.join(dataDir, "transactions.json");

  async function readJson(file, fallback) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  async function readHistory() { return readJson(historyPath, []); }
  async function writeHistory(history) { await writeJson(historyPath, history); }

  async function snapshotPath(abs, backupDir, index) {
    if (!existsSync(abs)) return { path: abs, hadContent: false, kind: "missing", backup: null };
    const info = await lstat(abs);
    if (info.isSymbolicLink()) {
      return { path: abs, hadContent: true, kind: "symlink", linkTarget: await readlink(abs), backup: null };
    }
    const backup = path.join(backupDir, `${index}-${path.basename(abs) || "root"}`);
    if (info.isDirectory()) await cp(abs, backup, { recursive: true, force: true });
    else await copyFile(abs, backup);
    return { path: abs, hadContent: true, kind: info.isDirectory() ? "directory" : "file", backup };
  }

  async function restoreSnapshots(snapshots) {
    const restored = [];
    const errors = [];
    for (const item of [...snapshots].reverse()) {
      try {
        const abs = resolvePath(item.path);
        await rm(abs, { recursive: true, force: true });
        if (item.hadContent && item.kind === "symlink") {
          await mkdir(path.dirname(abs), { recursive: true });
          await symlink(item.linkTarget, abs);
          restored.push({ path: toRel(abs), action: "restored_symlink" });
        } else if (item.hadContent && item.backup && existsSync(item.backup)) {
          await mkdir(path.dirname(abs), { recursive: true });
          if (item.kind === "directory") await cp(item.backup, abs, { recursive: true, force: true });
          else await copyFile(item.backup, abs);
          restored.push({ path: toRel(abs), action: "restored" });
        } else {
          restored.push({ path: toRel(abs), action: "removed_created_path" });
        }
      } catch (error) {
        errors.push({ path: item.path, error: String(error?.message || error) });
      }
    }
    return { ok: errors.length === 0, restored, errors };
  }

  async function pathFingerprint(abs) {
    if (!existsSync(abs)) return "missing";
    const info = await lstat(abs);
    if (info.isSymbolicLink()) return `symlink:${await readlink(abs)}`;
    if (info.isFile()) return `file:${sha256(await readFile(abs))}`;
    if (!info.isDirectory()) return `other:${info.mode}:${info.size}:${info.mtimeMs}`;
    const rows = [];
    async function walk(dir, prefix = "") {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const child = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const childInfo = await lstat(child);
        if (childInfo.isSymbolicLink()) rows.push(`${rel}:symlink:${await readlink(child)}`);
        else if (childInfo.isDirectory()) {
          rows.push(`${rel}:dir`);
          await walk(child, rel);
        } else if (childInfo.isFile()) rows.push(`${rel}:file:${sha256(await readFile(child))}`);
        else rows.push(`${rel}:other:${childInfo.mode}:${childInfo.size}`);
        if (rows.length > 20000) throw new Error(`DIRECTORY_STATE_TOO_LARGE: ${toRel(abs)}`);
      }
    }
    await walk(abs);
    return `directory:${sha256(rows.join("\n"))}`;
  }

  async function atomicWrite(abs, content) {
    await mkdir(path.dirname(abs), { recursive: true });
    const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.lca-${randomUUID()}.tmp`);
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, abs);
    } catch (error) {
      if (!existsSync(abs)) throw error;
      await rm(abs, { recursive: true, force: true });
      await rename(temp, abs);
    }
    try {
      const dirHandle = await open(path.dirname(abs), "r");
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch { /* directory fsync is not supported on every platform */ }
  }

  async function acquireLocks(targets, timeoutMs = 10000) {
    await mkdir(locksDir, { recursive: true });
    const acquired = [];
    const sorted = [...new Set(targets)].sort();
    const started = Date.now();
    try {
      for (const target of sorted) {
        const lockPath = path.join(locksDir, `${sha256(path.resolve(target))}.lock`);
        while (true) {
          try {
            const handle = await open(lockPath, "wx");
            await handle.writeFile(JSON.stringify({ pid: process.pid, target, createdAt: now() }), "utf8");
            acquired.push({ lockPath, handle });
            break;
          } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            if (Date.now() - started > timeoutMs) throw new Error(`MUTATION_LOCK_TIMEOUT: ${toRel(target)}`);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      }
      return async () => {
        for (const item of acquired.reverse()) {
          await item.handle.close().catch(() => {});
          await rm(item.lockPath, { force: true }).catch(() => {});
        }
      };
    } catch (error) {
      for (const item of acquired.reverse()) {
        await item.handle.close().catch(() => {});
        await rm(item.lockPath, { force: true }).catch(() => {});
      }
      throw error;
    }
  }

  async function normalizeOperation(raw) {
    const op = { ...raw };
    op.op = String(op.op || "");
    op.path = String(op.path || "");
    op.target = resolvePath(op.path);
    if (op.op === "rename") {
      if (!op.rename_to) throw new Error(`rename requires rename_to for ${op.path}`);
      op.destination = resolvePath(op.rename_to);
    }
    return op;
  }

  async function validateOperations(rawOperations) {
    if (!Array.isArray(rawOperations) || !rawOperations.length) throw new Error("Provide a non-empty operations array.");
    const planned = [];
    const touched = new Set();
    for (const raw of rawOperations) {
      const op = await normalizeOperation(raw);
      if (!["create", "update", "delete", "rename"].includes(op.op)) throw new Error(`Unsupported operation: ${op.op}`);
      if (touched.has(op.target)) throw new Error(`Duplicate target in transaction: ${op.path}`);
      touched.add(op.target);

      if (op.op === "create") {
        const exists = existsSync(op.target);
        if (exists && op.overwrite !== true) throw new Error(`CREATE_COLLISION: ${op.path}`);
        if (exists && op.expected_sha256) {
          const current = await readFile(op.target, "utf8");
          if (sha256(current) !== String(op.expected_sha256)) throw new Error(`FILE_CHANGED_SINCE_READ: ${op.path}`);
        }
        planned.push({ ...op, action: exists ? "overwrite" : "create", content: String(op.content ?? "") });
        continue;
      }

      if (!existsSync(op.target)) throw new Error(`PATH_NOT_FOUND: ${op.path}`);
      if (op.op === "delete") {
        const info = await lstat(op.target);
        if (info.isDirectory() && op.recursive !== true) throw new Error(`DIRECTORY_REQUIRES_RECURSIVE: ${op.path}`);
        planned.push({ ...op, action: "delete" });
        continue;
      }

      if (op.op === "rename") {
        if (touched.has(op.destination)) throw new Error(`Duplicate destination in transaction: ${op.rename_to}`);
        touched.add(op.destination);
        if (existsSync(op.destination) && op.overwrite !== true) throw new Error(`RENAME_COLLISION: ${op.rename_to}`);
        planned.push({ ...op, action: "rename" });
        continue;
      }

      const content = await readFile(op.target, "utf8");
      if (op.expected_sha256 && sha256(content) !== String(op.expected_sha256)) throw new Error(`FILE_CHANGED_SINCE_READ: ${op.path}`);
      let next = content;
      let replacements = 0;
      for (const edit of Array.isArray(op.edits) ? op.edits : []) {
        const oldText = String(edit.old_text || "");
        if (!oldText) throw new Error(`EMPTY_OLD_TEXT: ${op.path}`);
        const count = occurrenceCount(next, oldText);
        const expected = edit.expected_occurrences !== undefined
          ? Number(edit.expected_occurrences)
          : edit.replace_all ? count : 1;
        if (count === 0) throw new Error(`OLD_TEXT_NOT_FOUND: ${op.path}`);
        if (!edit.replace_all && count > 1 && edit.expected_occurrences === undefined) throw new Error(`AMBIGUOUS_EDIT: ${op.path} (${count} occurrences)`);
        if (count !== expected) throw new Error(`OCCURRENCE_CONFLICT: ${op.path} expected=${expected} actual=${count}`);
        if (edit.replace_all) {
          next = next.split(oldText).join(String(edit.new_text ?? ""));
          replacements += count;
        } else {
          next = next.replace(oldText, String(edit.new_text ?? ""));
          replacements += 1;
        }
      }
      planned.push({ ...op, action: "update", content: next, replacements, before_sha256: sha256(content), after_sha256: sha256(next) });
    }
    return planned;
  }

  async function diffToOperations(diffText) {
    const chunks = parseDiff(diffText);
    const operations = [];
    for (const chunk of chunks) {
      const isNew = chunk.minus === "/dev/null";
      const isDelete = chunk.plus === "/dev/null";
      const rel = isNew ? chunk.plus : chunk.minus || chunk.plus;
      if (isDelete) {
        operations.push({ op: "delete", path: rel, recursive: false });
        continue;
      }
      if (isNew) {
        const content = chunk.hunks.flatMap((hunk) => hunk.after).join("\n");
        operations.push({ op: "create", path: rel, content: content.endsWith("\n") ? content : `${content}\n`, overwrite: false });
        continue;
      }
      const target = resolvePath(rel);
      let content = await readFile(target, "utf8");
      const originalHash = sha256(content);
      for (const hunk of chunk.hunks) {
        const before = hunk.before.join("\n");
        const after = hunk.after.join("\n");
        if (before === after) continue;
        if (!before) {
          content += `${content.endsWith("\n") ? "" : "\n"}${after}`;
          continue;
        }
        const count = occurrenceCount(content, before);
        if (count === 0) throw new Error(`HUNK_NOT_FOUND: ${rel}`);
        if (count > 1) throw new Error(`AMBIGUOUS_HUNK: ${rel} (${count} matches)`);
        content = content.replace(before, after);
      }
      operations.push({ op: "create", path: rel, content, overwrite: true, expected_sha256: originalHash });
    }
    return operations;
  }

  async function commitPlanned(planned, { label = "mutation", recordHistory = true } = {}) {
    const id = randomUUID();
    const backupDir = path.join(backupsDir, id);
    await mkdir(backupDir, { recursive: true });
    const targets = [];
    for (const op of planned) {
      targets.push(op.target);
      if (op.destination) targets.push(op.destination);
    }
    const uniqueTargets = [...new Set(targets)];
    const releaseLocks = await acquireLocks(uniqueTargets);
    const snapshots = [];
    try {
      // Revalidate after acquiring LCA locks to close the validate/commit race.
      for (const op of planned) {
        if (op.before_sha256) {
          const current = await readFile(op.target, "utf8");
          if (sha256(current) !== op.before_sha256) throw new Error(`FILE_CHANGED_BEFORE_COMMIT: ${toRel(op.target)}`);
        }
        if (op.action === "create" && existsSync(op.target)) throw new Error(`CREATE_COLLISION_BEFORE_COMMIT: ${toRel(op.target)}`);
        if (op.action === "rename" && existsSync(op.destination) && op.overwrite !== true) throw new Error(`RENAME_COLLISION_BEFORE_COMMIT: ${toRel(op.destination)}`);
      }
      for (let i = 0; i < uniqueTargets.length; i++) snapshots.push(await snapshotPath(uniqueTargets[i], backupDir, i));
    } catch (error) {
      await releaseLocks();
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    const results = [];
    let finalStates = [];
    try {
      for (const op of planned) {
        if (op.action === "create" || op.action === "overwrite" || op.action === "update") {
          await atomicWrite(op.target, op.content);
          results.push({ op: op.op, action: op.action, path: toRel(op.target), ok: true, bytes: Buffer.byteLength(op.content), replacements: op.replacements });
        } else if (op.action === "delete") {
          await rm(op.target, { recursive: Boolean(op.recursive), force: false });
          results.push({ op: op.op, action: "delete", path: toRel(op.target), ok: true });
        } else if (op.action === "rename") {
          if (existsSync(op.destination) && op.overwrite === true) await rm(op.destination, { recursive: true, force: true });
          await mkdir(path.dirname(op.destination), { recursive: true });
          await rename(op.target, op.destination);
          results.push({ op: op.op, action: "rename", path: toRel(op.target), to: toRel(op.destination), ok: true });
        }
      }
      finalStates = [];
      for (const target of uniqueTargets) finalStates.push({ path: target, fingerprint: await pathFingerprint(target) });
    } catch (error) {
      const rollback = await restoreSnapshots(snapshots);
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
      const wrapped = new Error(`TRANSACTION_ROLLED_BACK: ${error?.message || error}`);
      wrapped.rollback = rollback;
      throw wrapped;
    } finally {
      await releaseLocks();
    }

    const record = {
      id,
      label,
      status: "committed",
      createdAt: now(),
      updatedAt: now(),
      backupDir,
      snapshots,
      finalStates,
      operations: planned.map((op) => ({
        op: op.op,
        path: toRel(op.target),
        rename_to: op.destination ? toRel(op.destination) : undefined,
        recursive: op.recursive,
        overwrite: op.overwrite,
        content: op.content,
        edits: op.edits
      })),
      results
    };
    if (recordHistory) {
      const history = await readHistory();
      history.push(record);
      while (history.length > maxHistory) {
        const expired = history.shift();
        if (expired?.backupDir) await rm(expired.backupDir, { recursive: true, force: true }).catch(() => {});
      }
      await writeHistory(history);
    } else {
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
    return { ok: true, transaction_id: id, status: "committed", applied: results.length, results };
  }

  async function applyOperations(operations, options = {}) {
    const planned = await validateOperations(operations);
    return commitPlanned(planned, options);
  }

  async function applyDiff(diff, options = {}) {
    const operations = await diffToOperations(diff);
    return applyOperations(operations, { label: options.label || "unified_diff", recordHistory: options.recordHistory !== false });
  }

  async function previewOperations(operations) {
    try {
      const planned = await validateOperations(operations);
      return { ok: true, files: planned.map((op) => ({ op: op.op, action: op.action, path: toRel(op.target), to: op.destination ? toRel(op.destination) : undefined, replacements: op.replacements })) };
    } catch (error) {
      return { ok: false, conflict: String(error?.message || error) };
    }
  }

  async function previewDiff(diff) {
    try {
      const operations = await diffToOperations(diff);
      return previewOperations(operations);
    } catch (error) {
      return { ok: false, conflict: String(error?.message || error) };
    }
  }

  async function list(limit = 50) {
    const history = await readHistory();
    return history.slice(-limit).reverse().map(({ snapshots, operations, ...record }) => ({ ...record, files: snapshots?.map((item) => toRel(item.path)) || [], operation_count: operations?.length || 0 }));
  }

  async function get(id) {
    const history = await readHistory();
    const record = history.find((item) => item.id === id);
    if (!record) throw new Error(`Transaction not found: ${id}`);
    return record;
  }

  async function undo(id, options = {}) {
    const history = await readHistory();
    const index = id ? history.findIndex((item) => item.id === id) : history.findLastIndex((item) => item.status === "committed");
    if (index < 0) throw new Error("No transaction to undo.");
    const record = history[index];
    if (record.status === "undone") throw new Error(`Transaction already undone: ${record.id}`);
    const targets = (record.snapshots || []).map((item) => item.path);
    const releaseLocks = await acquireLocks(targets);
    let restored;
    try {
      if (options.force !== true) {
        for (const expected of record.finalStates || []) {
          const actual = await pathFingerprint(expected.path);
          if (actual !== expected.fingerprint) throw new Error(`UNDO_CONFLICT: ${toRel(expected.path)} changed after transaction ${record.id}`);
        }
      }
      restored = await restoreSnapshots(record.snapshots || []);
    } finally {
      await releaseLocks();
    }
    if (!restored.ok) throw new Error(`UNDO_PARTIAL_FAILURE: ${JSON.stringify(restored.errors)}`);
    record.status = "undone";
    record.updatedAt = now();
    record.undoResult = restored;
    await writeHistory(history);
    return { ok: true, transaction_id: record.id, status: record.status, ...restored };
  }

  async function redo(id) {
    const history = await readHistory();
    const record = history.find((item) => item.id === id);
    if (!record) throw new Error(`Transaction not found: ${id}`);
    if (record.status !== "undone") throw new Error(`Transaction is not undone: ${record.id}`);
    const result = await applyOperations(record.operations || [], { label: `redo:${record.id}`, recordHistory: false });
    record.status = "committed";
    record.updatedAt = now();
    record.redoResult = result;
    await writeHistory(history);
    return { ...result, transaction_id: record.id, status: record.status };
  }

  async function cleanupOrphans() {
    await Promise.all([mkdir(backupsDir, { recursive: true }), mkdir(locksDir, { recursive: true })]);
    // Locks are process-local coordination. A server restart means every old
    // lock is stale, so clear them before accepting mutations.
    for (const name of await readdir(locksDir).catch(() => [])) {
      if (name.endsWith(".lock")) await rm(path.join(locksDir, name), { force: true }).catch(() => {});
    }
    const history = await readHistory();
    const keep = new Set(history.map((item) => path.basename(item.backupDir || "")).filter(Boolean));
    const names = await readdir(backupsDir).catch(() => []);
    for (const name of names) if (!keep.has(name)) await rm(path.join(backupsDir, name), { recursive: true, force: true }).catch(() => {});
  }

  return { applyOperations, applyDiff, previewOperations, previewDiff, list, get, undo, redo, cleanupOrphans };
}
