// Local Coding Agent MCP execution and Git tools
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

let CMD_OUTPUT_DEFAULT;
let DEFAULT_CMD_TIMEOUT;
let MAX_COMMAND_OUTPUT;
let MAX_PROCS;
let MODE;
let PROC_BUFFER;
let RUN_COMMANDS_OUTPUT_DEFAULT;
let assertCommandAllowed;
let defaultShell;
let freezeTaskForMutation;
let getChangeJournal;
let jsonResult;
let killProcessTree;
let markUnmanagedChange;
let mutationFingerprintChanged;
let processes;
let qualifiedPath;
let redactGitOutputPaths;
let reg;
let resolvePath;
let resolveWorkspacePath;
let runShellCommand;
let spawnCapture;
let startBackground;
let toRel;
let toWorkspaceRel;
let trimOutputPair;
let workspaceMutationFingerprint;

export function registerExecutionTools(mcp, dependencies) {
  ({
    CMD_OUTPUT_DEFAULT,
    DEFAULT_CMD_TIMEOUT,
    MAX_COMMAND_OUTPUT,
    MAX_PROCS,
    MODE,
    PROC_BUFFER,
    RUN_COMMANDS_OUTPUT_DEFAULT,
    assertCommandAllowed,
    defaultShell,
    freezeTaskForMutation,
    getChangeJournal,
    jsonResult,
    killProcessTree,
    markUnmanagedChange,
    mutationFingerprintChanged,
    processes,
    qualifiedPath,
    redactGitOutputPaths,
    reg,
    resolvePath,
    resolveWorkspacePath,
    runShellCommand,
    spawnCapture,
    startBackground,
    toRel,
    toWorkspaceRel,
    trimOutputPair,
    workspaceMutationFingerprint
  } = dependencies);
  registerExecTools(mcp);
  registerGitTool(mcp);
}

