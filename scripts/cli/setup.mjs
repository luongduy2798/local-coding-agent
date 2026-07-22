// Local Coding Agent CLI setup and optional editor integration.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import os from "node:os";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import {
  MIN_NODE_VERSION,
  assertSupportedNodeVersion
} from "../process-lifecycle.mjs";
import {
  CONFIG_PATH,
  DEFAULT_PORT,
  DEFAULT_TUNNEL_VERSION,
  ENV_EXAMPLE_PATH,
  ENV_LOCAL_PATH,
  FULL_ACCESS_CONSENT_VERSION,
  KEY_URLS,
  REPO_ROOT,
  SERVER_DIR,
  SCRIPT_DIR,
  TUNNEL_RELEASE_BASE,
  VSCODE_EXTENSION_DIR,
  VSCODE_EXTENSION_STATE_PATH,
  applySetupSecurityConsent,
  defaultTunnelBinForPlatform,
  detectSetupPlatform,
  effectiveOptions,
  ensureConfigDir,
  isPlaceholder,
  platformMatchesHost,
  readJsonFile,
  readRepoEnvFile,
  ripgrepInstallCommand,
  saveConfig,
  setupPlatformChoices,
  setupUsage,
  sha256,
  stripRuntimeFields,
  tunnelAssetName,
  tunnelAssetUrl,
  validate,
  writeRepoEnv
} from "./config.mjs";
import {
  capture,
  runChecked,
  spawnLogged
} from "./processes.mjs";

async function promptLine(rl, label, current = "") {
  const suffix = current ? ` [${current}]` : "";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || current;
}

async function promptYesNo(rl, label, current = false) {
  const suffix = current ? "Y/n" : "y/N";
  const answer = (await rl.question(`${label} (${suffix}): `)).trim().toLowerCase();
  if (!answer) return Boolean(current);
  return ["y", "yes", "1", "true"].includes(answer);
}

async function promptSecretUpdate(rl, label, current = "") {
  const suffix = current ? " [saved, leave blank to keep]" : " [optional]";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || current;
}

async function promptSecretRequired(rl, label, current = "") {
  const suffix = current ? " [saved, leave blank to keep]" : "";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || current;
}

async function promptChoice(rl, label, choices, currentId = "") {
  const defaultIndex = Math.max(0, choices.findIndex((choice) => choice.id === currentId));
  console.log(label);
  choices.forEach((choice, index) => {
    const marker = index === defaultIndex ? " default" : "";
    console.log(`  ${index + 1}. ${choice.label}${marker}`);
  });
  while (true) {
    const answer = (await rl.question(`Choose [${defaultIndex + 1}]: `)).trim();
    if (!answer) return choices[defaultIndex];
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index];
    const byId = choices.find((choice) => choice.id.toLowerCase() === answer.toLowerCase());
    if (byId) return byId;
    console.log("Please enter one of the listed numbers.");
  }
}

