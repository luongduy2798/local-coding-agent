// Local Coding Agent — Eval Runner (v2.9)
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Spins the server on a temp workspace, runs each eval scenario, asserts behavior.
// Usage:  node evals/run.mjs
// Or:     npm run eval   (from server/ directory)

// Resolve imports from server's node_modules (evals/ has no separate package)
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, "..", "server");

// Dynamic imports from server's node_modules using file:// URLs (required on Windows)
const sdkClientPath = path.join(serverDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js");
const sdkHttpPath = path.join(serverDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "streamableHttp.js");
const { Client } = await import(pathToFileURL(sdkClientPath).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(sdkHttpPath).href);

import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";

const SERVER_MJS = path.resolve(__dirname, "..", "server", "server.mjs");
const EVAL_PORT = 8898;
const EVAL_ENDPOINT = `http://127.0.0.1:${EVAL_PORT}/mcp`;

let pass = 0;
let fail = 0;
const results = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    results.push({ name, ok: true });
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    results.push({ name, ok: false, detail });
    console.log(`  [FAIL] ${name}${detail ? ": " + detail : ""}`);
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startServer(workspace) {
  await mkdir(workspace, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SERVER_MJS],
      {
        env: {
          ...process.env,
          PORT: String(EVAL_PORT),
          AGENT_WORKSPACE: workspace,
          AGENT_MODE: "safe",
          AGENT_POLICY: "full",
          AGENT_WORKFLOW_MODE: "auto",
          CONTROL_PLANE_API_KEY: "EVAL_INTERNAL_CONTROL_SECRET"
        },
        windowsHide: true
      }
    );
    child.stderr?.on("data", () => {});
    let started = false;
    child.stdout?.on("data", (d) => {
      if (!started && d.toString().includes("listening on")) {
        started = true;
        resolve(child);
      }
    });
    child.on("error", reject);
    setTimeout(() => {
      if (!started) reject(new Error("Server start timeout"));
    }, 8000);
  });
}

async function stopServer(child) {
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
    await sleep(500);
  } catch { /* ignore */ }
}