function registerExecTools(mcp) {
  reg(
    mcp,
    "run_command",
    {
      title: "Run command",
      description: "Run a command and wait for it to finish. Use proc_start for long-running servers. Output is trimmed to keep payloads small — use tail_lines/head_lines or max_output_chars to control it.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional().describe("Working directory inside a root."),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional().describe("Shell to use (default cmd on Windows, bash/sh on macOS/Linux)."),
        timeout_ms: z.number().int().min(1000).max(600000).optional(),
        tail_lines: z.number().int().min(1).max(5000).optional().describe("Return only the last N lines of output."),
        head_lines: z.number().int().min(1).max(5000).optional().describe("Return only the first N lines of output."),
        max_output_chars: z.number().int().min(500).max(MAX_COMMAND_OUTPUT).optional().describe(`Combined stdout/stderr budget (default ${CMD_OUTPUT_DEFAULT}).`),
        include_request: z.boolean().optional().describe("Echo command/cwd/shell in the response (default false).")
      }
    },
    async ({ command, cwd = ".", workspace_id, task_token, shell, timeout_ms = DEFAULT_CMD_TIMEOUT, tail_lines, head_lines, max_output_chars = CMD_OUTPUT_DEFAULT, include_request = false }) => {
      assertCommandAllowed(command);
      await freezeTaskForMutation(task_token);
      const selected = await resolveWorkspacePath(cwd, { workspaceId: workspace_id, taskToken: task_token });
      const workdir = selected.path;
      const beforeMutation = await workspaceMutationFingerprint(workdir, selected.workspace.canonicalRoot);
      const result = await runShellCommand(
        command,
        workdir,
        shell,
        timeout_ms,
        selected.workspace.canonicalRoot
      );
      const afterMutation = await workspaceMutationFingerprint(workdir, selected.workspace.canonicalRoot);
      const unmanagedChanges = mutationFingerprintChanged(beforeMutation, afterMutation);
      if (unmanagedChanges) {
        await markUnmanagedChange({
          workspaceId: selected.workspace.id,
          taskId: selected.task?.id || null,
          source: "run_command",
          before: beforeMutation,
          after: afterMutation
        });
      }
      const trimmed = trimOutputPair(result.stdout, result.stderr, { tail_lines, head_lines, max_chars: max_output_chars });
      const stdout = trimmed.stdout;
      const stderr = trimmed.stderr;
      const journal = await getChangeJournal(selected.workspace.id);
      await journal.recordActivity({
        source: "run_command",
        commandCount: 1,
        completed: 1,
        failed: result.exit_code === 0 ? 0 : 1,
        cwd: toWorkspaceRel(selected.workspace, workdir),
        exitCode: result.exit_code,
        timedOut: result.timed_out,
        message: unmanagedChanges
          ? "Command completed and changed the workspace outside apply_patch."
          : result.exit_code === 0 ? "Command completed." : "Command failed."
      });
      return jsonResult({
        workspace_id: selected.workspace.id,
        ...(include_request ? {
          cwd: qualifiedPath(selected.workspace, workdir),
          command,
          shell: shell || defaultShell()
        } : {}),
        ok: result.exit_code === 0 && !result.timed_out,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        unmanaged_changes: unmanagedChanges,
        output_chars: stdout.length + stderr.length,
        stdout_truncated: stdout.length < result.stdout.length,
        stderr_truncated: stderr.length < result.stderr.length,
        stdout,
        stderr
      });
    }
  );

  reg(
    mcp,
    "run_commands",
    {
      title: "Run command batch",
      description: "Run up to 12 guarded commands sequentially or in parallel.",
      inputSchema: {
        commands: z.array(z.object({
          command: z.string().min(1),
          cwd: z.string().optional(),
          workspace_id: z.string().optional(),
          shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional(),
          timeout_ms: z.number().int().min(1000).max(600000).optional(),
          max_output_chars: z.number().int().min(500).max(50_000).optional()
        })).min(1).max(12),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        parallel: z.boolean().optional().describe("Run independent commands concurrently (default false)."),
        max_concurrency: z.number().int().min(1).max(4).optional(),
        stop_on_failure: z.boolean().optional().describe("Sequential mode only; default true."),
        max_total_output_chars: z.number().int().min(1000).max(500000).optional().describe(`Combined batch output budget (default ${RUN_COMMANDS_OUTPUT_DEFAULT}).`),
        include_request: z.boolean().optional().describe("Echo each command/cwd/shell in results (default false).")
      }
    },
    async ({ commands, workspace_id, task_token, parallel = false, max_concurrency = 4, stop_on_failure = true, max_total_output_chars = RUN_COMMANDS_OUTPUT_DEFAULT, include_request = false }) => {
      await freezeTaskForMutation(task_token);
      const results = new Array(commands.length);
      const runOne = async (item, index) => {
        assertCommandAllowed(item.command);
        const selected = await resolveWorkspacePath(item.cwd || ".", {
          workspaceId: item.workspace_id || workspace_id,
          taskToken: task_token
        });
        const workdir = selected.path;
        const beforeMutation = await workspaceMutationFingerprint(workdir, selected.workspace.canonicalRoot);
        const result = await runShellCommand(
          item.command,
          workdir,
          item.shell,
          item.timeout_ms || DEFAULT_CMD_TIMEOUT,
          selected.workspace.canonicalRoot
        );
        const afterMutation = await workspaceMutationFingerprint(workdir, selected.workspace.canonicalRoot);
        const unmanagedChanges = mutationFingerprintChanged(beforeMutation, afterMutation);
        if (unmanagedChanges) {
          await markUnmanagedChange({
            workspaceId: selected.workspace.id,
            taskId: selected.task?.id || null,
            source: "run_commands",
            before: beforeMutation,
            after: afterMutation,
            details: { index }
          });
        }
        const maxChars = item.max_output_chars || 6_000;
        const trimmed = trimOutputPair(result.stdout, result.stderr, { max_chars: maxChars });
        const stdout = trimmed.stdout;
        const stderr = trimmed.stderr;
        const journal = await getChangeJournal(selected.workspace.id);
        await journal.recordActivity({
          source: "run_commands",
          commandCount: 1,
          completed: 1,
          failed: result.exit_code === 0 ? 0 : 1,
          cwd: toWorkspaceRel(selected.workspace, workdir),
          exitCode: result.exit_code,
          timedOut: result.timed_out,
          message: unmanagedChanges
            ? "Command changed the workspace outside apply_patch."
            : result.exit_code === 0 ? "Command completed." : "Command failed."
        });
        results[index] = {
          index,
          workspace_id: selected.workspace.id,
          ...(include_request ? {
            cwd: qualifiedPath(selected.workspace, workdir),
            command: item.command,
            shell: item.shell || defaultShell()
          } : {}),
          exit_code: result.exit_code,
          timed_out: result.timed_out,
          unmanaged_changes: unmanagedChanges,
          stdout_truncated: stdout.length < result.stdout.length,
          stderr_truncated: stderr.length < result.stderr.length,
          stdout,
          stderr
        };
      };

      if (parallel) {
        let cursor = 0;
        const worker = async () => {
          while (true) {
            const index = cursor++;
            if (index >= commands.length) return;
            await runOne(commands[index], index);
          }
        };
        await Promise.all(Array.from({ length: Math.min(max_concurrency, commands.length) }, () => worker()));
      } else {
        for (let index = 0; index < commands.length; index++) {
          await runOne(commands[index], index);
          if (stop_on_failure && results[index].exit_code !== 0) break;
        }
      }

      const completed = results.filter(Boolean);
      let remainingOutput = Math.min(max_total_output_chars, 500_000);
      let batchOutputTruncated = false;
      for (const item of completed) {
        for (const key of ["stderr", "stdout"]) {
          const value = String(item[key] || "");
          if (value.length > remainingOutput) {
            item[key] = value.slice(0, Math.max(0, remainingOutput));
            item[`${key}_truncated`] = true;
            batchOutputTruncated = true;
          }
          remainingOutput = Math.max(0, remainingOutput - String(item[key] || "").length);
        }
      }
      return jsonResult({
        ok: completed.length === commands.length && completed.every((result) => result.exit_code === 0),
        parallel,
        requested: commands.length,
        completed: completed.length,
        stopped_early: completed.length < commands.length,
        output_chars: Math.min(max_total_output_chars, 500_000) - remainingOutput,
        output_truncated: batchOutputTruncated,
        results: completed
      });
    }
  );
}