function printStep(index, total, title) {
  console.log(`\n[${index}/${total}] ${title}`);
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function commandAvailable(command) {
  const res = await capture(command, ["--version"]);
  return res.code === 0;
}

async function detectAvailableCommands(commands) {
  const found = [];
  for (const command of commands) {
    if (await commandAvailable(command)) found.push(command);
  }
  return found;
}

function ripgrepManualInstallHint(platform = detectSetupPlatform()) {
  if (platform.id === "darwin") return "Install manually: brew install ripgrep";
  if (platform.id === "win32") return "Install manually: winget install BurntSushi.ripgrep.MSVC";
  if (platform.id === "linux" || platform.id === "wsl") return "Install manually with your package manager, e.g. sudo apt-get install -y ripgrep";
  return "Install ripgrep from https://github.com/BurntSushi/ripgrep";
}

async function ensureRipgrep(platform = detectSetupPlatform()) {
  const existing = await capture(process.platform === "win32" ? "rg.exe" : "rg", ["--version"]);
  if (existing.code === 0) {
    console.log(`OK ${existing.stdout.split(/\r?\n/)[0]}`);
    return true;
  }
  console.log("WARN ripgrep not found; attempting install because it makes repo search much faster.");
  const candidates = platform.id === "darwin"
    ? ["brew"]
    : platform.id === "win32"
      ? ["winget"]
      : ["sudo", "apt-get", "dnf", "yum", "pacman", "zypper"];
  const install = ripgrepInstallCommand(platform, await detectAvailableCommands(candidates));
  if (!install) {
    console.log(`WARN no supported ripgrep installer found. ${ripgrepManualInstallHint(platform)}`);
    return false;
  }
  try {
    await runChecked("ripgrep", install.command, install.args);
  } catch (error) {
    console.log(`WARN ripgrep install via ${install.label} failed: ${error.message}`);
    console.log(ripgrepManualInstallHint(platform));
    return false;
  }
  const verify = await capture(process.platform === "win32" ? "rg.exe" : "rg", ["--version"]);
  if (verify.code === 0) {
    console.log(`OK ${verify.stdout.split(/\r?\n/)[0]}`);
    return true;
  }
  console.log(`WARN ripgrep install finished but rg is not on PATH. ${ripgrepManualInstallHint(platform)}`);
  return false;
}

async function checkPrerequisites(platform = detectSetupPlatform()) {
  assertSupportedNodeVersion(
    process.versions.node,
    platform.id === "wsl" ? "linux" : platform.id,
    { wsl: platform.id === "wsl" }
  );
  console.log(`OK node ${process.version}`);
  await assertNodeSqlite(process.execPath);
  console.log("OK node:sqlite");
  const npm = await capture(npmCommand(), ["--version"]);
  if (npm.code !== 0) throw new Error("npm was not found. Install Node.js with npm, then rerun setup.");
  console.log(`OK npm ${npm.stdout.trim()}`);
  const git = await capture(process.platform === "win32" ? "git.exe" : "git", ["--version"]);
  console.log(git.code === 0 ? `OK ${git.stdout.trim()}` : "WARN git not found; repo-root detection will use the current folder.");
  await ensureRipgrep(platform);
}

async function probeNodeSqlite(nodeExecutable = process.execPath) {
  const source = [
    "import('node:sqlite')",
    ".then((m) => process.exit(typeof m.DatabaseSync === 'function' ? 0 : 2))",
    ".catch(() => process.exit(2));"
  ].join("");
  return capture(nodeExecutable, ["--input-type=module", "-e", source]);
}

async function assertNodeSqlite(nodeExecutable = process.execPath) {
  const result = await probeNodeSqlite(nodeExecutable);
  if (result.code === 0) return true;
  throw new Error(
    `The selected Node.js executable (${nodeExecutable}) does not provide node:sqlite. ` +
    "Install an official Node.js >=22.13.0 build (for example `nvm install 22 && nvm use 22`) and retry."
  );
}

function openUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function openKeyPages(rl) {
  const shouldOpen = await promptYesNo(rl, "Open OpenAI Tunnel and Runtime API key pages now", true);
  if (!shouldOpen) {
    for (const url of KEY_URLS) console.log(url);
    return;
  }
  for (const url of KEY_URLS) {
    if (!openUrl(url)) console.log(url);
  }
}

function printInstructionMode(selected, host) {
  console.log(`\nThis terminal is ${host.label}, but you selected ${selected.label}.`);
  console.log("Instruction mode only: no setup commands were run for the other OS.");
  console.log("\nRun this on the target OS instead:");
  if (selected.id === "win32") console.log("  scripts\\lca.cmd setup");
  else console.log("  bash scripts/lca setup");
  console.log("\nExpected tunnel-client asset:");
  console.log(`  ${tunnelAssetName(DEFAULT_TUNNEL_VERSION, selected.tunnelOs, selected.arch)}`);
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": "local-coding-agent-setup" } });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchSha256ForAsset(version, assetName) {
  const url = `${TUNNEL_RELEASE_BASE}/${version}/SHA256SUMS.txt`;
  const res = await fetch(url, { headers: { "User-Agent": "local-coding-agent-setup" } });
  if (!res.ok) return "";
  const text = await res.text();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const file = parts.slice(1).join(" ").replace(/^\*/, "");
    if (file === assetName) return parts[0].toLowerCase();
  }
  return "";
}

