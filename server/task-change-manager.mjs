// Local Coding Agent task-scoped change sets
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";

const TASK_ID_RE = /^task_[a-zA-Z0-9._-]+$/;
const DEFAULT_MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const locks = new Map();

export function createTaskChangeManager(options = {}) {
  return new TaskChangeManager(options);
}

class TaskChangeManager {
  constructor({ maxGitOutput = DEFAULT_MAX_GIT_OUTPUT, validatePath } = {}) {
    this.maxGitOutput = maxGitOutput;
    this.validatePath = typeof validatePath === "function" ? validatePath : null;
  }

  async begin({ title, description = "", paths, cwd }) {
    const repo = await resolveRepository(cwd, this.maxGitOutput, this.validatePath);
    const scope = normalizeTaskScope(repo, paths);
    return withRepoLock(repo.root, async () => {
      const active = (await readAllTasks(repo)).find((task) => task.status === "active");
      if (active) {
        throw new Error(`An active task already exists: ${active.id} (${active.title}). Finish it before starting another task.`);
      }

      const id = createTaskId();
      const beforeRef = taskRef(id, "before");
      await createSnapshot(repo, beforeRef, this.maxGitOutput, scope);

      const now = new Date().toISOString();
      const record = {
        schemaVersion: 2,
        id,
        title: String(title).trim(),
        description: String(description || "").trim(),
        repoRoot: repo.root,
        status: "active",
        startedAt: now,
        finishedAt: null,
        beforeRef,
        afterRef: null,
        scope,
        files: [],
        stats: { filesChanged: 0, additions: 0, deletions: 0 },
        summary: "",
        lastOperation: null
      };

      await writeTask(repo, record);
      await appendHistory(repo, id, { at: now, event: "task_started", source: "chatgpt", scope });
      return { ok: true, task: publicTask(record), operation: { type: "begin", noOp: false } };
    });
  }

  async finish({ taskId, summary = "", cwd }) {
    const repo = await resolveRepository(cwd, this.maxGitOutput, this.validatePath);
    return withRepoLock(repo.root, async () => {
      const record = await readTask(repo, taskId);
      if (record.status === "applied" || record.status === "undone") {
        return { ok: true, task: publicTask(record), operation: { type: "finish", noOp: true } };
      }
      if (record.status !== "active") {
        throw new Error(`Task ${record.id} cannot be finished from status ${record.status}.`);
      }

      const afterRef = taskRef(record.id, "after");
      const scope = record.scope || { mode: "repository", paths: [] };
      await createSnapshot(repo, afterRef, this.maxGitOutput, scope);
      const taskDir = getTaskDir(repo, record.id);
      await mkdir(taskDir, { recursive: true });

      const forward = await gitOrThrow(
        ["diff", "--binary", "--full-index", "--find-renames", record.beforeRef, afterRef],
        repo.root,
        { maxOutput: this.maxGitOutput }
      );
      await writeFile(getTaskFile(repo, record.id, "forward.patch"), forward.stdout, "utf8");

      const { files, stats } = await collectDiffSummary(repo, record.beforeRef, afterRef, this.maxGitOutput);
      record.status = "applied";
      record.finishedAt = new Date().toISOString();
      record.afterRef = afterRef;
      record.files = files;
      record.stats = stats;
      record.summary = String(summary || "").trim();
      record.lastOperation = { type: "finish", status: "success", at: record.finishedAt };
      await writeTask(repo, record);
      await appendHistory(repo, record.id, {
        at: record.finishedAt,
        event: "task_finished",
        source: "chatgpt",
        filesChanged: stats.filesChanged
      });

      return {
        ok: true,
        task: publicTask(record),
        operation: { type: "finish", noOp: false, changedFiles: files.map((file) => file.path) }
      };
    });
  }

  async get({ taskId, cwd }) {
    const repo = await resolveRepository(cwd, this.maxGitOutput, this.validatePath);
    const record = await readTask(repo, taskId);
    return { ok: true, task: publicTask(record) };
  }

  async list({ cwd, limit = 20, status } = {}) {
    const repo = await resolveRepository(cwd, this.maxGitOutput, this.validatePath);
    let tasks = await readAllTasks(repo);
    if (status) tasks = tasks.filter((task) => task.status === status);
    tasks.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return { ok: true, count: Math.min(tasks.length, limit), tasks: tasks.slice(0, limit).map(publicTask) };
  }

