import { spawn } from "node:child_process";
import * as vscode from "vscode";

export async function connectLcaToWorkspace(workspace: string): Promise<void> {
  const cli = vscode.workspace.getConfiguration("lca").get<string>("cliPath", "lca");
  await run(cli, ["stop"], workspace, true);
  await run(cli, ["run", "--workspace", workspace, "--background"], workspace, false);
}

function run(command: string, args: string[], cwd: string, allowFailure: boolean): Promise<void> {
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
      if (allowFailure) resolve();
      else reject(new Error(`Could not run ${command}: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0 || allowFailure) resolve();
      else reject(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
  });
}
