// Persistent task, plan, dashboard, and mutation-event runtime.

import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";

const TASK_STATUSES = new Set([
  "created", "analyzing", "planned", "implementing", "paused",
  "verifying", "changed", "completed", "failed", "cancelled"
]);
const WORKFLOW_MODES = new Set(["fast", "plan", "auto"]);
const ACCESS_MODES = new Set(["full", "balanced", "safe"]);

function now() {
  return new Date().toISOString();
}

function cleanId(value, prefix) {
  const text = String(value || "").trim();
  if (/^[a-z0-9][a-z0-9._-]{2,100}$/i.test(text)) return text;
  return `${prefix}-${randomUUID()}`;
}

function existingId(value, label) {
  const text = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,100}$/i.test(text)) throw new Error(`Invalid ${label} id: ${value}`);
  return text;
}

function normalizeVerification(value = {}) {
  const normalize = (entry) => {
    if (entry && typeof entry === "object" && typeof entry.status === "string") return entry;
    if (entry === true) return { status: "requested" };
    return { status: "not_requested", reason: "explicit_only" };
  };
  return {
    tests: normalize(value.tests),
    lint: normalize(value.lint),
    build: normalize(value.build)
  };
}

function hashPlan(plan) {
  const stable = JSON.stringify({
    taskId: plan.taskId,
    goal: plan.goal,
    assumptions: plan.assumptions,
    scope: plan.scope,
    steps: plan.steps,
    risks: plan.risks,
    verification: plan.verification,
    version: plan.version
  });
  return createHash("sha256").update(stable).digest("hex");
}

function classifyComplexity(text) {
  const input = String(text || "").toLowerCase();
  const reasons = [];
  const checks = [
    [/\b(refactor|architecture|redesign|migration|migrate|monorepo|cross[- ]package)\b/i, "Architectural or cross-module change"],
    [/\b(database|schema|public api|backward compatibility|breaking change)\b/i, "Compatibility-sensitive change"],
    [/\b(multiple|many|all files|entire|toàn bộ|nhiều file|kiến trúc)\b/i, "Broad implementation scope"],
    [/\b(parallel|worktree|concurrent|race condition|security hardening)\b/i, "Coordination or safety complexity"]
  ];
  for (const [pattern, reason] of checks) if (pattern.test(input)) reasons.push(reason);
  const longRequest = input.length > 500;
  if (longRequest) reasons.push("Long multi-constraint request");
  const complexity = reasons.length ? "complex" : "simple";
  return { complexity, recommendedWorkflow: complexity === "complex" ? "plan" : "fast", reasons };
}