  async diff({ taskId, cwd, path: requestedPath, mode = "unified", maxChars = 300_000, offset = 0 }) {
    const repo = await resolveRepository(cwd, this.maxGitOutput, this.validatePath);
    const record = await readTask(repo, taskId);
    if (!record.afterRef) throw new Error(`Task ${record.id} has not been finished yet.`);

    if (mode === "summary") {
      return { ok: true, task: publicTask(record), diff: null, truncated: false, nextOffset: null };
    }

    const relativePath = requestedPath ? normalizeTaskPath(repo, requestedPath) : null;
    const patchPath = getTaskFile(repo, record.id, "forward.patch");
    const patchText = await readFile(patchPath, "utf8");
    const filteredPatch = relativePath ? filterPatchByPath(patchText, relativePath, record.files) : patchText;
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeMax = Math.max(1_000, Math.min(1_000_000, Number(maxChars) || 300_000));
    const end = safeOffset + safeMax;
    const chunk = filteredPatch.slice(safeOffset, end);
    const truncated = end < filteredPatch.length;

    return {
      ok: true,
      task: publicTask(record),
      path: relativePath,
      diff: chunk,
      offset: safeOffset,
      truncated,
      nextOffset: truncated ? end : null,
      totalChars: filteredPatch.length
    };
  }

  async undo({ taskId, cwd }) {
    return this.#applyTaskPatch({ taskId, cwd, type: "undo" });
  }

  async reapply({ taskId, cwd }) {
    return this.#applyTaskPatch({ taskId, cwd, type: "reapply" });
  }

  async #applyTaskPatch({ taskId, cwd, type }) {
    const repo = await resolveRepository(cwd, this.maxGitOutput, this.validatePath);
    return withRepoLock(repo.root, async () => {
      const record = await readTask(repo, taskId);
      const isUndo = type === "undo";
      const expectedStatus = isUndo ? "applied" : "undone";
      const targetStatus = isUndo ? "undone" : "applied";

      if (record.status === targetStatus) {
        return {
          ok: true,
          task: publicTask(record),
          operation: { type, noOp: true, changedFiles: [], filesystemChanged: false }
        };
      }
      if (record.status !== expectedStatus) {
        throw new Error(`Task ${record.id} cannot ${type} from status ${record.status}.`);
      }

      const patchPath = getTaskFile(repo, record.id, "forward.patch");
      const patchText = await readFile(patchPath, "utf8");
      const now = new Date().toISOString();

      if (!patchText.trim()) {
        record.status = targetStatus;
        record.lastOperation = { type, status: "success", at: now, noOp: true };
        await writeTask(repo, record);
        await appendHistory(repo, record.id, { at: now, event: `task_${targetStatus}`, source: "chatgpt", noOp: true });
        return {
          ok: true,
          task: publicTask(record),
          operation: { type, noOp: true, changedFiles: [], filesystemChanged: false }
        };
      }

      const applyArgs = ["apply", "--whitespace=nowarn"];
      if (isUndo) applyArgs.push("-R");
      const check = await execGit([...applyArgs, "--check", patchPath], repo.root, {
        maxOutput: this.maxGitOutput
      });
      if (check.code !== 0) {
        const conflictFiles = record.files.map((file) => file.path);
        record.lastOperation = {
          type,
          status: "conflict",
          at: now,
          conflictFiles,
          message: compactGitError(check)
        };
        await writeTask(repo, record);
        await appendHistory(repo, record.id, {
          at: now,
          event: `task_${type}_conflict`,
          source: "chatgpt",
          conflictFiles
        });
        return {
          ok: false,
          error: {
            code: "task_patch_conflict",
            message: `Task ${record.id} cannot be ${isUndo ? "undone" : "reapplied"} safely because current files no longer match its patch.`,
            detail: compactGitError(check),
            files: conflictFiles,
            filesystemChanged: false
          },
          task: publicTask(record),
          operation: { type, noOp: false, changedFiles: [], filesystemChanged: false }
        };
      }

      const applied = await execGit([...applyArgs, patchPath], repo.root, {
        maxOutput: this.maxGitOutput
      });
      if (applied.code !== 0) {
        record.lastOperation = {
          type,
          status: "failed",
          at: now,
          message: compactGitError(applied)
        };
        await writeTask(repo, record);
        await appendHistory(repo, record.id, { at: now, event: `task_${type}_failed`, source: "chatgpt" });
        return {
          ok: false,
          error: {
            code: "patch_apply_failed",
            message: compactGitError(applied),
            files: record.files.map((file) => file.path),
            filesystemChanged: false
          },
          task: publicTask(record),
          operation: { type, noOp: false, changedFiles: [], filesystemChanged: false }
        };
      }

      record.status = targetStatus;
      record.lastOperation = { type, status: "success", at: now };
      await writeTask(repo, record);
      await appendHistory(repo, record.id, { at: now, event: `task_${targetStatus}`, source: "chatgpt" });
      return {
        ok: true,
        task: publicTask(record),
        operation: {
          type,
          noOp: false,
          changedFiles: record.files.map((file) => file.path),
          filesystemChanged: true
        }
      };
    });
  }
}

