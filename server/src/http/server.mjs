// Local Coding Agent HTTP routing, authentication and listener lifecycle.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { ChangeJournalError } from "../change-journal.mjs";

export function createApplicationHttpServer({
  allowDangerous,
  auditStatus,
  authToken,
  catalogHash,
  catalogVersion,
  changeRoutes,
  configId,
  getPrimaryWorkspaceId,
  getRegistry,
  getTaskRouter,
  host,
  httpLog,
  instanceNonce,
  log,
  mcpTransport,
  mode,
  oauthProtectedResourceMetadata,
  originAllowed,
  policy,
  port,
  primaryRoot,
  processes,
  productTier,
  runtimeId,
  roots,
  sendJson,
  sessionManager,
  setCors,
  testRuntimeDiagnostics,
  version
}) {
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host || host}`);
      if (httpLog) log(`${req.method} ${requestUrl.pathname} ua=${req.headers["user-agent"] || ""}`);
      if (!originAllowed(req)) return sendJson(res, 403, { error: "browser_origin_not_allowed" });
      setCors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = requestUrl;
      if (req.method === "GET" && url.pathname === "/") {
        return sendJson(res, 200, {
          status: "ok",
          version,
          catalog_version: catalogVersion,
          catalog_hash: catalogHash,
          documentation: "Use /healthz for liveness and the local CLI for detailed status."
        });
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { status: "ok", version, catalog_version: catalogVersion, catalog_hash: catalogHash });
      }
      if (req.method === "GET" && url.pathname === "/healthz/details") {
        if (!checkCompanionAuth(req)) return sendJson(res, 401, { error: "instance_auth_required" });
        return sendJson(res, 200, await healthDetails());
      }
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
        return sendJson(res, 200, oauthProtectedResourceMetadata());
      }
      if (
        url.pathname === "/changes" || url.pathname.startsWith("/changes/") ||
        url.pathname === "/tasks" || url.pathname.startsWith("/tasks/")
      ) {
        if (!checkCompanionAuth(req)) return sendJson(res, 401, { error: "unauthorized" });
        return await changeRoutes.handle(req, res, url);
      }
      if (url.pathname === "/mcp") {
        if (!checkAuth(req)) {
          return sendJson(res, 401, {
            jsonrpc: "2.0",
            error: { code: -32001, message: "Unauthorized." },
            id: null
          });
        }
        return await mcpTransport.handle(req, res);
      }
      return sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        if (error instanceof ChangeJournalError) return sendJson(res, error.statusCode || 400, error.toJSON());
        if (String(error?.code || "").startsWith("WORKSPACE_")) {
          return sendJson(res, 409, {
            error: error.code,
            code: error.code,
            message: error.message
          });
        }
        return sendJson(res, error?.statusCode || 500, { error: error?.message || "Internal Server Error" });
      }
    }
  });

  async function healthDetails() {
    const registry = getRegistry();
    const taskRouter = getTaskRouter();
    const primaryWorkspaceId = getPrimaryWorkspaceId();
    const selected = registry
      ? await registry.getSelectedWorkspace({ scope: "default" }).catch(() => null)
      : null;
    const workspaceDescriptors = registry
      ? (await registry.listWorkspaces({ includeArchived: true })).map((workspace) => ({
          workspace_id: workspace.id,
          label: workspace.metadata?.label || path.basename(workspace.canonicalRoot),
          canonical_root: workspace.canonicalRoot,
          availability: workspace.availability,
          registration_state: workspace.registrationState,
          archived_at: workspace.archivedAt,
          trusted: workspace.metadata?.trusted === true
        }))
      : [{
          workspace_id: primaryWorkspaceId,
          label: path.basename(primaryRoot),
          canonical_root: primaryRoot,
          availability: "available",
          trusted: true
        }];
    const tasks = taskRouter
      ? (await taskRouter.listTasks({ limit: 100 })).map((task) => ({
          task_id: task.id,
          title: task.title,
          objective: task.objective,
          requested_profile: task.requested_profile,
          effective_profile: task.effective_profile,
          profile_confidence: task.profile_confidence,
          orchestration: task.orchestration ? {
            phase: task.orchestration.phase,
            evidence_status: task.orchestration.evidence_status,
            budgets: task.orchestration.budgets,
            counters: task.orchestration.counters,
            last_notice: task.orchestration.last_notice
          } : null,
          status: task.status,
          session_bound: task.session_bound,
          detached_at: task.detached_at,
          closed_reason: task.closed_reason,
          workspace_ids: task.workspace_ids,
          primary_workspace_id: task.primary_workspace_id,
          workspace_set_version: task.version,
          workspace_set_frozen: task.workspace_set_frozen,
          created_at: task.created_at,
          updated_at: task.updated_at,
          closed_at: task.closed_at
        }))
      : [];
    const processDescriptors = [...(processes?.values?.() || [])].map((item) => ({
      process_id: item.id,
      name: item.name,
      status: item.status,
      exit_code: Number.isInteger(item.exitCode) ? item.exitCode : null,
      task_id: item.taskId || null,
      workspace_id: item.workspaceId || null,
      started_at: item.startedAt || null
    }));
    return {
      status: "ok",
      version,
      tier: productTier,
      pid: process.pid,
      mode,
      policy,
      allow_dangerous: allowDangerous,
      auth: authToken ? "bearer" : "none",
      config_id: configId || null,
      runtime_id: runtimeId,
      roots,
      workspace: primaryRoot,
      global_default_workspace_id: selected?.workspace?.id || primaryWorkspaceId,
      workspaces: workspaceDescriptors,
      tasks,
      processes: processDescriptors,
      audit: auditStatus?.() || { enabled: false },
      mcp_sessions: sessionManager.summary(),
      change_events_endpoint: "/changes/events",
      mcp_endpoint: `http://${host}:${port}/mcp`
    };
  }

  function checkAuth(req) {
    if (!authToken) return true;
    const header = req.headers.authorization || "";
    const fromHeader = header.startsWith("Bearer ") ? header.slice(7) : "";
    return safeEqual(fromHeader, authToken);
  }

  function checkInstanceNonce(req) {
    if (!instanceNonce) return false;
    return safeEqual(String(req.headers["x-lca-instance-nonce"] || ""), instanceNonce);
  }

  function checkCompanionAuth(req) {
    if (testRuntimeDiagnostics) return checkAuth(req);
    return isLoopbackRequest(req) && checkInstanceNonce(req);
  }

  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      console.error(`FATAL: MCP port ${port} is already in use — another server instance is likely running. Exiting.`);
      process.exit(1);
    }
    log(`httpServer error: ${error?.message || error}`);
  });

  function listen({ onReady } = {}) {
    server.listen(port, host, () => {
      console.log(`Local Coding Agent v${version} listening on http://${host}:${port}`);
      console.log(`Mode: ${mode}${allowDangerous ? " (+dangerous)" : ""}  Auth: ${authToken ? "bearer" : "none (tunnel-only)"}`);
      console.log(`Roots:\n${roots.map((root) => `  - ${root}`).join("\n")}`);
      console.log(`MCP endpoint: http://${host}:${port}/mcp`);
      onReady?.();
    });
    return server;
  }

  return { listen, server };
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || "").toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