// Git flags blocked on the raw `git` tool (any mode): they can write arbitrary
// files, run external programs, or operate outside the resolved repo.
const BAD_GIT_FLAGS = [
  /^-c$/, /^-C$/,
  /^--git-dir(=|$)/i, /^--work-tree(=|$)/i,
  /^--output(=|$)/i, /^--no-index$/i, /^--ext-diff$/i,
  /^--exec-path(=|$)/i, /^--upload-pack(=|$)/i, /^--receive-pack(=|$)/i
];

// Read-only git subcommands allowed in safe mode (mutating ones need full mode).
export const GIT_READONLY = new Set([
  "status", "diff", "log", "show", "ls-files", "ls-tree", "rev-parse", "blame",
  "grep", "cat-file", "describe", "shortlog", "reflog", "whatchanged", "name-rev",
  "merge-base", "symbolic-ref", "for-each-ref", "count-objects", "version", "help"
]);

function registerGitTool(mcp) {
  reg(
    mcp,
    "git",
    {
      title: "Git",
      description: "Run a git command. Pass args as an array, e.g. [\"status\",\"--short\"].",
      inputSchema: {
        args: z.array(z.string()).min(1).describe('Git arguments, e.g. ["log","--oneline","-n","10"].'),
        cwd: z.string().optional().describe("Repository directory inside a workspace."),
        workspace_id: z.string().optional(),
        task_token: z.string().optional()
      }
    },
    async ({ args, cwd = ".", workspace_id, task_token }) => {
      // Always block flags that can write files, run external programs, or escape
      // the repo — even on "read" subcommands (e.g. `git diff --output=../x`,
      // `-c core.pager=...`, `--ext-diff`, `--git-dir`/`--work-tree`).
      if (args.some((a) => BAD_GIT_FLAGS.some((re) => re.test(a)))) {
        throw new Error("That git flag is blocked (can write files, run external programs, or escape the repo).");
      }
      const sub = (args.find((a) => !a.startsWith("-")) || "").toLowerCase();
      const infoFlag = args.some((a) => /^(--version|--help)$/i.test(a) || /^-[vh]$/.test(a));
      const readOnly = infoFlag || GIT_READONLY.has(sub);
      if (MODE !== "full") {
        // safe mode: only allow read-only git subcommands. Mutations
        // (restore, checkout --, rm, branch -D, push --force, reset, clean, …)
        // require AGENT_MODE=full.
        if (!infoFlag && !GIT_READONLY.has(sub)) {
          throw new Error(
            `Git "${sub || args[0] || ""}" is blocked in safe mode (only read-only git is allowed). Use git_status/git_diff, or set AGENT_MODE=full.`
          );
        }
      }
      if (!readOnly) await freezeTaskForMutation(task_token);
      const selected = await resolveWorkspacePath(cwd, { workspaceId: workspace_id, taskToken: task_token });
      const workdir = selected.path;
      const beforeMutation = await workspaceMutationFingerprint(workdir, selected.workspace.canonicalRoot);
      const result = await spawnCapture("git", args, workdir, DEFAULT_CMD_TIMEOUT);
      const afterMutation = await workspaceMutationFingerprint(workdir, selected.workspace.canonicalRoot);
      const unmanagedChanges = mutationFingerprintChanged(beforeMutation, afterMutation);
      if (unmanagedChanges) {
        await markUnmanagedChange({
          workspaceId: selected.workspace.id,
          taskId: selected.task?.id || null,
          source: "git",
          before: beforeMutation,
          after: afterMutation,
          details: { subcommand: sub || null }
        });
      }
      const journal = await getChangeJournal(selected.workspace.id);
      await journal.recordActivity({
        source: "git",
        commandCount: 1,
        completed: 1,
        failed: result.exit_code === 0 ? 0 : 1,
        cwd: toWorkspaceRel(selected.workspace, workdir),
        exitCode: result.exit_code,
        timedOut: result.timed_out,
        message: unmanagedChanges
          ? "Git changed the workspace outside apply_patch."
          : result.exit_code === 0 ? "Git command completed." : "Git command failed."
      });
      return jsonResult({
        workspace_id: selected.workspace.id,
        cwd: qualifiedPath(selected.workspace, workdir),
        args: args.map((argument) => redactGitOutputPaths(argument, selected.workspace)),
        output_scope: {
          workspace_id: selected.workspace.id,
          path: toWorkspaceRel(selected.workspace, workdir)
        },
        path_contract: "Path-like values in stdout/stderr are workspace-relative or redacted.",
        unmanaged_changes: unmanagedChanges,
        ...result,
        stdout: redactGitOutputPaths(result.stdout, selected.workspace),
        stderr: redactGitOutputPaths(result.stderr, selected.workspace)
      });
    }
  );


}

