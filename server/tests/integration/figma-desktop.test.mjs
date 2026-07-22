// Local Coding Agent Figma Desktop MCP bridge tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import {
  callFigmaDesktopTool,
  figmaDesktopStatus,
  listFigmaDesktopTools,
  parseFigmaNodeReference
} from "../../src/integrations/figma-desktop.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PACKAGE_DIR = path.resolve(TEST_DIR, "../..");
const SERVER = path.join(SERVER_PACKAGE_DIR, "server.mjs");
let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

function createMockFigmaMcp(calls) {
  const mcp = new McpServer({ name: "Mock Figma Desktop", version: "1.0.0" });
  const refSchema = {
    nodeId: z.string().optional(),
    clientLanguages: z.array(z.string()).optional(),
    clientFrameworks: z.array(z.string()).optional(),
    forceCode: z.boolean().optional(),
    enableBase64Response: z.boolean().optional()
  };

  mcp.registerTool(
    "get_design_context",
    { title: "Get design context", description: "Mock design context", inputSchema: refSchema },
    async (args) => {
      calls.push({ tool: "get_design_context", args });
      return { content: [{ type: "text", text: JSON.stringify({ kind: "design", args }) }] };
    }
  );
  mcp.registerTool(
    "get_screenshot",
    { title: "Get screenshot", description: "Mock screenshot", inputSchema: refSchema },
    async (args) => {
      calls.push({ tool: "get_screenshot", args });
      return {
        content: [
          { type: "text", text: JSON.stringify({ kind: "screenshot", args }) },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" }
        ]
      };
    }
  );
  mcp.registerTool(
    "get_metadata",
    { title: "Get metadata", description: "Mock metadata", inputSchema: refSchema },
    async (args) => {
      calls.push({ tool: "get_metadata", args });
      return { content: [{ type: "text", text: `<node id="${args.nodeId || "selection"}" />` }] };
    }
  );
  mcp.registerTool(
    "get_variable_defs",
    { title: "Get variable defs", description: "Mock variables", inputSchema: refSchema },
    async (args) => {
      calls.push({ tool: "get_variable_defs", args });
      return { content: [{ type: "text", text: JSON.stringify({ Color: "#FFFFFF" }) }] };
    }
  );
  return mcp;
}

async function startMockFigma() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const mcp = createMockFigmaMcp(calls);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, await readJsonBody(req));
  });
  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, calls, endpoint: `http://127.0.0.1:${port}/mcp` };
}

async function waitForHealth(port, stderrRef) {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`LCA did not become ready on port ${port}\n${stderrRef.value}`);
}

async function startLca(workspace, figmaEndpoint, policy = "full") {
  await mkdir(workspace, { recursive: true });
  const port = await getFreePort();
  const stderrRef = { value: "" };
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_WORKSPACE: workspace,
      AGENT_DATA_DIR: testContext.dataDir,
      LCA_TEST_RUN_ID: testContext.runId,
      AGENT_MODE: "safe",
      AGENT_POLICY: policy,
      AGENT_EXTRA_ROOTS_JSON: "[]",
      AGENT_AUDIT: "0",
      MCP_AUTH_TOKEN: "",
      FIGMA_DESKTOP_MCP_URL: figmaEndpoint,
      FIGMA_DESKTOP_TIMEOUT_MS: "10000"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => (stderrRef.value += chunk));
  await waitForHealth(port, stderrRef);
  return { child, port };
}

async function stopChild(child) {
  if (!child?.pid) return;
  child.kill("SIGTERM");
  await wait(300);
}