async function resolveRepository(cwd, maxOutput, validatePath) {
  const start = path.resolve(cwd || process.cwd());
  if (validatePath) validatePath(start);
  const rootResult = await execGit(["rev-parse", "--show-toplevel"], start, { maxOutput });
  if (rootResult.code !== 0) throw new Error(`Not a Git repository: ${compactGitError(rootResult)}`);
  const root = path.resolve(rootResult.stdout.trim());
  if (validatePath) validatePath(root);
  const gitDirResult = await gitOrThrow(["rev-parse", "--git-dir"], root, { maxOutput });
  const rawGitDir = gitDirResult.stdout.trim();
  const gitDir = path.isAbsolute(rawGitDir) ? path.resolve(rawGitDir) : path.resolve(root, rawGitDir);
  if (validatePath) validatePath(gitDir);
  const tasksDir = path.join(gitDir, "lca", "tasks");
  if (validatePath) validatePath(tasksDir);
  await mkdir(tasksDir, { recursive: true });
  return { root, gitDir, tasksDir, validatePath };
}

function normalizeTaskScope(repo, requestedPaths) {
  if (!Array.isArray(requestedPaths) || requestedPaths.length === 0) {
    return { mode: "repository", paths: [] };
  }

  const normalized = [];
  for (const requestedPath of requestedPaths) {
    const relativePath = normalizeTaskPath(repo, requestedPath);
    if (!relativePath) return { mode: "repository", paths: [] };
    normalized.push(relativePath);
  }

  const sorted = [...new Set(normalized)].sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    return depth || a.localeCompare(b);
  });
  const compact = [];
  for (const candidate of sorted) {
    if (compact.some((parent) => candidate === parent || candidate.startsWith(`${parent}/`))) continue;
    compact.push(candidate);
  }
  return compact.length ? { mode: "paths", paths: compact } : { mode: "repository", paths: [] };
}

function normalizeTaskPath(repo, requestedPath) {
  const raw = String(requestedPath || "");
  if (!raw.trim()) throw new Error("Task path must not be empty.");
  if (raw.includes("\0")) throw new Error("Task path contains a null byte.");
  const absolutePath = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repo.root, raw);
  if (repo.validatePath) repo.validatePath(absolutePath);
  const relativePath = path.relative(repo.root, absolutePath);
  if (!relativePath || relativePath === ".") return null;
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Task path is outside the task repository.");
  }
  return relativePath.split(path.sep).join("/");
}

function literalPathspec(relativePath) {
  return `:(top,literal)${relativePath}`;
}

async function selectSnapshotPathspecs(repo, scope, env, maxOutput) {
  if (scope.mode !== "paths" || !scope.paths.length) return ["."];
  const listed = await gitOrThrow(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scope.paths.map(literalPathspec)],
    repo.root,
    { env, maxOutput }
  );
  const matchedFiles = listed.stdout.split("\0").filter(Boolean);
  return scope.paths
    .filter((scopePath) => matchedFiles.some((filePath) => filePath === scopePath || filePath.startsWith(`${scopePath}/`)))
    .map(literalPathspec);
}

