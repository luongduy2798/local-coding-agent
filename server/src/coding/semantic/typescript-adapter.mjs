// Local Coding Agent project-local TypeScript semantic adapter
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  lstat,
  readFile,
  realpath,
  stat
} from "node:fs/promises";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  statSync
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  SOURCE_EXTENSIONS,
  SUPPORTED_LANGUAGES,
  TypeScriptSemanticAdapterError
} from "./typescript-contract.mjs";
import {
  SemanticResultCollector,
  abortError,
  adapterError,
  boundedInteger,
  cachedLineStarts,
  comparePath,
  displayPartsText,
  hasIdentifierBoundary,
  isCommonIdentifier,
  isWithin,
  lineIndexForPosition,
  normalizeRelativePath,
  normalizeTypeScriptModule,
  offsetFromLineColumn,
  samePath,
  sanitizeCompilerOptions,
  semanticPack,
  serializeTypeScriptGraph,
  takeSemanticCall,
  throwIfAborted,
  yieldToEventLoop
} from "./typescript-helpers.mjs";
const SUPPORTED_MODES = new Set(["definition", "references", "type", "callers", "callees"]);
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const DEFAULT_MAX_SOURCE_FILES = 5_000;
const DEFAULT_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_EXTERNAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_EXTERNAL_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_CANDIDATES = 64;
const DEFAULT_MAX_SEMANTIC_CALLS = 16;
const DEFAULT_MAX_RAW_RESULTS = 10_000;
export { TypeScriptSemanticAdapterError } from "./typescript-contract.mjs";
export { SUPPORTED_LANGUAGES as TYPESCRIPT_SEMANTIC_LANGUAGES } from "./typescript-contract.mjs";

/**
 * Discover only <workspace>/node_modules/typescript. The compiler is loaded
 * lazily on the first semantic query so normal lexical queries and workspace
 * selection do not pay TypeScript's startup cost.
 */
export async function discoverTypeScriptSemanticAdapter({
  rootDir,
  ...options
} = {}) {
  if (!rootDir) throw adapterError("TYPESCRIPT_WORKSPACE_REQUIRED", "TypeScript discovery requires rootDir.");
  const requestedRoot = path.resolve(String(rootDir));
  const rootInfo = await lstat(requestedRoot).catch((error) => {
    throw adapterError("TYPESCRIPT_WORKSPACE_UNAVAILABLE", "Workspace root is unavailable.", error);
  });
  if (!rootInfo.isDirectory()) {
    throw adapterError("TYPESCRIPT_WORKSPACE_INVALID", "Workspace root must be a directory.");
  }
  const canonicalRoot = await realpath(requestedRoot);
  const requestedPackageRoot = path.join(canonicalRoot, "node_modules", "typescript");
  const packageInfo = await lstat(requestedPackageRoot).catch((error) => {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw adapterError("TYPESCRIPT_PACKAGE_UNAVAILABLE", "Project-local TypeScript package is unavailable.", error);
  });
  if (!packageInfo) return null;
  if (!packageInfo.isDirectory() && !packageInfo.isSymbolicLink()) {
    throw adapterError("TYPESCRIPT_PACKAGE_INVALID", "Project-local TypeScript package is not a directory.");
  }

  const canonicalPackageRoot = await realpath(requestedPackageRoot).catch((error) => {
    throw adapterError("TYPESCRIPT_PACKAGE_UNAVAILABLE", "Project-local TypeScript package cannot be resolved.", error);
  });
  if (!isWithin(canonicalRoot, canonicalPackageRoot)) {
    throw adapterError(
      "TYPESCRIPT_PACKAGE_OUTSIDE_WORKSPACE",
      "Project-local TypeScript package resolves outside the workspace."
    );
  }
  const packageRootInfo = await stat(canonicalPackageRoot).catch((error) => {
    throw adapterError("TYPESCRIPT_PACKAGE_UNAVAILABLE", "Project-local TypeScript package cannot be inspected.", error);
  });
  if (!packageRootInfo.isDirectory()) {
    throw adapterError("TYPESCRIPT_PACKAGE_INVALID", "Project-local TypeScript package is not a directory.");
  }

  const packageJsonPath = path.join(canonicalPackageRoot, "package.json");
  const packageJsonInfo = await stat(packageJsonPath).catch((error) => {
    throw adapterError("TYPESCRIPT_PACKAGE_INVALID", "Project-local TypeScript package.json is missing.", error);
  });
  if (!packageJsonInfo.isFile() || packageJsonInfo.size > MAX_PACKAGE_JSON_BYTES) {
    throw adapterError("TYPESCRIPT_PACKAGE_INVALID", "Project-local TypeScript package.json is invalid.");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    throw adapterError("TYPESCRIPT_PACKAGE_INVALID", "Project-local TypeScript package.json cannot be parsed.", error);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw adapterError("TYPESCRIPT_PACKAGE_INVALID", "Project-local TypeScript package.json is invalid.");
  }
  if (manifest.name !== "typescript") {
    throw adapterError("TYPESCRIPT_PACKAGE_INVALID", "Project-local TypeScript package identity is invalid.");
  }

  const main = typeof manifest.main === "string" && manifest.main.trim()
    ? manifest.main.trim()
    : "lib/typescript.js";
  if (path.isAbsolute(main) || main.includes("\0")) {
    throw adapterError("TYPESCRIPT_ENTRY_OUTSIDE_PACKAGE", "Project-local TypeScript entrypoint is unsafe.");
  }
  const requestedEntry = path.resolve(canonicalPackageRoot, main);
  if (!isWithin(canonicalPackageRoot, requestedEntry)) {
    throw adapterError(
      "TYPESCRIPT_ENTRY_OUTSIDE_PACKAGE",
      "Project-local TypeScript entrypoint escapes its package."
    );
  }
  const canonicalEntry = await realpath(requestedEntry).catch((error) => {
    throw adapterError("TYPESCRIPT_ENTRY_UNAVAILABLE", "Project-local TypeScript entrypoint is unavailable.", error);
  });
  if (!isWithin(canonicalRoot, canonicalEntry) || !isWithin(canonicalPackageRoot, canonicalEntry)) {
    throw adapterError(
      "TYPESCRIPT_ENTRY_OUTSIDE_WORKSPACE",
      "Project-local TypeScript entrypoint resolves outside the workspace."
    );
  }
  const entryInfo = await stat(canonicalEntry).catch((error) => {
    throw adapterError("TYPESCRIPT_ENTRY_UNAVAILABLE", "Project-local TypeScript entrypoint cannot be inspected.", error);
  });
  if (!entryInfo.isFile()) {
    throw adapterError("TYPESCRIPT_ENTRY_INVALID", "Project-local TypeScript entrypoint is not a file.");
  }

  return new TypeScriptSemanticWorkerAdapter({
    rootDir: canonicalRoot,
    packageRoot: canonicalPackageRoot,
    moduleEntry: canonicalEntry,
    packageVersion: typeof manifest.version === "string" ? manifest.version : null,
    ...options
  });
}

