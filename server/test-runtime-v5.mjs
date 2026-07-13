// Local Coding Agent v5 runtime unit tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";

import { buildChildEnv } from "./core/child-env.mjs";
import { createTaskRuntime } from "./core/task-runtime.mjs";
import { createAtomicMutationEngine } from "./core/atomic-mutation.mjs";
import { boundaryStatus, wrapSpawnSpec } from "./core/execution-boundary.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-v5-test-"));
  const dataDir = path.join(root, ".data");
  const resolvePath = (input) => {
    const target = path.resolve(root, input);
    const rel = path.relative(root, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("outside root");
    return target;
  };
  const toRel = (input) => path.relative(root, input).split(path.sep).join("/") || ".";
  return { root, dataDir, resolvePath, toRel };
}

test("child environment strips only LCA control-plane credentials", () => {
  const env = buildChildEnv({
    PATH: "/bin",
    DATABASE_URL: "postgres://project",
    OPENAI_API_KEY: "project-key",
    MCP_AUTH_TOKEN: "internal-mcp",
    AGENT_APPROVAL_TOKEN: "internal-approval",
    CONTROL_PLANE_API_KEY: "internal-control"
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.DATABASE_URL, "postgres://project");
  assert.equal(env.OPENAI_API_KEY, "project-key");
  assert.equal(env.MCP_AUTH_TOKEN, undefined);
  assert.equal(env.AGENT_APPROVAL_TOKEN, undefined);
  assert.equal(env.CONTROL_PLANE_API_KEY, undefined);
});

test("task runtime defaults to full/auto and dashboard is visible after every mutation", async () => {
  const fx = await fixture();
  try {
    const runtime = createTaskRuntime({ dataDir: fx.dataDir, root: fx.root, defaultAccessMode: "full", defaultWorkflowMode: "auto", version: "test" });
    const dashboard = await runtime.recordMutation({ tool: "write_file", paths: ["src/a.js"], summary: "created a.js" });
    assert.equal(dashboard.visible, true);
    assert.equal(dashboard.task.accessMode, "full");
    assert.equal(dashboard.task.workflowMode, "auto");
    assert.equal(dashboard.changes[0].path, "src/a.js");
    assert.equal(dashboard.ui.alwaysShowOnCodeChange, true);
    assert.equal(dashboard.verification.tests.status, "not_requested");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("plan implementation rejects stale version/hash", async () => {
  const fx = await fixture();
  try {
    const runtime = createTaskRuntime({ dataDir: fx.dataDir, root: fx.root, defaultAccessMode: "full", defaultWorkflowMode: "auto", version: "test" });
    const task = await runtime.createTask({ goal: "Refactor architecture" });
    const plan = await runtime.createPlan({ taskId: task.id, steps: ["Extract module", "Update callers"] });
    await assert.rejects(() => runtime.prepareImplementation({ taskId: task.id, planId: plan.id, expectedPlanVersion: plan.version + 1 }), /PLAN_VERSION_CONFLICT/);
    await assert.rejects(() => runtime.prepareImplementation({ taskId: task.id, planId: plan.id, expectedPlanHash: "stale" }), /PLAN_HASH_CONFLICT/);
    const prepared = await runtime.prepareImplementation({ taskId: task.id, planId: plan.id, expectedPlanVersion: plan.version, expectedPlanHash: plan.hash });
    assert.equal(prepared.task.status, "implementing");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("atomic engine validates the full batch before writing", async () => {
  const fx = await fixture();
  try {
    await mkdir(path.join(fx.root, "src"), { recursive: true });
    await writeFile(path.join(fx.root, "src", "a.js"), "const a = 1;\n", "utf8");
    const engine = createAtomicMutationEngine({ dataDir: fx.dataDir, resolvePath: fx.resolvePath, toRel: fx.toRel });
    await assert.rejects(() => engine.applyOperations([
      { op: "update", path: "src/a.js", edits: [{ old_text: "1", new_text: "2" }] },
      { op: "update", path: "src/missing.js", edits: [{ old_text: "x", new_text: "y" }] }
    ]), /PATH_NOT_FOUND/);
    assert.equal(await readFile(path.join(fx.root, "src", "a.js"), "utf8"), "const a = 1;\n");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("atomic engine rejects ambiguous edit and create collision", async () => {
  const fx = await fixture();
  try {
    await writeFile(path.join(fx.root, "a.js"), "x\nx\n", "utf8");
    const engine = createAtomicMutationEngine({ dataDir: fx.dataDir, resolvePath: fx.resolvePath, toRel: fx.toRel });
    await assert.rejects(() => engine.applyOperations([{ op: "update", path: "a.js", edits: [{ old_text: "x", new_text: "y" }] }]), /AMBIGUOUS_EDIT/);
    await assert.rejects(() => engine.applyOperations([{ op: "create", path: "a.js", content: "new" }]), /CREATE_COLLISION/);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("atomic transaction can undo and redo", async () => {
  const fx = await fixture();
  try {
    await writeFile(path.join(fx.root, "a.js"), "old\n", "utf8");
    const engine = createAtomicMutationEngine({ dataDir: fx.dataDir, resolvePath: fx.resolvePath, toRel: fx.toRel });
    const applied = await engine.applyOperations([{ op: "update", path: "a.js", edits: [{ old_text: "old", new_text: "new" }] }]);
    assert.equal(await readFile(path.join(fx.root, "a.js"), "utf8"), "new\n");
    await engine.undo(applied.transaction_id);
    assert.equal(await readFile(path.join(fx.root, "a.js"), "utf8"), "old\n");
    await engine.redo(applied.transaction_id);
    assert.equal(await readFile(path.join(fx.root, "a.js"), "utf8"), "new\n");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("full execution mode always bypasses OS sandbox wrapping", () => {
  const status = boundaryStatus("full", process.cwd());
  const wrapped = wrapSpawnSpec({ file: "node", args: ["--version"], opts: {} }, process.cwd(), "full");
  assert.equal(status.active, false);
  assert.equal(status.adapter, "direct");
  assert.equal(wrapped.file, "node");
  assert.deepEqual(wrapped.args, ["--version"]);
});
