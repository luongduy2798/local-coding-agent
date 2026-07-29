// Persistent workspace memory service.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { WorkspaceRegistryError } from "./registry-contract.mjs";
import {
  basePriority,
  compactRecentTask,
  fitBrief,
  isLightMemoryCandidate,
  LIGHT_MAX_BRIEF_BYTES,
  LIGHT_MAX_BRIEF_ITEMS,
  MAX_BRIEF_ITEMS,
  rankLightMemory,
  rankMemory,
  resolveTaskMemoryPolicy,
  skippedTaskMemoryBrief,
  stripScore,
  unavailableMemoryBrief,
  unavailableTaskMemoryBrief
} from "./workspace-memory-retrieval.mjs";

export {
  resolveTaskMemoryPolicy,
  skippedTaskMemoryBrief,
  unavailableTaskMemoryBrief
} from "./workspace-memory-retrieval.mjs";

const MEMORY_KINDS = new Set([
  "project_goal",
  "architecture_decision",
  "constraint",
  "known_issue",
  "open_question",
  "user_preference",
  "verification_result"
]);
const MEMORY_LIFECYCLES = new Set(["active", "resolved", "superseded", "archived"]);
const MEMORY_FRESHNESS = new Set(["current", "needs_review", "stale"]);
const MEMORY_ORIGINS = new Set(["user", "model", "system"]);
const DEFAULT_MAX_BRIEF_BYTES = 4_096;
const MAX_RECENT_TASKS = 3;
const CACHE_ITEM_LIMIT = 48;

export class WorkspaceMemoryService {
  constructor({
    registry,
    taskRouter,
    maxBriefBytes = DEFAULT_MAX_BRIEF_BYTES,
    embeddingService = null,
    semanticDeadlineMs
  } = {}) {
    this.registry = registry;
    this.taskRouter = taskRouter;
    this.maxBriefBytes = Math.max(1_024, Math.min(16_384, Number(maxBriefBytes) || DEFAULT_MAX_BRIEF_BYTES));
    this.embeddingService = embeddingService;
    this.semanticDeadlineMs = Math.max(
      1,
      Math.min(100, Number(semanticDeadlineMs) || embeddingService?.deadlineMs || 10)
    );
    this.contextCache = new Map();
    this.recentTasksCache = new Map();
    this.embeddingJobs = new Map();
    this.embeddingQueue = Promise.resolve();
  }

  status() {
    return {
      available: Boolean(this.registry),
      semantic: this.embeddingService?.status?.() || {
        enabled: false,
        state: "disabled",
        ready: false
      }
    };
  }

  async close() {
    await this.embeddingService?.close?.().catch(() => {});
    await Promise.allSettled([...this.embeddingJobs.values()]);
    this.embeddingJobs.clear();
    this.contextCache.clear();
    this.recentTasksCache.clear();
  }