/**
 * Persistent worker proxy around the synchronous TypeScript Language Service.
 * Abort/timeout terminates the worker, so a compiler call cannot continue to
 * block MCP dispatch after CodeQueryEngine has fallen back to lexical results.
 */
export class TypeScriptSemanticWorkerAdapter {
  constructor({
    rootDir,
    packageRoot,
    moduleEntry,
    packageVersion = null,
    maxSourceFiles = DEFAULT_MAX_SOURCE_FILES,
    maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
    maxSourceFileBytes = DEFAULT_MAX_SOURCE_FILE_BYTES,
    maxExternalBytes = DEFAULT_MAX_EXTERNAL_BYTES,
    maxExternalFileBytes = DEFAULT_MAX_EXTERNAL_FILE_BYTES,
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    maxSemanticCalls = DEFAULT_MAX_SEMANTIC_CALLS,
    maxRawResults = DEFAULT_MAX_RAW_RESULTS,
    workerMaxOldGenerationMb = 256
  } = {}) {
    this.rootDir = path.resolve(String(rootDir || ""));
    this.packageRoot = path.resolve(String(packageRoot || ""));
    this.moduleEntry = path.resolve(String(moduleEntry || ""));
    if (!rootDir || !packageRoot || !moduleEntry ||
        !isWithin(this.rootDir, this.packageRoot) ||
        !isWithin(this.packageRoot, this.moduleEntry)) {
      throw adapterError("TYPESCRIPT_ADAPTER_INVALID", "TypeScript worker adapter paths are invalid.");
    }
    this.packageVersion = packageVersion ? String(packageVersion).slice(0, 80) : null;
    this.maxSourceFiles = boundedInteger(maxSourceFiles, DEFAULT_MAX_SOURCE_FILES, 1, 25_000);
    this.maxSourceBytes = boundedInteger(maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, 64 * 1024, 256 * 1024 * 1024);
    this.maxSourceFileBytes = boundedInteger(maxSourceFileBytes, DEFAULT_MAX_SOURCE_FILE_BYTES, 8 * 1024, 8 * 1024 * 1024);
    this.adapterOptions = {
      rootDir: this.rootDir,
      packageRoot: this.packageRoot,
      moduleEntry: this.moduleEntry,
      packageVersion: this.packageVersion,
      maxSourceFiles: this.maxSourceFiles,
      maxSourceBytes: this.maxSourceBytes,
      maxSourceFileBytes: this.maxSourceFileBytes,
      maxExternalBytes: boundedInteger(maxExternalBytes, DEFAULT_MAX_EXTERNAL_BYTES, 64 * 1024, 512 * 1024 * 1024),
      maxExternalFileBytes: boundedInteger(maxExternalFileBytes, DEFAULT_MAX_EXTERNAL_FILE_BYTES, 8 * 1024, 16 * 1024 * 1024),
      maxCandidates: boundedInteger(maxCandidates, DEFAULT_MAX_CANDIDATES, 1, 512),
      maxSemanticCalls: boundedInteger(maxSemanticCalls, DEFAULT_MAX_SEMANTIC_CALLS, 1, 128),
      maxRawResults: boundedInteger(maxRawResults, DEFAULT_MAX_RAW_RESULTS, 100, 100_000)
    };
    this.workerMaxOldGenerationMb = boundedInteger(workerMaxOldGenerationMb, 256, 64, 1_024);
    this.kind = "lsp";
    this.engine = "typescript-language-service";
    this.discovery = "workspace_local_dependency";
    this.hardPreemptible = true;
    this.warm = false;
    this._worker = null;
    this._workerNonce = null;
    this._workerGeneration = null;
    this._pending = new Map();
    this._sequence = 0;
    this._closed = false;
  }

