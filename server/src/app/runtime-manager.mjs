// Local Coding Agent runtime composition for workspace-scoped services.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";
import { createChangeJournal } from "../change-journal.mjs";
import { CodeQueryEngine } from "../coding/query-engine.mjs";
import {
  discoverBuiltinStructuralSemanticAdapter,
  STRUCTURAL_AST_LANGUAGES
} from "../coding/semantic/structural-adapter.mjs";
import { discoverTypeScriptSemanticAdapter } from "../coding/semantic/typescript-adapter.mjs";
import { PatchTransactionCoordinator } from "../mutation/patch-transaction.mjs";
import { boundedNumber } from "../shared/utils.mjs";
import { VerificationPlanner } from "../verification/planner.mjs";
import { WorkspaceGraph } from "../workspace/graph/workspace-graph.mjs";
import { prewarmWorkspaceGraphInChild } from "../workspace/graph/prewarm.mjs";
import { recoverWorkspacePurges } from "../workspace/purge.mjs";
import { WorkspaceRegistry, WorkspaceRegistryError } from "../workspace/registry.mjs";
import { TaskRouter, TaskRouterError } from "../workspace/task-router.mjs";
import { publicTaskOrchestration } from "../workspace/task-orchestration.mjs";

export function createRuntimeManager({
  canonicalize,
  initialPrimaryWorkspaceId,
  isWithinRoots,
  primaryRoot,
  runtimeDataDir,
  hotWorkspaceLimit,
  idleUnloadMs,
  testRuntimeDiagnostics,
  toWorkspaceRel
}) {
  const runtimes = new Map();
  const runtimeInits = new Map();
  const runtimeEvictions = new Map();
  const journals = new Map();
  const changeListeners = new Set();
  let registry = null;
  let taskRouter = null;
  let patchCoordinator = null;
  let primaryWorkspaceId = initialPrimaryWorkspaceId;
  let storageError = null;

  async function initialize() {
    try {
      registry = await WorkspaceRegistry.open({
        dataDir: runtimeDataDir,
        busyTimeoutMs: 5_000,
        maxOpenWorkspaces: hotWorkspaceLimit
      });
      await recoverWorkspacePurges({ dataDir: runtimeDataDir, registry });
      const registered = await registry.registerWorkspace(primaryRoot, {
        metadata: { label: path.basename(primaryRoot), trusted: true, source: "startup" }
      });
      primaryWorkspaceId = registered.workspace.id;
      const existingSelection = await registry.getSelectedWorkspace({
        scope: "default",
        fallback: false
      }).catch(() => null);
      if (!existingSelection) {
        await registry.selectWorkspace(primaryWorkspaceId, { scope: "default", fallback: false });
      }
      taskRouter = await TaskRouter.open({ dataDir: runtimeDataDir, busyTimeoutMs: 5_000 });
      await taskRouter.resetSessionBindings();
      patchCoordinator = new PatchTransactionCoordinator({
        dataDir: path.join(runtimeDataDir, "patch-coordinator"),
        stateStore: {
          upsert: (record) => registry.upsertTransactionState(record),
          listIncomplete: () => registry.listTransactionStates({ incompleteOnly: true })
        },
        authorizeWorkspace: async ({ workspaceId, taskId, taskToken, sessionId }) => {
          const authorizedTask = await taskRouter.assertWorkspaceAccess({ taskToken, sessionId, workspaceId });
          if (taskId && authorizedTask.id !== taskId) {
            throw new TaskRouterError(
              "TASK_CONTEXT_MISMATCH",
              `Patch task ${taskId} does not match authorized task ${authorizedTask.id}.`
            );
          }
        },
        resolveWorkspace: async (workspaceId) => {
          const workspace = await registry.getWorkspace(workspaceId);
          if (workspace.availability !== "available") return null;
          return { id: workspace.id, root: workspace.canonicalRoot };
        }
      });
      await patchCoordinator.init();
    } catch (error) {
      storageError = {
        code: error?.code || "RUNTIME_STORAGE_UNAVAILABLE",
        message: error?.message || String(error)
      };
      await taskRouter?.close().catch(() => {});
      await registry?.close().catch(() => {});
      taskRouter = null;
      registry = null;
      patchCoordinator = null;
      console.error(`Runtime storage unavailable; task-scoped mutation is disabled: ${storageError.message}`);
    }
  }

  async function getWorkspaceRuntime(workspaceId = primaryWorkspaceId) {
    const id = String(workspaceId || primaryWorkspaceId);
    const eviction = runtimeEvictions.get(id);
    if (eviction) await eviction;
    const pending = runtimeInits.get(id);
    if (pending) return pending;
    const initialization = getWorkspaceRuntimeNow(id);
    runtimeInits.set(id, initialization);
    try {
      return await initialization;
    } finally {
      if (runtimeInits.get(id) === initialization) runtimeInits.delete(id);
    }
  }

  async function getWorkspaceRuntimeNow(workspaceId = primaryWorkspaceId) {
    const id = String(workspaceId || primaryWorkspaceId);
    const now = Date.now();
    for (const [candidateId, candidate] of runtimes) {
      if (now - Number(candidate.lastUsedMs || now) >= idleUnloadMs) {
        await evictWorkspaceRuntime(candidateId);
      }
    }
    let runtime = runtimes.get(id);
    if (runtime) {
      if (registry) {
        const current = await registry.getWorkspace(id);
        if (current.availability !== "available") {
          await evictWorkspaceRuntime(id);
          throw new WorkspaceRegistryError("WORKSPACE_UNAVAILABLE", `Workspace is unavailable: ${id}`);
        }
        runtime.workspace = current;
      }
      const registryEviction = runtimeEvictions.get(id);
      if (registryEviction || runtimes.get(id) !== runtime) {
        await registryEviction;
        return getWorkspaceRuntimeNow(id);
      }
      runtimes.delete(id);
      runtime.lastUsedMs = now;
      runtimes.set(id, runtime);
      await runtime.prewarmPromise?.catch(() => {});
      const prewarmEviction = runtimeEvictions.get(id);
      if (prewarmEviction || runtimes.get(id) !== runtime) {
        await prewarmEviction;
        return getWorkspaceRuntimeNow(id);
      }
      return runtime;
    }
    let workspace;
    if (registry) {
      workspace = await registry.getWorkspace(id);
      if (workspace.availability !== "available") {
        throw new WorkspaceRegistryError("WORKSPACE_UNAVAILABLE", `Workspace is unavailable: ${id}`);
      }
    } else if (id === primaryWorkspaceId) {
      workspace = { id, canonicalRoot: primaryRoot, availability: "available", metadata: { trusted: true } };
    } else {
      throw new WorkspaceRegistryError(
        "WORKSPACE_UNAVAILABLE",
        `Runtime storage is unavailable: ${storageError?.message || "unknown error"}`
      );
    }
    runtime = await createWorkspaceRuntime(workspace, now);
    runtimes.set(id, runtime);
    await runtime.prewarmPromise?.catch(() => {});
    const initializationEviction = runtimeEvictions.get(id);
    if (initializationEviction || runtimes.get(id) !== runtime) {
      await initializationEviction;
      return getWorkspaceRuntimeNow(id);
    }
    while (runtimes.size > hotWorkspaceLimit) {
      const oldest = runtimes.keys().next().value;
      if (oldest === id) break;
      await evictWorkspaceRuntime(oldest);
    }
    return runtime;
  }

  async function createWorkspaceRuntime(workspace, lastUsedMs) {
    const graph = new WorkspaceGraph({
      rootDir: workspace.canonicalRoot,
      workspaceId: workspace.id,
      maxFiles: boundedNumber(process.env.AGENT_GRAPH_MAX_FILES, 25_000, 100, 250_000),
      maxDepth: boundedNumber(process.env.AGENT_GRAPH_MAX_DEPTH, 24, 1, 64),
      maxFileBytes: boundedNumber(process.env.AGENT_GRAPH_MAX_FILE_BYTES, 512 * 1024, 8_192, 4 * 1024 * 1024),
      watch: process.env.AGENT_GRAPH_WATCH !== "0",
      watchDebounceMs: boundedNumber(process.env.AGENT_GRAPH_WATCH_DEBOUNCE_MS, 120, 0, 5_000),
      watchReconcileIntervalMs: boundedNumber(process.env.AGENT_GRAPH_RECONCILE_INTERVAL_MS, 30_000, 0, 3_600_000),
      persistencePath: path.join(runtimeDataDir, "workspaces", workspace.id, "index", "workspace-graph.v1.json.br")
    });
    const runtime = { workspace, lastUsedMs, graph, semanticAdapters: {} };
    try {
      const structuralAdapter = await discoverBuiltinStructuralSemanticAdapter({
        rootDir: workspace.canonicalRoot,
        dataDir: runtimeDataDir
      });
      for (const language of STRUCTURAL_AST_LANGUAGES) runtime.semanticAdapters[language] = structuralAdapter;
    } catch (error) {
      runtime.structuralSemanticAdapterError = { code: error?.code || "STRUCTURAL_ADAPTER_UNAVAILABLE" };
    }
    try {
      const typescriptAdapter = await discoverTypeScriptSemanticAdapter({ rootDir: workspace.canonicalRoot });
      if (typescriptAdapter) {
        runtime.semanticAdapters.javascript = typescriptAdapter;
        runtime.semanticAdapters.typescript = typescriptAdapter;
      }
    } catch (error) {
      runtime.semanticAdapterError = { code: error?.code || "TYPESCRIPT_ADAPTER_UNAVAILABLE" };
    }
    runtime.query = new CodeQueryEngine({ graph, semanticAdapters: runtime.semanticAdapters });
    runtime.verification = new VerificationPlanner({
      rootDir: workspace.canonicalRoot,
      workspaceId: workspace.id,
      graph
    });
    if (process.env.AGENT_GRAPH_PREWARM !== "0") startPrewarm(runtime);
    return runtime;
  }

  function startPrewarm(runtime) {
    runtime.prewarming = true;
    runtime.prewarmAbortController = new AbortController();
    runtime.prewarmPromise = prewarmWorkspaceGraphInChild(runtime.graph, {
      persistenceRoot: runtimeDataDir,
      timeoutMs: boundedNumber(process.env.AGENT_GRAPH_BUILDER_TIMEOUT_MS, 120_000, 1_000, 600_000),
      fallbackToMain: true,
      signal: runtime.prewarmAbortController.signal
    }).then((result) => {
      runtime.prewarmFallback = result.external_builder?.fallback === true;
      return result;
    }).catch((error) => {
      runtime.prewarmError = { code: error?.code || "INDEX_PREWARM_FAILED", message: error?.message || String(error) };
      return null;
    }).finally(() => {
      runtime.prewarming = false;
      runtime.prewarmAbortController = null;
    });
  }

  async function evictWorkspaceRuntime(workspaceId) {
    const id = String(workspaceId || "");
    const pending = runtimeEvictions.get(id);
    if (pending) return pending;
    const runtime = runtimes.get(id);
    if (!runtime) return false;
    const eviction = (async () => {
      if (runtimes.get(id) === runtime) runtimes.delete(id);
      runtime.prewarmAbortController?.abort();
      await runtime.prewarmPromise?.catch(() => {});
      await Promise.allSettled([...new Set(Object.values(runtime.semanticAdapters || {}))].map((adapter) => adapter?.close?.()));
      await runtime.graph?.close?.().catch(() => {});
      if (runtimes.get(id) === runtime) runtimes.delete(id);
      return true;
    })();
    runtimeEvictions.set(id, eviction);
    try {
      return await eviction;
    } finally {
      if (runtimeEvictions.get(id) === eviction) runtimeEvictions.delete(id);
    }
  }

  async function closeWorkspaceRuntimes() {
    await Promise.allSettled([...runtimeInits.values()]);
    await Promise.allSettled([...runtimeEvictions.values()]);
    await Promise.all([...runtimes.keys()].map(evictWorkspaceRuntime));
    await Promise.allSettled([...runtimeEvictions.values()]);
  }

  function modelSafeGraphSnapshot(graph) {
    return sanitizeGraphSnapshot(graph.snapshot());
  }

  function modelSafeSemanticAdapterStatus(runtime) {
    const grouped = new Map();
    for (const [language, adapter] of Object.entries(runtime.semanticAdapters || {})) {
      if (!adapter) continue;
      const entry = grouped.get(adapter) || { adapter, languages: [] };
      entry.languages.push(language);
      grouped.set(adapter, entry);
    }
    const adapters = [...grouped.values()].map(({ adapter, languages }) => ({
      engine: String(adapter.engine || adapter.kind || "semantic"),
      languages: [...new Set(languages)].sort(),
      version: adapter.packageVersion || null,
      discovery: adapter.discovery || "runtime",
      warm: adapter.warm === true,
      hard_preemptible: adapter.hardPreemptible === true,
      artifact: adapter.artifact ? {
        id: adapter.artifact.id,
        version: adapter.artifact.version,
        sha256: adapter.artifact.sha256,
        origin: adapter.artifact.origin
      } : null
    }));
    return {
      available: adapters.length > 0,
      adapters,
      discovery_error: runtime.semanticAdapterError || runtime.structuralSemanticAdapterError || null,
      typescript_search_scope: "<workspace>/node_modules/typescript",
      installs_packages: false,
      unavailable_reason: adapters.length || runtime.semanticAdapterError || runtime.structuralSemanticAdapterError
        ? null
        : "semantic_adapters_unavailable"
    };
  }

  function modelSafePersistenceStatus(graph) {
    const persistence = { ...graph.persistenceStatus() };
    if (persistence.error && !testRuntimeDiagnostics) {
      persistence.error = { code: persistence.error.code || "INDEX_PERSISTENCE_FAILED" };
    }
    return persistence;
  }

  function sanitizeGraphSnapshot(snapshot) {
    const safe = { ...snapshot };
    if (safe.persistence?.error && !testRuntimeDiagnostics) {
      safe.persistence = { ...safe.persistence, error: { code: safe.persistence.error.code || "INDEX_PERSISTENCE_FAILED" } };
    }
    return safe;
  }

  function modelSafeWatcherStatus(graph) {
    const watcher = graph.watcherStatus();
    if (watcher.error && !testRuntimeDiagnostics) {
      watcher.error = { code: watcher.error.code || "INDEX_WATCHER_FAILED" };
    }
    return watcher;
  }

  async function getChangeJournal(workspaceId, { allowArchived = false } = {}) {
    let workspace;
    if (registry && allowArchived) {
      workspace = await registry.getWorkspace(workspaceId, {
        refreshAvailability: false,
        allowArchived: true
      });
    } else {
      workspace = (await getWorkspaceRuntime(workspaceId)).workspace;
    }
    if (journals.has(workspaceId)) return journals.get(workspaceId);
    const root = workspace.canonicalRoot;
    const journal = createChangeJournal({
      root,
      workspaceId,
      dataDir: path.join(runtimeDataDir, "workspaces", workspaceId, "changes"),
      validatePath(input = ".") {
        const raw = String(input ?? ".").trim();
        const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
        const canonical = canonicalize(resolved);
        if (!isWithinRoots(canonical, [root])) throw new Error(`Path is outside workspace ${workspaceId}: ${input}`);
        return resolved;
      },
      toRelativePath: (absolute) => toWorkspaceRel(workspace, absolute),
      maxSnapshotBytes: boundedNumber(process.env.AGENT_MAX_SNAPSHOT_BYTES, 5 * 1024 * 1024, 1, 100 * 1024 * 1024),
      snapshotConcurrency: boundedNumber(process.env.AGENT_JOURNAL_SNAPSHOT_CONCURRENCY, 4, 1, 16),
      deferLineStats: process.env.AGENT_DEFER_LINE_STATS !== "0",
      deferLineStatsBytes: boundedNumber(process.env.AGENT_DEFER_LINE_STATS_BYTES, 512_000, 32_000, 100 * 1024 * 1024)
    });
    await journal.init();
    journal.onDidChange((event) => emitChange(event));
    journals.set(workspaceId, journal);
    return journal;
  }

  async function captureTaskWorkspaceBaseline(workspaceId) {
    const runtime = await getWorkspaceRuntime(workspaceId);
    const changes = await runtime.verification.inspectChanges();
    const known = changes.is_git_repo === true && changes.dirty_unknown !== true &&
      typeof changes.head === "string" && /^[a-f0-9]{40,64}$/i.test(changes.head);
    return {
      workspace_id: workspaceId,
      known,
      base_head: known ? changes.head : null,
      branch: known ? changes.branch || null : null,
      clean: known && typeof changes.clean === "boolean" ? changes.clean : null,
      dirty_unknown: known ? changes.dirty_unknown === true : true,
      dirty: known ? {
        summary: changes.summary || null,
        files: (changes.files || []).slice(0, 1_000).map((entry) => ({
          path: entry.location?.path || null,
          original_path: entry.original_location?.path || null,
          index_status: entry.index_status || null,
          worktree_status: entry.worktree_status || null,
          staged: entry.staged === true,
          unstaged: entry.unstaged === true,
          untracked: entry.untracked === true
        })),
        truncated: (changes.files || []).length > 1_000
      } : null,
      captured_at: new Date().toISOString()
    };
  }

  function taskWorkspaceBaseline(task, workspaceId) {
    return task?.workspaces?.find((entry) => entry.workspace_id === workspaceId)?.baseline || { known: false };
  }

  async function taskOpenPayload(task) {
    const workspaceState = (task.workspaces || []).map((workspace) => {
      const baseline = workspace.baseline || { known: false };
      return {
        workspace_id: workspace.workspace_id,
        baseline_known: baseline.known === true,
        base_head: baseline.known === true ? baseline.base_head : null,
        branch: baseline.known === true ? baseline.branch : null,
        clean: baseline.known === true ? baseline.clean : null,
        dirty_unknown: baseline.known === true ? baseline.dirty_unknown : true,
        dirty: baseline.known === true ? baseline.dirty : null,
        captured_at: baseline.captured_at || null
      };
    });
    return {
      ...task,
      orchestration: publicTaskOrchestration(task.orchestration, task.effective_profile),
      workspace_set_version: task.version,
      workspace_state: workspaceState
    };
  }

  async function close() {
    await closeWorkspaceRuntimes();
    await Promise.allSettled([...journals.values()].map((journal) => journal.close?.()));
    changeListeners.clear();
    await taskRouter?.close().catch(() => {});
    await registry?.close().catch(() => {});
  }

  function onDidChange(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Runtime change listener must be a function.");
    }
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  }

  function emitChange(event) {
    for (const listener of changeListeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  function state() {
    return {
      registry,
      taskRouter,
      patchCoordinator,
      primaryWorkspaceId,
      storageError,
      runtimes,
      runtimeInits,
      runtimeEvictions,
      journals
    };
  }

  return {
    captureTaskWorkspaceBaseline,
    close,
    closeWorkspaceRuntimes,
    evictWorkspaceRuntime,
    getChangeJournal,
    getWorkspaceRuntime,
    initialize,
    modelSafeGraphSnapshot,
    modelSafePersistenceStatus,
    modelSafeSemanticAdapterStatus,
    modelSafeWatcherStatus,
    onDidChange,
    sanitizeGraphSnapshot,
    state,
    taskOpenPayload,
    taskWorkspaceBaseline,
    get registry() { return registry; },
    get taskRouter() { return taskRouter; },
    get patchCoordinator() { return patchCoordinator; },
    get primaryWorkspaceId() { return primaryWorkspaceId; },
    get storageError() { return storageError; },
    runtimes,
    runtimeInits,
    runtimeEvictions,
    journals
  };
}
