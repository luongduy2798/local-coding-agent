// Local Coding Agent — Figma Desktop MCP bridge
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pathToFileURL } from "node:url";

export const DEFAULT_FIGMA_DESKTOP_MCP_URL = "http://127.0.0.1:3845/mcp";
const DEFAULT_TIMEOUT_MS = 30_000;

export function normalizeFigmaDesktopEndpoint(value = process.env.FIGMA_DESKTOP_MCP_URL || DEFAULT_FIGMA_DESKTOP_MCP_URL) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_FIGMA_DESKTOP_MCP_URL).trim());
  } catch {
    throw new Error("FIGMA_DESKTOP_MCP_URL must be a valid HTTP URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("FIGMA_DESKTOP_MCP_URL must use http or https.");
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (!loopback && process.env.FIGMA_DESKTOP_ALLOW_REMOTE !== "1") {
    throw new Error("Figma Desktop MCP must use a loopback address unless FIGMA_DESKTOP_ALLOW_REMOTE=1.");
  }
  return url.toString();
}

export function parseFigmaNodeReference(value) {
  const raw = String(value || "").trim();
  if (!raw) return { nodeId: "", fileKey: "", url: "" };
  if (!/^https?:\/\//i.test(raw)) {
    return {
      nodeId: /^\d+-\d+$/.test(raw) ? raw.replace("-", ":") : raw,
      fileKey: "",
      url: ""
    };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid Figma URL.");
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
    throw new Error("Only figma.com URLs are accepted as Figma references.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const typeIndex = parts.findIndex((part) => ["design", "file", "board", "proto", "make"].includes(part.toLowerCase()));
  const fileKey = typeIndex >= 0 ? String(parts[typeIndex + 1] || "") : "";
  const rawNodeId = decodeURIComponent(url.searchParams.get("node-id") || "").trim();
  const nodeId = /^\d+-\d+$/.test(rawNodeId) ? rawNodeId.replace("-", ":") : rawNodeId;
  return { nodeId, fileKey, url: url.toString() };
}

function timeoutMs(value) {
  const parsed = Number(value ?? process.env.FIGMA_DESKTOP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(120_000, Math.max(1_000, Math.trunc(parsed)));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function friendlyFigmaDesktopError(error, endpoint = normalizeFigmaDesktopEndpoint()) {
  const message = String(error?.cause?.message || error?.message || error || "Unknown error");
  if (/ECONNREFUSED|fetch failed|Failed to open SSE stream/i.test(message)) {
    return new Error(
      `Figma Desktop MCP is not running at ${endpoint}. Open the Figma desktop app, open a Design file, switch to Dev Mode, then click "Enable desktop MCP server" in the MCP server section.`
    );
  }
  return new Error(`Figma Desktop MCP error: ${message}`);
}

export async function withFigmaDesktopClient(callback, options = {}) {
  const endpoint = normalizeFigmaDesktopEndpoint(options.endpoint);
  const ms = timeoutMs(options.timeoutMs);
  const client = new Client({ name: options.clientName || "local-coding-agent-figma-bridge", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  try {
    await withTimeout(client.connect(transport), ms, "Connecting to Figma Desktop MCP");
    return await withTimeout(Promise.resolve(callback(client)), ms, "Figma Desktop MCP request");
  } catch (error) {
    throw friendlyFigmaDesktopError(error, endpoint);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function listFigmaDesktopTools(options = {}) {
  return withFigmaDesktopClient((client) => client.listTools(), options);
}

export async function callFigmaDesktopTool(name, args = {}, options = {}) {
  const toolName = String(name || "").trim();
  if (!toolName) throw new Error("Figma tool name is required.");
  return withFigmaDesktopClient(async (client) => {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(`Figma Desktop does not expose tool "${toolName}". Available: ${listed.tools.map((item) => item.name).join(", ") || "none"}`);
    }
    return client.callTool({ name: toolName, arguments: args || {} });
  }, options);
}

export async function figmaDesktopStatus(options = {}) {
  let endpoint = String(options.endpoint || process.env.FIGMA_DESKTOP_MCP_URL || DEFAULT_FIGMA_DESKTOP_MCP_URL);
  try {
    endpoint = normalizeFigmaDesktopEndpoint(endpoint);
    const listed = await listFigmaDesktopTools({ ...options, endpoint });
    return {
      connected: true,
      endpoint,
      tool_count: listed.tools.length,
      tools: listed.tools.map((tool) => tool.name)
    };
  } catch (error) {
    return {
      connected: false,
      endpoint,
      tool_count: 0,
      tools: [],
      error: error?.message || String(error),
      enable_steps: [
        "Open the Figma desktop app and sign in.",
        "Open a Figma Design file.",
        "Switch to Dev Mode (Shift+D).",
        "In the MCP server section, click Enable desktop MCP server."
      ]
    };
  }
}

export function buildFigmaDesktopArguments({
  url,
  node_id,
  client_languages,
  client_frameworks,
  force_code,
  enable_base64_response,
  arguments: extra = {}
} = {}) {
  const args = { ...(extra || {}) };
  const reference = parseFigmaNodeReference(url || node_id || "");
  if (reference.nodeId && args.nodeId === undefined) args.nodeId = reference.nodeId;
  if (client_languages?.length && args.clientLanguages === undefined) args.clientLanguages = client_languages;
  if (client_frameworks?.length && args.clientFrameworks === undefined) args.clientFrameworks = client_frameworks;
  if (force_code !== undefined && args.forceCode === undefined) args.forceCode = force_code;
  if (enable_base64_response !== undefined && args.enableBase64Response === undefined) args.enableBase64Response = enable_base64_response;
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] || "status";
  const result = command === "tools" ? await listFigmaDesktopTools() : await figmaDesktopStatus();
  console.log(JSON.stringify(result, null, 2));
  if (command !== "tools" && !result.connected) process.exitCode = 1;
}
