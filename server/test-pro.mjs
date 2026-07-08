// Local Coding Agent Pro regression tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER = path.resolve("server.mjs");
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
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, stderrRef) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`Server did not become ready on port ${port}\n${stderrRef.value}`);
}

async function startServer(workspace) {
  await mkdir(workspace, { recursive: true });
  const port = await getFreePort();
  const stderrRef = { value: "" };
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_WORKSPACE: workspace,
      AGENT_MODE: "safe",
      AGENT_POLICY: "full",
      AGENT_EXTRA_ROOTS_JSON: "[]",
      MCP_AUTH_TOKEN: "",
      AGENT_AUDIT: "0"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => (stderrRef.value += chunk));
  await waitForHealth(port, stderrRef);
  return { child, port };
}

async function stopServer(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  await wait(300);
}

async function connect(port) {
  const client = new Client({ name: "agent-pro-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  return client;
}

function runLocal(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function callJson(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

const base = await mkdtemp(path.join(os.tmpdir(), "lca-pro-"));
let server;
let client;
try {
  server = await startServer(base);
  client = await connect(server.port);

  await callJson(client, "write_file", {
    path: "package.json",
    content: JSON.stringify({ scripts: { test: "node --version", build: "node --version", lint: "node --version", typecheck: "node --version" }, dependencies: { express: "^4.0.0" } }, null, 2)
  });
  await callJson(client, "write_file", { path: "README.md", content: "# Pro workspace\n" });
  await callJson(client, "write_file", { path: "src/index.js", content: "export function hello(){ return 'pro'; }\n" });

  const info = await callJson(client, "workspace_info");
  check("workspace_info exposes pro tier", info.tier === "pro", `tier=${info.tier}`);
  check("workspace_info exposes policy", typeof info.policy === "string" && info.policy.length > 0);

  const snap = await callJson(client, "workspace_snapshot", { depth: 3, max_entries: 120, include_symbols: true, refresh: true });
  check("snapshot kind is workspace_snapshot", snap.kind === "workspace_snapshot");
  check("snapshot is pro", snap.pro === true && snap.tier === "pro");
  check("snapshot version is 4.4.0-pro", snap.version === "4.4.0-pro", `version=${snap.version}`);
  check("snapshot includes safety model", snap.safety?.file_tools_root_confined === true && snap.safety?.command_os_sandbox === false);
  check("snapshot detects javascript", snap.profile?.languages?.includes("javascript"), JSON.stringify(snap.profile));
  check("snapshot omits fast-workflow commands", snap.commands === undefined, JSON.stringify(snap.commands));
  check("snapshot includes ripgrep status", typeof snap.ripgrep?.available === "boolean", JSON.stringify(snap.ripgrep));
  check("snapshot includes cache status", typeof snap.cache?.hit === "boolean" && snap.cache.ttl_seconds > 0, JSON.stringify(snap.cache));
  check("snapshot includes important files", snap.important_files?.some((f) => f.path === "README.md"));
  check("snapshot includes tree entries", snap.tree?.entries?.includes("src/index.js"));
  check("snapshot includes symbols when requested", snap.symbols?.some((s) => s.name === "hello"), JSON.stringify(snap.symbols?.slice(0, 10)));
  check("snapshot includes recommended reads", snap.recommended_reads?.some((f) => f.path === "README.md"), JSON.stringify(snap.recommended_reads));
  check("snapshot workflow hints skip automatic tests", snap.workflow_hints?.some((h) => /explicitly requested/.test(h)), JSON.stringify(snap.workflow_hints));
  check("snapshot omits metrics", snap.metrics === undefined && snap.health === undefined);
  check("snapshot includes next actions", Array.isArray(snap.next_best_actions) && snap.next_best_actions.length > 0);
  check("snapshot next actions avoid quality gates", !snap.next_best_actions.join("\n").match(/quality_gate|run_tests|run_changed_tests|build|lint/), JSON.stringify(snap.next_best_actions));
  await callJson(client, "write_file", { path: "src/deep/a/b/c/feature.js", content: "export function deepFeature(){ return true; }\n" });
  await callJson(client, "workspace_snapshot", { depth: 2, max_entries: 20, refresh: true });
  const deepMap = await callJson(client, "repo_map", { depth: 6, max_entries: 400 });
  check("repo_map rebuilds cache for deeper coverage", deepMap.tree?.includes("src/deep/a/b/c/feature.js"), JSON.stringify(deepMap.tree?.slice(-20)));
  const deepSymbols = await callJson(client, "repo_symbols", { max_files: 800, max_matches: 2000 });
  check("repo_symbols expands cached symbol coverage", deepSymbols.symbols?.some((s) => s.name === "deepFeature"), JSON.stringify(deepSymbols.symbols?.slice(-20)));

  const doctor = await callJson(client, "workspace_doctor", {});
  check("doctor returns score", Number.isInteger(doctor.score) && doctor.score >= 0 && doctor.score <= 100);
  check("doctor checks policy", doctor.checks?.some((c) => c.id === "policy"));
  check("doctor does not check commands", !doctor.checks?.some((c) => c.id === "commands"), JSON.stringify(doctor.checks));

  const detected = await callJson(client, "detect_test_commands", {});
  check("manual detect_test_commands still works", detected.commands?.test === "npm test", JSON.stringify(detected.commands));
  const gatePlan = await callJson(client, "quality_gate", { dry_run: true });
  check("manual quality_gate dry run still works", gatePlan.dry_run === true && gatePlan.plan?.some((g) => g.name === "test"), JSON.stringify(gatePlan.plan));

  await runLocal("git", ["init"], base);
  await runLocal("git", ["config", "user.email", "test@example.com"], base);
  await runLocal("git", ["config", "user.name", "Test User"], base);
  await runLocal("git", ["add", "."], base);
  await runLocal("git", ["commit", "-m", "initial"], base);
  await callJson(client, "write_file", { path: "src/index.js", content: "export function hello(){ console.log('debug'); return 'pro'; }\n" });
  const review = await callJson(client, "review_diff", {});
  check("review_diff returns summary", review.summary?.changed_files === 1 && review.summary?.source_files === 1, JSON.stringify(review.summary));
  check("review_diff returns heuristic findings", review.findings?.some((f) => /console\.log|corresponding test/.test(f.issue)), JSON.stringify(review.findings));

  const report = await callJson(client, "session_report", {});
  check("session_report kind", report.kind === "session_report");
  check("session_report exposes doctor summary", report.doctor?.summary && Number.isInteger(report.doctor.score));
  check("session_report omits metrics", report.metrics === undefined && report.health === undefined && report.recent_errors === undefined);
} finally {
  if (client) await client.close().catch(() => {});
  if (server) await stopServer(server.child);
  await rm(base, { recursive: true, force: true });
}

console.log(`\n==== PRO RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
