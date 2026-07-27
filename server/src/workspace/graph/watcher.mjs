// Local Coding Agent bounded workspace watcher.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EventEmitter } from "node:events";
import { watch as watchFileSystem } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { yieldToEventLoop } from "./freshness.mjs";

export const DEFAULT_SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", ".next", ".nuxt", ".cache",
  "node_modules", "vendor", "dist", "build", "coverage", "target", "__pycache__",
  ".venv", "venv", ".dart_tool", ".gradle"
]);

export const DEFAULT_WATCH_DEBOUNCE_MS = 75;
export const DEFAULT_WATCH_RECONCILE_INTERVAL_MS = 30_000;

export function createWorkspaceWatcher(rootDir, options, listener) {
  return new DirectoryTreeWatcher(rootDir, options, listener);
}

/**
 * `fs.watch(root, { recursive: true })` can allocate one native watcher per
 * file on macOS and fail with EMFILE on otherwise modest 10k-file repos. A
 * bounded watcher per directory keeps descriptor use proportional to the
 * directory count while preserving recursive change coverage.
 */
export class DirectoryTreeWatcher extends EventEmitter {
  constructor(rootDir, options, listener) {
    super();
    this.implementation = "bounded_directory_tree";
    this.rootDir = rootDir;
    this.persistent = options?.persistent === true;
    this.listener = listener;
    this.maximumDirectories = 8_192;
    this.watchers = new Map();
    this.pendingDirectories = new Set();
    this.closed = false;
    this.ready = false;
    this.coverageComplete = true;
    this.degradedError = null;
    this.abortSignal = options?.signal || null;
    this.abortHandler = () => this.close();
    if (this.abortSignal?.aborted) {
      this.closed = true;
      return;
    }
    this.abortSignal?.addEventListener?.("abort", this.abortHandler, { once: true });
    void this._attachTree(rootDir).then(() => {
      if (!this.closed) this.ready = true;
    }).catch((error) => {
      if (isWatcherResourceLimit(error) && this.watchers.size > 0) {
        this._degrade(error);
      } else {
        this._fail(error);
      }
    });
  }

  get watchedDirectoryCount() {
    return this.watchers.size;
  }

  async _attachTree(startDirectory) {
    const absoluteStart = path.resolve(startDirectory);
    if (
      this.closed ||
      this.degradedError ||
      this.pendingDirectories.has(absoluteStart) ||
      this.watchers.has(absoluteStart) ||
      !isInsideRoot(this.rootDir, absoluteStart)
    ) return;
    this.pendingDirectories.add(absoluteStart);
    try {
      const queue = [absoluteStart];
      while (queue.length && !this.closed && !this.degradedError) {
        const directory = queue.shift();
        if (this.watchers.has(directory)) continue;
        let info;
        try {
          info = await lstat(directory);
        } catch (error) {
          if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) continue;
          throw error;
        }
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        if (this.watchers.size >= this.maximumDirectories) {
          const error = new Error(`Workspace watcher exceeded ${this.maximumDirectories} directories.`);
          error.code = "LCA_WATCH_DIRECTORY_LIMIT";
          throw error;
        }
        this._attachDirectory(directory);
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) continue;
          throw error;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || DEFAULT_SKIP_DIRS.has(entry.name)) continue;
          queue.push(path.join(directory, entry.name));
        }
        if (this.watchers.size % 128 === 0) await yieldToEventLoop();
      }
    } finally {
      this.pendingDirectories.delete(absoluteStart);
    }
  }

  _attachDirectory(directory) {
    let watcher;
    try {
      watcher = watchFileSystem(directory, { persistent: this.persistent }, (eventType, filename) => {
        if (this.closed) return;
        const relativeDirectory = path.relative(this.rootDir, directory);
        const rawFilename = Buffer.isBuffer(filename) ? filename.toString("utf8") : String(filename || "");
        const relativePath = rawFilename
          ? path.join(relativeDirectory, rawFilename)
          : relativeDirectory;
        this.listener(eventType, relativePath);
        if (eventType === "rename" && rawFilename) {
          void this._attachTree(path.join(directory, rawFilename)).catch((error) => this._fail(error));
        }
      });
    } catch (error) {
      throw error;
    }
    watcher.on?.("error", (error) => {
      this.watchers.delete(directory);
      try {
        watcher.close();
      } catch {
        // A native watcher can already be closed when it reports an error.
      }
      if (isWatcherResourceLimit(error) && this.watchers.size > 0) {
        this._degrade(error);
      } else {
        this._fail(error);
      }
    });
    this.watchers.set(directory, watcher);
  }

  _degrade(error) {
    if (this.closed || this.degradedError) return;
    this.coverageComplete = false;
    this.degradedError = error;
    this.ready = true;
    // Keep the directories that were attached successfully. Their events are
    // still exact and useful, while WorkspaceGraph exposes degraded freshness
    // and retains query-fingerprint/full-reconcile correctness fallbacks for
    // the directories that could not be watched.
    this.emit("degraded", error);
  }

  _fail(error) {
    if (this.closed) return;
    this.close();
    this.emit("error", error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.abortSignal?.removeEventListener?.("abort", this.abortHandler);
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // A native watcher may already be closed after its own error.
      }
    }
    this.watchers.clear();
    this.pendingDirectories.clear();
  }
}

export function isWatcherResourceLimit(error) {
  return ["EMFILE", "ENFILE", "ENOSPC", "LCA_WATCH_DIRECTORY_LIMIT"].includes(error?.code);
}

export function isInsideRoot(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
