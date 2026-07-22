// Local Coding Agent CLI workspace registry and selection.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONFIG_PATH,
  REPO_ROOT,
  SERVER_DIR,
  effectiveOptions,
  normalize,
  saveConfig,
  stripRuntimeFields
} from "./config.mjs";
import { capture } from "./processes.mjs";

let services = Object.create(null);

export function configureWorkspaceServices(next) {
  services = { ...services, ...next };
}

async function detectWorkspaceRoot(cwd = process.cwd()) {
  const git = process.platform === "win32" ? "git.exe" : "git";
  const result = await capture(git, ["-C", cwd, "rev-parse", "--show-toplevel"]);
  const root = result.code === 0 ? result.stdout.trim() : "";
  return root && existsSync(root) ? resolve(root) : resolve(cwd);
}

async function runCurrentWorkspace(flags) {
  const workspace = resolve(flags.workspace || await detectWorkspaceRoot());
  const opts = normalize({ ...effectiveOptions(flags), workspace });
  await selectCliWorkspace(workspace);
  await saveConfig(stripRuntimeFields(opts));
  return services.start({ ...flags, workspace });
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function workspaceItems(current) {
  const items = [
    { label: "Select this folder", type: "select", path: current },
    { label: "Back ..", type: "open", path: dirname(current) }
  ];
  const children = readdirSync(current, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".git" && !entry.name.startsWith("."))
    .map((entry) => join(current, entry.name))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
  for (const child of children) {
    const repo = existsSync(join(child, ".git"));
    items.push({ label: `${basename(child)}/${repo ? "  [repo]" : ""}`, type: repo ? "select" : "open", path: child });
  }
  return items;
}

function renderWorkspacePicker(current, items, selected) {
  output.write("\x1b[H\x1b[2J\x1b[?25l");
  output.write("Choose workspace\n");
  output.write(`Path: ${current}\n\n`);
  output.write("Up/Down: move  Enter: select/open  q: quit\n\n");
  items.forEach((item, index) => {
    if (index === selected) output.write(`\x1b[7m> ${item.label}\x1b[0m\n`);
    else output.write(`  ${item.label}\n`);
  });
}

function readKeypress() {
  return new Promise((resolveKey) => {
    const onKey = (str, key = {}) => {
      input.off("keypress", onKey);
      resolveKey({ str, key });
    };
    input.on("keypress", onKey);
  });
}

async function pickWorkspace(startDir) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive terminal required for workspace picker.");
  }
  let current = resolve(startDir);
  if (!isDirectory(current)) current = REPO_ROOT;
  let selected = 0;
  const wasRaw = input.isRaw;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  try {
    while (true) {
      const items = workspaceItems(current);
      if (selected >= items.length) selected = 0;
      renderWorkspacePicker(current, items, selected);
      const { str, key } = await readKeypress();
      if (key.name === "up") selected = selected <= 0 ? items.length - 1 : selected - 1;
      else if (key.name === "down") selected = selected >= items.length - 1 ? 0 : selected + 1;
      else if (key.name === "return" || key.name === "enter") {
        const item = items[selected];
        if (item.type === "select") return resolve(item.path);
        current = resolve(item.path);
        selected = 0;
      } else if (str === "q" || str === "Q" || (key.ctrl && key.name === "c")) {
        return "";
      }
    }
  } finally {
    input.setRawMode(Boolean(wasRaw));
    output.write("\x1b[?25h\x1b[0m\n");
  }
}

export function resolveCliRuntimeDataDir(agentDataDir = "", configPath = CONFIG_PATH) {
  return agentDataDir
    ? resolve(agentDataDir, "runtime")
    : join(dirname(configPath), "data", "runtime");
}

function cliRuntimeDataDir() {
  return resolveCliRuntimeDataDir(process.env.AGENT_DATA_DIR || "", CONFIG_PATH);
}

async function assertCliRuntimeStopped(opts, { operation = "Runtime data migration" } = {}) {
  if (typeof services.runningStatusForConfig === "function") {
    const status = await services.runningStatusForConfig(opts);
    if (status.running) {
      const error = new Error(`${operation} requires the supervisor, server, and tunnel to be stopped.`);
      error.code = "RUNTIME_PROCESS_ACTIVE";
      throw error;
    }
  }
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return;
  await new Promise((resolveStopped, rejectStopped) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectStopped(error);
      else resolveStopped();
    };
    socket.setTimeout(500, () => finish());
    socket.once("error", () => finish());
    socket.once("connect", () => {
      const error = new Error(`${operation} requires port ${port} to be free.`);
      error.code = "RUNTIME_PROCESS_ACTIVE";
      finish(error);
    });
  });
}