async function createSnapshot(repo, refName, maxOutput, scope = { mode: "repository", paths: [] }) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "lca-task-index-"));
  const indexPath = path.join(tempDir, "index");
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    const head = await execGit(["rev-parse", "--verify", "HEAD"], repo.root, { maxOutput });
    if (head.code === 0) await gitOrThrow(["read-tree", "HEAD"], repo.root, { env, maxOutput });
    else await gitOrThrow(["read-tree", "--empty"], repo.root, { env, maxOutput });
    const pathspecs = await selectSnapshotPathspecs(repo, scope, env, maxOutput);
    if (pathspecs.length) await gitOrThrow(["add", "-A", "--", ...pathspecs], repo.root, { env, maxOutput });
    const tree = await gitOrThrow(["write-tree"], repo.root, { env, maxOutput });
    const treeSha = tree.stdout.trim();
    await gitOrThrow(["update-ref", refName, treeSha], repo.root, { maxOutput });
    return treeSha;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function filterPatchByPath(patchText, requestedPath, files = []) {
  const targetPaths = new Set([requestedPath]);
  for (const file of files || []) {
    if (file?.path === requestedPath || file?.previousPath === requestedPath) {
      if (file.path) targetPaths.add(file.path);
      if (file.previousPath) targetPaths.add(file.previousPath);
    }
  }

  const sections = splitPatchSections(patchText);
  return sections
    .filter((section) => {
      const sectionPaths = patchSectionPaths(section);
      return [...targetPaths].some((targetPath) =>
        [...sectionPaths].some((sectionPath) => sectionPath === targetPath || sectionPath.startsWith(`${targetPath}/`))
      );
    })
    .join("");
}

function splitPatchSections(patchText) {
  const starts = [];
  const pattern = /^diff --git /gm;
  let match;
  while ((match = pattern.exec(patchText)) !== null) starts.push(match.index);
  if (!starts.length) return patchText ? [patchText] : [];
  return starts.map((start, index) => patchText.slice(start, starts[index + 1] ?? patchText.length));
}

function patchSectionPaths(section) {
  const paths = new Set();
  const lines = section.split(/\r?\n/);
  const header = lines[0] || "";
  if (header.startsWith("diff --git ")) {
    for (const token of tokenizeGitHeader(header.slice("diff --git ".length))) {
      const decoded = stripPatchPrefix(decodeGitPathToken(token));
      if (decoded) paths.add(decoded);
    }
  }

  const prefixes = ["--- ", "+++ ", "rename from ", "rename to ", "copy from ", "copy to "];
  for (const line of lines.slice(1)) {
    const prefix = prefixes.find((candidate) => line.startsWith(candidate));
    if (!prefix) continue;
    const decoded = stripPatchPrefix(decodeGitPathToken(line.slice(prefix.length).trim()));
    if (decoded) paths.add(decoded);
  }
  return paths;
}

function tokenizeGitHeader(value) {
  const tokens = [];
  let index = 0;
  while (index < value.length) {
    while (value[index] === " ") index++;
    if (index >= value.length) break;
    const start = index;
    if (value[index] === '"') {
      index++;
      let escaped = false;
      while (index < value.length) {
        const char = value[index++];
        if (!escaped && char === '"') break;
        if (!escaped && char === "\\") escaped = true;
        else escaped = false;
      }
    } else {
      while (index < value.length && value[index] !== " ") index++;
    }
    tokens.push(value.slice(start, index));
  }
  return tokens;
}

