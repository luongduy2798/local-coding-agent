// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_SESSIONS = 32;

export class McpSessionManager {
  constructor({
    createServer,
    maxSessions = DEFAULT_MAX_SESSIONS,
    idleTtlMs = DEFAULT_IDLE_TTL_MS,
    allowStatelessFallback = true,
    onSessionOpened,
    onSessionClosed
  } = {}) {
    if (typeof createServer !== "function") throw new TypeError("createServer is required");
    this.createServer = createServer;
    this.maxSessions = boundedInteger(maxSessions, DEFAULT_MAX_SESSIONS, 1, 256);
    this.idleTtlMs = boundedInteger(idleTtlMs, DEFAULT_IDLE_TTL_MS, 10_000, 24 * 60 * 60_000);
    this.allowStatelessFallback = allowStatelessFallback !== false;
    this.onSessionOpened = onSessionOpened;
    this.onSessionClosed = onSessionClosed;
    this.sessions = new Map();
    this.closingSessions = new Map();
    this.statefulDispatchSamples = [];
    this.statefulDispatchCalls = 0;
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdle().catch(() => {});
    }, Math.min(60_000, Math.max(10_000, Math.floor(this.idleTtlMs / 2))));
    this.cleanupTimer.unref?.();
  }

  get size() {
    return this.sessions.size;
  }

  snapshot() {
    const now = Date.now();
    return {
      active: this.sessions.size,
      max: this.maxSessions,
      idle_ttl_ms: this.idleTtlMs,
      sessions: [...this.sessions.values()].map((entry) => ({
        id: entry.id,
        created_at: entry.createdAt,
        last_used_at: entry.lastUsedAt,
        idle_ms: Math.max(0, now - entry.lastUsedMs),
        requests: entry.requests,
        active_requests: entry.activeRequests
      }))
    };
  }

  summary() {
    const entries = [...this.sessions.values()];
    const dispatch = summarizeDurations(this.statefulDispatchSamples);
    return {
      active: entries.length,
      max: this.maxSessions,
      idle_ttl_ms: this.idleTtlMs,
      total_requests: entries.reduce((sum, entry) => sum + Number(entry.requests || 0), 0),
      stateful_dispatch: {
        calls: this.statefulDispatchCalls,
        sample_size: this.statefulDispatchSamples.length,
        p95_ms: dispatch.p95,
        max_ms: dispatch.max
      },
      oldest_created_at: entries
        .map((entry) => entry.createdAt)
        .filter(Boolean)
        .sort()[0] || null,
      most_recent_use_at: entries
        .map((entry) => entry.lastUsedAt)
        .filter(Boolean)
        .sort()
        .at(-1) || null
    };
  }

  async handle(req, res, body) {
    const method = String(req.method || "POST").toUpperCase();
    const requestedSessionId = headerValue(req.headers?.["mcp-session-id"]);
    if (requestedSessionId) {
      const dispatchStarted = performance.now();
      const entry = this.sessions.get(requestedSessionId);
      if (!entry) {
        return sendRpcError(res, 404, -32001, "Unknown or expired MCP session. Reconnect the client.");
      }
      entry.lastUsedMs = Date.now();
      entry.lastUsedAt = new Date(entry.lastUsedMs).toISOString();
      entry.requests++;
      entry.activeRequests++;
      // Session dispatch ends once the existing transport has been selected
      // and its request accounting is updated. SDK transport/handler work is
      // measured separately by the request and tool telemetry layers.
      this.recordStatefulDispatch(performance.now() - dispatchStarted);
      try {
        await entry.transport.handleRequest(req, res, body);
      } finally {
        entry.activeRequests = Math.max(0, entry.activeRequests - 1);
        if (method === "DELETE") await this.closeSession(requestedSessionId, "client_delete");
      }
      return { mode: "stateful", sessionId: requestedSessionId, reused: true };
    }

    if (method === "POST" && isInitializeRequest(body)) {
      if (!await this.ensureCapacity()) {
        return sendRpcError(
          res,
          503,
          -32003,
          "MCP session capacity is busy. Retry after an active request completes."
        );
      }
      return this.openSession(req, res, body);
    }

    if (method === "GET" || method === "DELETE") {
      return sendRpcError(res, 400, -32000, "Missing MCP session ID.");
    }

    if (!this.allowStatelessFallback) {
      return sendRpcError(res, 400, -32000, "Initialize a stateful MCP session before calling tools.");
    }
    return this.handleStateless(req, res, body);
  }

  async openSession(req, res, body) {
    let entry = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        const now = Date.now();
        entry = {
          id: sessionId,
          server,
          transport,
          createdAt: new Date(now).toISOString(),
          lastUsedAt: new Date(now).toISOString(),
          lastUsedMs: now,
          requests: 1,
          activeRequests: 1
        };
        this.sessions.set(sessionId, entry);
        this.onSessionOpened?.(this.publicEntry(entry));
      },
      onsessionclosed: (sessionId) => {
        this.closeSession(sessionId, "transport_closed").catch(() => {});
      }
    });
    const server = this.createServer();
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) this.closeSession(sessionId, "transport_closed").catch(() => {});
    };
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, body);
    } catch (error) {
      await Promise.allSettled([transport.close(), server.close()]);
      throw error;
    } finally {
      if (entry) entry.activeRequests = Math.max(0, entry.activeRequests - 1);
    }
    return { mode: "stateful", sessionId: entry?.id || transport.sessionId || null, reused: false };
  }

  async handleStateless(req, res, body) {
    const server = this.createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const close = onceAsync(async () => {
      await Promise.allSettled([transport.close(), server.close()]);
    });
    res.once("close", close);
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, body);
    } finally {
      if (res.writableEnded || res.destroyed) await close();
    }
    return { mode: "stateless", sessionId: null, reused: false };
  }

  async ensureCapacity() {
    await this.cleanupIdle();
    if (this.sessions.size < this.maxSessions) return true;
    const oldest = [...this.sessions.values()]
      .filter((entry) => entry.activeRequests === 0)
      .sort((a, b) => a.lastUsedMs - b.lastUsedMs)[0];
    if (oldest) await this.closeSession(oldest.id, "capacity");
    return this.sessions.size < this.maxSessions;
  }

  async cleanupIdle(now = Date.now()) {
    const stale = [...this.sessions.values()]
      .filter((entry) =>
        entry.activeRequests === 0
        && now - entry.lastUsedMs >= this.idleTtlMs
      )
      .map((entry) => entry.id);
    await Promise.all(stale.map((sessionId) => this.closeSession(sessionId, "idle_ttl")));
    return stale.length;
  }

  async closeSession(sessionId, reason = "closed") {
    const existingClose = this.closingSessions.get(sessionId);
    if (existingClose) return existingClose;
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    const closing = (async () => {
      entry.closing = true;
      this.sessions.delete(sessionId);
      await Promise.allSettled([entry.transport.close(), entry.server.close()]);
      await Promise.resolve(this.onSessionClosed?.({ ...this.publicEntry(entry), reason }));
      return true;
    })();
    this.closingSessions.set(sessionId, closing);
    try {
      return await closing;
    } finally {
      if (this.closingSessions.get(sessionId) === closing) {
        this.closingSessions.delete(sessionId);
      }
    }
  }

  async close() {
    clearInterval(this.cleanupTimer);
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId, "shutdown")));
    await Promise.allSettled([...this.closingSessions.values()]);
  }

  recordStatefulDispatch(durationMs) {
    const measured = Number(durationMs);
    if (!Number.isFinite(measured) || measured < 0) return;
    this.statefulDispatchCalls++;
    this.statefulDispatchSamples.push(measured);
    if (this.statefulDispatchSamples.length > 1_024) this.statefulDispatchSamples.shift();
  }

  publicEntry(entry) {
    return {
      id: entry.id,
      created_at: entry.createdAt,
      last_used_at: entry.lastUsedAt,
      requests: entry.requests
    };
  }
}

function isInitializeRequest(body) {
  if (Array.isArray(body)) return body.some((item) => item?.method === "initialize");
  return body?.method === "initialize";
}

function headerValue(value) {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function summarizeDurations(values) {
  if (!values.length) return { p95: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    p95: roundMilliseconds(sorted[index]),
    max: roundMilliseconds(sorted.at(-1))
  };
}

function roundMilliseconds(value) {
  return Math.round(Number(value) * 1_000) / 1_000;
}

function onceAsync(fn) {
  let promise = null;
  return () => {
    promise ||= Promise.resolve().then(fn);
    return promise;
  };
}

function sendRpcError(res, status, code, message) {
  if (res.headersSent || res.destroyed) return { mode: "rejected", sessionId: null, reused: false };
  const payload = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
  return { mode: "rejected", sessionId: null, reused: false };
}
