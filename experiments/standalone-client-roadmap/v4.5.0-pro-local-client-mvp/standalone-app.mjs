#!/usr/bin/env node
// Shared runtime for standalone Local Agent Studio experiments.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MCP_URL = process.env.MCP_ENDPOINT || "http://127.0.0.1:8787/mcp";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const DEFAULT_PROVIDER = process.env.LCA_MODEL_PROVIDER || "openai";
const MAX_TOOL_LOOPS = Number(process.env.LCA_STUDIO_MAX_TOOL_LOOPS || 8);
let mcpSdkPromise = null;

export function startStudio(manifest) {
  const host = process.env.LCA_STUDIO_HOST || "127.0.0.1";
  const port = Number(process.env.LCA_STUDIO_PORT || manifest.defaultPort || 5177);
  const storageDir = getStorageDir(manifest.version);
  const state = {
    manifest,
    storageDir,
    repoRoot: findRepoRoot(process.cwd()),
    mcpEndpoint: process.env.MCP_ENDPOINT || manifest.defaultMcpEndpoint || DEFAULT_MCP_URL,
    dashboardUrl: process.env.LCA_DASHBOARD_URL || "http://127.0.0.1:8790",
    client: null,
    tools: [],
    events: [],
    activeProfile: null,
    serverProcess: null,
    serverLogs: []
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url, state);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return sendText(res, 200, renderHtml(manifest), "text/html; charset=utf-8");
    }
    return sendJson(res, 404, { error: "Not found" });
  });

  server.listen(port, host, () => {
    console.log(`${manifest.productName} ${manifest.version} listening on http://${host}:${port}`);
    console.log(`MCP endpoint default: ${state.mcpEndpoint}`);
    console.log(`Local data: ${storageDir}`);
  });
}

async function handleApi(req, res, url, state) {
  try {
    if (url.pathname === "/api/health") {
      return sendJson(res, 200, healthPayload(state));
    }
    if (url.pathname === "/api/providers") {
      return sendJson(res, 200, providersPayload(state.manifest));
    }
    if (url.pathname === "/api/model-presets") {
      return sendJson(res, 200, { presets: modelPresets(state.manifest) });
    }
    if (url.pathname === "/api/connect" && req.method === "POST") {
      const body = await readJson(req);
      await connectMcp(state, body.endpoint || state.mcpEndpoint);
      return sendJson(res, 200, {
        ok: true,
        endpoint: state.mcpEndpoint,
        tools: publicTools(state.tools)
      });
    }
    if (url.pathname === "/api/tools") {
      if (!state.client) await connectMcp(state, state.mcpEndpoint);
      return sendJson(res, 200, {
        endpoint: state.mcpEndpoint,
        tools: publicTools(state.tools, true)
      });
    }
    if (url.pathname === "/api/call-tool" && req.method === "POST") {
      if (!state.client) await connectMcp(state, state.mcpEndpoint);
      const body = await readJson(req);
      const result = await callMcpTool(state, body.name, body.arguments || {});
      return sendJson(res, 200, result);
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.message) throw new Error("message is required");
      const result = await chatWithTools(state, {
        message: body.message,
        model: body.model || DEFAULT_MODEL,
        provider: body.provider || DEFAULT_PROVIDER
      });
      return sendJson(res, 200, result);
    }
    if (url.pathname === "/api/events") {
      return sendJson(res, 200, { events: state.events.slice(-150) });
    }
    if (url.pathname === "/api/profiles") {
      assertFeature(state.manifest, "profiles");
      if (req.method === "GET") return sendJson(res, 200, await readProfiles(state));
      if (req.method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 200, await saveProfile(state, body));
      }
      if (req.method === "DELETE") {
        return sendJson(res, 200, await deleteProfile(state, url.searchParams.get("id")));
      }
    }
    if (url.pathname === "/api/profiles/activate" && req.method === "POST") {
      assertFeature(state.manifest, "profiles");
      return sendJson(res, 200, await activateProfile(state, await readJson(req)));
    }
    if (url.pathname === "/api/profiles/export") {
      assertFeature(state.manifest, "profiles");
      return sendJson(res, 200, await exportProfiles(state));
    }
    if (url.pathname === "/api/skills") {
      assertFeature(state.manifest, "skills");
      if (!state.client) await connectMcp(state, state.mcpEndpoint);
      const name = url.searchParams.get("name");
      const result = await callMcpTool(state, name ? "read_skill" : "list_skills", name ? { name } : {});
      return sendJson(res, 200, result);
    }
    if (url.pathname === "/api/skills/validate" && req.method === "POST") {
      assertFeature(state.manifest, "skills");
      return sendJson(res, 200, await validateSkills(state));
    }
    if (url.pathname === "/api/server/status") {
      assertFeature(state.manifest, "serverSupervisor");
      return sendJson(res, 200, await serverStatus(state));
    }
    if (url.pathname === "/api/server/start" && req.method === "POST") {
      assertFeature(state.manifest, "serverSupervisor");
      return sendJson(res, 200, await startManagedServer(state, await readJson(req)));
    }
    if (url.pathname === "/api/server/stop" && req.method === "POST") {
      assertFeature(state.manifest, "serverSupervisor");
      return sendJson(res, 200, await stopManagedServer(state));
    }
    if (url.pathname === "/api/dashboard/metrics") {
      assertFeature(state.manifest, "dashboard");
      return sendJson(res, 200, await dashboardJson(state, "/metrics"));
    }
    if (url.pathname === "/api/dashboard/tree") {
      assertFeature(state.manifest, "fileViewer");
      return sendJson(res, 200, await dashboardJson(state, `/api/tree${url.search}`));
    }
    if (url.pathname === "/api/dashboard/file") {
      assertFeature(state.manifest, "fileViewer");
      return sendJson(res, 200, await dashboardJson(state, `/api/file${url.search}`));
    }
    if (url.pathname === "/api/dashboard/diff") {
      assertFeature(state.manifest, "fileViewer");
      return sendJson(res, 200, await dashboardJson(state, `/api/diff${url.search}`));
    }
    if (url.pathname === "/api/approvals") {
      assertFeature(state.manifest, "approvals");
      return sendJson(res, 200, await dashboardJson(state, "/api/approvals"));
    }
    if (url.pathname.startsWith("/api/approvals/") && req.method === "POST") {
      assertFeature(state.manifest, "approvals");
      const suffix = url.pathname.slice("/api".length);
      return sendJson(res, 200, await dashboardJson(state, `/api${suffix}`, { method: "POST" }));
    }
    if (url.pathname === "/api/update" && req.method === "POST") {
      assertFeature(state.manifest, "customerUpdateFlow");
      return sendJson(res, 200, await runCustomerUpdate(state, await readJson(req)));
    }
    if (url.pathname === "/api/support-bundle" && req.method === "POST") {
      assertFeature(state.manifest, "supportBundle");
      return sendJson(res, 200, await writeSupportBundle(state));
    }
    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || String(error) });
  }
}