function decodeGitPathToken(token) {
  if (!(token.startsWith('"') && token.endsWith('"'))) return token;
  const bytes = [];
  const value = token.slice(1, -1);
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let index = 0; index < value.length;) {
    const char = value[index++];
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const escaped = value[index++] || "";
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(value[index] || "")) octal += value[index++];
      bytes.push(Number.parseInt(octal, 8));
    } else if (Object.hasOwn(escapes, escaped)) {
      bytes.push(escapes[escaped]);
    } else {
      bytes.push(...Buffer.from(escaped, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripPatchPrefix(filePath) {
  if (!filePath || filePath === "/dev/null") return null;
  return filePath.startsWith("a/") || filePath.startsWith("b/") ? filePath.slice(2) : filePath;
}

async function collectDiffSummary(repo, beforeRef, afterRef, maxOutput) {
  const names = await gitOrThrow(["diff", "--name-status", "--find-renames", beforeRef, afterRef], repo.root, { maxOutput });
  const nums = await gitOrThrow(["diff", "--numstat", "--find-renames", beforeRef, afterRef], repo.root, { maxOutput });

  const statsByPath = new Map();
  let additions = 0;
  let deletions = 0;
  for (const line of nums.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const add = parts[0] === "-" ? null : Number(parts[0]);
    const del = parts[1] === "-" ? null : Number(parts[1]);
    const filePath = parts.slice(2).join("\t");
    if (Number.isFinite(add)) additions += add;
    if (Number.isFinite(del)) deletions += del;
    statsByPath.set(filePath, { additions: add, deletions: del, binary: add === null || del === null });
  }

  const files = [];
  for (const line of names.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    const rawStatus = parts[0] || "M";
    const code = rawStatus[0];
    const renamed = code === "R" || code === "C";
    const previousPath = renamed ? parts[1] : null;
    const filePath = renamed ? parts[2] : parts[1];
    if (!filePath) continue;
    const stat = statsByPath.get(filePath) || { additions: null, deletions: null, binary: false };
    files.push({
      path: filePath,
      previousPath,
      operation: code === "A" ? "added" : code === "D" ? "deleted" : renamed ? "renamed" : "modified",
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary
    });
  }

  return {
    files,
    stats: { filesChanged: files.length, additions, deletions }
  };
}

async function readAllTasks(repo) {
  let entries = [];
  try {
    entries = await readdir(repo.tasksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TASK_ID_RE.test(entry.name)) continue;
    try {
      records.push(await readTask(repo, entry.name));
    } catch {
      // Ignore partially written or legacy task folders in list operations.
    }
  }
  return records;
}

async function readTask(repo, taskId) {
  assertTaskId(taskId);
  const metadataPath = getTaskFile(repo, taskId, "metadata.json");
  let record;
  try {
    record = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    throw new Error(`Task not found: ${taskId}`);
  }
  if (!record || record.id !== taskId) throw new Error(`Task metadata is invalid: ${taskId}`);
  return record;
}

async function writeTask(repo, record) {
  assertTaskId(record.id);
  const taskDir = getTaskDir(repo, record.id);
  await mkdir(taskDir, { recursive: true });
  const target = getTaskFile(repo, record.id, "metadata.json");
  const temporary = getTaskFile(repo, record.id, `.metadata-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function appendHistory(repo, taskId, event) {
  const taskDir = getTaskDir(repo, taskId);
  await mkdir(taskDir, { recursive: true });
  await appendFile(getTaskFile(repo, taskId, "history.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

function getTaskDir(repo, taskId) {
  assertTaskId(taskId);
  const taskDir = path.join(repo.tasksDir, taskId);
  if (repo.validatePath) repo.validatePath(taskDir);
  return taskDir;
}

function getTaskFile(repo, taskId, fileName) {
  if (!/^[a-zA-Z0-9._-]+$/.test(String(fileName || ""))) throw new Error("Invalid task file name.");
  const taskFile = path.join(getTaskDir(repo, taskId), fileName);
  if (repo.validatePath) repo.validatePath(taskFile);
  return taskFile;
}

function assertTaskId(taskId) {
  if (!TASK_ID_RE.test(String(taskId || ""))) throw new Error("Invalid task ID.");
}

function createTaskId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `task_${stamp}_${randomBytes(3).toString("hex")}`;
}

function taskRef(taskId, name) {
  assertTaskId(taskId);
  return `refs/lca/tasks/${taskId}/${name}`;
}

function publicTask(record) {
  return {
    id: record.id,
    title: record.title,
    description: record.description || "",
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt || null,
    summary: record.summary || "",
    files: Array.isArray(record.files) ? record.files : [],
    stats: record.stats || { filesChanged: 0, additions: 0, deletions: 0 },
    lastOperation: record.lastOperation || null,
    scope: record.scope || { mode: "repository", paths: [] }
  };
}

function withRepoLock(repoRoot, work) {
  const previous = locks.get(repoRoot) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(repoRoot, tail);
  return previous
    .then(work)
    .finally(() => {
      release();
      if (locks.get(repoRoot) === tail) locks.delete(repoRoot);
    });
}

async function gitOrThrow(args, cwd, options = {}) {
  const result = await execGit(args, cwd, options);
  if (result.code !== 0) throw new Error(compactGitError(result));
  return result;
}

function execGit(args, cwd, { env = {}, maxOutput = DEFAULT_MAX_GIT_OUTPUT } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;

    const collect = (target, chunk, type) => {
      const size = Buffer.byteLength(chunk);
      if (type === "stdout") stdoutBytes += size;
      else stderrBytes += size;
      if (stdoutBytes + stderrBytes > maxOutput) {
        overflow = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(Buffer.from(chunk));
    };

    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.on("error", (error) => {
      resolve({ code: 127, stdout: "", stderr: error.message, overflow: false });
    });
    child.on("close", (code) => {
      resolve({
        code: overflow ? 1 : code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: overflow ? `Git output exceeded ${maxOutput} bytes.` : Buffer.concat(stderr).toString("utf8"),
        overflow
      });
    });
  });
}

function compactGitError(result) {
  const text = String(result.stderr || result.stdout || "Git command failed.").trim();
  return text.split(/\r?\n/).slice(0, 6).join("\n").slice(0, 2_000);
}
