// Local Coding Agent HTTP response and origin helpers
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

let ALLOWED_ORIGINS;
let HOST;
let PORT;

export function configureHttpHelpers({ allowedOrigins, host, port }) {
  ALLOWED_ORIGINS = allowedOrigins;
  HOST = host;
  PORT = port;
}

export function localBrowserOrigins() {
  return new Set([
    `http://${HOST}:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `http://[::1]:${PORT}`
  ]);
}

export function originAllowed(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin) || localBrowserOrigins().has(origin);
}

export function setCors(req, res) {
  const origin = String(req.headers.origin || "");
  if (origin && (ALLOWED_ORIGINS.has(origin) || localBrowserOrigins().has(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, X-LCA-Instance-Nonce, Mcp-Session-Id, mcp-session-id"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        return;
      }
      if (!overflow) chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        reject(Object.assign(new Error("Payload too large."), { statusCode: 413 }));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res, status, value) {
  const json = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

export function oauthProtectedResourceMetadata() {
  const resource = `http://${HOST}:${PORT}/mcp`;
  return {
    resource,
    bearer_methods_supported: ["header"],
    scopes_supported: [],
    resource_name: "Local Coding Agent MCP",
    resource_documentation: `http://${HOST}:${PORT}/`
  };
}