  async briefForTask(task) {
    const policy = resolveTaskMemoryPolicy(task);
    if (policy.effective_mode === "skip") return skippedTaskMemoryBrief(task);
    if (!this.registry || !task?.workspace_ids?.length) {
      return unavailableMemoryBrief("WORKSPACE_MEMORY_UNAVAILABLE", policy);
    }
    const lightMode = policy.effective_mode === "light";
    try {
      const tokens = lightMode
        ? []
        : tokenize([task.title, task.objective].filter(Boolean).join(" "));
      const candidates = [];
      const workspaceRevisions = [];
      let includeRecentTasks = false;
      let semanticAllowed = false;
      for (const [workspaceIndex, workspaceId] of task.workspace_ids.entries()) {
        const context = await this.#cachedContext(workspaceId, {
          semantic: !lightMode,
          scheduleEmbeddings: !lightMode
        });
        const meta = context.meta;
        workspaceRevisions.push({
          workspace_id: workspaceId,
          revision: meta.revision,
          enabled: meta.enabled
        });
        if (!meta.enabled || !meta.auto_load) continue;
        if (!lightMode) {
          semanticAllowed ||= meta.semantic_search !== false;
          includeRecentTasks ||= policy.recent_tasks_requested &&
            workspaceIndex === 0 && meta.include_recent_tasks;
        }
        for (const item of context.items) {
          const candidate = {
            ...item,
            workspace_id: workspaceId,
            workspace_index: workspaceIndex
          };
          if (lightMode && !isLightMemoryCandidate(candidate, policy.relevant_paths)) continue;
          candidates.push(candidate);
        }
      }
      const semanticVector = !lightMode && semanticAllowed && this.embeddingService?.enabled &&
          candidates.some((candidate) => candidate.semantic_vector instanceof Float32Array)
        ? await this.embeddingService.embedQuery(buildSemanticQuery(task), {
            deadlineMs: this.semanticDeadlineMs
          })
        : null;
      for (const candidate of candidates) {
        candidate.score = lightMode
          ? rankLightMemory(candidate, policy.relevant_paths)
          : rankMemory(candidate, tokens, candidate.workspace_index, semanticVector);
      }
      candidates.sort((left, right) =>
        right.score - left.score ||
        Date.parse(right.updated_at || 0) - Date.parse(left.updated_at || 0)
      );
      const itemLimit = lightMode ? LIGHT_MAX_BRIEF_ITEMS : MAX_BRIEF_ITEMS;
      const recentTasks = includeRecentTasks && this.taskRouter
        ? await this.#recentTasks(task.primary_workspace_id, task.id)
        : [];
      return fitBrief({
        version: 1,
        available: true,
        requested_mode: policy.requested_mode,
        effective_mode: policy.effective_mode,
        skipped: false,
        semantic_used: Boolean(semanticVector),
        recent_tasks_requested: policy.recent_tasks_requested,
        recent_tasks_included: false,
        revision: workspaceRevisions[0]?.revision || 0,
        workspace_revisions: workspaceRevisions,
        items: candidates.slice(0, itemLimit).map(stripScore),
        recent_tasks: recentTasks,
        truncated: candidates.length > itemLimit
      }, lightMode ? LIGHT_MAX_BRIEF_BYTES : this.maxBriefBytes);
    } catch (error) {
      return unavailableMemoryBrief(error?.code || "WORKSPACE_MEMORY_UNAVAILABLE", policy);
    }
  }

  async summary(workspaceId, { allowArchived = false } = {}) {
    return (await this.#database(workspaceId, { allowArchived })).memorySummary();
  }

  async list(workspaceId, options = {}) {
    const { allowArchived = false, ...filters } = options;
    return (await this.#database(workspaceId, { allowArchived })).listMemoryItems(filters);
  }

  async get(workspaceId, memoryId, { allowArchived = false } = {}) {
    const item = await (await this.#database(workspaceId, { allowArchived })).getMemoryItem(memoryId);
    if (!item) {
      throw memoryError(
        "WORKSPACE_MEMORY_NOT_FOUND",
        `Workspace memory item not found: ${memoryId}`
      );
    }
    return item;
  }

  async view(workspaceId, { allowArchived = false } = {}) {
    const database = await this.#database(workspaceId, { allowArchived });
    const [summary, items, embeddingSummary] = await Promise.all([
      database.memorySummary(),
      database.listMemoryItems({ limit: 500 }),
      this.embeddingService?.enabled
        ? database.memoryEmbeddingSummary(this.embeddingService.modelId)
        : Promise.resolve({ indexed: 0, current: 0 })
    ]);
    const ranked = items
      .filter((item) => item.lifecycle === "active")
      .sort((left, right) =>
        basePriority(right) - basePriority(left) ||
        Date.parse(right.updated_at || 0) - Date.parse(left.updated_at || 0)
      );
    const autoLoadPayload = fitBrief({
      version: 1,
      available: summary.enabled && summary.auto_load,
      requested_mode: "auto",
      effective_mode: "full",
      skipped: false,
      semantic_used: false,
      recent_tasks_requested: false,
      recent_tasks_included: false,
      revision: summary.revision,
      workspace_revisions: [{
        workspace_id: workspaceId,
        revision: summary.revision,
        enabled: summary.enabled
      }],
      items: ranked.slice(0, MAX_BRIEF_ITEMS).map(publicMemoryItem),
      recent_tasks: [],
      truncated: ranked.length > MAX_BRIEF_ITEMS
    }, this.maxBriefBytes);
    return {
      workspace_id: workspaceId,
      revision: summary.revision,
      settings: {
        enabled: summary.enabled,
        auto_load: summary.auto_load,
        include_recent_tasks: summary.include_recent_tasks,
        semantic_search: summary.semantic_search
      },
      semantic: {
        ...(this.embeddingService?.status?.() || {
          enabled: false,
          state: "disabled",
          ready: false
        }),
        indexed_items: embeddingSummary.indexed,
        current_items: embeddingSummary.current
      },
      counts: summary.counts,
      brief: autoLoadPayload.brief || "",
      auto_load_payload: autoLoadPayload,
      items
    };
  }

  async save(workspaceId, input, context = {}) {
    const database = await this.#database(workspaceId);
    const normalized = normalizeMemoryInput(input, {
      workspaceId,
      sourceTaskId: context.taskId,
      sourceHead: context.sourceHead,
      actor: context.actor || input?.origin || "model"
    });
    if (context.idempotent) {
      const existing = await database.getMemoryItem(normalized.id);
      if (existing) {
        if (existing.content_hash === normalized.contentHash) return existing;
        throw memoryError(
          "WORKSPACE_MEMORY_ID_CONFLICT",
          `Workspace memory ID already exists with different content: ${normalized.id}`
        );
      }
    }
    if (context.dedupeExact) {
      const duplicate = (await database.listMemoryItems({
        query: normalized.title,
        limit: 100
      })).find((item) => item.content_hash === normalized.contentHash);
      if (duplicate) return duplicate;
    }
    const item = await database.createMemoryItem(normalized);
    if (context.rebuild !== false) await this.rebuildBrief(workspaceId);
    return item;
  }

  async update(workspaceId, memoryId, input, context = {}) {
    const database = await this.#database(workspaceId);
    const existing = await this.get(workspaceId, memoryId);
    const expectedRevision = Number(
      input?.expected_revision ?? input?.expectedRevision ?? existing.revision
    );
    const normalized = normalizeMemoryInput(
      { ...existing, ...input, id: existing.id },
      {
        workspaceId,
        sourceTaskId: context.taskId || input?.source_task_id || existing.source_task_id,
        sourceHead: context.sourceHead || input?.source_head || existing.source_head,
        actor: context.actor || input?.origin || existing.origin,
        beforeHash: existing.content_hash,
        eventOperation: context.operation || "update",
        createdAt: existing.created_at
      }
    );
    if (context.idempotent && memoryItemMatchesNormalized(existing, normalized)) return existing;
    const item = await database.updateMemoryItem(normalized, { expectedRevision });
    if (context.rebuild !== false) await this.rebuildBrief(workspaceId);
    return item;
  }

  async transition(workspaceId, memoryId, action, context = {}) {
    const existing = await this.get(workspaceId, memoryId);
    if (context.idempotent && memoryTransitionAlreadyApplied(existing, action)) return existing;
    const changes = {};
    if (action === "pin") changes.pinned = true;
    else if (action === "unpin") changes.pinned = false;
    else if (action === "resolve") changes.lifecycle = "resolved";
    else if (action === "archive") {
      changes.lifecycle = "archived";
      changes.archived_at = new Date().toISOString();
    } else if (action === "restore") {
      changes.lifecycle = "active";
      changes.archived_at = null;
    } else if (action === "current") changes.freshness = "current";
    else if (action === "stale") changes.freshness = "stale";
    else {
      throw memoryError(
        "WORKSPACE_MEMORY_ACTION_INVALID",
        `Unsupported memory transition: ${action}`
      );
    }
    return this.update(
      workspaceId,
      memoryId,
      { ...changes, expected_revision: existing.revision },
      { ...context, operation: action }
    );
  }

  async supersede(workspaceId, memoryId, replacement, context = {}) {
    const existing = await this.get(workspaceId, memoryId);
    if (context.idempotent && replacement?.id && existing.lifecycle === "superseded") {
      const replayed = await (await this.#database(workspaceId)).getMemoryItem(replacement.id);
      if (replayed?.supersedes_id === existing.id) return replayed;
    }
    if (
      Number.isInteger(Number(context.expectedRevision)) &&
      existing.revision !== Number(context.expectedRevision)
    ) {
      throw memoryError(
        "WORKSPACE_MEMORY_REVISION_CONFLICT",
        `Workspace memory item changed before supersede: ${existing.id}`
      );
    }
    const created = await this.save(
      workspaceId,
      {
        ...replacement,
        kind: replacement?.kind || existing.kind,
        supersedes_id: existing.id
      },
      { ...context, rebuild: false, dedupeExact: false }
    );
    await this.update(
      workspaceId,
      existing.id,
      { lifecycle: "superseded", expected_revision: existing.revision },
      { ...context, rebuild: false, operation: "supersede" }
    );
    if (context.rebuild !== false) await this.rebuildBrief(workspaceId);
    return created;
  }

  async delete(workspaceId, memoryId, context = {}) {
    const database = await this.#database(workspaceId);
    const existing = await this.get(workspaceId, memoryId);
    const deleted = await database.deleteMemoryItem(memoryId, {
      actor: context.actor || "user",
      taskId: context.taskId,
      beforeHash: existing.content_hash
    });
    await this.rebuildBrief(workspaceId);
    return { ok: deleted, id: memoryId };
  }

  async settings(workspaceId, changes) {
    const database = await this.#database(workspaceId);
    const meta = await database.updateMemorySettings({
      enabled: booleanOrUndefined(changes?.enabled),
      autoLoad: booleanOrUndefined(changes?.auto_load ?? changes?.autoLoad),
      includeRecentTasks: booleanOrUndefined(
        changes?.include_recent_tasks ?? changes?.includeRecentTasks
      ),
      semanticSearch: booleanOrUndefined(
        changes?.semantic_search ?? changes?.semanticSearch
      )
    });
    await this.rebuildBrief(workspaceId);
    return meta;
  }

  async rebuildBrief(workspaceId, { scheduleEmbeddings = true } = {}) {
    const database = await this.#database(workspaceId);
    const meta = await database.getMemoryMeta();
    const previous = this.contextCache.get(workspaceId);
    if (!meta.enabled) {
      await database.setMemoryCache({ revision: meta.revision, items: [] });
      const nextMeta = await database.getMemoryMeta();
      this.contextCache.set(workspaceId, { meta: nextMeta, items: [] });
      return nextMeta;
    }
    const items = await database.listMemoryItems({ lifecycle: "active", limit: 100 });
    const persistedCache = items
      .sort((left, right) =>
        basePriority(right) - basePriority(left) ||
        Date.parse(right.updated_at || 0) - Date.parse(left.updated_at || 0)
      )
      .slice(0, CACHE_ITEM_LIMIT)
      .map(cacheMemoryItem);
    await database.setMemoryCache({ revision: meta.revision, items: persistedCache });
    const nextMeta = await database.getMemoryMeta();
    const previousById = new Map((previous?.items || []).map((item) => [item.id, item]));
    const contextItems = persistedCache.map((item) => {
      const old = previousById.get(item.id);
      return old?.content_hash === item.content_hash && old.semantic_vector
        ? { ...item, semantic_vector: old.semantic_vector }
        : item;
    });
    const context = { meta: nextMeta, items: contextItems };
    this.contextCache.set(workspaceId, context);
    if (scheduleEmbeddings && nextMeta.auto_load) {
      this.#scheduleMissingEmbeddings(workspaceId, context);
    }
    return nextMeta;
  }

  async markPathsChanged(operations, { taskId } = {}) {
    const groups = new Map();
    for (const operation of operations || []) {
      const workspaceId = operation.workspace_id;
      if (!workspaceId) continue;
      const changes = groups.get(workspaceId) || [];
      changes.push({
        path: normalizePath(operation.path),
        freshness: ["delete", "rename"].includes(operation.op)
          ? "stale"
          : "needs_review"
      });
      if (operation.op === "rename" && operation.rename_to) {
        changes.push({
          path: normalizePath(operation.rename_to),
          freshness: "needs_review"
        });
      }
      groups.set(workspaceId, changes);
    }
    const results = [];
    for (const [workspaceId, changes] of groups) {
      try {
        const database = await this.#database(workspaceId);
        const result = await database.markMemoryPaths(changes, { taskId });
        if (result.updated) await this.rebuildBrief(workspaceId);
        results.push({ workspace_id: workspaceId, ...result });
      } catch (error) {
        results.push({
          workspace_id: workspaceId,
          updated: 0,
          error_code: error?.code || "WORKSPACE_MEMORY_FRESHNESS_FAILED"
        });
      }
    }
    return results;
  }

  async applyTaskCloseUpdates(task, updates, options = {}) {
    const results = [];
    const touched = new Set();
    for (const update of (updates || []).slice(0, 6)) {
      const workspaceId = update.workspace_id || options.workspaceId || task.primary_workspace_id;
      if (!task.workspace_ids.includes(workspaceId)) {
        results.push({ ok: false, error_code: "WORKSPACE_NOT_ATTACHED", retryable: false });
        continue;
      }
      try {
        const context = {
          taskId: task.id,
          sourceHead: task.workspaces?.find(
            (item) => item.workspace_id === workspaceId
          )?.baseline?.base_head || null,
          actor: "model",
          rebuild: false,
          idempotent: options.idempotent !== false
        };
        const action = update.action || "save";
        let item;
        if (action === "save") {
          item = await this.save(workspaceId, update, { ...context, dedupeExact: true });
        } else if (action === "update") {
          item = await this.update(workspaceId, update.id, update, context);
        } else if (action === "supersede") {
          item = await this.supersede(
            workspaceId,
            update.id,
            update.replacement || update,
            { ...context, expectedRevision: update.expected_revision }
          );
        } else if ([
          "pin", "unpin", "resolve", "archive", "restore", "current", "stale"
        ].includes(action)) {
          item = await this.transition(workspaceId, update.id, action, context);
        } else {
          throw memoryError(
            "WORKSPACE_MEMORY_ACTION_INVALID",
            `Unsupported task_close memory action: ${action}`
          );
        }
        touched.add(workspaceId);
        results.push({ ok: true, action, workspace_id: workspaceId, item });
      } catch (error) {
        const errorCode = error?.code || "WORKSPACE_MEMORY_PERSIST_FAILED";
        results.push({
          ok: false,
          action: update.action || "save",
          workspace_id: workspaceId,
          error_code: errorCode,
          retryable: retryableMemoryPersistenceCode(errorCode)
        });
      }
    }
    for (const workspaceId of touched) {
      try {
        await this.rebuildBrief(workspaceId);
      } catch (error) {
        const errorCode = error?.code || "WORKSPACE_MEMORY_CACHE_REBUILD_FAILED";
        results.push({
          ok: false,
          action: "rebuild",
          workspace_id: workspaceId,
          error_code: errorCode,
          retryable: retryableMemoryPersistenceCode(errorCode)
        });
      }
    }
    return {
      status: results.every((item) => item.ok)
        ? "complete"
        : results.some((item) => item.ok)
          ? "partial"
          : "failed",
      results
    };
  }

  invalidateRecentTasks(workspaceIds = []) {
    for (const workspaceId of workspaceIds) this.recentTasksCache.delete(workspaceId);
  }

  async #cachedContext(workspaceId, { semantic = true, scheduleEmbeddings = true } = {}) {
    let context = this.contextCache.get(workspaceId);
    let database = null;
    if (!context) {
      database = await this.#database(workspaceId);
      const meta = await database.getMemoryMeta();
      const persistedItems = safeArray(meta.cached_brief_json);
      if (
        meta.cached_brief_revision !== meta.revision ||
        persistedItems.some((item) => !item?.content_hash)
      ) {
        await this.rebuildBrief(workspaceId, {
          scheduleEmbeddings: scheduleEmbeddings && meta.enabled && meta.auto_load
        });
        context = this.contextCache.get(workspaceId) || { meta, items: [] };
      } else {
        context = { meta, items: persistedItems };
        this.contextCache.set(workspaceId, context);
      }
    }
    const activeForTaskOpen = context.meta.enabled && context.meta.auto_load;
    if (semantic && activeForTaskOpen && context.meta.semantic_search &&
        this.embeddingService?.enabled && context.items.length) {
      await this.#loadStoredEmbeddings(workspaceId, context, database);
    }
    if (scheduleEmbeddings && activeForTaskOpen) {
      this.#scheduleMissingEmbeddings(workspaceId, context);
    }
    return context;
  }

  async #loadStoredEmbeddings(workspaceId, context, database = null) {
    if (context.semantic_model_id === this.embeddingService.modelId) return;
    const selectedDatabase = database || await this.#database(workspaceId);
    const embeddings = await selectedDatabase.listMemoryEmbeddings({
      modelId: this.embeddingService.modelId,
      memoryIds: context.items.map((item) => item.id)
    });
    const byId = new Map(embeddings.map((item) => [item.memory_id, item]));
    context.items = context.items.map((item) => {
      const embedding = byId.get(item.id);
      return embedding?.content_hash === item.content_hash
        ? { ...item, semantic_vector: embedding.vector }
        : item;
    });
    context.semantic_model_id = this.embeddingService.modelId;
  }

  #scheduleMissingEmbeddings(workspaceId, context) {
    if (!context?.meta?.semantic_search) return;
    for (const item of context.items || []) {
      if (!item.semantic_vector) this.#scheduleEmbedding(workspaceId, item);
    }
  }

  #scheduleEmbedding(workspaceId, item) {
    if (
      !this.embeddingService?.enabled ||
      !item?.id ||
      !item?.content_hash ||
      item.lifecycle !== "active"
    ) return;
    const key = `${workspaceId}:${item.id}:${item.content_hash}:${this.embeddingService.modelId}`;
    if (this.embeddingJobs.has(key)) return;
    const job = this.embeddingQueue.catch(() => {}).then(async () => {
      const vector = await this.embeddingService.embedPassage(buildSemanticPassage(item));
      if (!vector) return;
      const database = await this.#database(workspaceId);
      const stored = await database.upsertMemoryEmbedding({
        memoryId: item.id,
        contentHash: item.content_hash,
        modelId: this.embeddingService.modelId,
        dimensions: vector.length,
        vector
      });
      if (!stored) return;
      const context = this.contextCache.get(workspaceId);
      const selected = context?.items?.find((candidate) =>
        candidate.id === item.id && candidate.content_hash === item.content_hash
      );
      if (selected) selected.semantic_vector = vector;
    }).catch(() => {}).finally(() => {
      this.embeddingJobs.delete(key);
    });
    this.embeddingJobs.set(key, job);
    this.embeddingQueue = job;
  }

  async #recentTasks(workspaceId, excludeTaskId) {
    let cached = this.recentTasksCache.get(workspaceId);
    if (!cached) {
      cached = await this.taskRouter.listRecentTasksForWorkspace({
        workspaceId,
        limit: MAX_RECENT_TASKS + 4
      });
      this.recentTasksCache.set(workspaceId, cached);
    }
    return cached
      .filter((task) => !excludeTaskId || task.task_id !== excludeTaskId)
      .slice(0, MAX_RECENT_TASKS)
      .map(compactRecentTask);
  }

  async #database(workspaceId, { allowArchived = false } = {}) {
    if (!this.registry) {
      throw memoryError(
        "WORKSPACE_MEMORY_UNAVAILABLE",
        "Workspace memory storage is unavailable."
      );
    }
    return this.registry.openWorkspace(workspaceId, {
      allowUnavailable: true,
      allowArchived,
      refreshAvailability: false
    });
  }
}

