// Local Coding Agent MCP planning tools
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const PLAN_ACTIONS = ["create", "get", "complete_step", "add_steps", "set_status"];

export function registerPlanningTools(mcp, dependencies) {
  const {
    CHANGE_JOURNAL,
    TASK_PLAN_PATH,
    atomicWriteJson,
    currentTask,
    getChangeJournal,
    isoNow,
    jsonResult,
    reg,
    taskArtifactPath,
    taskRouter
  } = dependencies;

  reg(
    mcp,
    "task_plan",
    {
      title: "Task plan",
      description: "Create, inspect, or update persistent milestones for a multi-step, ambiguous, multi-workspace, or long-running task. Use task_checkpoint for resumable in-progress context and workspace_memory only for durable knowledge needed by future tasks. Do not create a plan for a localized edit unless it has meaningful independent steps.",
      inputSchema: {
        action: z.enum(PLAN_ACTIONS).optional().describe("Defaults to create when goal/steps are supplied, otherwise get."),
        goal: z.string().min(1).optional().describe("create only: high-level goal description."),
        steps: z.array(z.string().min(1)).min(1).optional().describe("create/add_steps: ordered steps to create or append."),
        step_index: z.number().int().min(0).optional().describe("complete_step only: zero-based step index."),
        status: z.string().min(1).max(240).optional().describe("set_status only: meaningful phase transition or blocker, not per-call narration."),
        task_token: z.string().optional()
      }
    },
    async ({ action, goal, steps, step_index, status, task_token }) => {
      const effectiveAction = action || ((goal || steps?.length) ? "create" : "get");
      const routedTask = await currentTask({
        taskToken: task_token,
        required: Boolean(taskRouter)
      });
      const planPath = taskArtifactPath(routedTask, "plan.json", TASK_PLAN_PATH);

      if (effectiveAction === "create") {
        if (!goal || !steps?.length) throw new Error("task_plan action=create requires goal and steps.");
        if (routedTask) {
          for (const workspaceId of routedTask.workspace_ids) {
            await (await getChangeJournal(workspaceId)).beginTask({ title: goal });
          }
        } else {
          await CHANGE_JOURNAL.beginTask({ title: goal });
        }
        await mkdir(path.dirname(planPath), { recursive: true });
        const plan = {
          version: 5,
          task_id: routedTask?.id || null,
          goal,
          steps: steps.map((text) => ({ text, done: false })),
          created: isoNow(),
          updated: isoNow()
        };
        await atomicWriteJson(planPath, plan);
        return jsonResult({
          ok: true,
          action: effectiveAction,
          task: routedTask,
          plan,
          progress: `0/${plan.steps.length}`,
          steps_count: plan.steps.length
        });
      }

      let plan = null;
      try {
        plan = JSON.parse(await readFile(planPath, "utf8"));
      } catch {}

      if (effectiveAction === "get") {
        const done = plan?.steps?.filter((step) => step.done).length || 0;
        const total = plan?.steps?.length || 0;
        return jsonResult({
          ok: true,
          action: effectiveAction,
          task: routedTask,
          plan,
          progress: plan ? `${done}/${total}` : null
        });
      }

      if (!plan) throw new Error("No persistent task plan exists. Call task_plan with action=create first.");
      if (effectiveAction === "complete_step") {
        if (step_index === undefined) throw new Error("task_plan action=complete_step requires step_index.");
        if (!plan.steps?.[step_index]) throw new Error(`Task plan step ${step_index} does not exist.`);
        plan.steps[step_index].done = true;
      } else if (effectiveAction === "add_steps") {
        if (!steps?.length) throw new Error("task_plan action=add_steps requires steps.");
        plan.steps.push(...steps.map((text) => ({ text, done: false })));
      } else if (effectiveAction === "set_status") {
        if (!status) throw new Error("task_plan action=set_status requires status.");
        plan.status = status;
      }
      plan.updated = isoNow();
      await atomicWriteJson(planPath, plan);

      if (effectiveAction === "set_status" && /^(done|completed|complete|finished|success)$/i.test(String(status).trim())) {
        if (routedTask) {
          for (const workspaceId of routedTask.workspace_ids) {
            await (await getChangeJournal(workspaceId)).completeTask({ title: plan.goal });
          }
        } else {
          await CHANGE_JOURNAL.completeTask({ title: plan.goal });
        }
      }

      const done = plan.steps.filter((step) => step.done).length;
      return jsonResult({
        ok: true,
        action: effectiveAction,
        task: routedTask,
        plan,
        progress: `${done}/${plan.steps.length}`
      });
    }
  );
}
