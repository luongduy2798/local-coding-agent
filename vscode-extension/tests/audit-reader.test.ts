import assert from "node:assert/strict";
import { auditReaderTestExports } from "../src/activity/audit-reader.js";

const { buildActivities, projectAuditEvent } = auditReaderTestExports;
const raw = [
  {
    ts: "2026-07-22T01:00:00.000Z",
    kind: "runtime",
    phase: "started",
    runtime_id: "runtime-old",
  },
  {
    ts: "2026-07-22T01:00:01.000Z",
    kind: "tool",
    phase: "started",
    invocation_id: "invocation-running",
    runtime_id: "runtime-old",
    tool: "apply_patch",
    task_id: "task_audit12345678",
    workspace_ids: ["ws_audit12345678"],
    args: { command: "must-not-escape" },
    output: "must-not-escape",
  },
  {
    ts: "2026-07-22T01:00:02.000Z",
    kind: "tool",
    phase: "started",
    invocation_id: "invocation-finished",
    runtime_id: "runtime-old",
    tool: "verify_changes",
    task_id: "task_audit12345678",
    workspace_ids: ["ws_audit12345678"],
  },
  {
    ts: "2026-07-22T01:00:03.000Z",
    kind: "tool",
    phase: "finished",
    invocation_id: "invocation-finished",
    runtime_id: "runtime-old",
    tool: "verify_changes",
    task_id: "task_audit12345678",
    workspace_ids: ["ws_audit12345678"],
    duration_ms: 1000,
    verification: "PASS",
    ok: true,
  },
  {
    ts: "2026-07-22T01:00:05.000Z",
    kind: "runtime",
    phase: "started",
    runtime_id: "runtime-new",
  },
];

const projected = raw.map(projectAuditEvent).filter((event) => event !== null);
const deduplicated = new Map(projected.map((event) => [event!.key, event!]));
// Replaying a rotated file must not duplicate the same invocation phase.
for (const event of projected) deduplicated.set(event!.key, event!);
const activities = buildActivities(deduplicated.values());

assert.equal(activities.length, 2);
const interrupted = activities.find((activity) => activity.invocationId === "invocation-running");
assert.equal(interrupted?.status, "interrupted");
assert.equal(interrupted?.errorCode, "RUNTIME_INTERRUPTED");
const finished = activities.find((activity) => activity.invocationId === "invocation-finished");
assert.equal(finished?.status, "finished");
assert.equal(finished?.verification, "PASS");
assert.equal(finished?.durationMs, 1000);
const serialized = JSON.stringify(projected);
assert.equal(serialized.includes("must-not-escape"), false);

console.log("[PASS] Audit reader deduplicates rotation and marks replaced runtime calls interrupted");
