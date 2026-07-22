// Local Coding Agent change-journal HTTP routes.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import path from "node:path";
import { ChangeJournalError } from "../change-journal.mjs";
import { TaskRouterError } from "../workspace/task-router.mjs";

export function createChangeRoutes({
  getChangeJournal,
  getPrimaryWorkspaceId,
  getRegistry,
  getTaskRouter,
  maxBodyBytes,
  primaryRoot,
  readJsonBody,
  sendJson,
  testRuntimeDiagnostics
}) {
  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/changes/events") {
      const workspaceId = url.searchParams.get("workspace_id") || getPrimaryWorkspaceId();
      const taskId = url.searchParams.get("task_id") || null;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      let previousRevision = String(req.headers["last-event-id"] || "") ||
        String(url.searchParams.get("since_revision") || "");
      let running = false;
      const emit = async () => {
        if (running || res.destroyed) return;
        running = true;
        try {
          const snapshot = workspaceId === "all"
            ? await listAllWorkspaceChanges({ limit: 200, offset: 0, taskId })
            : await listOneWorkspaceChanges(workspaceId, { limit: 200, offset: 0, taskId });
          const revision = snapshot.revision;
          if (revision !== previousRevision) {
            previousRevision = revision;
            res.write(`id: ${revision}\nevent: revision\ndata: ${JSON.stringify({
              workspace_id: workspaceId,
              task_id: taskId,
              revision,
              ...(workspaceId === "all" ? {
                workspace_revisions: snapshot.workspaces.map((item) => ({
                  workspace_id: item.workspace_id,
                  revision: item.revision
                }))
              } : {})
            })}\n\n`);
          } else {
            res.write(": keepalive\n\n");
          }
        } finally {
          running = false;
        }
      };
      const timer = setInterval(() => emit().catch(() => {}), 1_000);
      timer.unref?.();
      req.once("close", () => clearInterval(timer));
      await emit();
      return;
    }
    if (req.method === "GET" && url.pathname === "/changes") {
      return listChanges(req, res, url);
    }
    return mutateOrReadChange(req, res, url);
  }

  async function listChanges(req, res, url) {
    const requestedWorkspace = url.searchParams.get("workspace_id");
    const taskId = url.searchParams.get("task_id") || null;
    const registry = getRegistry();
    if (requestedWorkspace === "all" && registry) {
      const aggregate = await listAllWorkspaceChanges({
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        taskId
      });
      const { revision, workspaces: results } = aggregate;
      if (notModified(req, url, revision)) return sendNotModified(res, revision);
      res.setHeader("etag", `"${revision}"`);
      return sendJson(res, 200, { revision, workspaces: results });
    }
    const workspaceId = requestedWorkspace || getPrimaryWorkspaceId();
    const registryWorkspace = registry
      ? await registry.getWorkspace(workspaceId, { allowArchived: true })
      : { canonicalRoot: primaryRoot, registrationState: "active" };
    const changes = await (await getChangeJournal(workspaceId, { allowArchived: true })).listChanges({
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
      taskId
    });
    const revision = changeListRevision(changes);
    if (notModified(req, url, revision)) return sendNotModified(res, revision);
    res.setHeader("etag", `"${revision}"`);
    return sendJson(res, 200, {
      workspace_id: workspaceId,
      canonical_root: registryWorkspace.canonicalRoot,
      registration_state: registryWorkspace.registrationState || "active",
      task_id: taskId,
      revision,
      ...changes
    });
  }

  async function mutateOrReadChange(req, res, url) {
    const workspaceId = url.searchParams.get("workspace_id") || getPrimaryWorkspaceId();
    const queryTaskId = url.searchParams.get("task_id") || null;
    const readOnlyRequest = req.method === "GET";
    if (!readOnlyRequest) await assertWorkspaceMutationActive(workspaceId);
    const journal = await getChangeJournal(workspaceId, { allowArchived: readOnlyRequest });
    if (req.method === "POST" && url.pathname === "/changes/undo-all") {
      if (!queryTaskId && !testRuntimeDiagnostics) return sendJson(res, 400, { error: "task_id_required" });
      await assertHistoryMutationAllowed({ taskId: queryTaskId, workspaceId });
      return sendJson(res, 200, { workspace_id: workspaceId, ...(await journal.undoAll({ taskId: queryTaskId })) });
    }
    if (req.method === "DELETE" && url.pathname === "/changes") {
      if (!queryTaskId && !testRuntimeDiagnostics) return sendJson(res, 400, { error: "task_id_required" });
      await assertHistoryMutationAllowed({ taskId: queryTaskId, workspaceId });
      return sendJson(res, 200, { workspace_id: workspaceId, ...(await journal.clear({ taskId: queryTaskId })) });
    }
    const match = url.pathname.match(/^\/changes\/([^/]+)(?:\/(diff|content|undo|reapply))?$/);
    if (!match) return sendJson(res, 404, { error: "not_found" });
    const id = decodeURIComponent(match[1]);
    const action = match[2] || null;
    if (req.method === "GET" && !action) {
      return sendJson(res, 200, { workspace_id: workspaceId, change: await journal.getChange(id, { taskId: queryTaskId }) });
    }
    if (req.method === "GET" && action === "diff") {
      return sendJson(res, 200, {
        workspace_id: workspaceId,
        ...(await journal.getDiff(id, { path: url.searchParams.get("path") || undefined, taskId: queryTaskId }))
      });
    }
    if (req.method === "GET" && action === "content") {
      return sendJson(res, 200, {
        workspace_id: workspaceId,
        ...(await journal.getContent(id, {
          path: url.searchParams.get("path") || undefined,
          side: url.searchParams.get("side") || undefined,
          taskId: queryTaskId
        }))
      });
    }
    if (req.method === "POST" && (action === "undo" || action === "reapply")) {
      const body = await readJsonBody(req, Math.min(maxBodyBytes, 1024 * 1024)) || {};
      const paths = Array.isArray(body.paths) ? body.paths.map(String) : undefined;
      const taskId = queryTaskId || (body.task_id ? String(body.task_id) : null);
      if (!taskId && !testRuntimeDiagnostics) return sendJson(res, 400, { error: "task_id_required" });
      await assertHistoryMutationAllowed({ taskId, workspaceId });
      const change = action === "undo"
        ? await journal.undo(id, { paths, taskId })
        : await journal.reapply(id, { paths, taskId });
      return sendJson(res, 200, { workspace_id: workspaceId, change });
    }
    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  async function assertHistoryMutationAllowed({ taskId, workspaceId }) {
    const taskRouter = getTaskRouter();
    if (!taskRouter || !taskId) return;
    let task;
    try {
      task = await taskRouter.getTaskById(taskId);
    } catch (error) {
      if (!(error instanceof TaskRouterError) || error.code !== "TASK_NOT_FOUND") throw error;
      throw new ChangeJournalError("change_not_found", "Task change set not found.", {}, 404);
    }
    if (!task.workspace_ids.includes(workspaceId)) {
      throw new ChangeJournalError("change_not_found", "Task change set not found.", {}, 404);
    }
    if (task.workspace_ids.length > 1) {
      throw new ChangeJournalError(
        "CROSS_WORKSPACE_HISTORY_ATOMICITY_REQUIRED",
        "History mutation is blocked for multi-workspace tasks until the whole transaction can be recovered atomically.",
        {
          task_id: taskId,
          guidance: "Open a single-workspace task for local history mutation, or apply a new compensating patch across all attached workspaces."
        },
        409
      );
    }
  }

  async function assertWorkspaceMutationActive(workspaceId) {
    const registry = getRegistry();
    if (!registry) return;
    await registry.getWorkspace(workspaceId, { refreshAvailability: true });
  }

  async function listOneWorkspaceChanges(workspaceId, { limit, offset, taskId }) {
    const changes = await (await getChangeJournal(workspaceId, { allowArchived: true })).listChanges({
      limit,
      offset,
      taskId
    });
    return { revision: changeListRevision(changes), ...changes };
  }

  async function listAllWorkspaceChanges({ limit, offset, taskId }) {
    const registry = getRegistry();
    if (!registry) {
      const primary = await listOneWorkspaceChanges(getPrimaryWorkspaceId(), { limit, offset, taskId });
      return { revision: primary.revision, workspaces: [{ workspace_id: getPrimaryWorkspaceId(), ...primary }] };
    }
    const workspaces = (await registry.listWorkspaces()).filter(
      (workspace) => workspace.availability === "available"
    );
    const results = await Promise.all(workspaces.map(async (workspace) => ({
      workspace_id: workspace.id,
      label: workspace.metadata?.label || path.basename(workspace.canonicalRoot),
      canonical_root: workspace.canonicalRoot,
      ...(await listOneWorkspaceChanges(workspace.id, { limit, offset, taskId }))
    })));
    const revision = createHash("sha256")
      .update(results.map((item) => `${item.workspace_id}:${item.revision}`).join("\n"))
      .digest("hex")
      .slice(0, 16);
    return { revision, workspaces: results };
  }

  return { handle };
}

function changeListRevision(value) {
  return createHash("sha256")
    .update(JSON.stringify((value?.changes || []).map((change) => [
      change.id,
      change.updatedAt,
      change.lastOperation?.at,
      change.files?.length
    ])))
    .digest("hex")
    .slice(0, 16);
}

function notModified(req, url, revision) {
  return url.searchParams.get("revision") === revision || req.headers["if-none-match"] === `"${revision}"`;
}

function sendNotModified(res, revision) {
  res.writeHead(304, { etag: `"${revision}"` });
  res.end();
}