  async query({ graph, query, mode, limit = 50, signal } = {}) {
    if (this._closed) throw adapterError("TYPESCRIPT_ADAPTER_CLOSED", "TypeScript semantic adapter is closed.");
    if (!graph || typeof graph.getRecords !== "function") {
      throw adapterError("TYPESCRIPT_GRAPH_REQUIRED", "TypeScript semantic query requires a workspace graph.");
    }
    if (signal?.aborted) throw abortError(signal.reason);
    const worker = this._ensureWorker();
    const generation = Number(graph.generation || 0);
    const id = ++this._sequence;
    const payload = {
      protocol: "lca-typescript-semantic-v1",
      nonce: this._workerNonce,
      type: "query",
      id,
      generation,
      query: String(query || ""),
      mode: String(mode || ""),
      limit: boundedInteger(limit, 50, 1, 500)
    };
    if (this._workerGeneration !== generation) {
      payload.snapshot = serializeTypeScriptGraph(graph, this);
      this._workerGeneration = generation;
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this._terminateWorker(abortError(signal?.reason));
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      this._pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener?.("abort", onAbort)
      });
      try {
        worker.postMessage(payload);
      } catch (error) {
        const pending = this._pending.get(id);
        this._pending.delete(id);
        pending?.cleanup();
        reject(adapterError("TYPESCRIPT_WORKER_SEND_FAILED", "Unable to send semantic query to worker.", error));
      }
    });
  }

  async close() {
    this._closed = true;
    const worker = this._worker;
    this._terminateWorker(adapterError("TYPESCRIPT_ADAPTER_CLOSED", "TypeScript semantic adapter is closed."));
    await worker?.terminate?.().catch(() => {});
  }

  _ensureWorker() {
    if (this._worker) return this._worker;
    const nonce = randomUUID();
    const worker = new Worker(new URL("./typescript-worker.mjs", import.meta.url), {
      workerData: {
        protocol: "lca-typescript-semantic-v1",
        nonce,
        adapter: this.adapterOptions
      },
      resourceLimits: { maxOldGenerationSizeMb: this.workerMaxOldGenerationMb }
    });
    this._worker = worker;
    this._workerNonce = nonce;
    worker.on("message", (message) => this._handleWorkerMessage(worker, message));
    worker.on("error", (error) => {
      if (this._worker === worker) {
        this._terminateWorker(adapterError("TYPESCRIPT_WORKER_FAILED", "TypeScript semantic worker failed.", error));
      }
    });
    worker.on("exit", (code) => {
      if (this._worker === worker) {
        this._terminateWorker(adapterError(
          "TYPESCRIPT_WORKER_EXITED",
          `TypeScript semantic worker exited before completing its query (${code}).`
        ));
      }
    });
    return worker;
  }

  _handleWorkerMessage(worker, message) {
    if (this._worker !== worker || !message ||
        message.protocol !== "lca-typescript-semantic-v1" ||
        message.nonce !== this._workerNonce) return;
    const pending = this._pending.get(Number(message.id));
    if (!pending) return;
    this._pending.delete(Number(message.id));
    pending.cleanup();
    if (message.type === "result") {
      this.warm = true;
      pending.resolve(message.value);
      return;
    }
    const error = adapterError(
      String(message.error?.code || "TYPESCRIPT_WORKER_FAILED"),
      String(message.error?.message || "TypeScript semantic worker failed.")
    );
    pending.reject(error);
  }

  _terminateWorker(error) {
    const worker = this._worker;
    this._worker = null;
    this._workerNonce = null;
    this._workerGeneration = null;
    this.warm = false;
    for (const pending of this._pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this._pending.clear();
    worker?.terminate?.().catch(() => {});
  }
}

