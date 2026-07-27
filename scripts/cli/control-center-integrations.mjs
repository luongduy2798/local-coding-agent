// Local Coding Agent Control Center integrations and standalone UI launcher.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  INTEGRATIONS_STATE_PATH,
  REPO_ROOT,
  VSCODE_EXTENSION_DIR,
  VSCODE_EXTENSION_STATE_PATH,
  effectiveOptions,
  ensureConfigDir,
  readJsonFile
} from "./config.mjs";
import { capture, runChecked } from "./processes.mjs";
import {
  openUrl,
  openVsCodeExtension,
  setupVsCodeExtension,
  uninstallVsCodeExtension
} from "./setup.mjs";

const JETBRAINS_PLUGIN_DIR = join(REPO_ROOT, "jetbrains-plugin");
const WEB_BUNDLE_JS = join(VSCODE_EXTENSION_DIR, "dist", "webview.js");
const WEB_BUNDLE_CSS = join(VSCODE_EXTENSION_DIR, "dist", "webview.css");

export async function integrationsCommand(rest, flags, services) {
  const action = String(rest[0] || "list").toLowerCase();
  if (action === "list") return listIntegrations(flags);
  if (action === "doctor") return integrationDoctor(flags);
  const target = normalizeTarget(rest[1]);
  if (!target) throw new Error("Usage: lca integrations setup|open|uninstall <vscode|jetbrains|web>");
  if (action === "setup") return setupIntegration(target);
  if (action === "open") return openIntegration(target, flags, services);
  if (["uninstall", "remove"].includes(action)) return uninstallIntegration(target);
  throw new Error("Usage: lca integrations list | setup|open|uninstall <vscode|jetbrains|web> | doctor");
}

export async function openControlCenterWeb(flags, services) {
  if (!existsSync(WEB_BUNDLE_JS) || !existsSync(WEB_BUNDLE_CSS)) await setupWebIntegration();
  const opts = effectiveOptions(flags);
  const workspace = flags.workspace || await services.detectWorkspaceRoot();
  await services.start({ ...flags, workspace, background: true });
  const running = await waitForRuntime(opts, services.runningStatusForConfig);
  const nonce = running.state?.instanceNonce ||
    running.state?.server?.instanceNonce ||
    running.state?.tunnel?.instanceNonce ||
    "";
  if (!nonce) throw new Error("The running LCA supervisor did not provide a local Control Center launch credential.");
  const port = running.state?.port || opts.port;
  const host = ["browser", "jetbrains"].includes(String(flags.hostKind || ""))
    ? String(flags.hostKind)
    : "browser";
  const response = await fetch(`http://127.0.0.1:${port}/control/tickets`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lca-instance-nonce": nonce
    },
    body: JSON.stringify({ host })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.launch_url) {
    throw new Error(body.message || body.error || `Could not create a Control Center session (HTTP ${response.status}).`);
  }
  const launchUrl = String(body.launch_url);
  recordIntegration("web", {
    enabled: true,
    host,
    lastOpenedAt: new Date().toISOString()
  });
  if (flags.printUrl || flags.noOpen) {
    console.log(launchUrl);
    return launchUrl;
  }
  if (!openUrl(launchUrl)) console.log(launchUrl);
  else console.log("Opened Local Coding Agent Control Center.");
  return launchUrl;
}

async function setupIntegration(target) {
  if (target === "vscode") {
    const installed = await setupVsCodeExtension();
    recordIntegration("vscode", {
      installed: true,
      target: installed,
      installedAt: new Date().toISOString()
    });
    return installed;
  }
  if (target === "web") return setupWebIntegration();
  return setupJetBrainsIntegration();
}

async function openIntegration(target, flags, services) {
  if (target === "vscode") return openVsCodeExtension(flags, { detectWorkspaceRoot: services.detectWorkspaceRoot });
  if (target === "web") return openControlCenterWeb({ ...flags, hostKind: "browser" }, services);
  const opened = await openJetBrainsProject(flags, services.detectWorkspaceRoot);
  if (!opened) {
    console.log("Open a JetBrains IDE and choose View → Tool Windows → Local Coding Agent.");
  }
}

async function uninstallIntegration(target) {
  if (target === "vscode") {
    await uninstallVsCodeExtension();
    recordIntegration("vscode", { installed: false, uninstalledAt: new Date().toISOString() });
    return;
  }
  if (target === "web") {
    recordIntegration("web", { enabled: false, disabledAt: new Date().toISOString() });
    console.log("The local web UI is disabled in integration metadata. Shared build assets remain available to IDE hosts.");
    return;
  }
  recordIntegration("jetbrains", { installed: false, uninstalledAt: new Date().toISOString() });
  console.log("Remove Local Coding Agent from the JetBrains Plugins page, then restart the IDE.");
}