function healthPayload(state) {
  return {
    ok: true,
    product: state.manifest.productName,
    version: state.manifest.version,
    channel: state.manifest.channel,
    default_port: state.manifest.defaultPort,
    mcp_endpoint: state.mcpEndpoint,
    connected: Boolean(state.client),
    tools: state.tools.length,
    features: state.manifest.features || [],
    providers: providersPayload(state.manifest).providers,
    active_profile: state.activeProfile,
    repo_root: state.repoRoot,
    managed_server_pid: state.serverProcess?.pid || null,
    openai_key_present: Boolean(process.env.OPENAI_API_KEY),
    anthropic_key_present: Boolean(process.env.ANTHROPIC_API_KEY),
    ollama_url: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"
  };
}

function providersPayload(manifest) {
  const enabled = new Set(manifest.providers || ["openai"]);
  const providers = [
    { id: "openai", name: "OpenAI Responses API", enabled: enabled.has("openai"), ready: Boolean(process.env.OPENAI_API_KEY) },
    { id: "anthropic", name: "Anthropic Messages API", enabled: enabled.has("anthropic"), ready: Boolean(process.env.ANTHROPIC_API_KEY) },
    { id: "ollama", name: "Ollama/local HTTP", enabled: enabled.has("ollama"), ready: true }
  ];
  return { providers };
}

function modelPresets(manifest) {
  const providers = new Set(manifest.providers || ["openai"]);
  return [
    ...(providers.has("openai") ? [
      { id: "fast", provider: "openai", model: "gpt-4.1-mini", label: "Fast" },
      { id: "balanced", provider: "openai", model: "gpt-4.1", label: "Balanced" }
    ] : []),
    ...(providers.has("anthropic") ? [
      { id: "deep-review", provider: "anthropic", model: "claude-3-5-sonnet-latest", label: "Deep review" }
    ] : []),
    ...(providers.has("ollama") ? [
      { id: "local-only", provider: "ollama", model: "qwen2.5-coder:7b", label: "Local only" }
    ] : [])
  ];
}

async function connectMcp(state, endpoint) {
  if (state.client) await state.client.close().catch(() => {});
  const { Client, StreamableHTTPClientTransport } = await loadMcpSdk();
  const client = new Client({ name: "local-agent-studio", version: state.manifest.version });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  await client.connect(transport);
  const listed = await client.listTools();
  state.client = client;
  state.mcpEndpoint = endpoint;
  state.tools = listed.tools || [];
  return state;
}

async function loadMcpSdk() {
  if (!mcpSdkPromise) {
    mcpSdkPromise = (async () => {
      const requireFromVersion = createRequire(join(process.cwd(), "package.json"));
      const clientPath = requireFromVersion.resolve("@modelcontextprotocol/sdk/client/index.js");
      const transportPath = requireFromVersion.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const clientModule = await import(pathToFileURL(clientPath).href);
      const transportModule = await import(pathToFileURL(transportPath).href);
      return {
        Client: clientModule.Client,
        StreamableHTTPClientTransport: transportModule.StreamableHTTPClientTransport
      };
    })();
  }
  return mcpSdkPromise;
}