async function connect(port) {
  const client = new Client({ name: "figma-bridge-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

async function callRaw(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

async function call(client, name, args = {}) {
  const result = await callRaw(client, name, args);
  if (result.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
  return result;
}

const testContext = await createIsolatedTestRoot({ prefix: "lca-figma-desktop-", protectedPaths: [path.resolve("..")] });
const base = testContext.fixtureDir;
const mock = await startMockFigma();
let lca;
let client;
try {
  const parsed = parseFigmaNodeReference("https://www.figma.com/design/XZYsFkZZKLuvesuSg8vSqC/MoodLab?node-id=12305-144779");
  check("Figma URL extracts file key", parsed.fileKey === "XZYsFkZZKLuvesuSg8vSqC", JSON.stringify(parsed));
  check("Figma URL normalizes node id", parsed.nodeId === "12305:144779", JSON.stringify(parsed));

  let rejectedNonFigma = false;
  try {
    parseFigmaNodeReference("https://example.com/design/file?node-id=1-2");
  } catch (error) {
    rejectedNonFigma = /figma\.com/.test(error.message);
  }
  check("node parser rejects non-Figma URLs", rejectedNonFigma);

  const remoteStatus = await figmaDesktopStatus({ endpoint: "https://example.com/mcp" });
  check("bridge rejects non-loopback endpoints by default", remoteStatus.connected === false && /loopback/.test(remoteStatus.error || ""), JSON.stringify(remoteStatus));

  const status = await figmaDesktopStatus({ endpoint: mock.endpoint });
  check("module status connects to mock desktop MCP", status.connected && status.tools.includes("get_design_context"), JSON.stringify(status));

  const listed = await listFigmaDesktopTools({ endpoint: mock.endpoint });
  check("module lists upstream schemas", listed.tools.some((tool) => tool.name === "get_screenshot" && tool.inputSchema), JSON.stringify(listed.tools));

  const direct = await callFigmaDesktopTool("get_metadata", { nodeId: "1:2" }, { endpoint: mock.endpoint });
  check("module forwards direct upstream tool calls", direct.content?.[0]?.text === '<node id="1:2" />', JSON.stringify(direct));

  lca = await startLca(path.join(base, "workspace"), mock.endpoint);
  client = await connect(lca.port);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  check("Runtime exposes one aggregate figma tool", names.has("figma"), JSON.stringify([...names]));
  for (const name of ["figma_status", "figma_list_tools", "figma_call_tool", "figma_get_design_context", "figma_get_screenshot", "figma_get_metadata", "figma_get_variable_defs"]) {
    check(`${name} is hidden from the Runtime catalog`, !names.has(name), JSON.stringify([...names]));
  }
  const staleAlias = await callRaw(client, "figma_status");
  check(
    "stale Figma aliases are not callable",
    staleAlias.isError === true && /Tool figma_status not found/.test(staleAlias.content?.[0]?.text || ""),
    JSON.stringify(staleAlias)
  );

  const bridgeStatus = await call(client, "figma", { action: "status" });
  const bridgeStatusJson = JSON.parse(bridgeStatus.content?.[0]?.text || "{}");
  check("LCA aggregate figma status reports connection", bridgeStatusJson.connected === true && bridgeStatusJson.tool_count === 4, JSON.stringify(bridgeStatusJson));

  const design = await call(client, "figma", {
    action: "design_context",
    url: "https://www.figma.com/design/XZYsFkZZKLuvesuSg8vSqC/MoodLab?node-id=12305-144779",
    client_languages: ["Dart"],
    client_frameworks: ["Flutter"],
    force_code: true
  });
  const designPayload = JSON.parse(design.content?.[0]?.text || "{}");
  check("design wrapper forwards normalized node and client context", designPayload.args?.nodeId === "12305:144779" && designPayload.args?.clientLanguages?.[0] === "Dart" && designPayload.args?.clientFrameworks?.[0] === "Flutter" && designPayload.args?.forceCode === true, JSON.stringify(designPayload));

  const screenshot = await call(client, "figma", { action: "screenshot", node_id: "7-8", enable_base64_response: true });
  check("screenshot wrapper preserves image content", screenshot.content?.some((item) => item.type === "image" && item.mimeType === "image/png" && item.data === "aGVsbG8="), JSON.stringify(screenshot));

  const generic = await call(client, "figma", { action: "call", tool: "get_variable_defs", arguments: { nodeId: "9:10" } });
  check("generic bridge forwards current upstream tools", /#FFFFFF/.test(generic.content?.[0]?.text || ""), JSON.stringify(generic));

  check("mock received normalized node id", mock.calls.some((entry) => entry.tool === "get_design_context" && entry.args.nodeId === "12305:144779"), JSON.stringify(mock.calls));

  await client.close();
  client = null;
  await stopChild(lca.child);
  lca = null;

  lca = await startLca(path.join(base, "strict-workspace"), mock.endpoint, "strict");
  client = await connect(lca.port);
  const strictRead = await call(client, "figma", { action: "metadata", node_id: "11:12" });
  check("strict policy allows dedicated read-only Figma wrappers", /11:12/.test(strictRead.content?.[0]?.text || ""), JSON.stringify(strictRead));
  const strictGeneric = await callRaw(client, "figma", { action: "call", tool: "future_write_tool", arguments: { nodeId: "11:12" } });
  check("strict policy blocks unknown or mutating aggregate passthrough", strictGeneric.isError === true && /policy=strict/.test(strictGeneric.content?.[0]?.text || ""), JSON.stringify(strictGeneric));

  await client.close();
  client = null;
  await stopChild(lca.child);
  lca = null;

  lca = await startLca(path.join(base, "balanced-workspace"), mock.endpoint, "balanced");
  client = await connect(lca.port);
  const balancedRead = await call(client, "figma", { action: "call", tool: "get_variable_defs", arguments: { nodeId: "13:14" } });
  check("balanced policy allows known read-only generic Figma tools", /#FFFFFF/.test(balancedRead.content?.[0]?.text || ""), JSON.stringify(balancedRead));
  const balancedUnknown = await callRaw(client, "figma", { action: "call", tool: "future_write_tool", arguments: { nodeId: "13:14" } });
  check("balanced policy requires approval for unknown or mutating upstream tools", balancedUnknown.isError === true && /Approval required/.test(balancedUnknown.content?.[0]?.text || ""), JSON.stringify(balancedUnknown));
} finally {
  if (client) await client.close().catch(() => {});
  await stopChild(lca?.child);
  await new Promise((resolve) => mock.server.close(resolve));
  await safeRemove(base, testContext, { recursive: true, force: true });
}

console.log(`\n==== FIGMA DESKTOP RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
