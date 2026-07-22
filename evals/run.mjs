// Local Coding Agent — Eval Runner
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

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createGitFixture, createIsolatedTestRoot, safeRemove } from "../server/tests/helpers/test-guard.mjs";
import { getFreePort, startTestServer, stopTestProcess } from "../server/tests/helpers/test-runtime.mjs";

const SERVER_MJS = path.resolve(__dirname, "..", "server", "server.mjs");
const testContext = await createIsolatedTestRoot({ prefix: "lca-eval-", protectedPaths: [path.resolve(__dirname, "..")] });
const EVAL_PORT = await getFreePort();
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
  const runtime = await startTestServer({
    serverPath: SERVER_MJS,
    workspace,
    dataDir: testContext.dataDir,
    runId: testContext.runId,
    port: EVAL_PORT,
    mode: "safe",
    policy: "full",
    env: {
      LCA_TEST_RUNTIME_DIAGNOSTICS: "0"
    }
  });
  return runtime.child;
}

async function stopServer(child) {
  await stopTestProcess(child);
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

    const workspaceList = await call(client, "workspace_list", {});
    const workspaceListData = await parseJSON(workspaceList.text);
    const primaryWorkspaceId = workspaceListData?.workspaces?.[0]?.workspace_id;
    const openedTask = await call(client, "task_open", {
      title: "Runtime golden eval",
      primary_workspace_id: primaryWorkspaceId
    });
    const openedTaskData = await parseJSON(openedTask.text);
    check(
      "eval setup: stateful session is bound to an explicit workspace task",
      !openedTask.isError && Boolean(openedTaskData?.task?.id),
      openedTask.text
    );

    // ---- eval 1: edit-single-file ----
    console.log("EVAL: edit-single-file");
    {
      await call(client, "apply_patch", {
        operations: [{ op: "create", path: "src/greet.js", content: "function greet() { return 'hello'; }\n" }]
      });
      const r = await call(client, "apply_patch", {
        operations: [{
          op: "update",
          path: "src/greet.js",
          edits: [{ old_text: "hello", new_text: "world" }]
        }]
      });
      const read = await call(client, "read_file", { path: "src/greet.js" });
      const d = await parseJSON(read.text);
      check("edit-single-file: file written and edited", !r.isError && d && d.content && d.content.includes("world"));
    }

    // ---- eval 2: edit-multi-file (apply_patch) ----
    console.log("EVAL: edit-multi-file");
    {
      await call(client, "apply_patch", {
        operations: [
          { op: "create", path: "src/a.js", content: "const a = 1;\n" },
          { op: "create", path: "src/b.js", content: "const b = 2;\n" }
        ]
      });
      const r = await call(client, "apply_patch", {
        diff: `--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 10;\n--- a/src/b.js\n+++ b/src/b.js\n@@ -1 +1 @@\n-const b = 2;\n+const b = 20;\n`
      });
      const d = await parseJSON(r.text);
      check("edit-multi-file: apply_patch both files ok", d && d.ok && d.applied === 2);

      const ra = await call(client, "read_file", { path: "src/a.js" });
      const da = await parseJSON(ra.text);
      check("edit-multi-file: content correct", da && da.content.includes("10") && !da.content.includes("const a = 1;"));
    }

    // ---- eval 3: Review Changes undo restores ----
    console.log("EVAL: Review Changes undo");
    {
      await call(client, "apply_patch", {
        operations: [{ op: "create", path: "src/undo-me.js", content: "const x = 'original';\n" }]
      });
      const changed = await call(client, "apply_patch", {
        operations: [{
          op: "update",
          path: "src/undo-me.js",
          edits: [{ old_text: "original", new_text: "changed" }]
        }]
      });
      const changedData = await parseJSON(changed.text);
      const before = await call(client, "read_file", { path: "src/undo-me.js" });
      const dBefore = await parseJSON(before.text);
      check("undo: file was changed", dBefore && dBefore.content.includes("changed"));

      const undoResponse = await call(client, "change_history", {
        action: "undo",
        id: changedData.change_id
      });
      check("undo: change_history returned ok", !undoResponse.isError);

      const after = await call(client, "read_file", { path: "src/undo-me.js" });
      const dAfter = await parseJSON(after.text);
      check("undo: file restored to original", dAfter && dAfter.content.includes("original") && !dAfter.content.includes("changed"));
    }

    // ---- eval 4: detect bug via review_diff ----
    console.log("EVAL: review_diff detects console.log");
    {
      // This eval only works if workspace is a git repo; if not, we note it
      const gs = await call(client, "git", { args: ["rev-parse", "--is-inside-work-tree"] });
      const gsData = await parseJSON(gs.text);
      if (!gsData || gsData.exit_code !== 0) {
        console.log("  [SKIP] review_diff: not a git repo (expected for scratch workspace)");
      } else {
        const rd = await call(client, "review_diff", { cwd: "." });
        const data = await parseJSON(rd.text);
        check("review_diff: returns a verdict", data && ["PASS", "WARN", "BLOCK", "CLEAN"].includes(data.verdict));
      }
    }

    // ---- eval 5: run failing test reported ----
    console.log("EVAL: run_command reports failure");
    {
      // Write a simple Node test that will fail
      await call(client, "apply_patch", {
        operations: [{ op: "create", path: "test/fail.test.js", content: "// simple failing test\nprocess.exit(1);\n" }]
      });
      const r = await call(client, "run_command", { command: "node test/fail.test.js", cwd: "." });
      const d = await parseJSON(r.text);
      check("run_command: failing test detected (exit_code != 0)", d && d.exit_code !== 0 && d.ok === false);
    }

    // ---- eval 6: prevent path escape ----
    console.log("EVAL: path escape blocked");
    {
      const r = await call(client, "read_file", { path: "../../../../etc/passwd" });
      check("path-escape: read outside root blocked", r.isError && /outside/i.test(r.text));
    }

    // ---- eval 7: prevent secret in audit ----
    console.log("EVAL: audit redaction");
    {
      const sentinel = "EVAL_SECRET_" + randomUUID().replace(/-/g, "").slice(0, 16);
      await call(client, "apply_patch", { operations: [{ op: "create", path: "sec-eval.txt", content: `API_KEY=${sentinel}` }] });
      await call(client, "apply_patch", { operations: [{ op: "delete", path: "sec-eval.txt" }] });
      const auditPath = path.join(testContext.dataDir, "runtime", "audit.log");
      let auditContent = "";
      try { auditContent = await readFile(auditPath, "utf8"); } catch { /* no audit log */ }
      check("audit: secret NOT in audit.log", auditContent.length > 0 && !auditContent.includes(sentinel));
    }

    // ---- eval 8: git safety (flag blocked) ----
    console.log("EVAL: git safety");
    {
      const r = await call(client, "git", { args: ["diff", "--output=../escape.txt"] });
      check("git-safety: --output flag blocked", r.isError);

      const r2 = await call(client, "git", { args: ["-c", "core.pager=calc", "log"] });
      check("git-safety: -c flag blocked", r2.isError);
    }

    // ---- eval 9: workspace_snapshot on sample project ----
    console.log("EVAL: workspace_snapshot");
    {
      // Write a package.json so project_profile can detect it
      await call(client, "apply_patch", {
        operations: [{
          op: "create",
          path: "package.json",
          content: JSON.stringify({
            name: "eval-proj",
            scripts: { test: "node test/fail.test.js", build: "echo build" }
          }, null, 2)
        }]
      });
      const r = await call(client, "workspace_snapshot", { refresh: true });
      const d = await parseJSON(r.text);
      check("workspace_snapshot: returns tree + profile", d && Array.isArray(d.tree?.entries) && d.profile && Array.isArray(d.profile.languages));
      check("workspace_snapshot: detects javascript", d && d.profile && d.profile.languages.includes("javascript"));
    }

    // ---- eval 10: task checkpoint ----
    console.log("EVAL: task checkpoint");
    {
      const cp = await call(client, "task_checkpoint", {
        summary: "Eval progress: 10 evals done",
        next_steps: ["verify", "commit"]
      });
      const d = await parseJSON(cp.text);
      check(
        "task_checkpoint: saves resumable task state",
        !cp.isError && d?.checkpoint?.summary?.includes("Eval progress")
      );
    }

    // ---- eval 11: task_plan + task_state ----
    console.log("EVAL: task_plan + task_state");
    {
      const plan = await call(client, "task_plan", { goal: "Eval test goal", steps: ["Step A", "Step B", "Step C"] });
      const pd = await parseJSON(plan.text);
      check("task_plan: created", pd && pd.ok && pd.steps_count === 3);

      const state = await call(client, "task_state", { set_step_done: 0 });
      const sd = await parseJSON(state.text);
      check("task_state: step marked done", sd?.plan?.steps?.[0]?.done === true);
    }

    // ---- eval 12: lca_status ----
    console.log("EVAL: lca_status");
    {
      const r = await call(client, "lca_status", {});
      const d = await parseJSON(r.text);
      check(
        "lca_status: returns fixed catalog and policy info",
        d?.catalog_version === 5 &&
          typeof d.policy === "string" &&
          ["strict", "balanced", "full"].includes(d.policy)
      );
    }

    // ---- eval 13: apply_patch failed preflight is non-mutating ----
    console.log("EVAL: apply_patch preflight");
    {
      await call(client, "apply_patch", {
        operations: [{ op: "create", path: "src/preflight-me.js", content: "const x = 1;\n" }]
      });
      const r = await call(client, "apply_patch", {
        operations: [{
          op: "update",
          path: "src/preflight-me.js",
          expected_version: "stale-version",
          content: "const x = 99;\n"
        }]
      });
      check("apply_patch: stale expected_version is rejected", r.isError);
      const read = await call(client, "read_file", { path: "src/preflight-me.js" });
      const rd = await parseJSON(read.text);
      check("apply_patch: failed preflight leaves file unchanged", rd?.content?.includes("const x = 1;"));
    }

    // ---- eval 14: retrieval and symbol quality golden set ----
    console.log("EVAL: retrieval + symbol golden set");
    {
      await call(client, "apply_patch", {
        operations: [
          {
            op: "create",
            path: "src/pricing.js",
            content: "export function calculateTotal(lines) { return lines.reduce((sum, line) => sum + line.price, 0); }\n"
          },
          {
            op: "create",
            path: "src/discounts.js",
            content: "export function applyDiscount(total, rate) { return total * (1 - rate); }\n"
          },
          {
            op: "create",
            path: "src/inventory.js",
            content: "export function reserveInventory(lines) { return lines.map((line) => line.sku); }\n"
          },
          {
            op: "create",
            path: "src/tax.js",
            content: "export function computeTax(total, rate) { return total * rate; }\n"
          },
          {
            op: "create",
            path: "src/shipping.js",
            content: "export function estimateShipping(lines) { return lines.length * 2; }\n"
          },
          {
            op: "create",
            path: "src/customer.js",
            content: "export function normalizeCustomer(customer) { return { ...customer, email: customer.email.toLowerCase() }; }\n"
          },
          {
            op: "create",
            path: "src/order-service.js",
            content: "import { calculateTotal } from './pricing.js';\nimport { applyDiscount } from './discounts.js';\nimport { reserveInventory } from './inventory.js';\nimport { computeTax } from './tax.js';\nexport function submitOrder(lines) { reserveInventory(lines); const subtotal = applyDiscount(calculateTotal(lines), 0.1); return subtotal + computeTax(subtotal, 0.08); }\n"
          },
          {
            op: "create",
            path: "src/checkout.js",
            content: "import { submitOrder } from './order-service.js';\nimport { estimateShipping } from './shipping.js';\nimport { normalizeCustomer } from './customer.js';\nexport function finalizeCheckout(lines, customer) { return { total: submitOrder(lines) + estimateShipping(lines), customer: normalizeCustomer(customer) }; }\n"
          },
          {
            op: "create",
            path: "test/order-service.test.js",
            content: "import { finalizeCheckout } from '../src/checkout.js';\nvoid finalizeCheckout;\n"
          }
        ]
      });
      await call(client, "index_control", { action: "rebuild" });
      const definitionGoldens = [
        ["calculateTotal", "src/pricing.js"],
        ["applyDiscount", "src/discounts.js"],
        ["reserveInventory", "src/inventory.js"],
        ["computeTax", "src/tax.js"],
        ["estimateShipping", "src/shipping.js"],
        ["normalizeCustomer", "src/customer.js"],
        ["submitOrder", "src/order-service.js"],
        ["finalizeCheckout", "src/checkout.js"]
      ];
      let truePositives = 0;
      let returnedDefinitions = 0;
      const definitionResults = {};
      for (const [symbol, expectedPath] of definitionGoldens) {
        const response = await call(client, "code_query", {
          query: symbol,
          mode: "definition",
          depth: "auto",
          limit: 20
        });
        const data = await parseJSON(response.text);
        const paths = new Set(
          (data?.results || []).map((item) => item.location?.path).filter(Boolean)
        );
        definitionResults[symbol] = [...paths];
        returnedDefinitions += paths.size;
        if (paths.has(expectedPath)) truePositives++;
      }
      const recallAt20 = truePositives / definitionGoldens.length;
      const precision = truePositives / Math.max(1, returnedDefinitions);
      const symbolF1 = (2 * precision * recallAt20) / Math.max(Number.EPSILON, precision + recallAt20);
      check(
        "retrieval: Recall@20 >= 95%",
        recallAt20 >= 0.95,
        JSON.stringify({ recallAt20, definitionResults })
      );
      check(
        "symbols: F1 >= 95% on seeded definition set",
        symbolF1 >= 0.95,
        JSON.stringify({ precision, recallAt20, symbolF1, definitionResults })
      );

      const referenceGoldens = [
        ["calculateTotal", "src/order-service.js"],
        ["applyDiscount", "src/order-service.js"],
        ["reserveInventory", "src/order-service.js"],
        ["computeTax", "src/order-service.js"],
        ["estimateShipping", "src/checkout.js"],
        ["normalizeCustomer", "src/checkout.js"],
        ["submitOrder", "src/checkout.js"],
        ["finalizeCheckout", "test/order-service.test.js"]
      ];
      let foundReferences = 0;
      const referenceResults = {};
      for (const [symbol, expectedPath] of referenceGoldens) {
        const response = await call(client, "code_query", {
          query: symbol,
          mode: "references",
          depth: "auto",
          limit: 20
        });
        const data = await parseJSON(response.text);
        const paths = new Set(
          (data?.results || []).map((item) => item.location?.path).filter(Boolean)
        );
        referenceResults[symbol] = [...paths];
        if (paths.has(expectedPath)) foundReferences++;
      }
      check(
        "retrieval: reference Recall@20 >= 95%",
        foundReferences / referenceGoldens.length >= 0.95,
        JSON.stringify(referenceResults)
      );
    }

    // ---- eval 15: seeded security bug is blocked by review ----
    console.log("EVAL: seeded security bug");
    {
      await call(client, "apply_patch", {
        operations: [{
          op: "create",
          path: "src/unsafe-eval.js",
          content: "export function executeUserInput(input) { return eval(input); }\n"
        }]
      });
      const review = await call(client, "review_diff", {});
      const reviewData = await parseJSON(review.text);
      check(
        "seeded bug: review_diff blocks eval-based code injection",
        reviewData?.verdict === "BLOCK"
          && reviewData?.findings?.some((item) => /eval\(\)/i.test(item.issue || "")),
        review.text
      );
    }

  } finally {
    if (client) await client.close().catch(() => {});
    if (serverChild) await stopServer(serverChild);
  }
}