async function prepareCliRuntimeDataDirectory(opts = effectiveOptions()) {
  const { prepareRuntimeDataDirectory } = await import(
    pathToFileURL(join(SERVER_DIR, "src", "storage", "runtime-data.mjs")).href
  );
  return prepareRuntimeDataDirectory({
    agentDataDir: process.env.AGENT_DATA_DIR || "",
    configRoot: dirname(CONFIG_PATH),
    assertStopped: () => assertCliRuntimeStopped(opts)
  });
}

async function openCliWorkspaceRegistry(opts = effectiveOptions(), { recoverPurges = false } = {}) {
  await prepareCliRuntimeDataDirectory(opts);
  const { WorkspaceRegistry } = await import(
    pathToFileURL(join(SERVER_DIR, "src", "workspace", "registry.mjs")).href
  );
  const registry = await WorkspaceRegistry.open({
    dataDir: cliRuntimeDataDir(),
    maxOpenWorkspaces: 1
  });
  try {
    if (recoverPurges) {
      const { recoverWorkspacePurges } = await import(
        pathToFileURL(join(SERVER_DIR, "src", "workspace", "purge.mjs")).href
      );
      await recoverWorkspacePurges({ dataDir: cliRuntimeDataDir(), registry });
    }
    return registry;
  } catch (error) {
    await registry.close().catch(() => {});
    throw error;
  }
}

async function readCliRuntimeStatus() {
  let registry;
  let router;
  try {
    registry = await openCliWorkspaceRegistry();
    const [selected, workspaces, storage] = await Promise.all([
      registry.getSelectedWorkspace({ scope: "default", fallback: false }).catch(() => null),
      registry.listWorkspaces({ includeArchived: true }),
      registry.health()
    ]);
    const { TaskRouter } = await import(
      pathToFileURL(join(SERVER_DIR, "src", "workspace", "task-router.mjs")).href
    );
    router = await TaskRouter.open({ dataDir: cliRuntimeDataDir(), busyTimeoutMs: 5_000 });
    const activeTasks = await router.listTasks({ status: "open", limit: 100 });
    const recentTasks = await router.listTasks({ limit: 100 });
    const auditPath = join(cliRuntimeDataDir(), "audit.log");
    let auditInfo = null;
    try {
      const info = statSync(auditPath);
      auditInfo = {
        enabled: process.env.AGENT_AUDIT !== "0",
        path: auditPath,
        exists: info.isFile(),
        bytes: info.size,
        updated_at: info.mtime.toISOString()
      };
    } catch {
      auditInfo = {
        enabled: process.env.AGENT_AUDIT !== "0",
        path: auditPath,
        exists: false,
        bytes: 0,
        updated_at: null
      };
    }
    return {
      selected_workspace: selected?.workspace || null,
      workspaces,
      active_tasks: activeTasks,
      recent_tasks: recentTasks,
      audit: auditInfo,
      storage
    };
  } catch (error) {
    return {
      selected_workspace: null,
      workspaces: [],
      active_tasks: [],
      recent_tasks: [],
      audit: {
        enabled: process.env.AGENT_AUDIT !== "0",
        path: join(cliRuntimeDataDir(), "audit.log"),
        exists: false,
        bytes: 0,
        updated_at: null
      },
      storage: null,
      error: error?.message || String(error)
    };
  } finally {
    await router?.close().catch(() => {});
    await registry?.close().catch(() => {});
  }
}

async function selectCliWorkspace(rootOrId) {
  const registry = await openCliWorkspaceRegistry();
  try {
    const requested = String(rootOrId || "").trim();
    if (!requested) throw new Error("Workspace path or ID is required.");
    let workspace;
    if (/^ws_[a-f0-9]{16,64}$/i.test(requested)) {
      workspace = await registry.getWorkspace(requested);
    } else {
      const registered = await registry.registerWorkspace(resolve(requested), {
        metadata: {
          label: basename(resolve(requested)),
          trusted: true,
          source: "cli"
        }
      });
      workspace = registered.workspace;
    }
    const selected = await registry.selectWorkspace(workspace.id, { scope: "default" });
    return selected.workspace;
  } finally {
    await registry.close();
  }
}

async function findCliWorkspace(registry, reference) {
  const requested = String(reference || "").trim();
  const workspaces = await registry.listWorkspaces({
    refreshAvailability: false,
    includeArchived: true
  });
  if (/^ws_/i.test(requested)) return workspaces.find((item) => item.id === requested) || null;
  const resolvedReference = resolve(requested);
  return workspaces.find((item) =>
    resolve(item.root) === resolvedReference || resolve(item.canonicalRoot) === resolvedReference
  ) || null;
}

