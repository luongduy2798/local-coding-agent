// Local Coding Agent security regression tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { summarizeArgs } from "../../src/core/redaction.mjs";

const ENDPOINT = process.env.TEST_ENDPOINT;
const TEST_ROOT = process.env.LCA_TEST_ROOT;
const TEST_FIXTURE = process.env.LCA_TEST_FIXTURE;
const TEST_DATA_DIR = process.env.LCA_TEST_DATA_DIR;
const TEST_RUN_ID = process.env.LCA_TEST_RUN_ID;
if (!ENDPOINT || !TEST_ROOT || !TEST_FIXTURE || !TEST_DATA_DIR || !TEST_RUN_ID) {
  throw new Error("Security tests must run through tests/runners/run-security-isolated.mjs.");
}
const client = new Client({ name: "agent-security-test-client", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT));
await client.connect(transport);

let pass = 0;
let fail = 0;

function ok(condition, name, detail = "") {
  if (condition) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? `\n${detail}` : ""}`);
  }
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  return { result, text };
}

const info = JSON.parse((await call("lca_status", {})).text);
const root = info.primary_root;
if (path.resolve(root) !== path.resolve(TEST_FIXTURE)) {
  throw new Error(`Security test workspace mismatch: ${root}`);
}
const opened = JSON.parse((await call("task_open", {
  title: "Runtime security regression",
  primary_workspace_id: info.primary_workspace_id
})).text);
const taskToken = opened.task?.task_token;
if (!taskToken) throw new Error("Security test could not open an explicit task.");

// Default macOS volumes are commonly case-insensitive. A differently-cased
// absolute path to the same root must remain inside the root after canonicalization.
if (process.platform === "darwin") {
  const variant = root.replace(/[A-Za-z]/, (ch) => ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());
  if (variant !== root && existsSync(variant)) {
    const caseVariant = await call("list_files", { path: variant, limit: 10, task_token: taskToken });
    ok(!caseVariant.result.isError, "case-insensitive macOS root path is accepted", caseVariant.text);
  }
}

// 1) Symlink/junction escape must be blocked.
const outside = path.join(path.dirname(root), `outside-${Date.now()}`);
await mkdir(outside, { recursive: true });
await writeFile(path.join(outside, "secret.txt"), "outside-secret\n", "utf8");
const linkPath = path.join(root, "escape-link");
try {
  await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
} catch (err) {
  console.log(`[SKIP] symlink/junction setup failed: ${err?.message || err}`);
}
if (existsSync(linkPath)) {
  const escaped = await call("read_file", { path: "escape-link/secret.txt", task_token: taskToken });
  ok(Boolean(escaped.result.isError), "symlink/junction escape is blocked", escaped.text);
}

// 2) Non-git helper behavior should be structured and compact.
const nongit = path.join(root, "nongit");
await mkdir(nongit, { recursive: true });
const status = JSON.parse((await call("git", { args: ["status", "--short"], cwd: "nongit", task_token: taskToken })).text);
ok(status.exit_code !== 0 && /not a git repository/i.test(status.stderr), "git reports non-git status honestly", JSON.stringify(status));
const diff = JSON.parse((await call("git", { args: ["diff"], cwd: "nongit", task_token: taskToken })).text);
ok(diff.exit_code !== 0 && /not a git repository/i.test(diff.stderr) && diff.stderr.length < 200_000, "git diff reports non-git repo within the hard response budget", JSON.stringify(diff).slice(0, 500));

// 3) Raw git flags that can mutate outside the workspace are rejected before
// Git executes, so this test deliberately remains a non-Git disposable root.
const outsideDiff = path.join(path.dirname(root), `outside-${Date.now()}.diff`);
const gitOutput = await call("git", { args: ["diff", `--output=${outsideDiff}`], task_token: taskToken });
ok(Boolean(gitOutput.result.isError), "git --output is blocked in safe mode", gitOutput.text);
ok(!existsSync(outsideDiff), "git --output did not create file outside root");

const restore = await call("git", { args: ["restore", "."], task_token: taskToken });
ok(Boolean(restore.result.isError), "git restore is blocked in safe mode", restore.text);

// 4) Nested audit payloads must be redacted.
const secret = `LCA_AUDIT_SECRET_${Date.now()}`;
await call("apply_patch", {
  task_token: taskToken,
  operations: [{ op: "create", path: "audit-secret.txt", content: secret }]
});
const audit = await readFile(path.join(TEST_DATA_DIR, "runtime", "audit.log"), "utf8").catch(() => "");
ok(!audit.includes(secret), "audit log redacts nested apply_patch content");
const tokenSentinel = `TASK_TOKEN_SECRET_${Date.now()}`;
const summarized = summarizeArgs({
  task_token: tokenSentinel,
  instanceNonce: tokenSentinel,
  nested: { refreshToken: tokenSentinel }
});
ok(
  !summarized.includes(tokenSentinel),
  "audit argument summaries redact task tokens, nonces and nested credential aliases"
);

await client.close();
console.log(`\n==== SECURITY RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
