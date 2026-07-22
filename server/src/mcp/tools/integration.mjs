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
let currentTask;
let decodePageCursor;
let discoverSkills;
let isWorkspaceSkillsDir;
let jsonResult;
let pageMetadata;
let pageScope;
let preparePatchTaskContext;
let reg;
let registry;
let resolveWorkspacePath;
let runPatchTransactionWithJournals;
let sanitizeSkillName;
let selectWorkspace;
let getSkillDirs;
let toWorkspaceRel;
let verifyWorkspaceChanges;

export function registerUtilityTools(mcp, dependencies) {
  ({
    FIGMA_DESKTOP_MCP_URL,
    FIGMA_DESKTOP_TIMEOUT_MS,
    MAX_READ_CHARS,
    buildFigmaDesktopArguments,
    currentTask,
    decodePageCursor,
    discoverSkills,
    isWorkspaceSkillsDir,
    jsonResult,
    pageMetadata,
    pageScope,
    preparePatchTaskContext,
    reg,
    registry,
    resolveWorkspacePath,
    runPatchTransactionWithJournals,
    sanitizeSkillName,
    selectWorkspace,
    getSkillDirs,
    toWorkspaceRel,
    verifyWorkspaceChanges
  } = dependencies);
  return registerUtilityToolsInternal(mcp);
}

function registerUtilityToolsInternal(mcp) {
  registerSkillsTool(mcp);
  registerNotesTool(mcp);
  registerFigmaTool(mcp);
  reg(
    mcp,
    "verify_changes",
    {
      title: "Verify changes",
      description: "Verify every required test, lint, typecheck and build gate; return PASS, FAIL or INCOMPLETE, never success for skipped/unanalysed changes.",
      inputSchema: {
        cwd: z.string().optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        include: z.array(z.enum(["lint", "typecheck", "test", "build"])).optional(),
        timeout_ms: z.number().int().min(1000).max(600000).optional(),
        stop_on_failure: z.boolean().optional(),
        dry_run: z.boolean().optional(),
        adopt_unmanaged: z.boolean().optional().describe("After reviewing the reported diff, explicitly adopt shell-made tracked changes into this task.")
      }
    },
    async (input) => {
      const routedTask = await currentTask({ taskToken: input.task_token, required: false });
      const workspaceIds = input.workspace_id
        ? [input.workspace_id]
        : routedTask?.workspace_ids?.length
          ? routedTask.workspace_ids
          : [(await selectWorkspace({ taskToken: input.task_token })).workspace.id];
      const results = [];
      for (const workspaceId of workspaceIds) {
        results.push(await verifyWorkspaceChanges({ ...input, workspace_id: workspaceId }));
      }
      if (results.length === 1) return jsonResult(results[0]);
      const status = results.some((result) => result.status === "FAIL")
        ? "FAIL"
        : results.every((result) => result.status === "PASS")
          ? "PASS"
          : "INCOMPLETE";
      return jsonResult({
        ok: status === "PASS",
        status,
        task_id: routedTask?.id || null,
        workspaces: results,
        summary: {
          total: results.length,
          pass: results.filter((result) => result.status === "PASS").length,
          fail: results.filter((result) => result.status === "FAIL").length,
          incomplete: results.filter((result) => result.status === "INCOMPLETE").length
        }
      });
    }
  );
}

function registerFigmaTool(mcp) {
  reg(
    mcp,
    "figma",
    {
      title: "Figma Desktop",
      description: "Check, list or call the official Figma Desktop MCP bridge.",
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
      description: "List or read skills visible to one task workspace; create/delete are journaled patch transactions.",
      inputSchema: {
        action: z.enum(["list", "read", "create", "delete"]).optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        body: z.string().optional(),
        dir: z.string().optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional()
      }
    },
    async ({
      action = "list",
      name,
      description,
      body = "",
      dir,
      workspace_id,
      task_token
    }) => {
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
          skills: skills.map((item) => ({
            name: item.name,
            description: item.description
          }))
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
      const relativeFolder = toWorkspaceRel(
        selected.workspace,
        path.join(resolvedDir.path, folderName)
      );
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

function registerNotesTool(mcp) {
  reg(
    mcp,
    "notes",
    {
      title: "Notes",
      description: "List or save workspace-local notes.",
      inputSchema: {
        action: z.enum(["list", "save"]).optional(),
        title: z.string().optional(),
        body: z.string().max(100_000).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().max(2048).optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional()
      }
    },
    async ({ action = "list", title, body, limit = 100, cursor, workspace_id, task_token }) => {
      const selected = await selectWorkspace({
        workspaceId: workspace_id,
        taskToken: task_token,
        requireTask: true
      });
      const database = await registry.openWorkspace(selected.workspace.id);
      if (action === "list") {
        const scope = pageScope("notes", {
          workspace_id: selected.workspace.id,
          task_id: selected.task.id
        });
        const offset = decodePageCursor(cursor, { kind: "notes", scope });
        const notes = await database.listNotes({
          taskId: selected.task.id,
          limit: limit + 1,
          offset
        });
        const page = notes.slice(0, limit);
        const hasMore = notes.length > page.length;
        return jsonResult({
          workspace_id: selected.workspace.id,
          task_id: selected.task.id,
          count: page.length,
          pagination: pageMetadata({
            kind: "notes",
            scope,
            offset,
            limit,
            returned: page.length,
            hasMore
          }),
          notes: page
        });
      }
      if (!title || !body) throw new Error("title and body are required for action=save");
      const note = await database.saveNote({
        taskId: selected.task.id,
        title,
        body
      });
      return jsonResult({
        ok: true,
        workspace_id: selected.workspace.id,
        task_id: selected.task.id,
        note
      });
    }
  );
}
