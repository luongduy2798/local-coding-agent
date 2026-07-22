// Local Coding Agent runtime hardening regression suite
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(TEST_DIR, "../..", "server.mjs");
const CLI = path.resolve(TEST_DIR, "../../..", "scripts", "local-coding-agent.mjs");
let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? `\n${detail}` : ""}`);
  }
}

async function waitFor(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

async function startServer(workspace, { port, policy = "strict", auth = "", approvalToken = "", maxBody = "1048576" }) {
  await mkdir(workspace, { recursive: true });
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
      MCP_AUTH_TOKEN: auth,
      AGENT_APPROVAL_TOKEN: approvalToken,
      AGENT_MAX_BODY_BYTES: maxBody,
      LCA_TEST_RUN_ID: testContext.runId,
      LCA_TEST_RUNTIME_DIAGNOSTICS: "1"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  await waitFor(`http://127.0.0.1:${port}/healthz`).catch((error) => {
    throw new Error(`${error.message}\n${stderr}`);
  });
  return child;
}

async function stopServer(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function connect(port) {
  const client = new Client({ name: "hardening-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), text: result.content?.[0]?.text || "" };
}

async function openRuntimeTask(client, title) {
  const info = JSON.parse((await call(client, "lca_status")).text);
  const opened = await call(client, "task_open", {
    title,
    primary_workspace_id: info.primary_workspace_id
  });
  if (opened.isError) throw new Error(`task_open failed: ${opened.text}`);
  return JSON.parse(opened.text).task;
}

function decideApproval(action, id, cwd) {
  return spawnSync(process.execPath, [CLI, "approval", action, id], {
    cwd,
    env: { ...process.env, AGENT_DATA_DIR: testContext.dataDir },
    encoding: "utf8",
    windowsHide: true
  });
}

function callPayload(result) {
  try { return JSON.parse(result.text || "{}"); } catch { return {}; }
}

async function changeApi(port, method, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}

function chunkedPost(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" }
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write(body.slice(0, Math.floor(body.length / 2)));
    req.end(body.slice(Math.floor(body.length / 2)));
  });
}

const testContext = await createIsolatedTestRoot({ prefix: "lca-hardening-", protectedPaths: [path.resolve("..")] });
const base = testContext.fixtureDir;
let server;
try {
  // Strict policy + browser-origin + body limit + removed legacy UI routes.
  console.log("\n[phase] strict policy, origin, body limit, no legacy UI routes");
  const strictPort = await getFreePort();
  server = await startServer(path.join(base, "strict"), { port: strictPort, policy: "strict", maxBody: "8192" });
  const evil = await fetch(`http://127.0.0.1:${strictPort}/mcp`, {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" }
  });
  check("browser Origin is denied by default", evil.status === 403, `status=${evil.status}`);

  const client = await connect(strictPort);
  const strictTask = await openRuntimeTask(client, "Strict aggregate-policy hardening");
  check("strict policy blocks apply_patch create", (await call(client, "apply_patch", { operations: [{ op: "create", path: "blocked.txt", content: "x" }] })).isError);
  check("strict policy blocks run_command", (await call(client, "run_command", { command: "node --version" })).isError);
  check("strict policy blocks run_commands", (await call(client, "run_commands", { commands: [{ command: "node --version" }] })).isError);
  check("strict policy blocks aggregate process start", (await call(client, "process", { action: "start", command: "node --version", task_token: strictTask.task_token })).isError);
  check("strict policy blocks aggregate skill creation", (await call(client, "skills", { action: "create", name: "blocked", description: "blocked", body: "blocked", task_token: strictTask.task_token })).isError);
  check("strict policy blocks aggregate note writes", (await call(client, "notes", { action: "save", title: "blocked", body: "blocked", task_token: strictTask.task_token })).isError);
  check("strict policy blocks verification command execution", (await call(client, "verify_changes", { task_token: strictTask.task_token })).isError);
  check("strict policy still allows read-only task state", !(await call(client, "task_state", { task_token: strictTask.task_token })).isError);
  await call(client, "lca_status");
  await client.close();

  const metricsRoute = await fetch(`http://127.0.0.1:${strictPort}/metrics`);
  const uiRoute = await fetch(`http://127.0.0.1:${strictPort}/ui`);
  const companionRoute = await fetch(`http://127.0.0.1:${strictPort}/companion`);
  const evilCompanion = await fetch(`http://127.0.0.1:${strictPort}/companion/api/workspace_search`, {
    method: "POST",
    headers: { Origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ query: "@" })
  });
  check("legacy UI metrics route is gone", metricsRoute.status === 404, `status=${metricsRoute.status}`);
  check("legacy UI ui route is gone", uiRoute.status === 404, `status=${uiRoute.status}`);
  check("companion standalone HTTP route is gone", companionRoute.status === 404, `status=${companionRoute.status}`);
  check("hostile browser Origin is rejected", evilCompanion.status === 403, `status=${evilCompanion.status}`);
  check("chunked payload is size-limited", (await chunkedPost(strictPort, JSON.stringify({ data: "x".repeat(12000) }))) === 413);
  await stopServer(server);
  server = null;

  // Balanced policy approvals are decided through the local operator token.
  console.log("\n[phase] token-only one-time approvals");
  const balancedSecret = `LCA_BALANCED_APPROVAL_${Date.now()}`;
  const balancedWorkspace = path.join(base, "balanced");
  const balancedPort = await getFreePort();
  server = await startServer(balancedWorkspace, { port: balancedPort, policy: "balanced", approvalToken: balancedSecret });
  const balanced = await connect(balancedPort);
  const balancedTask = await openRuntimeTask(balanced, "Balanced approval hardening");
  const listedBalancedTools = await balanced.listTools();
  const balancedToolNames = listedBalancedTools.tools.map((tool) => tool.name);
  check(
    "approval controls are local-only and absent from the MCP catalog",
    ["request_approval", "request_approval_batch", "approve_request", "deny_request"].every((name) => !balancedToolNames.includes(name)),
    balancedToolNames.join(",")
  );
  const seededVictim = await call(balanced, "apply_patch", {
    task_token: balancedTask.task_token,
    operations: [{ op: "create", path: "victim.txt", content: "x" }]
  });
  check("balanced policy permits a normal seed write", !seededVictim.isError, seededVictim.text);
  const seededSkill = await call(balanced, "skills", {
    action: "create",
    name: "balanced-skill",
    description: "Balanced policy fixture",
    body: "# Fixture\n",
    task_token: balancedTask.task_token
  });
  check("balanced policy permits aggregate skill creation", !seededSkill.isError, seededSkill.text);
  const blockedSkillDelete = await call(balanced, "skills", {
    action: "delete",
    name: "balanced-skill",
    task_token: balancedTask.task_token
  });
  check("balanced policy requires local approval for aggregate skill deletion", blockedSkillDelete.isError && blockedSkillDelete.text.includes("Approval required"), blockedSkillDelete.text);
  const victimDelete = {
    task_token: balancedTask.task_token,
    operations: [{ op: "delete", path: "victim.txt" }]
  };
  const blockedDelete = await call(balanced, "apply_patch", victimDelete);
  check("balanced policy blocks delete before approval", blockedDelete.isError && blockedDelete.text.includes("Approval required") && blockedDelete.text.includes("victim.txt"));
  const deleteRequestId = callPayload(blockedDelete).details?.request_id;
  check("approval error returns a local request id", /^[0-9a-f-]{36}$/i.test(deleteRequestId || ""), blockedDelete.text);
  const blockedRiskyBatch = await call(balanced, "run_commands", {
    task_token: balancedTask.task_token,
    commands: [{ command: "curl -o downloaded.txt https://example.invalid" }]
  });
  check("balanced policy does not let run_commands bypass risky-command approval", blockedRiskyBatch.isError && blockedRiskyBatch.text.includes("Approval required"));
  const approvedLocally = decideApproval("approve", deleteRequestId, balancedWorkspace);
  check("local CLI approves the exact pending action", approvedLocally.status === 0 && /approved/.test(approvedLocally.stdout), approvedLocally.stderr || approvedLocally.stdout);
  const approvedDelete = await call(balanced, "apply_patch", victimDelete);
  check("approved action executes once", !approvedDelete.isError, approvedDelete.text);
  await call(balanced, "apply_patch", {
    task_token: balancedTask.task_token,
    operations: [{ op: "create", path: "victim.txt", content: "x" }]
  });
  const replayedDelete = await call(balanced, "apply_patch", victimDelete);
  check("consumed approval cannot be replayed", replayedDelete.isError && callPayload(replayedDelete).details?.request_id !== deleteRequestId, replayedDelete.text);
  check("local CLI cannot approve the consumed request twice", decideApproval("approve", deleteRequestId, balancedWorkspace).status !== 0);
  const replayRequestId = callPayload(replayedDelete).details?.request_id;
  const deniedLocally = decideApproval("deny", replayRequestId, balancedWorkspace);
  check("local CLI can deny a pending request", deniedLocally.status === 0 && /denied/.test(deniedLocally.stdout), deniedLocally.stderr || deniedLocally.stdout);
  check("denied request cannot be approved later", decideApproval("approve", replayRequestId, balancedWorkspace).status !== 0);
  check("local approval command rejects path-like ids", decideApproval("approve", "../outside", balancedWorkspace).status !== 0);

  const blockedConcurrent = await call(balanced, "run_command", {
    command: "git fetch --dry-run",
    task_token: balancedTask.task_token
  });
  const concurrentRequestId = callPayload(blockedConcurrent).details?.request_id;
  check("risky command produces an exact approval request", blockedConcurrent.isError && Boolean(concurrentRequestId), blockedConcurrent.text);
  check("local CLI approves the concurrent command once", decideApproval("approve", concurrentRequestId, balancedWorkspace).status === 0);
  const concurrentResults = await Promise.all([
    call(balanced, "run_command", { command: "git fetch --dry-run", task_token: balancedTask.task_token }),
    call(balanced, "run_command", { command: "git fetch --dry-run", task_token: balancedTask.task_token })
  ]);
  check("one-time approval remains one-time under concurrent calls", concurrentResults.filter((result) => result.isError).length === 1);
  await balanced.close();
  await stopServer(server);
  server = null;
  const approvalAudit = await readFile(path.join(testContext.dataDir, "runtime", "audit.log"), "utf8").catch(() => "");
  check("audit log redacts approval_token", !approvalAudit.includes(balancedSecret));

  // Query-string tokens must not authenticate.
  console.log("\n[phase] header-only bearer authentication");
  const authPort = await getFreePort();
  server = await startServer(path.join(base, "auth"), { port: authPort, policy: "full", auth: "operator-secret" });
  const queryAuth = await fetch(`http://127.0.0.1:${authPort}/mcp?token=operator-secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  check("query-string bearer token is rejected", queryAuth.status === 401, `status=${queryAuth.status}`);
  await stopServer(server);
  server = null;

  // Undo must cover created files and renamed directories.
  const workspaceA = path.join(base, "workspace-a");
  console.log("\n[phase] transactional undo coverage");
  const undoPort = await getFreePort();
  server = await startServer(workspaceA, { port: undoPort, policy: "full" });
  const full = await connect(undoPort);
  const fullTask = await openRuntimeTask(full, "Transactional undo hardening");
  const createdChange = JSON.parse((await call(full, "apply_patch", {
    task_token: fullTask.task_token,
    operations: [{ op: "create", path: "created.txt", content: "created" }]
  })).text);
  await changeApi(undoPort, "POST", `/changes/${createdChange.change_id}/undo`, {});
  check("Review Changes undo removes files created by apply_patch", (await call(full, "read_file", { path: "created.txt", task_token: fullTask.task_token })).isError);
  await call(full, "apply_patch", {
    task_token: fullTask.task_token,
    operations: [{ op: "create", path: "source.txt", content: "a" }]
  });
  const movedChange = JSON.parse((await call(full, "apply_patch", {
    task_token: fullTask.task_token,
    operations: [{ op: "rename", path: "source.txt", rename_to: "dest.txt" }]
  })).text);
  await changeApi(undoPort, "POST", `/changes/${movedChange.change_id}/undo`, {});
  check("Review Changes undo restores renamed file source", !(await call(full, "read_file", { path: "source.txt", task_token: fullTask.task_token })).isError);
  check("Review Changes undo removes renamed file destination", (await call(full, "read_file", { path: "dest.txt", task_token: fullTask.task_token })).isError);
  await full.close();
  await stopServer(server);
  server = null;

  // History is scoped to the workspace and cannot replay into an old root.
  console.log("\n[phase] workspace-scoped history");
  const isolatedPort = await getFreePort();
  server = await startServer(path.join(base, "workspace-b"), { port: isolatedPort, policy: "full" });
  const other = await connect(isolatedPort);
  const isolatedChanges = await changeApi(isolatedPort, "GET", "/changes?limit=10");
  check("new workspace cannot see another workspace change history", isolatedChanges.status === 200 && isolatedChanges.data.count === 0, JSON.stringify(isolatedChanges.data));
  await other.close();
} finally {
  if (server) await stopServer(server);
  await safeRemove(base, testContext, { recursive: true, force: true });
}

console.log(`\n==== HARDENING: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