function workspaceLabel(workspace) {
  return String(workspace.metadata?.label || basename(workspace.canonicalRoot));
}

function printWorkspaceResult(value, flags) {
  if (flags.json) console.log(JSON.stringify(value, null, 2));
}

function purgeSummaryPayload(workspace, summary) {
  return {
    workspace_id: workspace.id,
    label: workspaceLabel(workspace),
    registration_state: workspace.registrationState,
    task_count: summary.task_count,
    data_bytes: summary.data_bytes,
    journal_bytes: summary.journal_bytes,
    blob_bytes: summary.blob_bytes,
    index_bytes: summary.index_bytes
  };
}

async function confirmPermanentRemove(workspace, summary, flags) {
  const label = workspaceLabel(workspace);
  if (flags.force) {
    if (String(flags.confirmLabel || "") !== label) {
      const error = new Error(`Permanent removal requires --confirm-label ${JSON.stringify(label)}.`);
      error.code = "WORKSPACE_CONFIRMATION_REQUIRED";
      throw error;
    }
    return;
  }
  if (!input.isTTY || !output.isTTY) {
    const error = new Error("Permanent removal requires an interactive terminal or --force with --confirm-label.");
    error.code = "WORKSPACE_CONFIRMATION_REQUIRED";
    throw error;
  }
  console.log(`Permanent removal will delete LCA data for ${label}:`);
  console.log(`  Workspace ID: ${workspace.id}`);
  console.log(`  Tasks: ${summary.task_count}`);
  console.log(`  Runtime data: ${formatBytes(summary.data_bytes)}`);
  console.log(`  Journal: ${formatBytes(summary.journal_bytes)}`);
  console.log(`  Blobs: ${formatBytes(summary.blob_bytes)}`);
  console.log(`  Index: ${formatBytes(summary.index_bytes)}`);
  console.log("  Source repository files will not be changed.");
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question(`Type ${JSON.stringify(label)} to continue: `);
    if (answer !== label) {
      const error = new Error("Workspace label confirmation did not match; nothing was removed.");
      error.code = "WORKSPACE_CONFIRMATION_MISMATCH";
      throw error;
    }
  } finally {
    prompt.close();
  }
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

function comparableWorkspacePath(value) {
  let normalized = resolve(String(value || "")).replace(/[\\/]+$/, "");
  if (process.platform === "win32" || process.platform === "darwin") normalized = normalized.toLowerCase();
  return normalized;
}

