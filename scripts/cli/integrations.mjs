// Local Coding Agent CLI Figma integration.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_FIGMA_DESKTOP_MCP_URL,
  SERVER_DIR,
  effectiveOptions
} from "./config.mjs";
import { openUrl } from "./setup.mjs";
import { restartIfRunning } from "./status.mjs";

function figmaDesktopEndpoint() {
  return String(process.env.FIGMA_DESKTOP_MCP_URL || DEFAULT_FIGMA_DESKTOP_MCP_URL).trim();
}

async function loadFigmaDesktopBridge() {
  if (!existsSync(join(SERVER_DIR, "node_modules"))) {
    throw new Error("Figma bridge dependencies are missing. Run `lca setup` or `lca install` first.");
  }
  return import(pathToFileURL(join(SERVER_DIR, "src", "integrations", "figma-desktop.mjs")).href);
}

async function figmaDesktopStatusCli() {
  const bridge = await loadFigmaDesktopBridge();
  return bridge.figmaDesktopStatus({ endpoint: figmaDesktopEndpoint() });
}

async function listFigmaDesktopToolsCli() {
  const bridge = await loadFigmaDesktopBridge();
  return bridge.listFigmaDesktopTools({ endpoint: figmaDesktopEndpoint() });
}

function printFigmaDesktopEnableSteps(statusValue = {}) {
  console.log(`Figma Desktop MCP: ${statusValue.endpoint || DEFAULT_FIGMA_DESKTOP_MCP_URL}`);
  console.log("  1. Open the Figma desktop app and sign in.");
  console.log("  2. Open a Figma Design file.");
  console.log("  3. Switch to Dev Mode (Shift+D).");
  console.log('  4. In the MCP server section, click "Enable desktop MCP server".');
}

function openFigmaDesktop() {
  try {
    if (process.platform === "darwin") {
      const child = spawn("open", ["-a", "Figma"], { stdio: "ignore", detached: true, windowsHide: true });
      child.unref();
      return true;
    }
    return openUrl("figma://");
  } catch {
    return false;
  }
}

async function ensureFigmaDesktopConnected(rl, { interactive = false, failOnMissing = false } = {}) {
  let statusValue = await figmaDesktopStatusCli();
  if (statusValue.connected) {
    console.log(`Figma Desktop MCP connected: ${statusValue.endpoint}`);
    console.log(`Tools: ${statusValue.tools.join(", ") || "none"}`);
    return statusValue;
  }

  console.log(statusValue.error || "Figma Desktop MCP is not available.");
  printFigmaDesktopEnableSteps(statusValue);
  if (interactive) {
    if (openFigmaDesktop()) console.log("Opened Figma Desktop.");
    await rl.question("Enable the MCP server in Figma, then press Enter to retry: ");
    statusValue = await figmaDesktopStatusCli();
    if (statusValue.connected) {
      console.log(`Figma Desktop MCP connected: ${statusValue.endpoint}`);
      console.log(`Tools: ${statusValue.tools.join(", ") || "none"}`);
      return statusValue;
    }
    console.log(statusValue.error || "Figma Desktop MCP is still unavailable.");
  }

  if (failOnMissing) throw new Error(statusValue.error || "Figma Desktop MCP is not available.");
  console.log("You can finish later with: lca figma");
  return statusValue;
}

async function figmaCommand(rest, flags = {}) {
  const [sub = "connect"] = rest;
  if (sub === "status") {
    console.log(JSON.stringify(await figmaDesktopStatusCli(), null, 2));
    return;
  }
  if (sub === "tools") {
    const listed = await listFigmaDesktopToolsCli();
    console.log(JSON.stringify({ endpoint: figmaDesktopEndpoint(), count: listed.tools.length, tools: listed.tools }, null, 2));
    return;
  }
  if (sub === "open") {
    if (!openFigmaDesktop()) console.log("Could not open Figma automatically.");
    printFigmaDesktopEnableSteps({ endpoint: figmaDesktopEndpoint() });
    return;
  }
  if (sub !== "connect" && sub !== "check") {
    throw new Error("Usage: lca figma [connect|status|tools|open]");
  }

  if (!input.isTTY || !output.isTTY) {
    const statusValue = await figmaDesktopStatusCli();
    console.log(JSON.stringify(statusValue, null, 2));
    if (!statusValue.connected) process.exitCode = 1;
    return;
  }

  const rl = createPromptInterface({ input, output });
  let statusValue;
  try {
    statusValue = await ensureFigmaDesktopConnected(rl, { interactive: true, failOnMissing: false });
  } finally {
    rl.close();
  }
  if (!statusValue.connected) {
    process.exitCode = 1;
    return;
  }

  const opts = effectiveOptions(flags);
  await restartIfRunning(opts, opts);
}


export {
  ensureFigmaDesktopConnected,
  figmaCommand,
  figmaDesktopStatusCli,
  listFigmaDesktopToolsCli
};