// Parse `git status --porcelain` into structured entries. Each line is
// "XY <path>" (or "XY <old> -> <new>" for renames) where X is the index code
// and Y the worktree code.
function parsePorcelain(out) {
  const files = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const index = line[0];
    const worktree = line[1];
    let rest = line.slice(3);
    let from = null;
    let to = rest;
    const arrow = rest.indexOf(" -> ");
    if (arrow !== -1) {
      from = rest.slice(0, arrow);
      to = rest.slice(arrow + 4);
    }
    files.push({
      index: index === " " ? null : index,
      worktree: worktree === " " ? null : worktree,
      path: to,
      from,
      staged: index !== " " && index !== "?",
      untracked: index === "?" && worktree === "?"
    });
  }
  return files;
}

export function parsePorcelainZ(out) {
  const records = String(out || "").split("\0");
  const files = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 3) continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const destination = record.slice(3);
    const renamed = indexStatus === "R" || indexStatus === "C" ||
      worktreeStatus === "R" || worktreeStatus === "C";
    const source = renamed ? records[++index] || null : null;
    files.push({
      index: indexStatus === " " ? null : indexStatus,
      worktree: worktreeStatus === " " ? null : worktreeStatus,
      path: destination,
      from: source,
      staged: indexStatus !== " " && indexStatus !== "?",
      untracked: indexStatus === "?" && worktreeStatus === "?"
    });
  }
  return files;
}