// ============================================================================
// Main
// ============================================================================

const evalFixture = await createGitFixture(testContext, {
  initialFiles: { "fixture/.gitkeep": "" }
});
const evalWorkspace = evalFixture.fixtureDir;

console.log("=".repeat(60));
console.log("Local Coding Agent — Eval Suite");
console.log("=".repeat(60));
console.log(`Workspace: ${evalWorkspace}`);

try {
  await runEvals(evalWorkspace);
} catch (err) {
  console.error("\nFATAL eval runner error:", err?.message || err);
  process.exit(1);
} finally {
  await safeRemove(evalWorkspace, testContext, { recursive: true, force: true }).catch((error) => {
    console.error(`Cleanup skipped for safety: ${error?.message || error}`);
  });
  await safeRemove(testContext.dataDir, testContext, { recursive: true, force: true }).catch((error) => {
    console.error(`Data cleanup skipped for safety: ${error?.message || error}`);
  });
}

const total = pass + fail;
const pct = total > 0 ? Math.round((pass / total) * 100) : 0;

console.log("\n" + "=".repeat(60));
console.log(`EVAL RESULTS: ${pass}/${total} passed (${pct}%)`);
console.log("=".repeat(60));

results.forEach((r) => {
  console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
});

if (fail > 0) {
  console.error(`\nFAIL: ${fail} eval assertion(s) failed`);
  process.exit(1);
} else {
  console.log(`\nPASS: ${pct}% with zero failed assertions`);
  process.exit(0);
}