async function callMcpTool(state, name, args) {
  const started = Date.now();
  let result;
  try {
    result = await state.client.callTool({ name, arguments: args || {} });
  } catch (error) {
    result = { isError: true, content: [{ type: "text", text: error?.message || String(error) }] };
  }
  const event = {
    at: new Date().toISOString(),
    tool: name,
    args: args || {},
    isError: Boolean(result.isError),
    ms: Date.now() - started,
    result: toolResultText(result).slice(0, 50_000)
  };
  state.events.push(event);
  return { ok: !result.isError, ms: event.ms, result, event };
}

async function chatWithTools(state, request) {
  if (!state.client) await connectMcp(state, state.mcpEndpoint);
  if (request.provider === "anthropic") return chatAnthropic(state, request);
  if (request.provider === "ollama") return chatOllama(state, request);
  return chatOpenAI(state, request);
}

async function chatOpenAI(state, { message, model }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const timeline = [];
  let input = [
    { role: "system", content: systemPrompt(state.manifest) },
    { role: "user", content: message }
  ];
  let response = null;
  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    response = await httpJson("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        input,
        tools: state.tools.map(openAiTool),
        tool_choice: "auto"
      })
    });
    const calls = (response.output || []).filter((item) => item.type === "function_call");
    if (!calls.length) return { provider: "openai", text: extractOpenAiText(response), timeline, raw: response };
    input = [{ role: "system", content: systemPrompt(state.manifest) }, { role: "user", content: message }, ...response.output];
    for (const call of calls) {
      const args = parseJsonObject(call.arguments);
      const result = await callMcpTool(state, originalToolName(state, call.name), args);
      timeline.push(result.event);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result.event.result });
    }
  }
  return { provider: "openai", text: extractOpenAiText(response) || "Stopped after max tool loops.", timeline, raw: response };
}

async function chatAnthropic(state, { message, model }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const timeline = [];
  const messages = [{ role: "user", content: message }];
  let response = null;
  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    response = await httpJson("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: model || "claude-3-5-sonnet-latest",
        max_tokens: 4096,
        system: systemPrompt(state.manifest),
        messages,
        tools: state.tools.map(anthropicTool)
      })
    });
    const uses = (response.content || []).filter((item) => item.type === "tool_use");
    if (!uses.length) return { provider: "anthropic", text: anthropicText(response), timeline, raw: response };
    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: await Promise.all(uses.map(async (use) => {
        const result = await callMcpTool(state, use.name, use.input || {});
        timeline.push(result.event);
        return { type: "tool_result", tool_use_id: use.id, content: result.event.result, is_error: !result.ok };
      }))
    });
  }
  return { provider: "anthropic", text: anthropicText(response) || "Stopped after max tool loops.", timeline, raw: response };
}

async function chatOllama(state, { message, model }) {
  const base = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const timeline = [];
  const messages = [
    { role: "system", content: systemPrompt(state.manifest) },
    { role: "user", content: message }
  ];
  let response = null;
  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    response = await httpJson(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model || "qwen2.5-coder:7b",
        stream: false,
        messages,
        tools: state.tools.map(ollamaTool)
      })
    });
    const msg = response.message || {};
    const calls = msg.tool_calls || [];
    if (!calls.length) return { provider: "ollama", text: msg.content || "", timeline, raw: response };
    messages.push(msg);
    for (const call of calls) {
      const fn = call.function || {};
      const result = await callMcpTool(state, fn.name, parseJsonObject(fn.arguments));
      timeline.push(result.event);
      messages.push({ role: "tool", content: result.event.result, name: fn.name });
    }
  }
  return { provider: "ollama", text: response?.message?.content || "Stopped after max tool loops.", timeline, raw: response };
}

async function readProfiles(state) {
  const file = join(state.storageDir, "profiles.json");
  if (!existsSync(file)) return { profiles: [] };
  return JSON.parse(await readFile(file, "utf8"));
}

async function saveProfile(state, body) {
  const data = await readProfiles(state);
  const current = (data.profiles || []).find((item) => item.id === body.id);
  const profile = {
    id: body.id || safeId(body.name || "profile"),
    name: body.name || current?.name || "Profile",
    endpoint: body.endpoint || state.mcpEndpoint,
    provider: body.provider || DEFAULT_PROVIDER,
    model: body.model || DEFAULT_MODEL,
    workspace: body.workspace || current?.workspace || state.repoRoot || process.cwd(),
    extraRoots: Array.isArray(body.extraRoots) ? body.extraRoots : current?.extraRoots || [],
    mode: body.mode || current?.mode || "safe",
    policy: body.policy || current?.policy || "balanced",
    port: Number(body.port || current?.port || 8787),
    dashboardPort: Number(body.dashboardPort || current?.dashboardPort || 8790),
    tunnelId: body.tunnelId || current?.tunnelId || "",
    organizationId: body.organizationId || current?.organizationId || "",
    updatedAt: new Date().toISOString()
  };
  data.profiles = (data.profiles || []).filter((item) => item.id !== profile.id);
  data.profiles.push(profile);
  await mkdir(state.storageDir, { recursive: true });
  await writeFile(join(state.storageDir, "profiles.json"), JSON.stringify(data, null, 2), "utf8");
  return { ok: true, profile, profiles: data.profiles };
}