async function setupWebIntegration() {
  if (!existsSync(join(VSCODE_EXTENSION_DIR, "node_modules"))) {
    await runChecked("control-center dependencies", npmCommand(), ["install"], { cwd: VSCODE_EXTENSION_DIR });
  }
  await runChecked("control-center web bundle", npmCommand(), ["run", "build:webview"], { cwd: VSCODE_EXTENSION_DIR });
  recordIntegration("web", {
    enabled: true,
    bundle: join(VSCODE_EXTENSION_DIR, "dist"),
    builtAt: new Date().toISOString()
  });
  console.log("Built the shared Local Coding Agent Control Center web bundle.");
  return join(VSCODE_EXTENSION_DIR, "dist");
}

async function setupJetBrainsIntegration() {
  if (!existsSync(JETBRAINS_PLUGIN_DIR)) throw new Error(`JetBrains plugin source is missing: ${JETBRAINS_PLUGIN_DIR}`);
  await setupWebIntegration();
  const gradle = process.env.GRADLE_PATH || "gradle";
  const available = await capture(gradle, ["--version"]);
  if (available.code !== 0) {
    throw new Error("Gradle was not found. Install a Gradle version supported by the bundled IntelliJ Platform Gradle Plugin, then run `lca integrations setup jetbrains` again.");
  }
  await runChecked("jetbrains plugin build", gradle, ["buildPlugin"], { cwd: JETBRAINS_PLUGIN_DIR });
  const distributions = join(JETBRAINS_PLUGIN_DIR, "build", "distributions");
  const archive = existsSync(distributions)
    ? readdirSync(distributions).find((name) => name.endsWith(".zip"))
    : undefined;
  if (!archive) throw new Error("The JetBrains plugin build completed without a distribution ZIP.");
  const target = join(distributions, archive);
  recordIntegration("jetbrains", {
    installed: false,
    distribution: target,
    builtAt: new Date().toISOString()
  });
  console.log(`Built JetBrains plugin: ${target}`);
  console.log("Install it from Settings → Plugins → Install Plugin from Disk, then restart the IDE.");
  return target;
}

async function listIntegrations(flags) {
  const state = readIntegrationsState();
  const data = {
    vscode: {
      installed: existsSync(VSCODE_EXTENSION_STATE_PATH),
      ...(state.integrations?.vscode || {})
    },
    jetbrains: {
      sourceAvailable: existsSync(JETBRAINS_PLUGIN_DIR),
      ...(state.integrations?.jetbrains || {})
    },
    web: {
      bundleAvailable: existsSync(WEB_BUNDLE_JS) && existsSync(WEB_BUNDLE_CSS),
      ...(state.integrations?.web || {})
    }
  };
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else {
    console.log(`VS Code: ${data.vscode.installed ? "installed" : "not installed"}`);
    console.log(`JetBrains: ${data.jetbrains.distribution ? `built (${data.jetbrains.distribution})` : "not built"}`);
    console.log(`Local web: ${data.web.bundleAvailable ? "ready" : "not built"}`);
  }
  return data;
}

async function integrationDoctor(flags) {
  const data = await listIntegrations({ ...flags, json: false });
  const result = {
    ok: data.web.bundleAvailable,
    integrations: data,
    guidance: data.web.bundleAvailable
      ? "Use `lca ui` or open an installed IDE integration."
      : "Run `lca integrations setup web`."
  };
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.guidance);
  return result;
}

async function openJetBrainsProject(flags, detectWorkspaceRoot) {
  const workspace = flags.workspace || await detectWorkspaceRoot();
  const candidates = [
    process.env.JETBRAINS_CLI_PATH,
    "idea",
    "webstorm",
    "pycharm",
    "goland",
    "studio",
    "rider"
  ].filter(Boolean);
  for (const command of candidates) {
    const result = await capture(command, [workspace]);
    if (result.code === 0) return true;
  }
  return false;
}

async function waitForRuntime(opts, runningStatusForConfig) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(250);
    const status = await runningStatusForConfig(opts);
    if (status.running && status.health?.status === "ok") return status;
  }
  throw new Error("LCA did not become ready before the Control Center launch deadline.");
}

function normalizeTarget(value) {
  const target = String(value || "").toLowerCase();
  if (["vscode", "vs-code", "code"].includes(target)) return "vscode";
  if (["jetbrains", "intellij", "idea"].includes(target)) return "jetbrains";
  if (["web", "browser", "ui"].includes(target)) return "web";
  return null;
}

function readIntegrationsState() {
  const value = readJsonFile(INTEGRATIONS_STATE_PATH, {});
  return value && typeof value === "object" ? value : {};
}

function recordIntegration(name, value) {
  const state = readIntegrationsState();
  const next = {
    schemaVersion: 1,
    ...state,
    integrations: {
      ...(state.integrations || {}),
      [name]: {
        ...(state.integrations?.[name] || {}),
        ...value
      }
    }
  };
  ensureConfigDir();
  mkdirSync(dirname(INTEGRATIONS_STATE_PATH), { recursive: true });
  writeFileSync(INTEGRATIONS_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
