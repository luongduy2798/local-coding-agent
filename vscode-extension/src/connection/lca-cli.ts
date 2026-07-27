import { spawn } from "node:child_process";
import os from "node:os";
import * as vscode from "vscode";
import type { AuditStatus, TaskDescriptor, WorkspaceDescriptor } from "../api/api-types.js";

export interface LcaCliStatus {
  configured_workspace?: string | null;
  runtime_id?: string | null;
  server?: Record<string, unknown> | null;
  pids?: {
    supervisor_alive?: boolean;
    server_alive?: boolean;
    tunnel_alive?: boolean;
    tunnel_ready?: boolean;
  };
  connector?: { configured?: boolean; ready?: boolean; round_trip_ms?: number | null };
  sessions?: { active?: number; max?: number; total_requests?: number } | null;
  workspaces?: WorkspaceDescriptor[];
  selected_workspace?: WorkspaceDescriptor | null;
  active_tasks?: TaskDescriptor[];
  recent_tasks?: TaskDescriptor[];
  audit?: AuditStatus;
  storage_error?: string | null;
}

export async function connectLcaToWorkspace(workspace: string): Promise<void> {
  await runLca(["run", "--workspace", workspace, "--background"], workspace);
}

export async function startLca(cwd?: string): Promise<void> {
  await runLca(["start", "--background"], cwd);
}

export async function stopLca(cwd?: string): Promise<void> {
  await runLca(["stop"], cwd);
}

export async function readLcaStatus(cwd?: string): Promise<LcaCliStatus> {
  const stdout = await runLca(["status", "--json"], cwd);
  try {
    return JSON.parse(stdout) as LcaCliStatus;
  } catch {
    throw new Error("LCA did not return valid JSON status.");
  }
}

export async function makeDefaultWorkspace(workspaceId: string, cwd?: string): Promise<void> {
  await runLca(["workspace", "use", workspaceId, "--json"], cwd);
}

export async function archiveWorkspace(workspaceId: string, cwd?: string): Promise<void> {
  await runLca(["workspace", "archive", workspaceId, "--json"], cwd);
}

export async function restoreWorkspace(workspaceId: string, cwd?: string): Promise<void> {
  await runLca(["workspace", "restore", workspaceId, "--json"], cwd);
}

export async function removeWorkspacePermanently(
  workspaceId: string,
  label: string,
  cwd?: string,
): Promise<void> {
  await runLca([
    "workspace",
    "remove",
    workspaceId,
    "--force",
    "--confirm-label",
    label,
    "--json",
  ], cwd);
}

export interface WorkspaceRemovalSummary {
  workspace_id: string;
  label: string;
  registration_state: "active" | "archived";
  task_count: number;
  data_bytes: number;
  journal_bytes: number;
  blob_bytes: number;
  index_bytes: number;
}

export async function inspectWorkspaceRemoval(
  workspaceId: string,
  cwd?: string,
): Promise<WorkspaceRemovalSummary> {
  const stdout = await runLca([
    "workspace",
    "remove",
    workspaceId,
    "--preview",
    "--json",
  ], cwd);
  try {
    const result = JSON.parse(stdout) as { summary?: WorkspaceRemovalSummary };
    if (!result.summary?.workspace_id) throw new Error("missing summary");
    return result.summary;
  } catch {
    throw new Error("LCA did not return a valid permanent-removal preview.");
  }
}

export async function readLcaInstanceNonce(workspace: string): Promise<string | undefined> {
  const stdout = await runLca(
    ["status", "--json", "--include-instance-nonce"],
    workspace,
  );
  try {
    const status = JSON.parse(stdout) as { instance_nonce?: unknown };
    const nonce = String(status.instance_nonce || "").trim();
    return nonce || undefined;
  } catch {
    throw new Error("LCA did not return valid companion authentication state.");
  }
}

async function runLca(args: string[], cwd?: string): Promise<string> {
  const cli = vscode.workspace.getConfiguration("lca").get<string>("cliPath", "lca");
  return run(cli, args, cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir());
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      reject(new Error(`Could not run ${command}: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
  });
}