export class TypeScriptSemanticAdapter {
  constructor({
    rootDir,
    packageRoot,
    moduleEntry,
    packageVersion = null,
    maxSourceFiles = DEFAULT_MAX_SOURCE_FILES,
    maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
    maxSourceFileBytes = DEFAULT_MAX_SOURCE_FILE_BYTES,
    maxExternalBytes = DEFAULT_MAX_EXTERNAL_BYTES,
    maxExternalFileBytes = DEFAULT_MAX_EXTERNAL_FILE_BYTES,
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    maxSemanticCalls = DEFAULT_MAX_SEMANTIC_CALLS,
    maxRawResults = DEFAULT_MAX_RAW_RESULTS
  } = {}) {
    if (!rootDir || !packageRoot || !moduleEntry) {
      throw adapterError("TYPESCRIPT_ADAPTER_INVALID", "TypeScript adapter paths are required.");
    }
    this.rootDir = path.resolve(String(rootDir));
    this.packageRoot = path.resolve(String(packageRoot));
    this.moduleEntry = path.resolve(String(moduleEntry));
    if (!isWithin(this.rootDir, this.packageRoot) || !isWithin(this.packageRoot, this.moduleEntry)) {
      throw adapterError("TYPESCRIPT_ADAPTER_INVALID", "TypeScript adapter paths are not root-confined.");
    }
    this.packageVersion = packageVersion ? String(packageVersion).slice(0, 80) : null;
    this.maxSourceFiles = boundedInteger(maxSourceFiles, DEFAULT_MAX_SOURCE_FILES, 1, 25_000);
    this.maxSourceBytes = boundedInteger(maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, 64 * 1024, 256 * 1024 * 1024);
    this.maxSourceFileBytes = boundedInteger(
      maxSourceFileBytes,
      DEFAULT_MAX_SOURCE_FILE_BYTES,
      8 * 1024,
      8 * 1024 * 1024
    );
    this.maxExternalBytes = boundedInteger(maxExternalBytes, DEFAULT_MAX_EXTERNAL_BYTES, 64 * 1024, 512 * 1024 * 1024);
    this.maxExternalFileBytes = boundedInteger(
      maxExternalFileBytes,
      DEFAULT_MAX_EXTERNAL_FILE_BYTES,
      8 * 1024,
      16 * 1024 * 1024
    );
    this.maxCandidates = boundedInteger(maxCandidates, DEFAULT_MAX_CANDIDATES, 1, 512);
    this.maxSemanticCalls = boundedInteger(maxSemanticCalls, DEFAULT_MAX_SEMANTIC_CALLS, 1, 128);
    this.maxRawResults = boundedInteger(maxRawResults, DEFAULT_MAX_RAW_RESULTS, 100, 100_000);

    this.kind = "lsp";
    this.engine = "typescript-language-service";
    this.discovery = "workspace_local_dependency";
    this.hardPreemptible = false;
    this.warm = false;
    this._typescript = null;
    this._moduleLoadPromise = null;
    this._service = null;
    this._host = null;
    this._state = null;
  }

  async query({ graph, query, mode, limit = 50, signal } = {}) {
    if (!graph || typeof graph.getRecords !== "function") {
      throw adapterError("TYPESCRIPT_GRAPH_REQUIRED", "TypeScript semantic query requires a workspace graph.");
    }
    if (!SUPPORTED_MODES.has(mode)) {
      return semanticPack([], {
        complete: false,
        confidence: 0.5,
        fallbackReasons: ["typescript_mode_unsupported"]
      });
    }
    const needle = String(query || "").trim();
    if (!needle) throw adapterError("TYPESCRIPT_QUERY_REQUIRED", "TypeScript semantic query requires query text.");
    throwIfAborted(signal);
    const graphRoot = path.resolve(String(graph.rootDir || ""));
    if (!samePath(graphRoot, this.rootDir)) {
      throw adapterError("TYPESCRIPT_WORKSPACE_MISMATCH", "TypeScript adapter is bound to a different workspace.");
    }

    const boundedLimit = boundedInteger(limit, 50, 1, 500);
    const ts = await this._loadTypeScript(signal);
    throwIfAborted(signal);
    this._syncGraphState(graph, ts);
    const state = this._state;
    const fallbackReasons = new Set(state.incompleteReasons);
    if (!state.sourceFiles.length) {
      return semanticPack([], {
        complete: fallbackReasons.size === 0,
        confidence: fallbackReasons.size ? 0.5 : 0.9,
        fallbackReasons
      });
    }

    const service = this._ensureLanguageService(ts);
    await yieldToEventLoop();
    throwIfAborted(signal);
    const candidates = await this._collectCandidates(service, needle, signal);
    for (const reason of candidates.fallbackReasons) fallbackReasons.add(reason);
    if (candidates.truncated) fallbackReasons.add("typescript_candidate_budget_exceeded");

    const collector = new SemanticResultCollector({
      rootDir: this.rootDir,
      state,
      limit: boundedLimit,
      maxRawResults: this.maxRawResults,
      resolveLocation: (fileName, textSpan) => this._locationFromSpan(fileName, textSpan)
    });
    const budget = { calls: 0, exhausted: false };
    if (mode === "definition") {
      await this._queryDefinitions(service, candidates.items, needle, collector, budget, signal);
    } else if (mode === "references") {
      await this._queryReferences(service, candidates.items, needle, collector, budget, signal);
    } else if (mode === "type") {
      await this._queryTypes(service, candidates.items, needle, collector, budget, signal);
    } else {
      await this._queryCallHierarchy(service, candidates.items, needle, mode, collector, budget, signal);
    }
    if (budget.exhausted) fallbackReasons.add("typescript_semantic_call_budget_exceeded");
    if (collector.truncated) fallbackReasons.add("typescript_result_budget_exceeded");
    for (const reason of collector.fallbackReasons) fallbackReasons.add(reason);
    for (const reason of state.incompleteReasons) fallbackReasons.add(reason);

    return semanticPack(collector.results, {
      total: collector.totalForResponse(),
      truncated: collector.truncated,
      complete: fallbackReasons.size === 0,
      confidence: fallbackReasons.size ? 0.88 : 0.98,
      fallbackReasons
    });
  }