async function deleteProfile(state, id) {
  if (!id) throw new Error("profile id is required");
  const data = await readProfiles(state);
  const before = (data.profiles || []).length;
  data.profiles = (data.profiles || []).filter((item) => item.id !== id);
  await mkdir(state.storageDir, { recursive: true });
  await writeFile(join(state.storageDir, "profiles.json"), JSON.stringify(data, null, 2), "utf8");
  if (state.activeProfile?.id === id) state.activeProfile = null;
  return { ok: true, deleted: before !== data.profiles.length, profiles: data.profiles };
}

async function activateProfile(state, body) {
  const data = await readProfiles(state);
  const profile = (data.profiles || []).find((item) => item.id === body.id);
  if (!profile) throw new Error(`Profile not found: ${body.id || ""}`);
  state.activeProfile = profile;
  state.mcpEndpoint = profile.endpoint || `http://127.0.0.1:${profile.port || 8787}/mcp`;
  state.dashboardUrl = `http://127.0.0.1:${profile.dashboardPort || 8790}`;
  if (state.client) {
    await state.client.close().catch(() => {});
    state.client = null;
    state.tools = [];
  }
  return { ok: true, profile, endpoint: state.mcpEndpoint, dashboardUrl: state.dashboardUrl };
}

async function exportProfiles(state) {
  const data = await readProfiles(state);
  return {
    exportedAt: new Date().toISOString(),
    profiles: (data.profiles || []).map((profile) => ({
      ...profile,
      tunnelId: profile.tunnelId ? "[configured]" : "",
      organizationId: profile.organizationId ? "[configured]" : ""
    }))
  };
}

async function serverStatus(state) {
  const port = state.activeProfile?.port || Number(new URL(state.mcpEndpoint).port || 8787);
  let health = null;
  try {
    health = await httpJson(`http://127.0.0.1:${port}/healthz`, {}, { retries: 0 });
  } catch {
    health = null;
  }
  return {
    ok: true,
    running: health?.status === "ok",
    managed: Boolean(state.serverProcess && !state.serverProcess.killed),
    pid: health?.pid || state.serverProcess?.pid || null,
    health,
    logs: state.serverLogs.slice(-100)
  };
}