export function createTaskRuntime({ dataDir, root, defaultAccessMode = "full", defaultWorkflowMode = "auto", version = "unknown" }) {
  const tasksDir = path.join(dataDir, "tasks");
  const plansDir = path.join(dataDir, "plans");
  const currentPath = path.join(dataDir, "current-task.json");

  async function ensure() {
    await Promise.all([mkdir(tasksDir, { recursive: true }), mkdir(plansDir, { recursive: true })]);
  }

  async function readJson(file, fallback = null) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
  }

  async function writeJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  function taskPath(id) { return path.join(tasksDir, `${existingId(id, "task")}.json`); }
  function planPath(id) { return path.join(plansDir, `${existingId(id, "plan")}.json`); }

  async function getTask(id) {
    await ensure();
    const task = await readJson(taskPath(id));
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  async function saveTask(task) {
    task.updatedAt = now();
    await writeJson(taskPath(task.id), task);
    await writeJson(currentPath, { taskId: task.id, updatedAt: task.updatedAt });
    return task;
  }

  async function getCurrentTask() {
    const current = await readJson(currentPath);
    if (!current?.taskId) return null;
    try { return await getTask(current.taskId); } catch { return null; }
  }

  async function createTask(input = {}) {
    await ensure();
    const analysis = classifyComplexity(input.goal || input.title || "");
    const workflowMode = WORKFLOW_MODES.has(input.workflowMode) ? input.workflowMode : defaultWorkflowMode;
    const accessMode = ACCESS_MODES.has(input.accessMode) ? input.accessMode : defaultAccessMode;
    const task = {
      id: cleanId(input.id, "task"),
      title: String(input.title || input.goal || "Local coding task").slice(0, 160),
      goal: String(input.goal || input.title || ""),
      status: TASK_STATUSES.has(input.status) ? input.status : "created",
      accessMode,
      workflowMode,
      complexity: input.complexity || analysis.complexity,
      complexityReasons: Array.isArray(input.complexityReasons) ? input.complexityReasons : analysis.reasons,
      planId: input.planId || null,
      verification: normalizeVerification(input.verification),
      changes: [],
      transactions: [],
      activity: [{ ts: now(), type: "task_created", message: "Task created" }],
      ui: {
        visible: true,
        alwaysShowOnCodeChange: true,
        autoPipOnImplement: true,
        autoOpenOnComplete: false,
        ...(input.ui || {})
      },
      root,
      runtimeVersion: version,
      createdAt: now(),
      updatedAt: now()
    };
    await saveTask(task);
    return task;
  }

  async function listTasks(limit = 50) {
    await ensure();
    const names = (await readdir(tasksDir).catch(() => [])).filter((name) => name.endsWith(".json"));
    const tasks = [];
    for (const name of names) {
      const task = await readJson(path.join(tasksDir, name));
      if (task) tasks.push(task);
    }
    tasks.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return tasks.slice(0, limit);
  }

  async function updateTask(id, patch = {}) {
    const task = await getTask(id);
    if (patch.status !== undefined) {
      if (!TASK_STATUSES.has(patch.status)) throw new Error(`Unsupported task status: ${patch.status}`);
      task.status = patch.status;
    }
    if (patch.title !== undefined) task.title = String(patch.title).slice(0, 160);
    if (patch.goal !== undefined) task.goal = String(patch.goal);
    if (patch.workflowMode !== undefined) {
      if (!WORKFLOW_MODES.has(patch.workflowMode)) throw new Error(`Unsupported workflow mode: ${patch.workflowMode}`);
      task.workflowMode = patch.workflowMode;
    }
    if (patch.accessMode !== undefined) {
      if (!ACCESS_MODES.has(patch.accessMode)) throw new Error(`Unsupported access mode: ${patch.accessMode}`);
      task.accessMode = patch.accessMode;
    }
    if (patch.verification !== undefined) task.verification = normalizeVerification(patch.verification);
    if (patch.ui && typeof patch.ui === "object") task.ui = { ...task.ui, ...patch.ui };
    if (patch.activityMessage) task.activity.push({ ts: now(), type: patch.activityType || "task_updated", message: String(patch.activityMessage) });
    return saveTask(task);
  }

  async function analyzeTask(text) {
    return classifyComplexity(text);
  }

  async function createPlan(input = {}) {
    const task = await getTask(input.taskId);
    const previous = task.planId ? await readJson(planPath(task.planId)) : null;
    if (previous) await writeJson(path.join(plansDir, `${previous.id}.v${previous.version}.json`), previous);
    const versionNumber = Number(previous?.version || 0) + 1;
    const plan = {
      id: cleanId(input.id || task.planId, "plan"),
      taskId: task.id,
      version: versionNumber,
      goal: String(input.goal || task.goal || task.title),
      assumptions: Array.isArray(input.assumptions) ? input.assumptions.map(String) : [],
      scope: Array.isArray(input.scope) ? input.scope.map(String) : [],
      steps: (Array.isArray(input.steps) ? input.steps : []).map((step, index) => typeof step === "string" ? { id: index + 1, text: step, enabled: true, done: false } : { id: index + 1, enabled: true, done: false, ...step }),
      risks: Array.isArray(input.risks) ? input.risks.map(String) : [],
      verification: normalizeVerification(input.verification || task.verification),
      createdAt: previous?.createdAt || now(),
      updatedAt: now()
    };
    plan.hash = hashPlan(plan);
    await writeJson(planPath(plan.id), plan);
    task.planId = plan.id;
    task.status = "planned";
    task.workflowMode = "plan";
    task.activity.push({ ts: now(), type: "plan_created", message: `Plan v${plan.version} created` });
    await saveTask(task);
    return plan;
  }

  async function getPlan(id) {
    const plan = await readJson(planPath(id));
    if (!plan) throw new Error(`Plan not found: ${id}`);
    return plan;
  }

  async function updatePlan(id, patch = {}) {
    const current = await getPlan(id);
    return createPlan({
      id: current.id,
      taskId: current.taskId,
      goal: patch.goal ?? current.goal,
      assumptions: patch.assumptions ?? current.assumptions,
      scope: patch.scope ?? current.scope,
      steps: patch.steps ?? current.steps,
      risks: patch.risks ?? current.risks,
      verification: patch.verification ?? current.verification
    });
  }

  async function planHistory({ planId, taskId } = {}) {
    await ensure();
    const names = await readdir(plansDir).catch(() => []);
    const plans = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const plan = await readJson(path.join(plansDir, name));
      if (!plan) continue;
      if (planId && plan.id !== planId) continue;
      if (taskId && plan.taskId !== taskId) continue;
      plans.push(plan);
    }
    const unique = new Map();
    for (const plan of plans) unique.set(`${plan.id}:${plan.version}`, plan);
    return [...unique.values()].sort((a, b) => Number(b.version) - Number(a.version));
  }

  async function prepareImplementation({ taskId, planId, expectedPlanVersion, expectedPlanHash }) {
    const task = await getTask(taskId);
    const selectedPlanId = planId || task.planId;
    if (!selectedPlanId) throw new Error("Task has no plan to implement.");
    const plan = await getPlan(selectedPlanId);
    if (expectedPlanVersion !== undefined && Number(expectedPlanVersion) !== Number(plan.version)) throw new Error("PLAN_VERSION_CONFLICT");
    if (expectedPlanHash && expectedPlanHash !== plan.hash) throw new Error("PLAN_HASH_CONFLICT");
    task.status = "implementing";
    task.planId = plan.id;
    task.activity.push({ ts: now(), type: "implementation_started", message: `Implementing plan v${plan.version}` });
    await saveTask(task);
    return { task, plan };
  }

  async function ensureActivityTask(input = {}) {
    const explicitTask = Boolean(input.taskId);
    let task = explicitTask ? await getTask(input.taskId).catch(() => null) : await getCurrentTask();
    if (!task || (!explicitTask && ["completed", "failed", "cancelled"].includes(task.status))) {
      task = await createTask({
        title: input.title || "Local coding activity",
        goal: input.summary || input.message || "Track local coding activity",
        status: input.status || "created",
        workflowMode: input.workflowMode || defaultWorkflowMode,
        accessMode: input.accessMode || defaultAccessMode
      });
    }
    return task;
  }

  async function recordActivity(input = {}) {
    const task = await ensureActivityTask(input);
    task.activity.push({
      id: randomUUID(),
      ts: now(),
      type: input.type || "activity",
      tool: input.tool || null,
      message: String(input.message || input.summary || "Task activity"),
      metadata: input.metadata || null
    });
    await saveTask(task);
    return dashboard(task);
  }

  async function recordVerification(input = {}) {
    let task = input.taskId ? await getTask(input.taskId).catch(() => null) : await getCurrentTask();
    if (!task) task = await createTask({ title: "Verification", goal: `Run ${input.kind || "verification"}`, status: "verifying" });
    const kind = ["tests", "lint", "build"].includes(input.kind) ? input.kind : "tests";
    const result = input.result && typeof input.result === "object" ? input.result : {};
    task.verification[kind] = {
      status: result.ok === true ? "passed" : "failed",
      explicit: true,
      at: now(),
      command: result.command || null,
      exitCode: result.exit_code ?? null,
      timedOut: Boolean(result.timed_out),
      summary: typeof result.summary === "string" ? result.summary.slice(0, 2000) : null
    };
    task.activity.push({
      id: randomUUID(),
      ts: now(),
      type: "verification",
      message: `${kind} ${task.verification[kind].status}`,
      kind,
      status: task.verification[kind].status
    });
    await saveTask(task);
    return dashboard(task);
  }

  async function recordMutation(input = {}) {
    const task = await ensureActivityTask({
      ...input,
      title: input.title || "Code changes",
      summary: input.summary || `Apply ${input.tool || "code"} changes`,
      status: "changed"
    });
    const paths = [...new Set((Array.isArray(input.paths) ? input.paths : []).map(String).filter(Boolean))];
    const event = {
      id: randomUUID(),
      ts: now(),
      type: "code_mutation",
      tool: input.tool || "unknown",
      paths,
      summary: String(input.summary || `${input.tool || "Tool"} changed code`),
      transactionId: input.transactionId || null
    };
    task.status = task.status === "planned"
      ? "implementing"
      : (["created", "completed", "failed", "cancelled"].includes(task.status) ? "changed" : task.status);
    task.activity.push(event);
    for (const changedPath of paths) {
      const current = task.changes.find((item) => item.path === changedPath);
      if (current) {
        current.lastChangedAt = event.ts;
        current.tool = event.tool;
      } else {
        task.changes.push({ path: changedPath, tool: event.tool, firstChangedAt: event.ts, lastChangedAt: event.ts });
      }
    }
    if (input.transactionId && !task.transactions.includes(input.transactionId)) task.transactions.push(input.transactionId);
    await saveTask(task);
    return dashboard(task);
  }

  function dashboard(task) {
    return {
      kind: "lca_task_dashboard",
      visible: true,
      task: {
        id: task.id,
        title: task.title,
        goal: task.goal,
        status: task.status,
        accessMode: task.accessMode,
        workflowMode: task.workflowMode,
        complexity: task.complexity,
        planId: task.planId,
        updatedAt: task.updatedAt
      },
      changes: task.changes.slice(-100),
      transactions: task.transactions.slice(-50),
      verification: task.verification,
      activity: task.activity.slice(-50),
      ui: task.ui
    };
  }

  async function getDashboard(taskId) {
    const task = taskId ? await getTask(taskId) : await getCurrentTask();
    if (!task) return { kind: "lca_task_dashboard", visible: false, task: null, changes: [], activity: [] };
    return dashboard(task);
  }

  return {
    analyzeTask,
    createTask,
    getTask,
    listTasks,
    updateTask,
    createPlan,
    getPlan,
    updatePlan,
    planHistory,
    prepareImplementation,
    recordActivity,
    recordVerification,
    recordMutation,
    getDashboard,
    getCurrentTask
  };
}