async function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    const ps = await capture("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`
    ]);
    if (ps.code === 0) return;
    const pwsh = await capture("pwsh", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`
    ]);
    if (pwsh.code === 0) return;
    throw new Error("Could not extract zip with PowerShell.");
  }
  const unzip = await capture("unzip", ["-qo", zipPath, "-d", destDir]);
  if (unzip.code !== 0) throw new Error("Could not extract zip. Install unzip or provide tunnel-client manually.");
}

function findBinary(root, names) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findBinary(full, names);
      if (found) return found;
    } else if (names.includes(entry.name)) {
      return full;
    }
  }
  return "";
}

async function downloadTunnelClient(selected, destination = defaultTunnelBinForPlatform(selected)) {
  const version = process.env.TUNNEL_CLIENT_VERSION || DEFAULT_TUNNEL_VERSION;
  const assetName = tunnelAssetName(version, selected.tunnelOs, selected.arch);
  const url = tunnelAssetUrl(version, selected.tunnelOs, selected.arch);
  const tmp = mkdtempSync(join(os.tmpdir(), "lca-tunnel-"));
  try {
    mkdirSync(dirname(destination), { recursive: true });
    const zipPath = join(tmp, assetName);
    console.log(`Downloading ${assetName}`);
    const data = await fetchBuffer(url);
    const expected = await fetchSha256ForAsset(version, assetName);
    if (expected) {
      const actual = sha256(data);
      if (actual !== expected) throw new Error(`SHA256 mismatch for ${assetName}`);
      console.log("OK sha256 verified");
    } else {
      console.log("WARN SHA256SUMS entry not found; continuing without checksum verification.");
    }
    writeFileSync(zipPath, data);
    const extractDir = join(tmp, "extract");
    await extractZip(zipPath, extractDir);
    const binary = findBinary(extractDir, [selected.executable, "tunnel-client", "tunnel-client.exe"]);
    if (!binary) throw new Error(`Could not find ${selected.executable} inside ${assetName}`);
    writeFileSync(destination, readFileSync(binary));
    try { await chmod(destination, 0o755); } catch { /* Windows may ignore POSIX mode. */ }
    console.log(`Installed tunnel-client: ${destination}`);
    return destination;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function defaultCliBinDir() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "LocalCodingAgent", "bin");
  }
  return join(home, ".local", "bin");
}

function canWriteDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.lca-write-test-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function cliBinCandidates() {
  if (process.env.LCA_BIN_DIR) return [process.env.LCA_BIN_DIR];
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  if (process.platform === "win32") return [defaultCliBinDir()];
  return [
    defaultCliBinDir(),
    join(home, "bin"),
    join(dirname(CONFIG_PATH), "bin")
  ];
}

function chooseCliBinDir() {
  for (const dir of cliBinCandidates()) {
    if (canWriteDir(dir)) return dir;
  }
  return defaultCliBinDir();
}

function pathEnvKey() {
  return Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
}

function getProcessPath() {
  return process.env[pathEnvKey()] || "";
}

function setProcessPath(value) {
  const key = pathEnvKey();
  process.env[key] = value;
  process.env.PATH = value;
}

function prependProcessPath(dir) {
  const current = getProcessPath();
  const sep = process.platform === "win32" ? ";" : ":";
  setProcessPath(current ? `${dir}${sep}${current}` : dir);
}

function normalizePathForCompare(value) {
  const resolved = resolve(String(value || ""));
  return process.platform === "win32"
    ? resolved.replace(/[\\/]+$/, "").toLowerCase()
    : resolved;
}

function pathHasDir(dir) {
  const target = normalizePathForCompare(dir);
  return getProcessPath()
    .split(process.platform === "win32" ? ";" : ":")
    .some((entry) => entry && normalizePathForCompare(entry) === target);
}

function shellProfileCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const shell = basename(process.env.SHELL || "");
  if (shell === "zsh") return [join(home, ".zshrc")];
  if (shell === "fish") return [join(home, ".config", "fish", "config.fish")];
  if (shell === "bash") {
    if (process.platform === "darwin") return [join(home, ".bash_profile"), join(home, ".bashrc")];
    return [join(home, ".bashrc"), join(home, ".profile")];
  }
  return [join(home, ".zshrc"), join(home, ".bashrc"), join(home, ".profile")];
}

function pathExportLine(dir, profilePath) {
  if (profilePath.endsWith("config.fish")) return `fish_add_path "${dir}"`;
  return `export PATH="${dir}:$PATH"`;
}

async function setWindowsUserPath(binDir) {
  const script = `
$ErrorActionPreference = 'Stop'
$dir = [System.IO.Path]::GetFullPath($args[0])
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
$exists = $false
foreach ($part in ($userPath -split ';')) {
  if ([string]::IsNullOrWhiteSpace($part)) { continue }
  try { $full = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($part)) } catch { $full = $part }
  if ($full.TrimEnd('\\') -ieq $dir.TrimEnd('\\')) { $exists = $true; break }
}
if (-not $exists) {
  $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $dir } else { "$userPath;$dir" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Output 'added'
} else {
  Write-Output 'exists'
}
`;
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script, binDir];
  let result = await capture("powershell.exe", args);
  if (result.code !== 0) result = await capture("pwsh", ["-NoProfile", "-Command", script, binDir]);
  return result;
}

async function configureShellPath(binDir) {
  if (pathHasDir(binDir)) return { changed: false, active: true, profile: "" };
  if (process.platform === "win32") {
    prependProcessPath(binDir);
    const result = await setWindowsUserPath(binDir);
    if (result.code === 0) {
      const changed = result.stdout.includes("added");
      return {
        changed,
        active: false,
        profile: "User PATH",
        message: `${changed ? "Added" : "Already present in"} Windows User PATH: ${binDir}. Open a new terminal before running lca.`
      };
    }
    return {
      changed: false,
      active: false,
      profile: "",
      message: `Could not update Windows User PATH automatically. Add this directory manually: ${binDir}`
    };
  }

  const profile = shellProfileCandidates()[0];
  mkdirSync(dirname(profile), { recursive: true });
  const existing = existsSync(profile) ? readFileSync(profile, "utf8") : "";
  const line = pathExportLine(binDir, profile);
  if (!existing.includes(binDir) && !existing.includes(line)) {
    const block = `\n# Local Coding Agent CLI\n${line}\n`;
    writeFileSync(profile, `${existing.replace(/\s*$/, "")}${block}`, "utf8");
  }
  prependProcessPath(binDir);
  return { changed: true, active: false, profile, message: `Added ${binDir} to ${profile}. Restart your terminal or run: source ${profile}` };
}

