// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENDPOINT = process.env.TEST_ENDPOINT;
if (!ENDPOINT) throw new Error("agent.test.mjs must run through tests/runners/run-agent-isolated.mjs.");
const client = new Client({ name: "agent-test-client", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT));
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) pass++;
  else fail++;
  console.log(`\n[${condition ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log(String(detail).slice(0, 600));
}

async function call(name, args, { expectError = false } = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  const isError = Boolean(result.isError);
  const ok = expectError ? isError : !isError;
  if (ok) pass++;
  else fail++;
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name} ${expectError ? "(expected error)" : ""}`);
  console.log(text.slice(0, 600));
  return text;
}

const toolNames = tools.tools.map((tool) => tool.name);
check("fixed catalog exposes exactly 35 tools", toolNames.length === 35, toolNames.join(", "));
check(
  "legacy aliases are absent from the catalog",
  ["workspace_info", "write_file", "replace_in_file", "make_dir", "proc_start"].every((name) => !toolNames.includes(name)),
  toolNames.join(", ")
);

await call("lca_status", {});
const workspaceList = JSON.parse(await call("workspace_list", {}));
const workspaceId = workspaceList.workspaces?.[0]?.workspace_id;
check("workspace_list returns the isolated workspace", Boolean(workspaceId), JSON.stringify(workspaceList));
const opened = JSON.parse(await call("task_open", {
  title: "Agent fixed-catalog regression",
  primary_workspace_id: workspaceId
}));
const taskToken = opened.task?.task_token;
check("task_open returns a resumable token", Boolean(taskToken), JSON.stringify(opened));

await call("apply_patch", {
  task_token: taskToken,
  operations: [
    { op: "create", path: "demo/hello.js", content: 'console.log("hello from local coding agent");\n' },
    { op: "create", path: "demo/pkg/util.js", content: "export const sum = (a, b) => a + b;\n" },
    { op: "mkdir", path: "demo/newdir" }
  ]
});
await call("read_file", { path: "demo/hello.js", task_token: taskToken });
await call("read_file", { path: "demo/hello.js", start_line: 1, line_count: 1, task_token: taskToken });
await call("apply_patch", {
  task_token: taskToken,
  operations: [{
    op: "update",
    path: "demo/hello.js",
    edits: [{ old_text: "hello from", new_text: "greetings from" }]
  }]
});
await call("find_files", { glob: "hello.js", path: "demo", task_token: taskToken });
await call("search_text", { query: "greetings", path: "demo", task_token: taskToken });
await call("list_files", { path: "demo", recursive: true, task_token: taskToken });
await call("read_many", {
  paths: ["demo/hello.js", "demo/pkg/util.js", "demo/does-not-exist.js"],
  task_token: taskToken
});
await call("read_many", {
  requests: [
    { path: "demo/hello.js", start_line: 1, line_count: 1, max_chars: 500 },
    { path: "demo/pkg/util.js", max_chars: 500 }
  ],
  concurrency: 2,
  task_token: taskToken
});
await call("workspace_snapshot", { path: ".", depth: 3, task_token: taskToken });
await call("apply_patch", {
  task_token: taskToken,
  operations: [{ op: "rename", path: "demo/newdir", rename_to: "demo/renamed" }]
});
await call("run_command", { command: "node demo/hello.js", timeout_ms: 10000, task_token: taskToken });
await call("run_commands", {
  task_token: taskToken,
  commands: [
    { command: "node --version", timeout_ms: 10000 },
    { command: "git --version", timeout_ms: 10000 }
  ]
});
await call("skills", { action: "list", task_token: taskToken });
await call("skills", {
  action: "create",
  name: "demo-skill",
  description: "Temporary skill created by the regression test.",
  body: "# Demo Skill\n\nUse only for regression tests.\n",
  task_token: taskToken
});
await call("skills", { action: "read", name: "demo-skill", task_token: taskToken });
await call("skills", { action: "delete", name: "demo-skill", task_token: taskToken });

// background process: short ticker
const startText = await call("process", {
  action: "start",
  command: "node -e \"setInterval(()=>console.log('tick'),200)\"",
  name: "ticker",
  task_token: taskToken
});
const id = JSON.parse(startText).id;
await new Promise((r) => setTimeout(r, 700));
await call("process", { action: "list", task_token: taskToken });
await call("process", { action: "output", id, task_token: taskToken });
await call("process", { action: "stop", id, task_token: taskToken });

// git (exercise; --version always works)
await call("git", { args: ["--version"], task_token: taskToken });

// safety: a path escaping the roots must error
await call("read_file", { path: "../../../etc/passwd", task_token: taskToken }, { expectError: true });

// Removed aliases must fail instead of silently invoking another contract.
await call("write_file", { path: "legacy.txt", content: "blocked" }, { expectError: true });

// cleanup
await call("apply_patch", {
  task_token: taskToken,
  operations: [{ op: "delete", path: "demo", recursive: true }]
});

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
await client.close();
process.exit(fail === 0 ? 0 : 1);
