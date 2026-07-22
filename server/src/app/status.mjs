// Local Coding Agent runtime status service
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import os from "node:os";
import path from "node:path";

const CONTROL_CACHE_TTL_MS = 1_000;

export function createStatusService({
  auditStatus,
  eventLoopDelay,
  finiteMetric,
  getSessionSummary,
  getState,
  modelSafePersistenceStatus,
  modelSafeWatcherStatus,
  processes,
  searchProcessPool,
  settings,
  toolMetrics
}) {
  const controlCache = { value: null, expiresAt: 0, loading: null };

  function invalidateStatusControlCache() {
    controlCache.value = null;
    controlCache.expiresAt = 0;
  }

  async function statusControlPlane() {
    const { registry } = getState();
    if (!registry) return { storageHealth: null, workspaces: null };
    const now = Date.now();
    if (controlCache.value && now < controlCache.expiresAt) return controlCache.value;
    if (controlCache.loading) return controlCache.loading;
    controlCache.loading = Promise.all([
      registry.health().catch((error) => ({ error: error?.code || "STORAGE_HEALTH_FAILED" })),
      registry.listWorkspaces()
    ]).then(([storageHealth, workspaces]) => {
      const value = { storageHealth, workspaces };
      controlCache.value = value;
      controlCache.expiresAt = Date.now() + CONTROL_CACHE_TTL_MS;
      return value;
    }).finally(() => {
      controlCache.loading = null;
    });
    return controlCache.loading;
  }

  async function workspaceInfoPayload() {
    const memory = process.memoryUsage();
    const state = getState();
    const controlPlane = await statusControlPlane();
    const indexMetrics = [...state.runtimes.values()].map((runtime) => ({
      workspace_id: runtime.workspace.id,
      generation: runtime.graph.generation,
      indexed_files: runtime.graph.records.size,
      coverage: runtime.graph.coverage ? { ...runtime.graph.coverage } : null,
      freshness: runtime.graph.freshness(),
      persistence: modelSafePersistenceStatus(runtime.graph),
      prewarming: runtime.prewarming === true,
      prewarm_fallback: runtime.prewarmFallback === true,
      prewarm_error: runtime.prewarmError
        ? (settings.testRuntimeDiagnostics ? runtime.prewarmError : { code: runtime.prewarmError.code })
        : null,
      watcher: modelSafeWatcherStatus(runtime.graph)
    }));
    const workspaceDescriptors = state.registry
      ? controlPlane.workspaces.map((workspace) => ({
          workspace_id: workspace.id,
          label: workspace.metadata?.label || path.basename(workspace.canonicalRoot),
          root: { workspace_id: workspace.id, path: "." },
          availability: workspace.availability,
          trusted: workspace.metadata?.trusted === true
        }))
      : [{
          workspace_id: state.primaryWorkspaceId,
          label: path.basename(settings.primaryRoot),
          root: { workspace_id: state.primaryWorkspaceId, path: "." },
          availability: "available",
          trusted: true
        }];
    const storageError = state.storageError
      ? (settings.testRuntimeDiagnostics ? state.storageError : { code: state.storageError.code })
      : null;
    return {
      status: "ok",
      version: settings.version,
      tier: settings.productTier,
      mode: settings.mode,
      policy: settings.policy,
      tool_catalog: "fixed",
      catalog_version: settings.catalogVersion,
      catalog_hash: settings.catalogHash,
      allow_dangerous: settings.allowDangerous,
      auth: settings.authToken ? "bearer" : "none",
      roots: settings.testRuntimeDiagnostics
        ? settings.roots
        : workspaceDescriptors.map((workspace) => workspace.root),
      primary_root: settings.testRuntimeDiagnostics
        ? settings.primaryRoot
        : { workspace_id: state.primaryWorkspaceId, path: "." },
      primary_workspace: { workspace_id: state.primaryWorkspaceId, path: "." },
      primary_workspace_id: state.primaryWorkspaceId,
      workspaces: workspaceDescriptors,
      multi_workspace: {
        available: Boolean(state.registry && state.taskRouter && state.patchCoordinator),
        registered_runtime_count: state.runtimes.size,
        initializing_runtime_count: state.runtimeInits.size,
        evicting_runtime_count: state.runtimeEvictions.size,
        transaction: state.patchCoordinator?.status?.() || null,
        storage_error: storageError
      },
      host: settings.testRuntimeDiagnostics
        ? { platform: os.platform(), release: os.release(), hostname: os.hostname(), cwd: process.cwd(), node: process.version }
        : { platform: os.platform(), node: process.version },
      limits: { ...settings.limits },
      running_processes: [...processes.values()].filter((entry) => entry.status === "running").length,
      runtime: {
        sessions: getSessionSummary(),
        tools: { ...toolMetrics },
        search_processes: searchProcessPool.status(),
        storage: controlPlane.storageHealth,
        indexes: indexMetrics,
        audit: auditStatus(),
        memory: {
          rss: memory.rss,
          heap_used: memory.heapUsed,
          heap_total: memory.heapTotal,
          external: memory.external
        },
        event_loop_delay_ms: {
          mean: finiteMetric(eventLoopDelay.mean / 1e6),
          p50: finiteMetric(eventLoopDelay.percentile(50) / 1e6),
          p99: finiteMetric(eventLoopDelay.percentile(99) / 1e6),
          max: finiteMetric(eventLoopDelay.max / 1e6)
        }
      },
      safety: settings.mode === "full"
        ? [
            "File tools are root-confined; command cwd is root-confined but command execution is not an OS sandbox.",
            "Catastrophic system commands stay blocked unless AGENT_ALLOW_DANGEROUS=1.",
            "Paths outside the roots are rejected by file tools."
          ]
        : [
            "File tools are root-confined; command cwd is root-confined but command execution is not an OS sandbox.",
            "Destructive commands and absolute Windows paths in commands are blocked.",
            "Switch to AGENT_MODE=full only for trusted automation."
          ]
    };
  }

  return { invalidateStatusControlCache, workspaceInfoPayload };
}
