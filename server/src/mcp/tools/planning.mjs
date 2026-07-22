// Local Coding Agent MCP planning tools
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

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
    taskRouter,
    textResult
  } = dependencies;
  reg(
    mcp,
    "task_plan",
    {
      title: "Task plan",
      description: "Create or update the current task plan. Stores goal + steps in .agent/state/current-task.json.",
      inputSchema: {
        goal: z.string().min(1).describe("High-level goal description."),
        steps: z.array(z.string()).min(1).describe("Ordered list of steps to complete the goal."),
        task_token: z.string().optional()
      }
    },
    async ({ goal, steps, task_token }) => {
      const routedTask = await currentTask({
        taskToken: task_token,
        required: Boolean(taskRouter)
      });
      const planPath = taskArtifactPath(routedTask, "plan.json", TASK_PLAN_PATH);
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
      return jsonResult({ ok: true, task: routedTask, goal, steps_count: steps.length });
    }
  );

  reg(
    mcp,
    "task_state",
    {
      title: "Task state",
      description: "Get or update the current task plan. Call with no args to read; pass set_step_done/add_steps/status to update.",
      inputSchema: {
        task_token: z.string().optional().describe("Resume or inspect a V5 task after reconnect."),
        set_step_done: z.number().int().min(0).optional().describe("Mark step N (0-indexed) as done."),
        add_steps: z.array(z.string()).optional().describe("Append new steps to the plan."),
        status: z.string().optional().describe("Set overall status string.")
      }
    },
    async ({ task_token, set_step_done, add_steps, status }) => {
      const routedTask = await currentTask({
        taskToken: task_token,
        required: Boolean(taskRouter)
      });
      const planPath = taskArtifactPath(routedTask, "plan.json", TASK_PLAN_PATH);
      let plan = null;
      try {
        plan = JSON.parse(await readFile(planPath, "utf8"));
      } catch {}

      if (!plan && !routedTask) return textResult("No active task. Call task_open and task_plan.");

      let changed = false;
      if (plan && set_step_done !== undefined) {
        if (plan.steps[set_step_done]) { plan.steps[set_step_done].done = true; changed = true; }
      }
      if (plan && add_steps && add_steps.length > 0) {
        plan.steps.push(...add_steps.map((text) => ({ text, done: false })));
        changed = true;
      }
      if (plan && status !== undefined) {
        plan.status = status;
        changed = true;
      }
      if (plan && changed) {
        plan.updated = isoNow();
        await atomicWriteJson(planPath, plan);
      }
      if (plan && status !== undefined && /^(done|completed|complete|finished|success)$/i.test(String(status).trim())) {
        if (routedTask) {
          for (const workspaceId of routedTask.workspace_ids) {
            await (await getChangeJournal(workspaceId)).completeTask({ title: plan.goal });
          }
        } else {
          await CHANGE_JOURNAL.completeTask({ title: plan.goal });
        }
      }

      const done = plan?.steps?.filter((s) => s.done).length || 0;
      const total = plan?.steps?.length || 0;
      return jsonResult({ task: routedTask, plan, progress: plan ? `${done}/${total}` : null });
    }
  );

}
