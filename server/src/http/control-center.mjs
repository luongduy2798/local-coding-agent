// Local Control Center HTTP session, assets and cross-host state projection.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readControlActivities } from "./control-activity.mjs";

const TICKET_TTL_MS = 60_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = "lca_control_session";
const CONTROL_REQUEST_HEADER = "x-lca-control-request";
const HOSTS = new Set(["browser", "jetbrains"]);

export function createControlCenterRoutes({
  auditPath,
  changeRoutes,
  controlOrigin,
  getHealthDetails,
  readJsonBody,
  sendJson,
  uiDir
}) {
  const tickets = new Map();
  const sessions = new Map();
  let revisionCounter = 0;
  let lastStateFingerprint = "";

  async function handle(req, res, url) {
    prune();
    if (req.method === "POST" && url.pathname === "/control/tickets") {
      const body = await readJsonBody(req, 16 * 1024) || {};
      const host = HOSTS.has(String(body.host || "")) ? String(body.host) : "browser";
      const ticket = randomToken();
      tickets.set(ticket, { host, expiresAt: Date.now() + TICKET_TTL_MS });
      return sendJson(res, 200, {
        ticket,
        expires_in_ms: TICKET_TTL_MS,
        launch_url: `${controlOrigin}/control/launch?t=${encodeURIComponent(ticket)}`
      });
    }

    if (req.method === "GET" && url.pathname === "/control/launch") {
      const ticket = String(url.searchParams.get("t") || "");
      const issued = tickets.get(ticket);
      tickets.delete(ticket);
      if (!issued || issued.expiresAt < Date.now()) return sendJson(res, 401, { error: "control_ticket_invalid" });
      const sessionId = randomToken();
      sessions.set(sessionId, { host: issued.host, expiresAt: Date.now() + SESSION_TTL_MS });
      res.writeHead(302, {
        location: `/control/?host=${encodeURIComponent(issued.host)}`,
        "set-cookie": `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        "cache-control": "no-store"
      });
      res.end();
      return;
    }

    const session = authorize(req, { mutation: req.method !== "GET" && req.method !== "HEAD" });
    if (!session) return sendJson(res, 401, { error: "control_session_required" });

    if (req.method === "GET" && (url.pathname === "/control" || url.pathname === "/control/")) {
      return sendHtml(res, 200, controlPage());
    }
    if (req.method === "GET" && url.pathname === "/control/assets/webview.js") {
      return sendAsset(res, path.join(uiDir, "webview.js"), "text/javascript; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/control/assets/webview.css") {
      return sendAsset(res, path.join(uiDir, "webview.css"), "text/css; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/control/state") {
      return sendJson(res, 200, await buildState(url, session));
    }
    if (req.method === "GET" && url.pathname === "/control/events") {
      return streamEvents(req, res);
    }
    if (req.method === "GET" && url.pathname === "/control/diff") {
      return sendHtml(res, 200, await diffPage(url));
    }
    return sendJson(res, 404, { error: "not_found" });
  }

  function authorize(req, { mutation = false } = {}) {
    if (!isLoopbackRequest(req)) return null;
    const sessionId = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session || session.expiresAt < Date.now()) {
      if (sessionId) sessions.delete(sessionId);
      return null;
    }
    if (mutation) {
      const origin = String(req.headers.origin || "");
      if (origin !== controlOrigin || String(req.headers[CONTROL_REQUEST_HEADER] || "") !== "1") return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }

  async function buildState(url, session) {
    const health = await getHealthDetails();
    const descriptors = (health.workspaces || []).map(normalizeWorkspaceDescriptor);
    const requestedKey = String(url.searchParams.get("workspace_key") || "");
    const requestedId = requestedKey.startsWith("workspace:") ? requestedKey.slice("workspace:".length) : "";
    const selected = descriptors.find((workspace) => workspace.id === requestedId) ||
      descriptors.find((workspace) => workspace.id === health.global_default_workspace_id) ||
      descriptors.find((workspace) => workspace.availability === "available") ||
      descriptors[0];
    const selectedWorkspaceId = selected?.id || health.global_default_workspace_id;
    const selectedWorkspaceKey = selectedWorkspaceId ? `workspace:${selectedWorkspaceId}` : undefined;
    const allTasks = (health.tasks || []).map(normalizeTask);
    const workspaceTasks = selectedWorkspaceId
      ? allTasks.filter((task) => !task.workspaceIds.length || task.workspaceIds.includes(selectedWorkspaceId))
      : allTasks;
    const requestedTaskId = String(url.searchParams.get("task_id") || "");
    const selectedTaskId = workspaceTasks.some((task) => task.id === requestedTaskId) ? requestedTaskId : undefined;
    const changesSnapshot = selectedWorkspaceId
      ? await changeRoutes.listSnapshot({ workspaceId: selectedWorkspaceId, taskId: selectedTaskId || null, limit: 200 })
      : { changes: [], revision: "empty" };
    const changes = (changesSnapshot.changes || []).map((change) => ({
      ...change,
      workspace_id: change.workspace_id || change.workspace || selectedWorkspaceId,
      workspace_label: change.workspace_label || selected?.label,
      task_id: change.task_id || change.routingTaskId || change.routing_task_id
    })).sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""));
    const audit = health.control_activity || await readActivities(health.runtime_id || null, health.audit);
    const workspaceIds = new Set(descriptors.map((workspace) => workspace.id));
    audit.activities = audit.activities.filter((activity) =>
      !activity.workspaceIds.length || activity.workspaceIds.every((workspaceId) => workspaceIds.has(workspaceId))
    );
    const controlWorkspaces = descriptors.map((workspace) => ({
      ...workspace,
      isDefault: workspace.id === health.global_default_workspace_id,
      isConfiguredStartup: workspace.root === health.workspace,
      opened: workspace.id === selectedWorkspaceId
    }));
    const fingerprint = stateFingerprint({
      audit: audit.revision || [
        audit.currentRuntimeId,
        audit.activities.length,
        audit.activities.at(-1)?.invocationId,
        audit.activities.at(-1)?.status,
        audit.activities.at(-1)?.finishedAt
      ],
      changes: changesSnapshot.revision,
      tasks: allTasks.map((task) => [task.id, task.updatedAt, task.status]),
      workspaces: descriptors.map((workspace) => [workspace.id, workspace.availability, workspace.registrationState])
    });
    if (fingerprint !== lastStateFingerprint) {
      lastStateFingerprint = fingerprint;
      revisionCounter += 1;
    }
    const revision = revisionCounter;
    const capabilities = hostCapabilities(session.host);
    return {
      loading: false,
      revision,
      serverRevision: changesSnapshot.revision,
      syncMode: "sse",
      trusted: selected?.trusted !== false,
      currentWorkspace: selected?.root || health.workspace,
      selectedWorkspaceKey,
      selectedTaskId,
      workspaceOptions: controlWorkspaces.map((workspace) => ({
        key: `workspace:${workspace.id}`,
        label: workspace.label,
        root: workspace.root,
        workspaceId: workspace.id,
        available: workspace.availability === "available",
        registered: true,
        trusted: workspace.trusted,
        opened: workspace.opened,
        registrationState: workspace.registrationState
      })),
      taskOptions: workspaceTasks.map((task) => ({ taskId: task.id, title: task.title, status: task.status })),
      connection: {
        kind: "connected",
        workspace: selected?.root || health.workspace,
        version: health.version,
        workspaceCount: descriptors.length
      },
      changes,
      control: {
        loading: false,
        revision,
        serverOnline: true,
        supervisorOnline: true,
        tunnelOnline: false,
        tunnelReady: false,
        version: health.version,
        runtimeId: health.runtime_id || null,
        sessions: {
          active: Number(health.mcp_sessions?.active || 0),
          max: Number(health.mcp_sessions?.max || 32)
        },
        audit: {
          available: audit.available,
          enabled: audit.enabled,
          currentRuntimeId: audit.currentRuntimeId,
          activities: audit.activities,
          error: audit.error,
          updatedAt: audit.updatedAt
        },
        workspaces: controlWorkspaces,
        tasks: allTasks,
        processes: health.processes || []
      },
      host: { kind: session.host, capabilities }
    };
  }

  async function diffPage(url) {
    const workspaceId = String(url.searchParams.get("workspace_id") || "");
    const taskId = String(url.searchParams.get("task_id") || "") || null;
    const changeId = String(url.searchParams.get("change_id") || "");
    const selectedPath = String(url.searchParams.get("path") || "") || null;
    if (!workspaceId || !changeId) return simplePage("Diff unavailable", "A workspace and change are required.");
    const result = await changeRoutes.getDiffSnapshot({
      workspaceId,
      taskId,
      changeId,
      path: selectedPath
    });
    const title = selectedPath || `Change ${changeId}`;
    const diff = result.diff || result.unavailable?.map((item) => `${item.path}: ${item.reason}`).join("\n") || "No textual diff is available.";
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#111318;color:#e7e9ee;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}header{position:sticky;top:0;padding:12px 16px;background:#1a1d24;border-bottom:1px solid #30343d;font-family:system-ui,sans-serif}pre{margin:0;padding:16px;white-space:pre-wrap;word-break:break-word}</style></head><body><header>${escapeHtml(title)}</header><pre>${escapeHtml(diff)}</pre></body></html>`;
  }

  function streamEvents(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const emit = () => {
      if (res.destroyed) return;
      const revision = String(Date.now());
      res.write(`id: ${revision}\nevent: revision\ndata: ${JSON.stringify({ revision })}\n\n`);
    };
    const timer = setInterval(emit, 2_000);
    timer.unref?.();
    req.once("close", () => clearInterval(timer));
    res.write(": ready\n\n");
    emit();
  }

  async function sendAsset(res, file, contentType) {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return sendJson(res, 503, { error: "control_center_assets_missing", guidance: "Run `lca integrations setup web`." });
    const content = await readFile(file);
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": content.length,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff"
    });
    res.end(content);
  }

  async function readActivities(runtimeId = null, status = null) {
    return readControlActivities({
      auditPath: status?.path || auditPath,
      enabled: status?.enabled === true,
      runtimeId
    });
  }

  function prune() {
    const now = Date.now();
    for (const [ticket, value] of tickets) if (value.expiresAt < now) tickets.delete(ticket);
    for (const [session, value] of sessions) if (value.expiresAt < now) sessions.delete(session);
  }

  return { handle, authorize, readActivities };
}

function normalizeWorkspaceDescriptor(workspace) {
  const root = workspace.canonical_root || workspace.canonicalRoot || workspace.root || workspace.path || "";
  return {
    id: workspace.workspace_id || workspace.id,
    label: workspace.label || workspace.metadata?.label || path.basename(root),
    root,
    availability: workspace.available === false || workspace.availability === "unavailable" ? "unavailable" : "available",
    registrationState: workspace.registration_state || workspace.registrationState || "active",
    archivedAt: workspace.archived_at || workspace.archivedAt || null,
    trusted: workspace.trusted === true || workspace.trust_state === "trusted" || workspace.metadata?.trusted === true
  };
}

function normalizeTask(task) {
  const id = task.task_id || task.id;
  return {
    id,
    title: task.title || `Task ${String(id || "").slice(0, 12)}`,
    objective: task.objective || null,
    requestedProfile: task.requested_profile || null,
    effectiveProfile: task.effective_profile || null,
    profileConfidence: Number.isFinite(Number(task.profile_confidence)) ? Number(task.profile_confidence) : null,
    orchestration: task.orchestration || null,
    status: task.status || "unknown",
    sessionBound: typeof task.session_bound === "boolean" ? task.session_bound : null,
    detachedAt: task.detached_at || null,
    closedReason: task.closed_reason || null,
    primaryWorkspaceId: task.primary_workspace_id || task.workspace_ids?.[0] || null,
    workspaceIds: task.workspace_ids || (task.primary_workspace_id ? [task.primary_workspace_id] : []),
    createdAt: task.created_at || null,
    updatedAt: task.updated_at || null,
    closedAt: task.closed_at || null
  };
}

function hostCapabilities(host) {
  return host === "jetbrains"
    ? {
        runtimeControl: false,
        workspaceManagement: false,
        taskManagement: true,
        changeMutation: true,
        nativeOpenFile: false,
        nativeDiff: false,
        secretStorage: false
      }
    : {
        runtimeControl: false,
        workspaceManagement: false,
        taskManagement: true,
        changeMutation: true,
        nativeOpenFile: false,
        nativeDiff: false,
        secretStorage: false
      };
}

function controlPage() {
  return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'\"><link rel=\"stylesheet\" href=\"/control/assets/webview.css\"><title>Local Coding Agent</title></head><body><div id=\"root\"></div><script defer src=\"/control/assets/webview.js\"></script></body></html>";
}

function simplePage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });
  res.end(html);
}

function stateFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function parseCookies(source) {
  const values = {};
  for (const part of String(source || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) values[name] = value;
  }
  return values;
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || "").toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
