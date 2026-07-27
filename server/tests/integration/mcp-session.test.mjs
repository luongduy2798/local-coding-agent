// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpSessionManager } from "../../src/mcp/session-manager.mjs";

function createServer() {
  const server = new McpServer({ name: "session-test", version: "1.0.0" });
  server.registerTool("echo", { inputSchema: { value: z.string() } }, async ({ value }) => ({
    content: [{ type: "text", text: value }]
  }));
  return server;
}

let closedSession = null;
const manager = new McpSessionManager({
  createServer,
  maxSessions: 1,
  idleTtlMs: 10_000,
  onSessionClosed: async (entry) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    closedSession = entry;
  }
});
const httpServer = http.createServer(async (req, res) => {
  let body;
  if (req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  await manager.handle(req, res, body);
});

await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const address = httpServer.address();
const endpoint = `http://127.0.0.1:${address.port}`;

try {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" }
  });
  assert.equal(initialized.response.status, 200);
  assert.ok(initialized.sessionId);
  assert.equal(manager.size, 1);

  const listed = await rpc("tools/list", {}, initialized.sessionId, 2);
  assert.equal(listed.response.status, 200);
  assert.match(listed.text, /echo/);
  assert.equal(manager.size, 1);

  const called = await rpc("tools/call", { name: "echo", arguments: { value: "ok" } }, initialized.sessionId, 3);
  assert.match(called.text, /ok/);
  assert.equal(manager.snapshot().sessions[0].requests, 3);
  assert.equal(manager.summary().stateful_dispatch.calls, 2);
  assert.equal(manager.summary().stateful_dispatch.sample_size, 2);
  assert.ok(Number.isFinite(manager.summary().stateful_dispatch.p95_ms));

  const activeEntry = manager.sessions.get(initialized.sessionId);
  activeEntry.activeRequests = 1;
  assert.equal(await manager.cleanupIdle(Date.now() + 60_000), 0);
  const capacity = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "capacity-test", version: "1.0.0" }
  }, undefined, 4);
  assert.equal(capacity.response.status, 503);
  assert.equal(manager.size, 1);
  activeEntry.activeRequests = 0;

  const missing = await rpc("tools/list", {}, "missing", 5);
  assert.equal(missing.response.status, 404);
  assert.equal(manager.summary().stateful_dispatch.calls, 2, "rejected unknown sessions are not successful dispatches");

  const deleted = await fetch(endpoint, {
    method: "DELETE",
    headers: { "mcp-session-id": initialized.sessionId, "mcp-protocol-version": "2025-06-18" }
  });
  assert.ok([200, 204].includes(deleted.status));
  assert.equal(manager.size, 0);
  await manager.closeSession(initialized.sessionId, "test_wait_for_close");
  assert.equal(closedSession?.id, initialized.sessionId);
  assert.ok(["client_delete", "transport_closed"].includes(closedSession?.reason));

  console.log("runtime MCP session tests passed");
} finally {
  await manager.close();
  await new Promise((resolve) => httpServer.close(resolve));
}

async function rpc(method, params, sessionId, id = 1) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  return {
    response,
    sessionId: response.headers.get("mcp-session-id"),
    text: await response.text()
  };
}
