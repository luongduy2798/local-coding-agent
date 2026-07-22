// Local Coding Agent bounded search services
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

let PRIMARY_ROOT;
let RG_BIN;
let SEARCH_PROCESS_POOL;
let SKIP_DIRS;
let toRel;

export function configureSearchServices(dependencies) {
  ({
    PRIMARY_ROOT,
    RG_BIN,
    SEARCH_PROCESS_POOL,
    SKIP_DIRS,
    toRel
  } = dependencies);
}

export async function listEntries(dir, { recursive, limit, formatPath = toRel }) {
  const out = [];
  async function walk(current) {
    let items;
    try {
      items = (await readdir(current, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }
    for (const item of items) {
      if (out.length >= limit) return;
      if (SKIP_DIRS.has(item.name) || item.isSymbolicLink()) continue;
      const abs = path.join(current, item.name);
      let info;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      out.push({
        path: formatPath(abs),
        type: item.isDirectory() ? "directory" : "file",
        size: info.size,
        modified: info.mtime.toISOString()
      });
      if (recursive && item.isDirectory()) await walk(abs);
    }
  }
  await walk(dir);
  return out;
}

// Parse "path:line:text" grep-style output into match objects.
function parseGrepOutput(out, dir, limit, formatPath = toRel) {
  const matches = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    const abs = path.resolve(dir, m[1]);
    matches.push({ path: formatPath(abs), line: Number(m[2]), text: m[3].slice(0, 500) });
    if (matches.length >= limit) break;
  }
  return matches;
}

export function dedupeSearchMatches(matches) {
  const seen = new Set();
  return (matches || []).filter((match) => {
    const key = `${match.path}:${match.line}:${match.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function compareSearchMatch(left, right) {
  return String(left?.path || "").localeCompare(String(right?.path || "")) ||
    Number(left?.line || 0) - Number(right?.line || 0) ||
    String(left?.text || "").localeCompare(String(right?.text || ""));
}

// Fastest path: ripgrep. Respects .gitignore, works in any folder. null on miss.
export async function ripgrepGrep(dir, query, { regex, limit, glob, formatPath = toRel, signal } = {}) {
  if (!RG_BIN) return null;
  const patterns = Array.isArray(query) ? query : [query];
  return SEARCH_PROCESS_POOL.run(() => new Promise((resolve, reject) => {
  // NOTE: no -I here — in ripgrep -I means --no-filename (grep/git use it for
  // "ignore binary"). ripgrep skips binary files by default.
  const args = ["--no-heading", "--with-filename", "-n", "-S", "--sort", "path", "--color", "never"];
  if (!regex) args.push("-F");
  if (glob) args.push("-g", glob);
  for (const pattern of patterns) args.push("-e", pattern);
  args.push("--", ".");
    let pending = "";
    const matches = [];
    let child;
    let settled = false;
    let limitReached = false;
    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const consumeLine = (line) => {
      if (!line || matches.length >= limit) return;
      const parsed = parseGrepOutput(line, dir, 1, formatPath)[0];
      if (!parsed) return;
      matches.push(parsed);
      if (matches.length >= limit) {
        limitReached = true;
        child?.kill?.();
      }
    };
    const abort = () => {
      child?.kill?.();
      const error = new Error("Search request was cancelled.");
      error.code = "REQUEST_CANCELLED";
      finish(null, error);
    };
    if (signal?.aborted) return abort();
    try {
      child = spawn(RG_BIN, args, { cwd: dir, windowsHide: true });
    } catch {
      return finish(null);
    }
    signal?.addEventListener?.("abort", abort, { once: true });
    child.stdout?.on("data", (c) => {
      pending += c.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) consumeLine(line);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (pending) consumeLine(pending);
      if (!limitReached && code !== 0 && code !== 1) return finish(null);
      finish(dedupeSearchMatches(matches).slice(0, limit));
    });
  }), signal);
}

// Fast path: `git grep` inside a git work tree. Returns null when not a git repo
// / git unavailable / errored, so the caller can fall back to a JS scan.
export function gitGrep(dir, query, { regex, limit, glob, formatPath = toRel }) {
  const patterns = Array.isArray(query) ? query : [query];
  return new Promise((resolve) => {
    const args = ["-C", dir, "grep", "--no-color", "-n", "-I", "-i", "--untracked"];
    args.push(regex ? "-E" : "-F");
    for (const pattern of patterns) args.push("-e", pattern);
    args.push("--", glob ? glob : ".");
    let out = "";
    let child;
    try {
      child = spawn("git", args, { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout?.on("data", (c) => {
      if (out.length < 8_000_000) out += c.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === 128) return resolve(null); // not a git repo
      if (code !== 0 && code !== 1) return resolve(null); // 1 = no matches
      resolve(parseGrepOutput(out, dir, limit, formatPath));
    });
  });
}

export function createAsyncPool(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < max && queue.length) {
      const entry = queue.shift();
      if (entry.signal?.aborted) {
        entry.reject(cancelledSearchError());
        continue;
      }
      active++;
      entry.signal?.removeEventListener?.("abort", entry.abortQueued);
      Promise.resolve()
        .then(entry.operation)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  };
  return {
    run(operation, signal) {
      if (signal?.aborted) return Promise.reject(cancelledSearchError());
      return new Promise((resolve, reject) => {
        const entry = { operation, resolve, reject, signal, abortQueued: null };
        entry.abortQueued = () => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          reject(cancelledSearchError());
        };
        signal?.addEventListener?.("abort", entry.abortQueued, { once: true });
        queue.push(entry);
        drain();
      });
    },
    status() {
      return { active, queued: queue.length, limit: max };
    }
  };
}

function cancelledSearchError() {
  const error = new Error("Search request was cancelled.");
  error.code = "REQUEST_CANCELLED";
  return error;
}

// Attach a few lines of context to each match by reading files locally (no extra
// round trips to the model). Files are read once and cached for this call.
export async function attachContext(matches, ctx, root = PRIMARY_ROOT) {
  const cache = new Map();
  for (const m of matches) {
    const abs = path.isAbsolute(m.path) ? m.path : path.resolve(root, m.path);
    let lines = cache.get(abs);
    if (!lines) {
      try {
        lines = (await readFile(abs, "utf8")).split(/\r?\n/);
      } catch {
        lines = null;
      }
      cache.set(abs, lines);
    }
    if (!lines) continue;
    const from = Math.max(1, m.line - ctx);
    const to = Math.min(lines.length, m.line + ctx);
    const snippet = [];
    for (let i = from; i <= to; i++) snippet.push(`${i}| ${lines[i - 1]}`);
    m.snippet = snippet.join("\n");
  }
}

// Convert a simple glob (*, **, ?) to a RegExp for the scan fallback.
function globToRegex(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += ".";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$", "i");
}

// Find files by name glob: ripgrep --files > git ls-files > JS walk.
export async function findFiles(start, glob, limit, formatPath = toRel) {
  // ripgrep
  if (RG_BIN) {
    const out = await spawnFilesList(RG_BIN, ["--files", "-g", glob], start);
    if (out !== null) return { engine: "ripgrep", files: out.slice(0, limit).map((p) => formatPath(path.resolve(start, p))) };
  }
  // git ls-files
  const gitOut = await spawnFilesList("git", ["-C", start, "ls-files", "--cached", "--others", "--exclude-standard"], null);
  if (gitOut !== null) {
    const rx = globToRegex(glob);
    const hasSlash = glob.includes("/");
    const hit = gitOut.filter((p) => rx.test(hasSlash ? p : path.basename(p)));
    if (hit.length || gitOut.length) return { engine: "git", files: hit.slice(0, limit).map((p) => formatPath(path.resolve(start, p))) };
  }
  // JS walk fallback
  const rx = globToRegex(glob);
  const hasSlash = glob.includes("/");
  const all = await listEntries(start, { recursive: true, limit: 20000, formatPath });
  const files = all
    .filter((e) => e.type === "file")
    .map((e) => e.path)
    .filter((p) => rx.test(hasSlash ? p.split(path.sep).join("/") : path.basename(p)))
    .slice(0, limit);
  return { engine: "scan", files };
}

export async function listRepoFilesFast(start, limit = 4000) {
  if (RG_BIN) {
    const out = await spawnFilesList(RG_BIN, ["--files"], start);
    if (out !== null) {
      return { engine: "ripgrep", files: out.slice(0, limit).map((p) => path.resolve(start, p)) };
    }
  }
  const gitOut = await spawnFilesList("git", ["-C", start, "ls-files", "--cached", "--others", "--exclude-standard"], null);
  if (gitOut !== null) {
    return { engine: "git", files: gitOut.slice(0, limit).map((p) => path.resolve(start, p)) };
  }
  const all = await listEntries(start, {
    recursive: true,
    limit,
    formatPath: (absolute) => absolute
  });
  return { engine: "scan", files: all.filter((entry) => entry.type === "file").map((entry) => entry.path) };
}

function spawnFilesList(file, args, cwd) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(file, args, cwd ? { cwd, windowsHide: true } : { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout?.on("data", (c) => {
      if (out.length < 8_000_000) out += c.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) return resolve(null);
      resolve(out.split(/\r?\n/).filter(Boolean));
    });
  });
}

export async function searchTree(start, query, { regex, limit, glob, formatPath = toRel }) {
  const pattern = regex ? new RegExp(query, "i") : null;
  const needle = query.toLowerCase();
  const globRx = glob ? globToRegex(glob) : null;
  const globHasSlash = glob ? glob.includes("/") : false;
  const matches = [];
  const files = [];

  async function collect(current) {
    let info;
    try {
      info = await stat(current);
    } catch {
      return;
    }
    if (info.isFile()) {
      files.push(current);
      return;
    }
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (SKIP_DIRS.has(item.name)) continue;
      if (files.length > 50000) return;
      await collect(path.join(current, item.name));
    }
  }

  await collect(start);
  for (const file of files) {
    if (matches.length >= limit) break;
    if (globRx) {
      const rel = formatPath(file);
      const target = globHasSlash ? rel : path.basename(file);
      if (!globRx.test(target)) continue;
    }
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const found = regex ? pattern.test(line) : line.toLowerCase().includes(needle);
      if (!found) continue;
      matches.push({ path: formatPath(file), line: i + 1, text: line.slice(0, 500) });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}