async function startManagedServer(state, body) {
  if (!state.repoRoot) throw new Error("Could not locate the Local Coding Agent repo root.");
  const profile = state.activeProfile || {};
  const port = Number(body.port || profile.port || 8787);
  const dashboardPort = Number(body.dashboardPort || profile.dashboardPort || 8790);
  const workspace = resolve(body.workspace || profile.workspace || state.repoRoot);
  state.mcpEndpoint = `http://127.0.0.1:${port}/mcp`;
  state.dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
  const existing = await serverStatus(state);
  if (existing.running) return { ...existing, endpoint: state.mcpEndpoint, dashboardUrl: state.dashboardUrl, alreadyRunning: true };
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: join(state.repoRoot, "server"),
    env: {
      ...process.env,
      PORT: String(port),
      DASHBOARD_PORT: String(dashboardPort),
      AGENT_WORKSPACE: workspace,
      AGENT_EXTRA_ROOTS_JSON: JSON.stringify(body.extraRoots || profile.extraRoots || []),
      AGENT_MODE: body.mode || profile.mode || "safe",
      AGENT_POLICY: body.policy || profile.policy || "balanced"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  state.serverProcess = child;
  state.serverLogs = [];
  child.stdout.on("data", (chunk) => appendServerLog(state, chunk));
  child.stderr.on("data", (chunk) => appendServerLog(state, chunk, "ERR"));
  child.on("exit", (code, signal) => {
    state.serverLogs.push(`${new Date().toISOString()} EXIT code=${code} signal=${signal || ""}`);
    state.serverProcess = null;
  });
  for (let i = 0; i < 40; i++) {
    const status = await serverStatus(state);
    if (status.running) return { ...status, endpoint: state.mcpEndpoint, dashboardUrl: state.dashboardUrl, workspace };
    await sleep(250);
  }
  throw new Error(`Managed MCP server did not become healthy on port ${port}`);
}

async function stopManagedServer(state) {
  const child = state.serverProcess;
  if (!child) return { ok: true, stopped: false, reason: "No server process was started by this Studio instance." };
  if (process.platform === "win32") {
    await runChild("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], process.cwd());
  } else {
    child.kill("SIGTERM");
  }
  state.serverProcess = null;
  if (state.client) {
    await state.client.close().catch(() => {});
    state.client = null;
    state.tools = [];
  }
  return { ok: true, stopped: true };
}

function appendServerLog(state, chunk, prefix = "OUT") {
  for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
    state.serverLogs.push(`${new Date().toISOString()} ${prefix} ${line}`);
  }
  if (state.serverLogs.length > 500) state.serverLogs.splice(0, state.serverLogs.length - 500);
}

async function dashboardJson(state, path, options = {}) {
  const url = `${state.dashboardUrl.replace(/\/+$/, "")}${path}`;
  return httpJson(url, options, { retries: 0 });
}

async function validateSkills(state) {
  if (!state.repoRoot) throw new Error("Could not locate repo root.");
  const result = await runChild(process.execPath, [join(state.repoRoot, "scripts", "validate-skills.mjs")], state.repoRoot);
  return { ok: result.code === 0, ...result };
}

async function runCustomerUpdate(state, body) {
  if (!state.repoRoot) throw new Error("Could not locate repo root.");
  if (body.confirm !== "update") throw new Error('Set confirm="update" to run the guarded customer update flow.');
  const args = [join(state.repoRoot, "scripts", "local-coding-agent.mjs"), "update"];
  if (body.force === true) args.push("--force");
  const result = await runChild(process.execPath, args, state.repoRoot, 15 * 60_000);
  return { ok: result.code === 0, ...result };
}

async function writeSupportBundle(state) {
  await mkdir(join(state.storageDir, "support-bundles"), { recursive: true });
  const stamp = Date.now();
  const bundleDir = join(state.storageDir, "support-bundles");
  const file = join(bundleDir, `support-${stamp}.json`);
  const networkDoctorPath = join(bundleDir, `network-doctor-${stamp}.txt`);
  const status = (state.manifest.features || []).includes("serverSupervisor") ? await serverStatus(state) : null;
  let metrics = null;
  let approvals = null;
  try { metrics = await dashboardJson(state, "/metrics"); } catch {}
  try { approvals = await dashboardJson(state, "/api/approvals"); } catch {}
  let doctor = null;
  if (state.client && state.tools.some((tool) => tool.name === "workspace_doctor")) {
    doctor = await callMcpTool(state, "workspace_doctor", {});
  }
  let networkDoctor = null;
  if (state.repoRoot) {
    const mcpUrl = state.mcpEndpoint;
    const healthUrl = mcpUrl.replace(/\/mcp(?:\?.*)?$/, "/healthz");
    const result = await runChild(process.execPath, [
      join(state.repoRoot, "scripts", "network-doctor.mjs"),
      "--out", networkDoctorPath,
      "--mcp-url", mcpUrl,
      "--health-url", healthUrl,
      "--dashboard-url", `${state.dashboardUrl.replace(/\/+$/, "")}/ui`,
      "--no-tunnel-smoke"
    ], state.repoRoot, 90_000);
    networkDoctor = {
      ok: result.code === 0,
      path: networkDoctorPath,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
  const report = {
    createdAt: new Date().toISOString(),
    health: healthPayload(state),
    server: status,
    metrics,
    approvals,
    workspaceDoctor: doctor,
    networkDoctor,
    events: state.events.slice(-50),
    tools: publicTools(state.tools),
    redaction: "No API keys or environment secret values are included."
  };
  await writeFile(file, JSON.stringify(report, null, 2), "utf8");
  return { ok: true, path: file, report };
}

function assertFeature(manifest, name) {
  if (!(manifest.features || []).includes(name)) throw new Error(`Feature not enabled in ${manifest.version}: ${name}`);
}

async function httpJson(url, options = {}, config = {}) {
  const retries = Number(config.retries ?? 2);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = new Error(data?.error?.message || data?.error || `${res.status} ${res.statusText}`);
        error.status = res.status;
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error;
      const retryable = !error?.status || error.status === 429 || error.status >= 500;
      if (attempt >= retries || !retryable) break;
      await sleep(300 * (2 ** attempt));
    }
  }
  throw lastError;
}

function openAiTool(tool) {
  return {
    type: "function",
    name: sanitizeToolName(tool.name),
    description: tool.description || tool.title || `Call MCP tool ${tool.name}`,
    parameters: normalizeSchema(tool.inputSchema)
  };
}

function anthropicTool(tool) {
  return {
    name: tool.name,
    description: tool.description || tool.title || `Call MCP tool ${tool.name}`,
    input_schema: normalizeSchema(tool.inputSchema)
  };
}

function ollamaTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || tool.title || `Call MCP tool ${tool.name}`,
      parameters: normalizeSchema(tool.inputSchema)
    }
  };
}

function publicTools(tools, schema = false) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || tool.title || "",
    ...(schema ? { inputSchema: tool.inputSchema || {} } : {})
  }));
}

function systemPrompt(manifest) {
  return `You are ${manifest.productName} ${manifest.version}, a standalone local AI coding assistant connected to a Local Coding Agent MCP server.

Rules:
- First inspect the workspace with workspace_info or workspace_snapshot when the task needs repo context.
- Prefer MCP file/search/git tools over shell commands.
- Use read_many for multiple files and run_commands for independent checks.
- Keep edits scoped to the user request.
- Explain risky actions before mutating files or running commands.
- After changing code, run the most relevant checks available.
- If a tool call is denied by policy, explain what approval or safer alternative is needed.`;
}

function extractOpenAiText(response) {
  if (typeof response?.output_text === "string" && response.output_text) return response.output_text;
  const parts = [];
  for (const item of response?.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" || content.type === "text") parts.push(content.text || "");
    }
  }
  return parts.filter(Boolean).join("\n").trim();
}

function anthropicText(response) {
  return (response?.content || []).filter((item) => item.type === "text").map((item) => item.text || "").join("\n").trim();
}

function toolResultText(result) {
  return result?.content?.map((part) => part.text || JSON.stringify(part)).join("\n") || "";
}

function originalToolName(state, sanitized) {
  const hit = state.tools.find((tool) => sanitizeToolName(tool.name) === sanitized);
  return hit?.name || sanitized;
}

