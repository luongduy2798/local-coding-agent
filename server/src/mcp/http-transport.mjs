// Local Coding Agent MCP HTTP transport and request telemetry.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";

export function createMcpHttpTransport({
  audit,
  auditIdentifier,
  catalogHash,
  catalogVersion,
  isoNow,
  maxBodyBytes,
  readJsonBody,
  requestContext,
  roundMs,
  sendJson,
  sessionManager
}) {
  async function handle(req, res) {
    if (!["POST", "GET", "DELETE"].includes(String(req.method || "").toUpperCase())) {
      return sendJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null
      });
    }
    const len = Number(req.headers["content-length"] || 0);
    if (len > maxBodyBytes) {
      return sendJson(res, 413, {
        jsonrpc: "2.0",
        error: { code: -32002, message: "Payload too large." },
        id: null
      });
    }

    const requestId = randomUUID();
    const startedAt = isoNow();
    const startedMs = performance.now();
    const requestMetrics = {
      requestId,
      sessionId: String(req.headers["mcp-session-id"] || "") || null,
      sessionMode: null,
      tool: null,
      handlerMs: null,
      outChars: null,
      outBytes: null,
      success: null
    };
    const transportReadyMs = performance.now();
    const body = req.method === "POST" ? await readJsonBody(req, maxBodyBytes) : undefined;
    const bodyParsedMs = performance.now();
    requestMetrics.tool = body?.method === "tools/call" ? String(body?.params?.name || "") : null;
    const clientCatalogVersion = String(
      req.headers["x-lca-catalog-version"] ?? body?.params?._meta?.lca_catalog_version ?? ""
    ).trim();
    const clientCatalogHash = String(
      req.headers["x-lca-catalog-hash"] ?? body?.params?._meta?.lca_catalog_hash ?? ""
    ).trim();
    const catalogMismatch =
      (clientCatalogVersion && clientCatalogVersion !== String(catalogVersion)) ||
      (clientCatalogHash && clientCatalogHash !== catalogHash);
    if (catalogMismatch && body?.method !== "initialize" && body?.method !== "tools/list" &&
      !(body?.method === "tools/call" && body?.params?.name === "lca_status")) {
      return sendJson(res, 409, {
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: {
          code: -32055,
          message: "LCA tool catalog is stale. Refresh the ChatGPT connector once and open a new chat.",
          data: { code: "STALE_TOOL_CATALOG", catalog_version: catalogVersion, catalog_hash: catalogHash }
        }
      });
    }

    let thrown = null;
    try {
      const session = await requestContext.run(requestMetrics, () => sessionManager.handle(req, res, body));
      requestMetrics.sessionId = session?.sessionId || requestMetrics.sessionId;
      requestMetrics.sessionMode = session?.mode || null;
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const finishedMs = performance.now();
      const responseLength = Number(res.getHeader("content-length") || 0) || undefined;
      audit({
        ts: startedAt,
        kind: "mcp_request",
        requestId,
        sessionIdHash: auditIdentifier(requestMetrics.sessionId) || undefined,
        sessionMode: requestMetrics.sessionMode || undefined,
        method: body?.method || null,
        tool: requestMetrics.tool || undefined,
        ok: thrown === null && res.statusCode < 400,
        requestBytes: len || undefined,
        responseBytes: responseLength,
        setupMs: roundMs(transportReadyMs - startedMs),
        bodyParseMs: roundMs(bodyParsedMs - transportReadyMs),
        transportMs: roundMs(finishedMs - bodyParsedMs),
        handlerMs: requestMetrics.handlerMs ?? undefined,
        serializationMs: requestMetrics.serializationMs ?? undefined,
        outChars: requestMetrics.outChars ?? undefined,
        outBytes: requestMetrics.outBytes ?? undefined,
        responseTruncated: requestMetrics.responseTruncated || undefined,
        httpTotalMs: roundMs(finishedMs - startedMs)
      });
    }
  }

  return { handle };
}