function normalizeMemoryInput(input = {}, context = {}) {
  const id = input.id || `memory_${randomUUID().replaceAll("-", "")}`;
  if (!/^memory_[A-Za-z0-9_-]{8,160}$/.test(String(id))) {
    throw memoryError("WORKSPACE_MEMORY_ID_INVALID", "Invalid workspace memory ID.");
  }
  const kind = enumValue(input.kind, MEMORY_KINDS, "architecture_decision", "kind");
  const title = compact(input.title, 180);
  const summary = compactMultiline(input.summary, 2_000);
  if (!title || !summary) {
    throw memoryError(
      "WORKSPACE_MEMORY_CONTENT_INVALID",
      "Memory title and summary are required."
    );
  }
  assertWorkspaceMemoryPublicText(`${title}\n${summary}`);
  const lifecycle = enumValue(
    input.lifecycle,
    MEMORY_LIFECYCLES,
    "active",
    "lifecycle"
  );
  const freshness = enumValue(
    input.freshness,
    MEMORY_FRESHNESS,
    "current",
    "freshness"
  );
  const origin = enumValue(input.origin, MEMORY_ORIGINS, "model", "origin");
  const paths = unique(
    (input.paths || input.related_paths || []).map(normalizePath).filter(Boolean)
  ).slice(0, 32);
  const tags = unique(
    (input.tags || []).map((item) => compact(item, 48).toLowerCase()).filter(Boolean)
  ).slice(0, 32);
  const contentHash = hashContent({
    kind,
    title,
    summary,
    lifecycle,
    freshness,
    pinned: Boolean(input.pinned),
    paths,
    tags
  });
  return {
    id: String(id),
    workspaceId: context.workspaceId,
    kind,
    title,
    summary,
    lifecycle,
    freshness,
    pinned: Boolean(input.pinned),
    origin,
    confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 1))),
    sourceTaskId: context.sourceTaskId || input.source_task_id || null,
    sourceHead: context.sourceHead || input.source_head || null,
    supersedesId: input.supersedes_id || null,
    paths,
    tags,
    archivedAt: input.archived_at || (
      lifecycle === "archived" ? new Date().toISOString() : null
    ),
    contentHash,
    beforeHash: context.beforeHash,
    actor: context.actor,
    eventOperation: context.eventOperation,
    createdAt: context.createdAt
  };
}