function sanitizeToolName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const out = JSON.parse(JSON.stringify(schema));
  if (!out.type) out.type = "object";
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2_000_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, body) {
  sendText(res, status, JSON.stringify(body, null, 2), "application/json; charset=utf-8");
}

function sendText(res, status, body, type) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function getStorageDir(version) {
  const base = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || process.env.HOME || APP_DIR;
  return join(base, "LocalAgentStudio", version);
}

function findRepoRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "server", "server.mjs")) &&
        existsSync(join(current, "scripts", "local-coding-agent.mjs"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function runChild(fileName, args, cwd, timeoutMs = 5 * 60_000) {
  return new Promise((resolveRun) => {
    const child = spawn(fileName, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (process.platform === "win32") {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function safeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "profile";
}

function renderHtml(manifest) {
  const features = new Set(manifest.features || []);
  const providers = manifest.providers || ["openai"];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(manifest.productName)} ${escapeHtml(manifest.version)}</title>
  <style>
    :root{color-scheme:dark;--bg:#0b0f14;--panel:#111821;--panel2:#0f151d;--text:#e5edf7;--muted:#8ea0b8;--line:#223044;--accent:#28d7bd;--warn:#f7b955;--bad:#ff6b6b}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line);background:#0d131b}h1{font-size:18px;margin:0}h2{font-size:14px;margin:14px 0 8px;color:#b9c8dc}main{display:grid;grid-template-columns:330px minmax(0,1fr)430px;min-height:calc(100vh - 58px)}section{border-right:1px solid var(--line);padding:14px;min-width:0}section:last-child{border-right:0}label{display:block;color:var(--muted);font-size:12px;margin:10px 0 6px}input,textarea,select{width:100%;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:9px 10px;font:inherit}textarea{min-height:128px;resize:vertical}button{background:var(--accent);color:#04110f;border:0;border-radius:6px;padding:9px 12px;font-weight:700;cursor:pointer;margin-top:10px}button.secondary{background:#1b2532;color:var(--text);border:1px solid var(--line)}.row{display:flex;gap:8px;align-items:center}.row>*{flex:1}.pill{display:inline-flex;gap:6px;color:var(--muted);border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:5px 9px;font-size:12px}.ok{color:var(--accent)}.bad{color:var(--bad)}.muted{color:var(--muted)}.box,.msg,.tool{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;margin-top:9px}.tools,.timeline{display:flex;flex-direction:column;gap:8px;overflow:auto}.tools{max-height:calc(100vh - 360px)}.timeline{max-height:calc(100vh - 116px)}.chat{display:flex;flex-direction:column;gap:10px;height:calc(100vh - 86px)}.messages{flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px;padding-right:4px}.msg{white-space:pre-wrap}.msg.user{border-color:#2c6a7a}.msg.agent{border-color:#246b5e}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0;color:#c9d7e8;font-size:12px}.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{font-size:12px;color:#c9d7e8;border:1px solid var(--line);border-radius:999px;padding:4px 8px;background:#172131}@media(max-width:980px){main{grid-template-columns:1fr}section{border-right:0;border-bottom:1px solid var(--line)}.chat{height:auto;min-height:520px}}
  </style>
</head>
<body>
  <header><h1>${escapeHtml(manifest.productName)} <span class="muted">${escapeHtml(manifest.version)}</span></h1><span class="pill" id="health">checking...</span></header>
  <main>
    <section>
      <h2>Connection</h2>
      ${features.has("serverSupervisor") ? `<div class="row"><button id="startServer">Start MCP</button><button class="secondary" id="stopServer">Stop MCP</button><button class="secondary" id="serverStatus">Status</button></div>` : ""}
      <label>MCP endpoint</label><input id="endpoint" value="${escapeHtml(manifest.defaultMcpEndpoint || DEFAULT_MCP_URL)}" />
      <button id="connect">Connect MCP</button> <button class="secondary" id="refresh">Refresh Tools</button>
      <div class="box"><b>Status</b><div id="status" class="muted">Not connected yet.</div></div>
      <h2>Features</h2><div class="chips">${(manifest.features || []).map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>
      ${features.has("profiles") ? `<h2>Profiles</h2><button class="secondary" id="saveProfile">Save</button> <button class="secondary" id="loadProfiles">Manage</button> <button class="secondary" id="exportProfiles">Export</button><div id="profiles" class="box muted">No profiles loaded.</div>` : ""}
      ${features.has("skills") ? `<h2>Skills</h2><button class="secondary" id="skills">List</button> <button class="secondary" id="readSkill">Read</button> <button class="secondary" id="validateSkills">Validate</button>` : ""}
      ${features.has("dashboard") ? `<h2>Operations</h2><button class="secondary" id="metrics">Metrics</button> <button class="secondary" id="approvals">Approvals</button>` : ""}
      ${features.has("fileViewer") ? `<button class="secondary" id="readFile">Read File</button> <button class="secondary" id="diff">Git Diff</button>` : ""}
      ${features.has("supportBundle") ? `<h2>Support</h2><button class="secondary" id="support">Export Support Bundle</button>` : ""}
      ${features.has("customerUpdateFlow") ? `<h2>Update</h2><button class="secondary" id="update">Run Guarded Update</button>` : ""}
      <h2>Tools</h2><div class="tools" id="tools"></div>
    </section>
    <section>
      <div class="chat">
        <div class="row">
          <div><label>Provider</label><select id="provider">${providers.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("")}</select></div>
          <div><label>Model</label><input id="model" value="${escapeHtml(manifest.defaultModel || DEFAULT_MODEL)}" /></div>
        </div>
        ${features.has("modelRouter") ? `<div><label>Preset</label><select id="preset"><option value="">Custom</option></select></div>` : ""}
        <div class="messages" id="messages"></div>
        <div><label>Ask the agent</label><textarea id="prompt" placeholder="Example: Call workspace_info, then summarize this workspace."></textarea><button id="send">Send</button></div>
      </div>
    </section>
    <section><h2>Tool Timeline</h2><div class="timeline" id="timeline"></div></section>
  </main>
  <script>
    const $=(id)=>document.getElementById(id); const state={tools:[]};
    async function api(path,options={}){const res=await fetch(path,{...options,headers:{"content-type":"application/json",...(options.headers||{})}});const data=await res.json();if(!res.ok)throw new Error(data.error||res.statusText);return data}
    function addMessage(kind,text){const div=document.createElement("div");div.className="msg "+kind;div.textContent=text;$("messages").appendChild(div);$("messages").scrollTop=$("messages").scrollHeight;return div}
    function escapeHtml(text){return String(text).replace(/[&<>"']/g,(ch)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[ch]))}
    function renderTools(){ $("tools").innerHTML=""; for(const tool of state.tools){const div=document.createElement("div");div.className="tool";div.innerHTML="<b>"+escapeHtml(tool.name)+"</b><span class='muted'>"+escapeHtml(tool.description||"")+"</span>";const btn=document.createElement("button");btn.className="secondary";btn.textContent="Call";btn.onclick=async()=>{const raw=prompt("JSON arguments for "+tool.name,"{}");if(raw===null)return;try{const args=JSON.parse(raw);const data=await api("/api/call-tool",{method:"POST",body:JSON.stringify({name:tool.name,arguments:args})});addTimeline(data.event||{tool:tool.name,args,isError:!data.ok,ms:data.ms,result:JSON.stringify(data.result,null,2)})}catch(err){addTimeline({tool:tool.name,args:{},isError:true,ms:0,result:err.message})}};div.appendChild(btn);$("tools").appendChild(div)}}
    function addTimeline(event){const div=document.createElement("div");div.className="box";const status=event.isError?"<span class='bad'>error</span>":"<span class='ok'>ok</span>";div.innerHTML="<b>"+escapeHtml(event.tool)+"</b> "+status+" <span class='muted'>"+(event.ms||0)+"ms</span><pre>"+escapeHtml(JSON.stringify(event.args||{},null,2))+"</pre><pre>"+escapeHtml(String(event.result||"").slice(0,4000))+"</pre>";$("timeline").prepend(div)}
    async function health(){try{const data=await api("/api/health");$("health").innerHTML=data.openai_key_present||data.anthropic_key_present?"<span class='ok'>ready</span>":"<span class='bad'>missing API key</span>";if($("preset")){const p=await api("/api/model-presets");for(const item of p.presets||[]){const opt=document.createElement("option");opt.value=item.id;opt.textContent=item.label+" - "+item.provider+"/"+item.model;opt.dataset.provider=item.provider;opt.dataset.model=item.model;$("preset").appendChild(opt)}$("preset").onchange=()=>{const opt=$("preset").selectedOptions[0];if(opt&&opt.dataset.provider){$("provider").value=opt.dataset.provider;$("model").value=opt.dataset.model}}}}catch{$("health").innerHTML="<span class='bad'>offline</span>"}}
    async function connect(){ $("status").textContent="Connecting..."; const data=await api("/api/connect",{method:"POST",body:JSON.stringify({endpoint:$("endpoint").value.trim()})}); state.tools=data.tools||[]; $("status").textContent="Connected to "+data.endpoint+". "+state.tools.length+" tools."; renderTools()}
    async function refreshTools(){const data=await api("/api/tools");state.tools=data.tools||[];$("status").textContent="Connected to "+data.endpoint+". "+state.tools.length+" tools.";renderTools()}
    async function send(){const message=$("prompt").value.trim();if(!message)return;$("prompt").value="";addMessage("user",message);const last=addMessage("agent","Thinking...");try{const data=await api("/api/chat",{method:"POST",body:JSON.stringify({message,provider:$("provider").value,model:$("model").value.trim()})});last.textContent=data.text||"(no text)";for(const event of data.timeline||[])addTimeline(event)}catch(err){last.textContent="Error: "+err.message}}
    async function saveProfile(){const name=prompt("Profile name","Default");if(!name)return;const workspace=prompt("Workspace path","")||"";const data=await api("/api/profiles",{method:"POST",body:JSON.stringify({name,workspace,endpoint:$("endpoint").value.trim(),provider:$("provider").value,model:$("model").value.trim(),mode:"safe",policy:"balanced"})});renderProfileList(data.profiles)}
    function renderProfileList(profiles){$("profiles").textContent=(profiles||[]).map(p=>p.id+" | "+p.name+" | "+p.provider+"/"+p.model+" | "+p.workspace).join("\\n")||"No profiles."}
    async function manageProfiles(){const data=await api("/api/profiles");renderProfileList(data.profiles);const action=prompt("Enter profile id to activate, or delete:<id>","");if(!action)return;if(action.startsWith("delete:")){const deleted=await api("/api/profiles?id="+encodeURIComponent(action.slice(7)),{method:"DELETE"});renderProfileList(deleted.profiles);return}const active=await api("/api/profiles/activate",{method:"POST",body:JSON.stringify({id:action})});$("endpoint").value=active.endpoint;$("provider").value=active.profile.provider;$("model").value=active.profile.model;$("status").textContent="Activated profile "+active.profile.name}
    async function exportProfiles(){const data=await api("/api/profiles/export");addMessage("agent","Redacted profiles:\\n"+JSON.stringify(data,null,2))}
    async function listSkills(){const data=await api("/api/skills");addTimeline({tool:"list_skills",args:{},isError:!data.ok,ms:data.ms,result:JSON.stringify(data.result,null,2)})}
    async function readSkill(){const name=prompt("Skill name","");if(!name)return;const data=await api("/api/skills?name="+encodeURIComponent(name));addTimeline({tool:"read_skill",args:{name},isError:!data.ok,ms:data.ms,result:JSON.stringify(data.result,null,2)})}
    async function validateSkills(){const data=await api("/api/skills/validate",{method:"POST",body:"{}"});addMessage("agent","Skill validation "+(data.ok?"passed":"failed")+":\\n"+data.stdout+"\\n"+data.stderr)}
    async function showMetrics(){const data=await api("/api/dashboard/metrics");addMessage("agent","Dashboard metrics:\\n"+JSON.stringify(data,null,2))}
    async function manageApprovals(){const data=await api("/api/approvals");addMessage("agent","Pending approvals:\\n"+JSON.stringify(data.pending||[],null,2));const action=prompt("Optional action: approve:<id> or deny:<id>","");if(!action)return;const parts=action.split(":");if(parts.length===2)await api("/api/approvals/"+encodeURIComponent(parts[1])+"/"+encodeURIComponent(parts[0]),{method:"POST",body:"{}"})}
    async function readWorkspaceFile(){const path=prompt("Workspace-relative file path","README.md");if(!path)return;const data=await api("/api/dashboard/file?path="+encodeURIComponent(path));addMessage("agent",data.path+"\\n\\n"+data.content)}
    async function showDiff(){const data=await api("/api/dashboard/diff");addMessage("agent","Git diff:\\n"+(data.diff||data.error||"(empty)"))}
    async function startServer(){const workspace=prompt("Workspace path for MCP server","");const data=await api("/api/server/start",{method:"POST",body:JSON.stringify({workspace:workspace||undefined,mode:"safe",policy:"balanced"})});$("endpoint").value=data.endpoint;$("status").textContent="MCP server running at "+data.endpoint}
    async function stopServer(){const data=await api("/api/server/stop",{method:"POST",body:"{}"});$("status").textContent=data.stopped?"Managed MCP server stopped.":data.reason}
    async function serverStatus(){const data=await api("/api/server/status");addMessage("agent","Server status:\\n"+JSON.stringify(data,null,2))}
    async function supportBundle(){const data=await api("/api/support-bundle",{method:"POST",body:"{}"});addMessage("agent","Support bundle written:\\n"+data.path)}
    async function runUpdate(){if(prompt('Type "update" to run guarded repository update','')!=="update")return;const data=await api("/api/update",{method:"POST",body:JSON.stringify({confirm:"update"})});addMessage("agent","Update "+(data.ok?"completed":"failed")+":\\n"+data.stdout+"\\n"+data.stderr)}
    $("connect").onclick=()=>connect().catch(err=>$("status").textContent=err.message);$("refresh").onclick=()=>refreshTools().catch(err=>$("status").textContent=err.message);$("send").onclick=send;$("prompt").addEventListener("keydown",(event)=>{if(event.ctrlKey&&event.key==="Enter")send()});
    if($("saveProfile"))$("saveProfile").onclick=saveProfile;if($("loadProfiles"))$("loadProfiles").onclick=manageProfiles;if($("exportProfiles"))$("exportProfiles").onclick=exportProfiles;
    if($("skills"))$("skills").onclick=listSkills;if($("readSkill"))$("readSkill").onclick=readSkill;if($("validateSkills"))$("validateSkills").onclick=validateSkills;
    if($("metrics"))$("metrics").onclick=showMetrics;if($("approvals"))$("approvals").onclick=manageApprovals;if($("readFile"))$("readFile").onclick=readWorkspaceFile;if($("diff"))$("diff").onclick=showDiff;
    if($("startServer"))$("startServer").onclick=startServer;if($("stopServer"))$("stopServer").onclick=stopServer;if($("serverStatus"))$("serverStatus").onclick=serverStatus;
    if($("support"))$("support").onclick=supportBundle;if($("update"))$("update").onclick=runUpdate;health();
  </script>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