  async close() {
    try {
      this._service?.dispose?.();
    } finally {
      this._service = null;
      this._host = null;
      this._state = null;
      this.warm = false;
    }
  }

  async _loadTypeScript(signal) {
    if (this._typescript) return this._typescript;
    if (!this._moduleLoadPromise) {
      this._moduleLoadPromise = (async () => {
        const currentEntry = await realpath(this.moduleEntry).catch((error) => {
          throw adapterError("TYPESCRIPT_ENTRY_UNAVAILABLE", "Project-local TypeScript entrypoint is unavailable.", error);
        });
        if (!samePath(currentEntry, this.moduleEntry) ||
            !isWithin(this.rootDir, currentEntry) ||
            !isWithin(this.packageRoot, currentEntry)) {
          throw adapterError("TYPESCRIPT_ENTRY_CHANGED", "Project-local TypeScript entrypoint changed after discovery.");
        }
        const namespace = await import(pathToFileURL(currentEntry).href);
        const ts = normalizeTypeScriptModule(namespace);
        if (!ts) {
          throw adapterError(
            "TYPESCRIPT_API_UNSUPPORTED",
            "Project-local TypeScript does not expose the required Language Service API."
          );
        }
        this._typescript = ts;
        return ts;
      })().catch((error) => {
        this._moduleLoadPromise = null;
        throw error;
      });
    }
    const ts = await this._moduleLoadPromise;
    throwIfAborted(signal);
    return ts;
  }

  _syncGraphState(graph, ts) {
    const generation = Number(graph.generation || 0);
    if (this._state?.generation === generation && this._state?.graph === graph) return;
    const relevant = graph.getRecords()
      .filter((record) => SUPPORTED_LANGUAGES.has(record.language) && SOURCE_EXTENSIONS.has(path.extname(record.path).toLowerCase()))
      .sort((left, right) => String(left.path).localeCompare(String(right.path)));
    const sourceFiles = [];
    const sourceByPath = new Map();
    const incompleteReasons = new Set(
      Array.isArray(graph.semanticIncompleteReasons)
        ? graph.semanticIncompleteReasons.map((reason) => String(reason))
        : []
    );
    let sourceBytes = 0;

    for (const record of relevant) {
      const content = typeof record.content === "string" ? record.content : null;
      const bytes = content === null ? 0 : Buffer.byteLength(content);
      if (content === null || record.content_complete === false || bytes > this.maxSourceFileBytes) {
        incompleteReasons.add("typescript_source_content_incomplete");
        continue;
      }
      if (sourceFiles.length >= this.maxSourceFiles || sourceBytes + bytes > this.maxSourceBytes) {
        incompleteReasons.add("typescript_source_budget_exceeded");
        continue;
      }
      const absolute = path.resolve(this.rootDir, record.path);
      if (!isWithin(this.rootDir, absolute)) {
        incompleteReasons.add("typescript_source_path_rejected");
        continue;
      }
      const source = {
        absolute,
        key: comparePath(absolute),
        relative: normalizeRelativePath(path.relative(this.rootDir, absolute)),
        content,
        bytes,
        version: String(record.fingerprint || `${record.mtime_ms || 0}:${bytes}`),
        record
      };
      sourceFiles.push(source);
      sourceByPath.set(source.key, source);
      sourceBytes += bytes;
    }
    if (relevant.length !== sourceFiles.length && !incompleteReasons.size) {
      incompleteReasons.add("typescript_source_coverage_incomplete");
    }

    const state = {
      graph,
      generation,
      projectVersion: `${generation}:${sourceFiles.length}:${sourceBytes}`,
      sourceFiles,
      sourceByPath,
      sourceBytes,
      externalCache: new Map(),
      externalReadBytes: 0,
      lineStarts: new Map(),
      incompleteReasons,
      compilerOptions: null
    };
    this._state = state;
    state.compilerOptions = this._loadCompilerOptions(ts);
  }