function cacheMemoryItem(item) {
  return {
    ...publicMemoryItem(item),
    content_hash: item.content_hash
  };
}

function publicMemoryItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    lifecycle: item.lifecycle,
    freshness: item.freshness,
    pinned: item.pinned,
    origin: item.origin,
    confidence: item.confidence,
    source_task_id: item.source_task_id,
    source_head: item.source_head,
    supersedes_id: item.supersedes_id,
    revision: item.revision,
    paths: item.paths,
    tags: item.tags,
    updated_at: item.updated_at
  };
}

function safeArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function assertWorkspaceMemoryPublicText(value) {
  const text = String(value || "");
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(?:sk|rk|pk)_[A-Za-z0-9_-]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
    /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s]{12,}/i,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
  ];
  if (patterns.some((pattern) => pattern.test(text))) {
    throw memoryError(
      "WORKSPACE_MEMORY_SENSITIVE_CONTENT",
      "Sensitive credentials must not be stored in workspace memory."
    );
  }
}

function memoryItemMatchesNormalized(item, normalized) {
  return item.content_hash === normalized.contentHash &&
    item.origin === normalized.origin &&
    Number(item.confidence) === Number(normalized.confidence) &&
    (item.source_task_id || null) === (normalized.sourceTaskId || null) &&
    (item.source_head || null) === (normalized.sourceHead || null) &&
    (item.supersedes_id || null) === (normalized.supersedesId || null) &&
    (item.archived_at || null) === (normalized.archivedAt || null);
}

