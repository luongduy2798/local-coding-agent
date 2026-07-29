// Persistent workspace memory HTTP routes shared by IDE and local web hosts.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export function createMemoryRoutes({
  memoryService,
  memoryOutbox,
  registry,
  readJsonBody,
  sendJson,
  maxBodyBytes = 64 * 1024
}) {
  async function handle(req, res, url) {
    if (!memoryService || !registry) {
      return sendJson(res, 503, { error: "workspace_memory_unavailable" });
    }
    const workspaceId = String(url.searchParams.get("workspace_id") || "");
    if (!workspaceId) return sendJson(res, 400, { error: "workspace_id_required" });
    const workspace = await registry.getWorkspace(workspaceId, {
      refreshAvailability: false,
      allowArchived: true
    });
    const readOnly = workspace.registrationState === "archived";

    if (req.method === "GET" && url.pathname === "/memory") {
      return sendJson(res, 200, {
        ...(await memoryService.view(workspaceId, { allowArchived: true })),
        outbox: await memoryOutbox?.summary(workspaceId) || emptyOutbox(),
        read_only: readOnly
      });
    }
    if (req.method === "POST" && url.pathname === "/memory/outbox/retry-failed") {
      assertWritable(readOnly);
      if (!memoryOutbox) {
        return sendJson(res, 503, { error: "workspace_memory_outbox_unavailable" });
      }
      const retried = await memoryOutbox.retryFailed(workspaceId);
      return sendJson(res, 200, {
        ok: true,
        workspace_id: workspaceId,
        retried,
        outbox: await memoryOutbox?.summary(workspaceId) || emptyOutbox()
      });
    }
    if (req.method === "GET" && url.pathname === "/memory/brief") {
      const view = await memoryService.view(workspaceId, { allowArchived: true });
      return sendJson(res, 200, {
        workspace_id: workspaceId,
        revision: view.revision,
        brief: view.brief,
        auto_load_payload: view.auto_load_payload,
        read_only: readOnly
      });
    }
    if (req.method === "PATCH" && url.pathname === "/memory/settings") {
      assertWritable(readOnly);
      const body = await readJsonBody(req, maxBodyBytes) || {};
      return sendJson(res, 200, {
        ok: true,
        workspace_id: workspaceId,
        settings: await memoryService.settings(workspaceId, body)
      });
    }
    if (req.method === "POST" && url.pathname === "/memory") {
      assertWritable(readOnly);
      const body = await readJsonBody(req, maxBodyBytes) || {};
      return sendJson(res, 201, {
        ok: true,
        workspace_id: workspaceId,
        item: await memoryService.save(
          workspaceId,
          { ...body, origin: "user" },
          { actor: "user" }
        )
      });
    }

    const match = url.pathname.match(/^\/memory\/([^/]+)(?:\/([^/]+))?$/);
    if (!match) return sendJson(res, 404, { error: "not_found" });
    const memoryId = decodeURIComponent(match[1]);
    const action = match[2] ? decodeURIComponent(match[2]) : null;

    if (req.method === "GET" && !action) {
      return sendJson(res, 200, {
        workspace_id: workspaceId,
        item: await memoryService.get(workspaceId, memoryId, { allowArchived: true }),
        read_only: readOnly
      });
    }
    assertWritable(readOnly);
    if (req.method === "PATCH" && !action) {
      const body = await readJsonBody(req, maxBodyBytes) || {};
      return sendJson(res, 200, {
        ok: true,
        workspace_id: workspaceId,
        item: await memoryService.update(workspaceId, memoryId, body, { actor: "user" })
      });
    }
    if (req.method === "DELETE" && !action) {
      return sendJson(res, 200, {
        workspace_id: workspaceId,
        ...(await memoryService.delete(workspaceId, memoryId, { actor: "user" }))
      });
    }
    if (req.method === "POST" && action === "supersede") {
      const body = await readJsonBody(req, maxBodyBytes) || {};
      return sendJson(res, 200, {
        ok: true,
        workspace_id: workspaceId,
        item: await memoryService.supersede(
          workspaceId,
          memoryId,
          { ...(body.replacement || body), origin: "user" },
          { actor: "user" }
        )
      });
    }
    if (req.method === "POST" && TRANSITIONS.has(action)) {
      return sendJson(res, 200, {
        ok: true,
        workspace_id: workspaceId,
        item: await memoryService.transition(workspaceId, memoryId, action, { actor: "user" })
      });
    }
    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  async function summarySnapshot(workspaceId) {
    if (!memoryService || !registry || !workspaceId) return null;
    const workspace = await registry.getWorkspace(workspaceId, {
      refreshAvailability: false,
      allowArchived: true
    });
    const [summary, outbox] = await Promise.all([
      memoryService.summary(workspaceId, { allowArchived: true }),
      memoryOutbox?.summary(workspaceId) || Promise.resolve(emptyOutbox())
    ]);
    return {
      workspace_id: workspaceId,
      revision: summary.revision,
      enabled: summary.enabled,
      auto_load: summary.auto_load,
      include_recent_tasks: summary.include_recent_tasks,
      semantic_search: summary.semantic_search,
      counts: summary.counts,
      outbox,
      read_only: workspace.registrationState === "archived"
    };
  }

  return { handle, summarySnapshot };
}

const TRANSITIONS = new Set([
  "pin", "unpin", "resolve", "archive", "restore", "current", "stale"
]);

function emptyOutbox() {
  return {
    pending: 0,
    processing: 0,
    retrying: 0,
    failed: 0,
    last_completed_at: null
  };
}

function assertWritable(readOnly) {
  if (!readOnly) return;
  const error = new Error("Archived workspace memory is read-only.");
  error.code = "WORKSPACE_MEMORY_READ_ONLY";
  error.statusCode = 409;
  throw error;
}