  _ensureLanguageService(ts) {
    if (this._service) {
      this.warm = true;
      return this._service;
    }
    const host = {
      getCompilationSettings: () => this._state?.compilerOptions || {},
      getScriptFileNames: () => this._state?.sourceFiles.map((source) => source.absolute) || [],
      getScriptVersion: (fileName) => this._scriptVersion(fileName),
      getScriptSnapshot: (fileName) => {
        const content = this._readConfinedText(fileName);
        return content === null ? undefined : ts.ScriptSnapshot.fromString(content);
      },
      getCurrentDirectory: () => this.rootDir,
      getDefaultLibFileName: (options) => {
        const candidate = typeof ts.getDefaultLibFilePath === "function"
          ? ts.getDefaultLibFilePath(options)
          : path.join(this.packageRoot, "lib", "lib.d.ts");
        return this._canonicalExistingPath(candidate, { file: true }) || path.join(this.packageRoot, "lib", "lib.d.ts");
      },
      fileExists: (fileName) => Boolean(this._canonicalExistingPath(fileName, { file: true })),
      readFile: (fileName) => this._readConfinedText(fileName) ?? undefined,
      readDirectory: (directory, extensions, _exclude, _include, depth) =>
        this._readConfinedDirectory(directory, extensions, depth),
      directoryExists: (directory) => Boolean(this._canonicalExistingPath(directory, { directory: true })),
      getDirectories: (directory) => this._getConfinedDirectories(directory),
      realpath: (candidate) => this._canonicalExistingPath(candidate) || this._confinedLexicalPath(candidate) || candidate,
      useCaseSensitiveFileNames: () => Boolean(ts.sys?.useCaseSensitiveFileNames ?? process.platform !== "win32"),
      getNewLine: () => String(ts.sys?.newLine || "\n"),
      getProjectVersion: () => this._state?.projectVersion || "0"
    };
    this._host = host;
    try {
      this._service = ts.createLanguageService(host);
    } catch (error) {
      this._host = null;
      throw adapterError("TYPESCRIPT_SERVICE_FAILED", "Project-local TypeScript Language Service failed to start.", error);
    }
    this.warm = true;
    return this._service;
  }

  _loadCompilerOptions(ts) {
    const defaults = {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
      allowNonTsExtensions: true,
      resolveJsonModule: true
    };
    if (ts.ScriptTarget) defaults.target = ts.ScriptTarget.ESNext ?? ts.ScriptTarget.Latest;
    if (ts.JsxEmit) defaults.jsx = ts.JsxEmit.Preserve;
    if (ts.ModuleResolutionKind) {
      defaults.moduleResolution = ts.ModuleResolutionKind.NodeNext ?? ts.ModuleResolutionKind.NodeJs;
    }
    if (ts.ModuleKind) defaults.module = ts.ModuleKind.NodeNext ?? ts.ModuleKind.ESNext ?? ts.ModuleKind.CommonJS;

    if (typeof ts.parseConfigFileTextToJson !== "function" || typeof ts.convertCompilerOptionsFromJson !== "function") {
      return defaults;
    }
    for (const configName of ["tsconfig.json", "jsconfig.json"]) {
      const configPath = path.join(this.rootDir, configName);
      const content = this._readConfinedText(configPath);
      if (content === null) continue;
      try {
        const parsed = ts.parseConfigFileTextToJson(configPath, content);
        if (parsed?.error || !parsed?.config || typeof parsed.config !== "object") continue;
        const converted = ts.convertCompilerOptionsFromJson(
          parsed.config.compilerOptions || {},
          this.rootDir,
          configName
        );
        const options = sanitizeCompilerOptions(converted?.options || {}, this.rootDir);
        return { ...defaults, ...options, allowJs: true, noEmit: true, plugins: undefined };
      } catch {
        this._state?.incompleteReasons.add("typescript_config_parse_failed");
      }
    }
    return defaults;
  }