function memoryTransitionAlreadyApplied(item, action) {
  if (action === "pin") return item.pinned === true;
  if (action === "unpin") return item.pinned === false;
  if (action === "resolve") return item.lifecycle === "resolved";
  if (action === "archive") return item.lifecycle === "archived";
  if (action === "restore") return item.lifecycle === "active";
  if (action === "current") return item.freshness === "current";
  if (action === "stale") return item.freshness === "stale";
  return false;
}

function retryableMemoryPersistenceCode(code) {
  return /^(?:SQLITE_BUSY|SQLITE_LOCKED|SQLITE_DATABASE_CLOSED|WORKSPACE_UNAVAILABLE|WORKSPACE_MEMORY_UNAVAILABLE|WORKSPACE_MEMORY_CACHE_REBUILD_FAILED|STORAGE_WORKER_|SQLITE_IOERR)/.test(String(code || ""));
}

function enumValue(value, allowed, fallback, field) {
  const normalized = value === undefined || value === null || value === ""
    ? fallback
    : String(value);
  if (!allowed.has(normalized)) {
    throw memoryError(
      "WORKSPACE_MEMORY_CONTENT_INVALID",
      `Invalid memory ${field}: ${normalized}`
    );
  }
  return normalized;
}

function compact(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function compactMultiline(value, max) {
  return String(value || "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

function normalizePath(value) {
  const raw = String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (!raw) return "";
  if (
    raw.startsWith("/") ||
    /^[A-Za-z]:\//.test(raw) ||
    raw.split("/").includes("..")
  ) {
    throw memoryError(
      "WORKSPACE_MEMORY_PATH_INVALID",
      `Memory path must be workspace-relative: ${value}`
    );
  }
  return raw;
}

function tokenize(value) {
  return unique(
    String(value || "").toLowerCase().match(/[a-z0-9_./-]{3,}/g) || []
  ).slice(0, 32);
}

function unique(values) {
  return [...new Set(values)];
}

function buildSemanticQuery(task) {
  return compactMultiline([
    `query: ${task?.title || ""}`,
    task?.objective ? `objective: ${task.objective}` : ""
  ].filter(Boolean).join("\n"), 2_000);
}

function buildSemanticPassage(item) {
  return compactMultiline([
    `passage: ${item.kind || "memory"}`,
    `title: ${item.title || ""}`,
    `summary: ${item.summary || ""}`,
    item.lifecycle ? `lifecycle: ${item.lifecycle}` : "",
    item.freshness ? `freshness: ${item.freshness}` : "",
    item.paths?.length ? `paths: ${item.paths.join(", ")}` : "",
    item.tags?.length ? `tags: ${item.tags.join(", ")}` : ""
  ].filter(Boolean).join("\n"), 3_000);
}

function hashContent(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function booleanOrUndefined(value) {
  return typeof value === "boolean" ? value : undefined;
}

function memoryError(code, message, details = {}) {
  return new WorkspaceRegistryError(code, message, details);
}