async function workspaceCommand(rest, flags) {
  const [sub, reference] = rest;
  if (sub === "list") {
    const registry = await openCliWorkspaceRegistry();
    try {
      const selected = await registry.getSelectedWorkspace({ scope: "default" }).catch(() => null);
      const workspaces = await registry.listWorkspaces({ includeArchived: true });
      if (flags.json) {
        printWorkspaceResult({
          default_workspace_id: selected?.workspace?.id || null,
          workspaces
        }, flags);
        return;
      }
      for (const workspace of workspaces) {
        const marker = selected?.workspace?.id === workspace.id ? "*" : " ";
        console.log(
          `${marker} ${workspace.id}  ${workspace.registrationState}  ${workspace.availability}  ${workspace.canonicalRoot}`
        );
      }
      if (!workspaces.length) console.log("No registered workspaces.");
      return;
    } finally {
      await registry.close();
    }
  }
  if (sub === "use" || sub === "register") {
    if (!reference) throw new Error(`Usage: lca workspace ${sub} <path|workspace-id>`);
    const workspace = await selectCliWorkspace(reference);
    const opts = normalize({ ...effectiveOptions(flags), workspace: workspace.canonicalRoot });
    await saveConfig(stripRuntimeFields(opts));
    if (flags.json) {
      printWorkspaceResult({ ok: true, action: sub, workspace, default_workspace_id: workspace.id }, flags);
      return;
    }
    console.log(`Workspace selected for new tasks: ${workspace.id} (${workspace.canonicalRoot})`);
    return;
  }
  if (sub === "archive") {
    if (!reference) throw new Error("Usage: lca workspace archive <path|workspace-id>");
    const opts = effectiveOptions(flags);
    await assertCliRuntimeStopped(opts, { operation: "Workspace archive" });
    const registry = await openCliWorkspaceRegistry(opts, { recoverPurges: true });
    try {
      const workspace = await findCliWorkspace(registry, reference);
      if (!workspace) throw new Error(`Workspace not found: ${reference}`);
      if (
        opts.workspace &&
        comparableWorkspacePath(opts.workspace) === comparableWorkspacePath(workspace.canonicalRoot)
      ) {
        const error = new Error("Configure another startup workspace before archiving this workspace.");
        error.code = "WORKSPACE_CONFIGURED_STARTUP";
        throw error;
      }
      const result = await registry.archiveWorkspace(workspace.id);
      if (flags.json) {
        printWorkspaceResult({ ok: true, action: "archive", ...result }, flags);
        return;
      }
      console.log(`Workspace archived: ${workspace.id} (${workspace.canonicalRoot})`);
      return;
    } finally {
      await registry.close();
    }
  }
  if (sub === "restore") {
    if (!reference) throw new Error("Usage: lca workspace restore <path|workspace-id>");
    const registry = await openCliWorkspaceRegistry();
    try {
      const workspace = await findCliWorkspace(registry, reference);
      if (!workspace) throw new Error(`Workspace not found: ${reference}`);
      const result = await registry.restoreWorkspace(workspace.id);
      if (flags.json) {
        printWorkspaceResult({ ok: true, action: "restore", ...result }, flags);
        return;
      }
      console.log(`Workspace restored: ${workspace.id} (${workspace.canonicalRoot})`);
      return;
    } finally {
      await registry.close();
    }
  }
  if (sub === "remove") {
    if (!reference) throw new Error("Usage: lca workspace remove <path|workspace-id>");
    const opts = effectiveOptions(flags);
    if (!flags.preview) {
      await assertCliRuntimeStopped(opts, { operation: "Permanent workspace removal" });
    }
    const registry = await openCliWorkspaceRegistry(opts, { recoverPurges: !flags.preview });
    try {
      const workspace = await findCliWorkspace(registry, reference);
      if (!workspace) throw new Error(`Workspace not found: ${reference}`);
      const { inspectWorkspacePurge, purgeWorkspace } = await import(
        pathToFileURL(join(SERVER_DIR, "src", "workspace", "purge.mjs")).href
      );
      const summary = await inspectWorkspacePurge({
        dataDir: cliRuntimeDataDir(),
        registry,
        workspaceId: workspace.id,
        configuredRoot: opts.workspace
      });
      if (flags.preview) {
        const preview = {
          ok: true,
          action: "remove_preview",
          summary: purgeSummaryPayload(workspace, summary)
        };
        if (flags.json) printWorkspaceResult(preview, flags);
        else {
          console.log(`Permanent removal preview for ${workspaceLabel(workspace)}:`);
          console.log(`  Workspace ID: ${workspace.id}`);
          console.log(`  Tasks: ${summary.task_count}`);
          console.log(`  Runtime data: ${formatBytes(summary.data_bytes)}`);
          console.log(`  Journal: ${formatBytes(summary.journal_bytes)}`);
          console.log(`  Blobs: ${formatBytes(summary.blob_bytes)}`);
          console.log(`  Index: ${formatBytes(summary.index_bytes)}`);
        }
        return;
      }
      await confirmPermanentRemove(workspace, summary, flags);
      const result = await purgeWorkspace({
        dataDir: cliRuntimeDataDir(),
        registry,
        workspaceId: workspace.id,
        configuredRoot: opts.workspace
      });
      if (flags.json) {
        printWorkspaceResult({ ok: true, action: "remove", ...result }, flags);
        return;
      }
      console.log(`Workspace permanently removed: ${workspace.id}`);
      console.log("Source repository files were not changed.");
      return;
    } finally {
      await registry.close();
    }
  }
  if (sub) {
    throw new Error(
      "Usage: lca workspace [list|use <path|id>|archive <path|id>|restore <path|id>|remove <path|id>]"
    );
  }

  const opts = effectiveOptions(flags);
  const startDir = flags.workspace || opts.workspace || process.cwd();
  const choice = await pickWorkspace(startDir);
  if (!choice) {
    console.log("Canceled.");
    return;
  }
  const workspace = await selectCliWorkspace(choice);
  console.log(`Workspace selected for new tasks: ${workspace.id} (${workspace.canonicalRoot})`);
}


export {
  cliRuntimeDataDir,
  detectWorkspaceRoot,
  openCliWorkspaceRegistry,
  prepareCliRuntimeDataDirectory,
  readCliRuntimeStatus,
  runCurrentWorkspace,
  selectCliWorkspace,
  assertCliRuntimeStopped,
  workspaceCommand
};