  async _collectCandidates(service, query, signal) {
    const items = [];
    const seen = new Set();
    const fallbackReasons = new Set();
    let truncated = false;
    const terminalName = query.split(".").pop() || query;
    const add = (candidate) => {
      const canonical = this._canonicalExistingPath(candidate.fileName, { file: true });
      if (!canonical) return;
      const position = boundedInteger(candidate.position, 0, 0, Number.MAX_SAFE_INTEGER);
      const key = `${comparePath(canonical)}:${position}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (items.length >= this.maxCandidates) {
        truncated = true;
        return;
      }
      items.push({
        fileName: canonical,
        position,
        name: String(candidate.name || terminalName).slice(0, 500),
        symbolKind: candidate.symbolKind ? String(candidate.symbolKind).slice(0, 100) : null,
        source: candidate.source || "lexical"
      });
    };

    if (typeof service.getNavigateToItems === "function") {
      try {
        const navigated = service.getNavigateToItems(terminalName, this.maxCandidates + 1, undefined, false, true) || [];
        for (const item of navigated) {
          if (String(item?.name || "") !== terminalName) continue;
          add({
            fileName: item.fileName,
            position: item.textSpan?.start,
            name: item.name,
            symbolKind: item.kind,
            source: "navigate"
          });
        }
        if (navigated.length > this.maxCandidates) truncated = true;
      } catch {
        fallbackReasons.add("typescript_navigation_failed");
      }
    } else {
      fallbackReasons.add("typescript_navigation_unavailable");
    }

    for (const source of this._state.sourceFiles) {
      for (const symbol of source.record.symbols || []) {
        if (String(symbol?.name || "") !== terminalName) continue;
        add({
          fileName: source.absolute,
          position: offsetFromLineColumn(source.content, symbol.line, symbol.column),
          name: symbol.name,
          symbolKind: symbol.kind,
          source: "graph_symbol"
        });
      }
    }

    // Language Service navigation and graph symbols identify declarations.
    // Occurrence candidates are only a fallback: preparing call hierarchy on
    // every call-site would ask for the enclosing function and return unrelated
    // outgoing calls instead of the queried symbol's hierarchy.
    if (!items.length && isCommonIdentifier(terminalName)) {
      for (const source of this._state.sourceFiles) {
        let cursor = 0;
        while (cursor < source.content.length) {
          const position = source.content.indexOf(terminalName, cursor);
          if (position < 0) break;
          cursor = position + Math.max(1, terminalName.length);
          if (!hasIdentifierBoundary(source.content, position, terminalName.length)) continue;
          add({ fileName: source.absolute, position, name: terminalName, source: "occurrence" });
          if (items.length >= this.maxCandidates) {
            truncated = true;
            break;
          }
        }
        if (items.length >= this.maxCandidates) break;
      }
    }
    await yieldToEventLoop();
    throwIfAborted(signal);
    return { items, truncated, fallbackReasons };
  }

  async _queryDefinitions(service, candidates, query, collector, budget, signal) {
    if (typeof service.getDefinitionAtPosition !== "function") {
      collector.addFallback("typescript_definition_unavailable");
      return;
    }
    for (const candidate of candidates) {
      if (!takeSemanticCall(budget, this.maxSemanticCalls)) break;
      throwIfAborted(signal);
      let definitions;
      try {
        definitions = service.getDefinitionAtPosition(candidate.fileName, candidate.position) || [];
      } catch {
        collector.addFallback("typescript_definition_failed");
        continue;
      }
      for (const definition of definitions) {
        if (!collector.addDocumentSpan(definition.fileName, definition.textSpan, {
          kind: "definition",
          name: definition.name || query,
          symbol_kind: definition.kind || candidate.symbolKind || "symbol",
          detail: definition.containerName || undefined,
          score: 0.99
        })) break;
      }
      await yieldToEventLoop();
    }
  }

  async _queryReferences(service, candidates, query, collector, budget, signal) {
    if (typeof service.getReferencesAtPosition !== "function") {
      collector.addFallback("typescript_references_unavailable");
      return;
    }
    for (const candidate of candidates) {
      if (!takeSemanticCall(budget, this.maxSemanticCalls)) break;
      throwIfAborted(signal);
      let references;
      try {
        references = service.getReferencesAtPosition(candidate.fileName, candidate.position) || [];
      } catch {
        collector.addFallback("typescript_references_failed");
        continue;
      }
      for (const reference of references) {
        if (!collector.addDocumentSpan(reference.fileName, reference.textSpan, {
          kind: "reference",
          name: query,
          detail: reference.isWriteAccess ? "write reference" : "read reference",
          score: reference.isWriteAccess ? 0.99 : 0.98
        })) break;
      }
      await yieldToEventLoop();
    }
  }

  async _queryTypes(service, candidates, query, collector, budget, signal) {
    if (typeof service.getQuickInfoAtPosition !== "function") {
      collector.addFallback("typescript_type_unavailable");
      return;
    }
    for (const candidate of candidates) {
      if (!takeSemanticCall(budget, this.maxSemanticCalls)) break;
      throwIfAborted(signal);
      let info;
      try {
        info = service.getQuickInfoAtPosition(candidate.fileName, candidate.position, 2_000);
      } catch {
        collector.addFallback("typescript_type_failed");
        continue;
      }
      if (info) {
        collector.addDocumentSpan(candidate.fileName, info.textSpan, {
          kind: "type",
          name: query,
          symbol_kind: info.kind || candidate.symbolKind || "symbol",
          signature: displayPartsText(info.displayParts),
          detail: displayPartsText(info.documentation),
          score: 0.99
        });
      }
      await yieldToEventLoop();
    }
  }

  async _queryCallHierarchy(service, candidates, query, mode, collector, budget, signal) {
    const incoming = mode === "callers";
    const provide = incoming
      ? service.provideCallHierarchyIncomingCalls
      : service.provideCallHierarchyOutgoingCalls;
    if (typeof service.prepareCallHierarchy !== "function" || typeof provide !== "function") {
      collector.addFallback("typescript_call_hierarchy_unavailable");
      return;
    }
    for (const candidate of candidates) {
      if (!takeSemanticCall(budget, this.maxSemanticCalls)) break;
      throwIfAborted(signal);
      let prepared;
      try {
        prepared = service.prepareCallHierarchy(candidate.fileName, candidate.position);
      } catch {
        collector.addFallback("typescript_call_hierarchy_failed");
        continue;
      }
      const items = Array.isArray(prepared) ? prepared : prepared ? [prepared] : [];
      for (const item of items) {
        if (!takeSemanticCall(budget, this.maxSemanticCalls)) break;
        let calls;
        try {
          calls = provide.call(service, item.file, item.selectionSpan?.start ?? item.span?.start ?? 0) || [];
        } catch {
          collector.addFallback("typescript_call_hierarchy_failed");
          continue;
        }
        for (const call of calls) {
          const target = incoming ? call.from : call.to;
          if (!target) continue;
          if (!collector.addDocumentSpan(target.file, target.selectionSpan || target.span, {
            kind: incoming ? "caller" : "callee",
            name: target.name || "<anonymous>",
            symbol_kind: target.kind || "function",
            owner: query,
            detail: target.containerName || undefined,
            score: 0.99
          })) break;
        }
      }
      await yieldToEventLoop();
    }
  }

  _scriptVersion(fileName) {
    const lexical = this._confinedLexicalPath(fileName);
    if (!lexical) return "0";
    const source = this._state?.sourceByPath.get(comparePath(lexical));
    if (source) return source.version;
    const canonical = this._canonicalExistingPath(lexical, { file: true });
    if (!canonical) return "0";
    try {
      const info = statSync(canonical);
      return `${Math.trunc(info.mtimeMs)}:${info.size}`;
    } catch {
      return "0";
    }
  }

  _locationFromSpan(fileName, textSpan) {
    if (!fileName || !textSpan || !Number.isFinite(Number(textSpan.start))) return null;
    const canonical = this._canonicalExistingPath(fileName, { file: true });
    if (!canonical) return null;
    const content = this._readConfinedText(canonical);
    if (content === null) return null;
    const key = comparePath(canonical);
    const position = Math.max(0, Math.min(content.length, Math.trunc(Number(textSpan.start))));
    const lineStarts = cachedLineStarts(this._state, key, content);
    const lineIndex = lineIndexForPosition(lineStarts, position);
    const lineStart = lineStarts[lineIndex];
    const lineEnd = content.indexOf("\n", lineStart);
    const rawLine = content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd).replace(/\r$/, "");
    return {
      path: normalizeRelativePath(path.relative(this.rootDir, canonical)),
      line: lineIndex + 1,
      column: position - lineStart + 1,
      snippet: rawLine.trim().slice(0, 1_000)
    };
  }

  _readConfinedText(fileName) {
    const lexical = this._confinedLexicalPath(fileName);
    if (!lexical || !this._state) return null;
    const source = this._state.sourceByPath.get(comparePath(lexical));
    if (source) return source.content;
    const canonical = this._canonicalExistingPath(lexical, { file: true });
    if (!canonical) return null;
    const key = comparePath(canonical);
    if (this._state.externalCache.has(key)) return this._state.externalCache.get(key);
    let info;
    try {
      info = statSync(canonical);
    } catch {
      return null;
    }
    if (!info.isFile() || info.size > this.maxExternalFileBytes) {
      this._state.incompleteReasons.add("typescript_external_file_budget_exceeded");
      return null;
    }
    if (this._state.externalReadBytes + info.size > this.maxExternalBytes) {
      this._state.incompleteReasons.add("typescript_external_read_budget_exceeded");
      return null;
    }
    try {
      const content = readFileSync(canonical, "utf8");
      this._state.externalReadBytes += Buffer.byteLength(content);
      this._state.externalCache.set(key, content);
      return content;
    } catch {
      return null;
    }
  }

  _readConfinedDirectory(directory, extensions, depth) {
    const canonical = this._canonicalExistingPath(directory, { directory: true });
    if (!canonical || !this._state) return [];
    const maxDepth = boundedInteger(depth, 100, 0, 100);
    const requestedExtensions = Array.isArray(extensions) && extensions.length
      ? new Set(extensions.map((extension) => String(extension).toLowerCase()))
      : null;
    return this._state.sourceFiles
      .filter((source) => isWithin(canonical, source.absolute))
      .filter((source) => path.relative(canonical, source.absolute).split(path.sep).length - 1 <= maxDepth)
      .filter((source) => !requestedExtensions || requestedExtensions.has(path.extname(source.absolute).toLowerCase()))
      .map((source) => source.absolute);
  }

  _getConfinedDirectories(directory) {
    const canonical = this._canonicalExistingPath(directory, { directory: true });
    if (!canonical) return [];
    try {
      return readdirSync(canonical, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .slice(0, 1_024)
        .map((entry) => path.join(canonical, entry.name))
        .filter((candidate) => Boolean(this._canonicalExistingPath(candidate, { directory: true })));
    } catch {
      return [];
    }
  }

  _confinedLexicalPath(candidate) {
    if (candidate === null || candidate === undefined || String(candidate).includes("\0")) return null;
    const absolute = path.isAbsolute(String(candidate))
      ? path.resolve(String(candidate))
      : path.resolve(this.rootDir, String(candidate));
    return isWithin(this.rootDir, absolute) ? absolute : null;
  }

  _canonicalExistingPath(candidate, { file = false, directory = false } = {}) {
    const lexical = this._confinedLexicalPath(candidate);
    if (!lexical) return null;
    let canonical;
    try {
      canonical = (realpathSync.native || realpathSync)(lexical);
    } catch {
      return null;
    }
    if (!isWithin(this.rootDir, canonical)) return null;
    if (file || directory) {
      try {
        const info = statSync(canonical);
        if (file && !info.isFile()) return null;
        if (directory && !info.isDirectory()) return null;
      } catch {
        return null;
      }
    }
    return canonical;
  }
}
