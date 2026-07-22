// Local Coding Agent safe operational audit activity tests.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createToolRegistrar } from "../../src/mcp/tool-runtime.mjs";

const events = [];
const handlers = new Map();
const task = {
  id: "task_audit12345678",
  workspace_ids: ["ws_audit12345678"]
};
const mcp = {
  registerTool(name, _definition, handler) {
    handlers.set(name, handler);
  }
};
const registrar = createToolRegistrar({
  audit: (entry) => events.push(entry),
  auditEnabled: true,
  currentTask: async () => task,
  defaultResponseBytes: 64 * 1024,
  enforcePolicy: async () => {},
  firstText: (result) => result?.content?.[0]?.text || "",
  getStorageError: () => null,
  isoNow: (() => {
    let tick = 0;
    return () => `2026-07-22T01:00:0${tick++}.000Z`;
  })(),
  maxResponseBytes: 200 * 1024,
  modelSafeError: async (error) => ({ code: error.code || "TOOL_FAILED", message: "safe" }),
  recoverTaskCloseIntent: async () => ({ ok: true }),
  requestContext: { getStore: () => ({ requestId: "request-audit" }) },
  resultBytes: (result) => Buffer.byteLength(JSON.stringify(result)),
  resultLen: (result) => JSON.stringify(result).length,
  roundMs: (value) => Math.round(value * 10) / 10,
  runtimeId: "runtime-audit",
  storageRequiredTools: new Set(),
  taskActivityTools: new Set(),
  taskContextTools: new Set(),
  testRuntimeDiagnostics: false,
  toolMetrics: {
    calls: 0,
    outputChars: 0,
    outputBytes: 0,
    largestOutputChars: 0,
    largestOutputBytes: 0,
    largestOutputTool: null,
    errors: 0
  },
  truncateUtf8: (value, max) => String(value).slice(0, max)
});

registrar(mcp, "task_close", {}, async () => ({
  content: [{
    type: "text",
    text: JSON.stringify({
      ok: false,
      status: "INCOMPLETE",
      task,
      changes: [{ files: 2 }, { files: 3 }],
      incomplete_reasons: ["VERIFICATION_NOT_PASS"]
    })
  }]
}));

await handlers.get("task_close")({
  task_token: "must-not-be-audited",
  command: "printf super-secret",
  prompt: "private thinking"
});

assert.equal(events.length, 2);
assert.equal(events[0].phase, "started");
assert.equal(events[1].phase, "finished");
assert.equal(events[0].invocation_id, events[1].invocation_id);
assert.equal(events[1].runtime_id, "runtime-audit");
assert.equal(events[1].task_id, task.id);
assert.deepEqual(events[1].workspace_ids, task.workspace_ids);
assert.equal(events[1].transport_ok, true);
assert.equal(events[1].ok, false);
assert.equal(events[1].verification, "INCOMPLETE");
assert.equal(events[1].error_code, "VERIFICATION_NOT_PASS");
assert.equal(events[1].change_count, 2);
assert.equal(events[1].file_count, 5);
assert.equal(Object.hasOwn(events[0], "args"), false);
assert.equal(Object.hasOwn(events[1], "args"), false);
assert.equal(Object.hasOwn(events[1], "error"), false);
const serialized = JSON.stringify(events);
for (const secret of ["must-not-be-audited", "super-secret", "private thinking"]) {
  assert.equal(serialized.includes(secret), false);
}

console.log("[PASS] Audit activity records operational metadata without args, output, or secret content");
