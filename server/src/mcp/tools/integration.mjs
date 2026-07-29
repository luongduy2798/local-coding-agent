// Local Coding Agent MCP utility and integration tools
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  callFigmaDesktopTool,
  figmaDesktopStatus,
  listFigmaDesktopTools
} from "../../integrations/figma-desktop.mjs";
import { TaskRouterError } from "../../workspace/task-router.mjs";

let FIGMA_DESKTOP_MCP_URL;
let FIGMA_DESKTOP_TIMEOUT_MS;
let MAX_READ_CHARS;
let buildFigmaDesktopArguments;
let discoverSkills;
let isWorkspaceSkillsDir;
let jsonResult;
let preparePatchTaskContext;
let reg;
let resolveWorkspacePath;
let runPatchTransactionWithJournals;
let sanitizeSkillName;
let selectWorkspace;
let getSkillDirs;
let toWorkspaceRel;

export function registerUtilityTools(mcp, dependencies) {
  ({
    FIGMA_DESKTOP_MCP_URL,
    FIGMA_DESKTOP_TIMEOUT_MS,
    MAX_READ_CHARS,
    buildFigmaDesktopArguments,
    discoverSkills,
    isWorkspaceSkillsDir,
    jsonResult,
    preparePatchTaskContext,
    reg,
    resolveWorkspacePath,
    runPatchTransactionWithJournals,
    sanitizeSkillName,
    selectWorkspace,
    getSkillDirs,
    toWorkspaceRel
  } = dependencies);
  registerSkillsTool(mcp);
  registerFigmaTool(mcp);
}

function registerFigmaTool(mcp) {
  reg(
    mcp,
    "figma",
    {
      title: "Figma Desktop",
      description: "Check, list or call the official Figma Desktop MCP bridge. Use this only for an explicit Figma workflow, not ordinary repository inspection.",
      inputSchema: {
        action: z.enum(["status", "list", "call", "design_context", "screenshot", "metadata", "variables", "code_connect", "figjam"]).optional(),
        tool: z.string().optional(),
        url: z.string().url().optional(),
        node_id: z.string().optional(),
        client_languages: z.array(z.string()).optional(),
        client_frameworks: z.array(z.string()).optional(),
        force_code: z.boolean().optional(),
        enable_base64_response: z.boolean().optional(),
        arguments: z.record(z.any()).optional()
      }
    },
    async (input) => {
      const action = input.action || "status";
      if (action === "status") {
        return jsonResult(await figmaDesktopStatus({ endpoint: FIGMA_DESKTOP_MCP_URL, timeoutMs: FIGMA_DESKTOP_TIMEOUT_MS }));
      }
      if (action === "list") {
        const result = await listFigmaDesktopTools({ endpoint: FIGMA_DESKTOP_MCP_URL, timeoutMs: FIGMA_DESKTOP_TIMEOUT_MS });
        return jsonResult({ count: result.tools.length, tools: result.tools });
      }
      const upstream = {
        design_context: "get_design_context",
        screenshot: "get_screenshot",
        metadata: "get_metadata",
        variables: "get_variable_defs",
        code_connect: "get_code_connect_map",
        figjam: "get_figjam"
      }[action] || input.tool;
      if (!upstream) throw new Error("tool is required for action=call");
      const args = action === "call" ? (input.arguments || {}) : buildFigmaDesktopArguments(input);
      return callFigmaDesktopTool(upstream, args, { endpoint: FIGMA_DESKTOP_MCP_URL, timeoutMs: FIGMA_DESKTOP_TIMEOUT_MS });
    }
  );
}

function registerSkillsTool(mcp) {
  reg(
    mcp,
    "skills",
    {
      title: "Skills",
      description: "Use a workspace skill only when the user names one or a relevant skill has already been identified. Do not list skills for ordinary repository browsing or localized code edits; create/delete are journaled patch transactions.",
      inputSchema: {
        action: z.enum(["list", "read", "create", "delete"]),
        name: z.string().optional(),
        description: z.string().optional(),
        body: z.string().optional(),
        dir: z.string().optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional()
      }
    },
    async ({ action, name, description, body = "", dir, workspace_id, task_token }) => {
      const selected = await selectWorkspace({
        workspaceId: workspace_id,
        taskToken: task_token,
        requireTask: true
      });
      const skillDirs = getSkillDirs(selected.workspace.canonicalRoot);
      const skills = await discoverSkills(skillDirs);
      if (action === "list") {
        return jsonResult({
          workspace_id: selected.workspace.id,
          task_id: selected.task.id,
          count: skills.length,
          skills: skills.map((item) => ({ name: item.name, description: item.description }))
        });
      }
      if (!name) throw new Error(`name is required for action=${action}`);
      if (action === "read") {
        const skill = skills.find((item) => item.name.toLowerCase() === name.toLowerCase());
        if (!skill) throw new Error(`No skill named "${name}".`);
        const content = await readFile(skill.skillFile, "utf8");
        const files = (await readdir(skill.dir).catch(() => [])).filter((file) => file.toLowerCase() !== "skill.md");
        return jsonResult({
          workspace_id: selected.workspace.id,
          task_id: selected.task.id,
          name: skill.name,
          files,
          content: content.slice(0, MAX_READ_CHARS)
        });
      }

      const requestedDir = dir || ".claude/skills";
      const resolvedDir = await resolveWorkspacePath(requestedDir, {
        workspaceId: selected.workspace.id,
        taskToken: task_token,
        requireTask: true
      });
      if (!isWorkspaceSkillsDir(resolvedDir.path, selected.workspace.canonicalRoot)) {
        throw new TaskRouterError(
          "SKILLS_PATH_INVALID",
          "Skill mutations are confined to .claude/skills or .agent/skills in the selected workspace."
        );
      }
      const folderName = sanitizeSkillName(name);
      if (!folderName) throw new Error("Invalid skill name.");
      const relativeFolder = toWorkspaceRel(selected.workspace, path.join(resolvedDir.path, folderName));
      let operations;
      if (action === "create") {
        if (!description) throw new Error("description is required for action=create");
        const frontName = name.replace(/"/g, '\\"');
        const frontDescription = description.replace(/\r?\n/g, " ").replace(/"/g, '\\"');
        const content = `---\nname: "${frontName}"\ndescription: "${frontDescription}"\n---\n\n${body}${body && !body.endsWith("\n") ? "\n" : ""}`;
        operations = [{
          workspace_id: selected.workspace.id,
          op: "create",
          path: `${relativeFolder}/SKILL.md`,
          content
        }];
      } else {
        operations = [{
          workspace_id: selected.workspace.id,
          op: "delete",
          path: relativeFolder,
          recursive: true
        }];
      }

      const prepared = await preparePatchTaskContext({
        operations,
        defaultWorkspaceId: selected.workspace.id,
        taskToken: task_token,
        taskTitle: action === "create" ? `Create skill ${name}` : `Delete skill ${name}`
      });
      const applied = await runPatchTransactionWithJournals({
        operations: prepared.operations,
        task: prepared.task,
        taskToken: prepared.taskToken,
        taskTitle: action === "create" ? `Create skill ${name}` : `Delete skill ${name}`
      });
      return jsonResult({
        ok: true,
        action,
        name: folderName,
        workspace_id: selected.workspace.id,
        task_id: prepared.task.id,
        transaction: applied.transaction,
        changes: applied.changes,
        journal_errors: applied.journalErrors
      });
    }
  );
}