async function connectClient() {
  const client = new Client({ name: "eval-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(EVAL_ENDPOINT));
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    return {
      text: r.content?.[0]?.text ?? "",
      structured: r.structuredContent ?? null,
      isError: Boolean(r.isError)
    };
  } catch (err) {
    return { text: String(err?.message || err), isError: true };
  }
}

async function parseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ============================================================================
// Eval definitions
// ============================================================================

async function runEvals(workspace) {
  let serverChild = null;
  let client = null;

  try {
    console.log(`\nStarting eval server on port ${EVAL_PORT}...`);
    serverChild = await startServer(workspace);
    await sleep(500);
    client = await connectClient();
    console.log("Connected.\n");

    // ---- eval 1: edit-single-file ----
    console.log("EVAL: edit-single-file");
    {
      await call(client, "write_file", { path: "src/greet.js", content: "function greet() { return 'hello'; }\n" });
      const r = await call(client, "replace_in_file", { path: "src/greet.js", old_text: "hello", new_text: "world" });
      const read = await call(client, "read_file", { path: "src/greet.js" });
      const d = await parseJSON(read.text);
      check("edit-single-file: file written and edited", !r.isError && d && d.content && d.content.includes("world"));
    }

    // ---- eval 2: edit-multi-file (apply_patch) ----
    console.log("EVAL: edit-multi-file");
    {
      await call(client, "write_file", { path: "src/a.js", content: "const a = 1;\n" });
      await call(client, "write_file", { path: "src/b.js", content: "const b = 2;\n" });
      const r = await call(client, "apply_patch", {
        diff: `--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 10;\n--- a/src/b.js\n+++ b/src/b.js\n@@ -1 +1 @@\n-const b = 2;\n+const b = 20;\n`
      });
      const d = await parseJSON(r.text);
      check("edit-multi-file: apply_patch both files ok", d && d.ok && d.applied === 2);

      const ra = await call(client, "read_file", { path: "src/a.js" });
      const da = await parseJSON(ra.text);
      check("edit-multi-file: content correct", da && da.content.includes("10") && !da.content.includes("const a = 1;"));
    }

    // ---- eval 3: undo_last_patch restores ----
    console.log("EVAL: undo_last_patch");
    {
      await call(client, "write_file", { path: "src/undo-me.js", content: "const x = 'original';\n" });
      await call(client, "replace_in_file", { path: "src/undo-me.js", old_text: "original", new_text: "changed" });
      const before = await call(client, "read_file", { path: "src/undo-me.js" });
      const dBefore = await parseJSON(before.text);
      check("undo: file was changed", dBefore && dBefore.content.includes("changed"));

      const undo = await call(client, "undo_last_patch", {});
      const dUndo = await parseJSON(undo.text);
      check("undo: undo_last_patch returned ok", dUndo && dUndo.ok);

      const after = await call(client, "read_file", { path: "src/undo-me.js" });
      const dAfter = await parseJSON(after.text);
      check("undo: file restored to original", dAfter && dAfter.content.includes("original") && !dAfter.content.includes("changed"));
    }

    // ---- eval 4: detect bug via review_diff ----
    console.log("EVAL: review_diff detects console.log");
    {
      // This eval only works if workspace is a git repo; if not, we note it
      const gs = await call(client, "git_status", {});
      const gsData = await parseJSON(gs.text);
      if (!gsData || !gsData.is_git_repo) {
        console.log("  [SKIP] review_diff: not a git repo (expected for scratch workspace)");
      } else {
        const rd = await call(client, "review_diff", { cwd: "." });
        const data = await parseJSON(rd.text);
        check("review_diff: returns a verdict", data && ["PASS", "WARN", "BLOCK", "CLEAN"].includes(data.verdict));
      }
    }

    // ---- eval 5: run failing test reported ----
    console.log("EVAL: run_tests reports failure");
    {
      // Write a simple Node test that will fail
      await call(client, "write_file", { path: "test/fail.test.js", content: "// simple failing test\nprocess.exit(1);\n" });
      const r = await call(client, "run_tests", { command: "node test/fail.test.js", cwd: "." });
      const d = await parseJSON(r.text);
      check("run_tests: failing test detected (exit_code != 0)", d && d.exit_code !== 0 && d.ok === false);
    }

    // ---- eval 6: prevent path escape ----
    console.log("EVAL: path escape blocked");
    {
      const r = await call(client, "read_file", { path: "../../../../etc/passwd" });
      check("path-escape: read outside root blocked", r.isError && r.text.includes("outside the allowed roots"));
    }

    // ---- eval 7: prevent secret in audit ----
    console.log("EVAL: audit redaction");
    {
      const sentinel = "EVAL_SECRET_" + randomUUID().replace(/-/g, "").slice(0, 16);
      await call(client, "apply_patch", { operations: [{ op: "create", path: "sec-eval.txt", content: `API_KEY=${sentinel}` }] });
      await call(client, "delete_path", { path: "sec-eval.txt" });
      // Read the audit log (it lives in server/data/audit.log)
      const auditPath = path.resolve(__dirname, "..", "server", "data", "audit.log");
      let auditContent = "";
      try { auditContent = await readFile(auditPath, "utf8"); } catch { /* no audit log */ }
      if (auditContent) {
        check("audit: secret NOT in audit.log", !auditContent.includes(sentinel));
      } else {
        console.log("  [SKIP] audit file not found");
      }
    }

    // ---- eval 8: git safety (flag blocked) ----
    console.log("EVAL: git safety");
    {
      const r = await call(client, "git", { args: ["diff", "--output=../escape.txt"] });
      check("git-safety: --output flag blocked", r.isError);

      const r2 = await call(client, "git", { args: ["-c", "core.pager=calc", "log"] });
      check("git-safety: -c flag blocked", r2.isError);
    }

    // ---- eval 9: repo_map on sample project ----
    console.log("EVAL: repo_map");
    {
      // Write a package.json so project_profile can detect it
      await call(client, "write_file", { path: "package.json", content: JSON.stringify({ name: "eval-proj", scripts: { test: "node test/fail.test.js", build: "echo build" } }, null, 2) });
      const r = await call(client, "repo_map", { refresh: true });
      const d = await parseJSON(r.text);
      check("repo_map: returns tree + profile", d && Array.isArray(d.tree) && d.profile && Array.isArray(d.profile.languages));
      check("repo_map: detects javascript", d && d.profile && d.profile.languages.includes("javascript"));
    }

    // ---- eval 10: resume checkpoint ----
    console.log("EVAL: checkpoint + resume");
    {
      const cp = await call(client, "checkpoint", { summary: "Eval progress: 10 evals done", next_steps: ["verify", "commit"] });
      check("checkpoint: saved without error", !cp.isError);

      const resume = await call(client, "resume", {});
      const d = await parseJSON(resume.text);
      check("resume: returns saved checkpoint", d && d.summary && d.summary.includes("Eval progress"));
    }

    // ---- eval 11: task_plan + task_state ----
    console.log("EVAL: task_plan + task_state");
    {
      const plan = await call(client, "task_plan", { goal: "Eval test goal", steps: ["Step A", "Step B", "Step C"] });
      const pd = await parseJSON(plan.text);
      check("task_plan: created", pd && pd.ok && pd.steps_count === 3);

      const state = await call(client, "task_state", { set_step_done: 0 });
      const sd = await parseJSON(state.text);
      check("task_state: step marked done", sd && sd.steps && sd.steps[0].done === true);
    }

    // ---- eval 12: policy_status ----
    console.log("EVAL: policy_status");
    {
      const r = await call(client, "policy_status", {});
      const d = await parseJSON(r.text);
      check("policy_status: returns policy info", d && typeof d.policy === "string" && ["strict", "balanced", "full"].includes(d.policy));
    }

    // ---- eval 13: preview_patch dry-run ----
    console.log("EVAL: preview_patch");
    {
      await call(client, "write_file", { path: "src/preview-me.js", content: "const x = 1;\n" });
      const r = await call(client, "preview_patch", { diff: "--- a/src/preview-me.js\n+++ b/src/preview-me.js\n@@ -1 +1 @@\n-const x = 1;\n+const x = 99;\n" });
      const d = await parseJSON(r.text);
      check("preview_patch: dry-run ok", d && typeof d.ok === "boolean");
      // Verify file was NOT changed
      const read = await call(client, "read_file", { path: "src/preview-me.js" });
      const rd = await parseJSON(read.text);
      check("preview_patch: file unchanged after dry run", rd && rd.content && rd.content.includes("const x = 1;"));
    }

    // ---- eval 14: every code mutation renders dashboard ----
    console.log("EVAL: code mutation dashboard");
    {
      const r = await call(client, "write_file", { path: "src/dashboard.js", content: "export const dashboard = true;\n" });
      const dashboard = r.structured?.dashboard;
      check("dashboard: mutation structured content returned", r.structured?.kind === "lca_code_mutation");
      check("dashboard: visible in safe mode too", dashboard?.visible === true && dashboard?.ui?.alwaysShowOnCodeChange === true);
      check("dashboard: code path recorded", dashboard?.changes?.some((item) => item.path === "src/dashboard.js"));
    }

    // ---- eval 15: explicit verification is not auto-run ----
    console.log("EVAL: explicit-only verification");
    {
      await call(client, "write_file", {
        path: "package.json",
        content: JSON.stringify({ name: "explicit-eval", scripts: { test: "node -e \\\"require('fs').writeFileSync('AUTO_TEST_RAN','yes')\\\"" } }, null, 2)
      });
      await call(client, "write_file", { path: "src/no-auto-test.js", content: "export const value = 1;\n" });
      check("verification: mutation did not auto-run npm test", !existsSync(path.join(workspace, "AUTO_TEST_RAN")));
    }

    // ---- eval 16: full batch validation prevents partial writes ----
    console.log("EVAL: atomic batch validation");
    {
      await call(client, "write_file", { path: "src/atomic-a.js", content: "const value = 1;\n" });
      const failed = await call(client, "apply_patch", {
        operations: [
          { op: "update", path: "src/atomic-a.js", edits: [{ old_text: "1", new_text: "2" }] },
          { op: "update", path: "src/does-not-exist.js", edits: [{ old_text: "x", new_text: "y" }] }
        ]
      });
      const after = await call(client, "read_file", { path: "src/atomic-a.js" });
      const data = await parseJSON(after.text);
      check("atomic: invalid batch fails", failed.isError);
      check("atomic: earlier operation was not partially written", data?.content?.includes("value = 1"));
    }

    // ---- eval 17: ambiguous edit must be explicit ----
    console.log("EVAL: ambiguous patch protection");
    {
      await call(client, "write_file", { path: "src/ambiguous.js", content: "same\nsame\n" });
      const failed = await call(client, "replace_in_file", { path: "src/ambiguous.js", old_text: "same", new_text: "changed" });
      check("ambiguous: duplicate context rejected", failed.isError && failed.text.includes("AMBIGUOUS_EDIT"));
    }

    // ---- eval 18: Plan -> Implement version/hash guard ----
    console.log("EVAL: persistent plan workflow");
    {
      const created = await call(client, "task_create", { goal: "Refactor multiple modules", workflow_mode: "plan" });
      const taskData = await parseJSON(created.text);
      const taskId = taskData?.task?.id;
      const planned = await call(client, "plan_create", { task_id: taskId, steps: ["Inspect modules", "Apply focused changes"] });
      const plan = planned.structured?.plan;
      check("plan: Plan card rendered", planned.structured?.kind === "lca_plan_card" && Boolean(plan?.hash));
      const stale = await call(client, "task_prepare_implementation", { task_id: taskId, plan_id: plan?.id, expected_plan_version: Number(plan?.version || 1) + 1 });
      check("plan: stale version rejected", stale.isError && stale.text.includes("PLAN_VERSION_CONFLICT"));
      const ready = await call(client, "task_prepare_implementation", { task_id: taskId, plan_id: plan?.id, expected_plan_version: plan?.version, expected_plan_hash: plan?.hash });
      check("plan: accepted plan returns follow-up", ready.structured?.kind === "lca_implementation_ready" && ready.structured?.follow_up_prompt?.includes(taskId));
    }

    // ---- eval 19: internal control-plane env is stripped ----
    console.log("EVAL: child env isolation");
    {
      const r = await call(client, "run_command", { command: "node -e \"console.log(process.env.CONTROL_PLANE_API_KEY || 'stripped')\"" });
      const d = await parseJSON(r.text);
      check("child-env: control secret stripped", d?.stdout?.trim() === "stripped");
    }

    // ---- eval 20: nested project graph and command discovery ----
    console.log("EVAL: monorepo project graph");
    {
      await call(client, "write_file", { path: "packages/api/package.json", content: JSON.stringify({ name: "api", scripts: { "test:unit": "node test.js", typecheck: "tsc --noEmit" } }, null, 2) });
      const r = await call(client, "project_graph", { refresh: true });
      const d = await parseJSON(r.text);
      check("project-graph: nested package detected", d?.projects?.some((project) => project.id === "api"));
      check("project-graph: non-conventional scripts detected", d?.commands?.some((command) => command.id === "test:unit") && d?.commands?.some((command) => command.id === "typecheck"));
    }

  } finally {
    if (client) await client.close().catch(() => {});
    if (serverChild) await stopServer(serverChild);
  }
}

// ============================================================================
// Main
// ============================================================================

const evalWorkspace = path.join(os.tmpdir(), `lca-eval-${Date.now()}`);

console.log("=".repeat(60));
console.log("Local Coding Agent — Eval Suite (v5.0)");
console.log("=".repeat(60));
console.log(`Workspace: ${evalWorkspace}`);

try {
  await runEvals(evalWorkspace);
} catch (err) {
  console.error("\nFATAL eval runner error:", err?.message || err);
  process.exit(1);
} finally {
  // Clean up workspace
  try { await rm(evalWorkspace, { recursive: true, force: true }); } catch { /* ok */ }
}

const total = pass + fail;
const pct = total > 0 ? Math.round((pass / total) * 100) : 0;

console.log("\n" + "=".repeat(60));
console.log(`EVAL RESULTS: ${pass}/${total} passed (${pct}%)`);
console.log("=".repeat(60));

results.forEach((r) => {
  console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
});

if (pct < 90) {
  console.error(`\nFAIL: Only ${pct}% passed (need >= 90%)`);
  process.exit(1);
} else {
  console.log(`\nPASS: ${pct}% >= 90%`);
  process.exit(0);
}