async function verifyCliShim(cliPath) {
  const result = process.platform === "win32"
    ? await capture("cmd.exe", ["/d", "/c", `call "${cliPath}" --help`], { cwd: REPO_ROOT })
    : await capture(cliPath, ["--help"], { cwd: REPO_ROOT });
  if (result.code !== 0) {
    throw new Error(`Installed lca wrapper failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  console.log(`OK lca wrapper: ${cliPath}`);
}

async function installCliCommand() {
  const marker = "local-coding-agent lca wrapper";
  const cliScript = join(REPO_ROOT, "scripts", "local-coding-agent.mjs");
  const preferredBinDir = process.env.LCA_BIN_DIR || defaultCliBinDir();
  const binDir = chooseCliBinDir();
  if (binDir !== preferredBinDir) {
    console.log(`WARN ${preferredBinDir} is not writable; installing lca into ${binDir} instead.`);
  }
  mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    const cmdPath = join(binDir, "lca.cmd");
    const psPath = join(binDir, "lca.ps1");
    for (const target of [cmdPath, psPath]) {
      if (existsSync(target) && !readFileSync(target, "utf8").includes(marker)) {
        throw new Error(`Refusing to overwrite: ${target}`);
      }
    }
    writeFileSync(cmdPath, `@echo off\r\nrem ${marker}\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (\r\n  echo ERROR: Node.js ^>=${MIN_NODE_VERSION} is required but node was not found in PATH.\r\n  echo Install Node.js 22 LTS from https://nodejs.org/ or run winget install OpenJS.NodeJS.LTS, then open a new terminal.\r\n  exit /b 1\r\n)\r\nnode "${cliScript}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
    writeFileSync(psPath, `# ${marker}\nif (-not (Get-Command node -ErrorAction SilentlyContinue)) {\n  Write-Error 'Node.js >=${MIN_NODE_VERSION} is required but node was not found in PATH. Install Node.js 22 LTS from https://nodejs.org/ or run winget install OpenJS.NodeJS.LTS, then open a new terminal.'\n  exit 1\n}\n& node "${cliScript}" @args\nexit $LASTEXITCODE\n`, "utf8");
    console.log(`Installed: ${cmdPath}`);
    const pathResult = await configureShellPath(binDir);
    if (pathResult.message) console.log(pathResult.message);
    if (!pathResult.active) console.log(`Current terminal fallback: "${cmdPath}"`);
    return cmdPath;
  }
  const target = join(binDir, "lca");
  if (existsSync(target) && !readFileSync(target, "utf8").includes(marker)) {
    throw new Error(`Refusing to overwrite: ${target}`);
  }
  writeFileSync(target, `#!/usr/bin/env bash\n# ${marker}\nif ! command -v node >/dev/null 2>&1; then\n  echo "ERROR: Node.js >=${MIN_NODE_VERSION} is required but node was not found in PATH." >&2\n  echo "Install Node.js 22 LTS from https://nodejs.org/ (or use your package/version manager), then open a new shell." >&2\n  exit 1\nfi\nexec node "${cliScript}" "$@"\n`, "utf8");
  await chmod(target, 0o755);
  console.log(`Installed: ${target}`);
  const pathResult = await configureShellPath(binDir);
  if (pathResult.message) console.log(pathResult.message);
  return target;
}

function vscodeExtensionInstallRoot() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return join(home, ".vscode", "extensions");
}

function readVsCodeExtensionManifest() {
  const manifestPath = join(VSCODE_EXTENSION_DIR, "package.json");
  if (!existsSync(manifestPath)) throw new Error(`Missing VS Code extension manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.publisher || !manifest.name || !manifest.version) {
    throw new Error("VS Code extension package.json requires publisher, name, and version.");
  }
  return manifest;
}

function vscodeExtensionTarget(manifest = readVsCodeExtensionManifest()) {
  return join(vscodeExtensionInstallRoot(), `${manifest.publisher}.${manifest.name}-${manifest.version}`);
}

function vscodeExtensionFingerprint(baseDir) {
  const manifestPath = join(baseDir, "package.json");
  const bundlePath = join(baseDir, "dist", "extension.js");
  if (!existsSync(manifestPath) || !existsSync(bundlePath)) return "";
  return sha256(Buffer.concat([readFileSync(manifestPath), readFileSync(bundlePath)]));
}

function readVsCodeExtensionState() {
  return readJsonFile(VSCODE_EXTENSION_STATE_PATH, {});
}

function writeVsCodeExtensionState(value) {
  ensureConfigDir();
  writeFileSync(VSCODE_EXTENSION_STATE_PATH, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function findVsCodeCli() {
  const configured = process.env.VSCODE_CLI_PATH;
  if (configured && existsSync(configured)) return configured;

  const commandNames = process.platform === "win32"
    ? ["code.cmd", "code.exe", "code-insiders.cmd"]
    : ["code", "code-insiders"];
  for (const command of commandNames) {
    const probe = await capture(command, ["--version"]);
    if (probe.code === 0) return command;
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        join(home, "Applications", "Visual Studio Code.app", "Contents", "Resources", "app", "bin", "code"),
        "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"
      ]
    : process.platform === "win32"
      ? [
          join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "bin", "code.cmd"),
          join(process.env.PROGRAMFILES || "", "Microsoft VS Code", "bin", "code.cmd")
        ]
      : ["/usr/bin/code", "/usr/local/bin/code", "/snap/bin/code"];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  if (process.platform === "darwin") {
    const processes = await capture("ps", ["-ax", "-o", "command="]);
    const match = processes.stdout.match(/([^\n]+Visual Studio Code(?: \d+)?\.app)\/Contents\/MacOS\/Electron/);
    if (match) {
      const translocatedCli = join(match[1], "Contents", "Resources", "app", "bin", "code");
      if (existsSync(translocatedCli)) return translocatedCli;
    }
  }
  return "";
}

async function setupVsCodeExtension() {
  if (!existsSync(VSCODE_EXTENSION_DIR)) {
    throw new Error(`VS Code extension source is missing: ${VSCODE_EXTENSION_DIR}`);
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  if (!existsSync(join(VSCODE_EXTENSION_DIR, "node_modules"))) {
    await runChecked("vscode-extension install", npm, ["install"], { cwd: VSCODE_EXTENSION_DIR });
  }
  await runChecked("vscode-extension build", npm, ["run", "build"], { cwd: VSCODE_EXTENSION_DIR });

  const manifest = readVsCodeExtensionManifest();
  const installRoot = vscodeExtensionInstallRoot();
  const extensionPrefix = `${manifest.publisher}.${manifest.name}-`;
  const target = vscodeExtensionTarget(manifest);
  mkdirSync(installRoot, { recursive: true });
  for (const entry of readdirSync(installRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(extensionPrefix)) continue;
    const previous = join(installRoot, entry.name);
    if (resolve(previous) !== resolve(target)) rmSync(previous, { recursive: true, force: true });
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const name of ["package.json", "README.md", "dist", "media"]) {
    const source = join(VSCODE_EXTENSION_DIR, name);
    if (existsSync(source)) cpSync(source, join(target, name), { recursive: true });
  }
  const fingerprint = vscodeExtensionFingerprint(target);
  writeVsCodeExtensionState({
    version: manifest.version,
    fingerprint,
    target,
    needsFreshWindow: true,
    installedAt: new Date().toISOString()
  });
  console.log(`Installed VS Code extension: ${target}`);
  console.log("Run: lca extension");
  return target;
}

async function uninstallVsCodeExtension() {
  const manifest = readVsCodeExtensionManifest();
  const extensionId = `${manifest.publisher}.${manifest.name}`;
  const extensionPrefix = `${extensionId}-`;
  const cli = await findVsCodeCli();

  if (cli) {
    const result = await capture(cli, ["--uninstall-extension", extensionId]);
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    const notInstalled = /not installed|is not installed|extension.*not found/i.test(output);
    if (result.code !== 0 && !notInstalled) {
      console.log(`WARN VS Code CLI could not unregister ${extensionId}: ${output || `exit ${result.code}`}`);
    }
  }

  const installRoot = vscodeExtensionInstallRoot();
  let removed = 0;
  if (existsSync(installRoot)) {
    for (const entry of readdirSync(installRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(extensionPrefix)) continue;
      rmSync(join(installRoot, entry.name), { recursive: true, force: true });
      removed += 1;
    }
  }
  rmSync(VSCODE_EXTENSION_STATE_PATH, { force: true });

  if (removed > 0 || cli) {
    console.log(`Uninstalled VS Code extension: ${extensionId}`);
  } else {
    console.log(`VS Code extension is not installed: ${extensionId}`);
  }
  console.log("Reload VS Code if the Local Coding Agent view is still visible.");
}

async function openVsCodeExtension(flags = {}, services = {}) {
  const manifest = readVsCodeExtensionManifest();
  let target = vscodeExtensionTarget(manifest);
  let state = readVsCodeExtensionState();
  const sourceFingerprint = vscodeExtensionFingerprint(VSCODE_EXTENSION_DIR);
  const installedFingerprint = vscodeExtensionFingerprint(target);
  let updated = false;

  if (!installedFingerprint || installedFingerprint !== sourceFingerprint) {
    console.log("Updating the VS Code Review Changes extension...");
    target = await setupVsCodeExtension();
    state = readVsCodeExtensionState();
    updated = true;
  }

  const workspace = resolve(flags.workspace || await services.detectWorkspaceRoot());
  const cli = await findVsCodeCli();
  const freshWindow = updated || state.needsFreshWindow === true;
  if (cli) {
    const opened = await capture(cli, [freshWindow ? "--new-window" : "--reuse-window", workspace]);
    if (opened.code !== 0) throw new Error(opened.stderr || opened.stdout || "Could not open VS Code.");
  } else if (process.platform === "darwin") {
    const opened = await capture("open", ["-a", "Visual Studio Code", workspace]);
    if (opened.code !== 0) throw new Error("Could not find the VS Code CLI or application.");
  } else {
    throw new Error("Could not find the VS Code CLI. Set VSCODE_CLI_PATH or install the `code` shell command.");
  }

  await new Promise((resolveDelay) => setTimeout(resolveDelay, freshWindow ? 1600 : 600));
  const reviewUri = `vscode://${manifest.publisher}.${manifest.name}/review-changes`;
  if (!openUrl(reviewUri)) {
    console.log("Open Activity Bar → Local Coding Agent → Review Changes.");
    return;
  }
  writeVsCodeExtensionState({
    ...state,
    version: manifest.version,
    fingerprint: vscodeExtensionFingerprint(target),
    target,
    needsFreshWindow: false,
    lastOpenedAt: new Date().toISOString()
  });
  console.log(`Opened Review Changes for: ${workspace}`);
}

async function setup(flags, services = {}) {
  if (flags.help) return setupUsage();
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive terminal required. Run `lca setup` from a terminal.");
  }
  const cfg = effectiveOptions(flags);
  const rl = createPromptInterface({ input, output });
  try {
    const host = detectSetupPlatform();
    const selected = flags.chooseOs
      ? await promptChoice(rl, "Choose target operating system", setupPlatformChoices(), host.id)
      : host;
    if (!platformMatchesHost(selected, host)) {
      printInstructionMode(selected, host);
      return;
    }

    console.log(`Detected OS: ${selected.label}`);
    console.log(`Config file: ${CONFIG_PATH}`);
    console.log(`Environment file: ${ENV_LOCAL_PATH}`);

    printStep(1, 9, "Check prerequisites");
    await checkPrerequisites(selected);

    printStep(2, 9, "Choose tunnel mode");
    const useTunnel = await promptYesNo(rl, "Use ChatGPT Web tunnel", !cfg.noTunnel);
    cfg.noTunnel = !useTunnel;
    if (useTunnel) await openKeyPages(rl);

    printStep(3, 9, "Configure local environment");
    const envValues = readRepoEnvFile();
    if (useTunnel) {
      cfg.tunnelId = await promptLine(rl, "Tunnel ID", flags.tunnelId || (!isPlaceholder(envValues.CONTROL_PLANE_TUNNEL_ID) ? envValues.CONTROL_PLANE_TUNNEL_ID : cfg.tunnelId));
      const currentKey = !isPlaceholder(envValues.CONTROL_PLANE_API_KEY) ? envValues.CONTROL_PLANE_API_KEY : "";
      const runtimeKey = await promptSecretRequired(rl, "Runtime API key", flags.runtimeKey || currentKey);
      if (!cfg.tunnelId) throw new Error("Tunnel ID is required when tunnel mode is enabled.");
      if (!runtimeKey) throw new Error("Runtime API key is required when tunnel mode is enabled.");
      await writeRepoEnv({
        CONTROL_PLANE_TUNNEL_ID: cfg.tunnelId,
        CONTROL_PLANE_API_KEY: runtimeKey
      });
      cfg.runtimeKeyEnv = "CONTROL_PLANE_API_KEY";
      cfg.runtimeKey = "";
      console.log("Saved .env.local");
    } else if (!existsSync(ENV_LOCAL_PATH) && existsSync(ENV_EXAMPLE_PATH)) {
      await writeFile(ENV_LOCAL_PATH, readFileSync(ENV_EXAMPLE_PATH, "utf8"), "utf8");
      console.log("Created .env.local from .env.example");
    } else {
      console.log("Tunnel disabled; .env.local can be filled later.");
    }

    printStep(4, 9, "Configure agent defaults");
    cfg.node = cfg.node || "node";
    cfg.workspace = resolve(flags.workspace || cfg.workspace || await services.detectWorkspaceRoot());
    const explicitSecurity = Boolean(flags.mode || flags.policy);
    const alreadyConsented =
      Number(cfg.fullAccessConsentVersion || 0) >= FULL_ACCESS_CONSENT_VERSION &&
      cfg.mode === "full" &&
      cfg.policy === "full";
    const acceptedFullAccess = explicitSecurity || alreadyConsented
      ? alreadyConsented
      : await promptYesNo(
          rl,
          "Allow full/full agent access for trusted workspaces (root confinement and catastrophic-command blocks stay enabled)",
          false
        );
    Object.assign(cfg, applySetupSecurityConsent(cfg, flags, acceptedFullAccess));
    cfg.port = String(flags.port || cfg.port || DEFAULT_PORT);
    cfg.extraRoots = flags.extraRoots ?? cfg.extraRoots ?? "";
    cfg.authToken = flags.authToken ?? cfg.authToken ?? "";
    console.log(`Workspace: ${cfg.workspace}`);
    console.log(`Access: ${cfg.mode}/${cfg.policy}`);
    console.log(`MCP port: ${cfg.port}`);

    printStep(5, 9, "Install server dependencies");
    if (!existsSync(join(SERVER_DIR, "node_modules"))) {
      await installDeps(cfg);
    } else {
      console.log("Server dependencies already installed.");
    }

    printStep(6, 9, "Connect Figma Desktop MCP");
    const useFigmaDesktop = await promptYesNo(rl, "Enable Figma Desktop integration", true);
    if (useFigmaDesktop) {
      await services.ensureFigmaDesktopConnected(rl, { interactive: true, failOnMissing: false });
    } else {
      console.log("Skipped. Run `lca figma` later.");
    }

    printStep(7, 9, "Install tunnel-client");
    if (useTunnel) {
      cfg.tunnelBin = cfg.tunnelBin || defaultTunnelBinForPlatform(selected);
      if (!existsSync(cfg.tunnelBin)) {
        try {
          cfg.tunnelBin = await downloadTunnelClient(selected, cfg.tunnelBin);
        } catch (error) {
          console.log(`Download failed: ${error.message}`);
          cfg.tunnelBin = await promptLine(rl, "Manual tunnel-client path", cfg.tunnelBin);
          if (!existsSync(cfg.tunnelBin)) throw new Error(`Tunnel client not found: ${cfg.tunnelBin}`);
        }
      } else {
        console.log(`Using existing tunnel-client: ${cfg.tunnelBin}`);
      }
      cfg.profileDir = cfg.profileDir || join(REPO_ROOT, "tools", "profiles");
      cfg.profile = cfg.profile || "local-coding-agent";
      cfg.organizationId = flags.organizationId || cfg.organizationId || "";
    } else {
      console.log("Tunnel disabled.");
    }

    printStep(8, 9, "Save config and install lca command");
    cfg.runtimeKey = "";
    validate(cfg);
    await saveConfig(stripRuntimeFields(cfg));
    const cliPath = await installCliCommand();

    printStep(9, 9, "Verify runtime");
    await verifyCliShim(cliPath);
    await services.start({
      ...stripRuntimeFields(cfg),
      background: true,
      save: false
    });
    await services.status({ json: false });
    console.log("\nSetup complete.");
    console.log("Daily use:");
    if (process.platform === "win32") {
      console.log("  Open a new terminal");
      console.log("  cd /d <path-to-your-repo>");
      console.log("  lca");
    } else {
      console.log("  cd /path/to/repo");
      console.log("  lca");
    }
    console.log(`Health: http://127.0.0.1:${cfg.port}/healthz`);
  } finally {
    rl.close();
  }
}

async function installDeps(opts) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawnLogged("install", npm, ["install"], { cwd: SERVER_DIR });
  const code = await new Promise((resolveExit) => child.on("exit", resolveExit));
  if (code !== 0) throw new Error(`npm install failed with exit code ${code}`);
  console.log("Install complete.");
}


export {
  assertNodeSqlite,
  capture,
  checkPrerequisites,
  chooseCliBinDir,
  configureShellPath,
  downloadTunnelClient,
  findVsCodeCli,
  installCliCommand,
  installDeps,
  openKeyPages,
  openUrl,
  openVsCodeExtension,
  probeNodeSqlite,
  promptChoice,
  promptLine,
  promptSecretRequired,
  promptSecretUpdate,
  promptYesNo,
  setup,
  setupVsCodeExtension,
  uninstallVsCodeExtension,
  verifyCliShim
};
