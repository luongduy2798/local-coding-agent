// Local Coding Agent verification planning and gate execution
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

let PRIMARY_ROOT;
let RG_BIN;
let SEARCH_OUTPUT_DEFAULT;
let adoptUnmanagedChange;
let assertCommandAllowed;
let attachContext;
let collectReviewInventory;
let collectTrackedReviewDiff;
let collectUntrackedReviewDiff;
let dedupe;
let fitJsonItems;
let freezeTaskForMutation;
let gitGrep;
let markUnmanagedChange;
let mutationFingerprintChanged;
let patchCoordinator;
let persistTaskVerificationEvidence;
let resolveWorkspacePath;
let reviewEvidenceDescriptor;
let ripgrepGrep;
let runShellCommand;
let searchTree;
let taskWorkspaceBaseline;
let tokenizeSearch;
let unmanagedChangeState;
let workspaceMutationFingerprint;

export function configureVerificationServices(dependencies) {
  ({
    PRIMARY_ROOT,
    RG_BIN,
    SEARCH_OUTPUT_DEFAULT,
    adoptUnmanagedChange,
    assertCommandAllowed,
    attachContext,
    collectReviewInventory,
    collectTrackedReviewDiff,
    collectUntrackedReviewDiff,
    dedupe,
    fitJsonItems,
    freezeTaskForMutation,
    gitGrep,
    markUnmanagedChange,
    mutationFingerprintChanged,
    patchCoordinator,
    persistTaskVerificationEvidence,
    resolveWorkspacePath,
    reviewEvidenceDescriptor,
    ripgrepGrep,
    runShellCommand,
    searchTree,
    taskWorkspaceBaseline,
    tokenizeSearch,
    unmanagedChangeState,
    workspaceMutationFingerprint
  } = dependencies);
}

export async function verifyWorkspaceChanges({
  cwd = ".",
  workspace_id,
  task_token,
  include,
  timeout_ms = 120_000,
  stop_on_failure = true,
  dry_run = false,
  adopt_unmanaged = false
} = {}) {
  const selected = await resolveWorkspacePath(cwd, { workspaceId: workspace_id, taskToken: task_token });
  const rootDir = selected.workspace.canonicalRoot;
  const runtime = selected.runtime;
  const unmanagedState = await unmanagedChangeState(
    selected.workspace.id,
    selected.task?.id || null
  );
  const initiallyUnmanaged = unmanagedState.detected === true && unmanagedState.adopted !== true;
  if (adopt_unmanaged && initiallyUnmanaged) {
    await adoptUnmanagedChange(selected.workspace.id, selected.task?.id || null);
  }

  const initialPlan = await runtime.verification.plan({
    include,
    unmanaged_changes: initiallyUnmanaged && !adopt_unmanaged,
    unmanaged_state_unknown: unmanagedState.unknown === true,
    transaction_in_doubt: transactionInDoubt(selected.workspace.id),
    refresh: true,
    base_head: selected.task
      ? taskWorkspaceBaseline(selected.task, selected.workspace.id).base_head
      : null,
    require_baseline: Boolean(selected.task)
  });
  if (dry_run) {
    return {
      ok: initialPlan.status === "PASS",
      status: "DRY_RUN",
      workspace: { workspace_id: selected.workspace.id, path: "." },
      plan: initialPlan,
      unmanaged_changes: {
        detected: initiallyUnmanaged,
        adopted: Boolean(adopt_unmanaged && initiallyUnmanaged)
      }
    };
  }

  await freezeTaskForMutation(task_token);
  const gateResults = {};
  const executed = [];
  for (const gate of initialPlan.gates) {
    if (!gate.command || gate.status === "missing") continue;
    const gateCwd = await resolveWorkspacePath(gate.cwd?.path || ".", {
      workspaceId: selected.workspace.id,
      taskToken: task_token
    });
    assertCommandAllowed(gate.command);
    const beforeMutation = await workspaceMutationFingerprint(
      gateCwd.path,
      selected.workspace.canonicalRoot
    );
    const startedAt = Date.now();
    const result = await runGatedCommand(
      gate.command,
      gateCwd.path,
      timeout_ms,
      selected.workspace.canonicalRoot
    );
    const afterMutation = await workspaceMutationFingerprint(
      gateCwd.path,
      selected.workspace.canonicalRoot
    );
    const commandChangedTrackedSource = mutationFingerprintChanged(beforeMutation, afterMutation);
    if (commandChangedTrackedSource) {
      await markUnmanagedChange({
        workspaceId: selected.workspace.id,
        taskId: selected.task?.id || null,
        source: `verify_changes:${gate.kind}`,
        before: beforeMutation,
        after: afterMutation
      });
    }
    const normalized = {
      id: gate.id,
      kind: gate.kind,
      cwd: gate.cwd,
      status: result.ok ? "pass" : "fail",
      command: gate.command,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      duration_ms: Date.now() - startedAt,
      summary: result.summary,
      failures: result.failures,
      unmanaged_changes: commandChangedTrackedSource
    };
    gateResults[gate.id] = normalized;
    executed.push(normalized);
    if (!result.ok && stop_on_failure) break;
  }

  const finalUnmanagedState = await unmanagedChangeState(
    selected.workspace.id,
    selected.task?.id || null
  );
  const unmanagedDetected =
    finalUnmanagedState.detected === true && finalUnmanagedState.adopted !== true;
  const evaluated = runtime.verification.evaluate(initialPlan, gateResults, {
    unmanaged_changes: unmanagedDetected,
    unmanaged_state_unknown: finalUnmanagedState.unknown === true,
    transaction_in_doubt: transactionInDoubt(selected.workspace.id)
  });
  const [reviewInventory, worktreeEvidence, stagedEvidence] = await Promise.all([
    collectReviewInventory(selected, rootDir),
    collectTrackedReviewDiff(selected, rootDir, "unstaged"),
    collectTrackedReviewDiff(selected, rootDir, "staged")
  ]);
  const untrackedEvidence = await collectUntrackedReviewDiff(selected, reviewInventory);
  const reviewEvidence = [worktreeEvidence, stagedEvidence, untrackedEvidence];
  const reviewEvidenceComplete = reviewInventory.complete === true &&
    reviewEvidence.every((entry) => entry.complete === true);
  const combinedDiff = reviewEvidence.map((entry) => entry.diff).filter(Boolean).join("\n");
  const review = combinedDiff.trim()
    ? analyzeDiff(combinedDiff)
    : { summary: { changed_files: 0, files: [] }, findings: [] };
  review.summary.files = (review.summary.files || []).map((file) => ({
    ...file,
    workspace_id: selected.workspace.id
  }));
  review.findings = review.findings.map((finding) => ({
    ...finding,
    workspace_id: selected.workspace.id
  }));
  const p1 = review.findings.filter((finding) => finding.priority === "P1").length;
  const reasons = [...evaluated.reasons];
  if (!reviewEvidenceComplete) reasons.push("REVIEW_EVIDENCE_INCOMPLETE");
  let uniqueReasons = dedupe(reasons);
  let status = evaluated.status;
  if (p1 > 0) status = "FAIL";
  else if (status === "PASS" && uniqueReasons.length) status = "INCOMPLETE";

  let verificationEvidence = null;
  const finalVerification = {
    ...evaluated,
    status,
    reasons: uniqueReasons,
    executed
  };
  try {
    verificationEvidence = await persistTaskVerificationEvidence({
      selected,
      source: "verify_changes",
      status,
      verification: finalVerification
    });
    if (status === "PASS" && verificationEvidence?.status !== "PASS") {
      status = "INCOMPLETE";
      uniqueReasons = dedupe([...uniqueReasons, "VERIFICATION_STATE_UNKNOWN"]);
      finalVerification.status = status;
      finalVerification.reasons = uniqueReasons;
    }
  } catch {
    if (status === "PASS") status = "INCOMPLETE";
    uniqueReasons = dedupe([...uniqueReasons, "VERIFICATION_EVIDENCE_PERSIST_FAILED"]);
    finalVerification.status = status;
    finalVerification.reasons = uniqueReasons;
  }

  return {
    ok: status === "PASS",
    status,
    workspace: { workspace_id: selected.workspace.id, path: "." },
    changes: evaluated.changes,
    review: {
      verdict: p1 > 0
        ? "BLOCK"
        : review.findings.length
          ? "WARN"
          : status === "INCOMPLETE"
            ? "INCOMPLETE"
            : evaluated.changes.files.length
              ? "PASS"
              : "CLEAN",
      summary: review.summary,
      findings: review.findings.slice(0, 100),
      p1,
      evidence: Object.fromEntries(reviewEvidence.map((entry) => [
        entry.source,
        reviewEvidenceDescriptor(entry)
      ])),
      failed_paths: [
        ...(reviewInventory.failed_paths || []),
        ...reviewEvidence.flatMap((entry) => entry.failed_paths || [])
      ].slice(0, 100)
    },
    verification: finalVerification,
    verification_evidence: {
      persisted: Boolean(verificationEvidence),
      state_known: verificationEvidence?.state?.state_known === true
    },
      unmanaged_changes: {
        detected: unmanagedDetected,
        adopted: Boolean(adopt_unmanaged && initiallyUnmanaged),
        state_known: finalUnmanagedState.unknown !== true,
        ...(finalUnmanagedState.unknown ? { error_code: finalUnmanagedState.error_code } : {})
      },
    incomplete_reasons: uniqueReasons
  };
}

export function transactionInDoubt(workspaceId) {
  const status = patchCoordinator?.status?.();
  if (!status) return true;
  return Boolean(
    status.in_doubt && (
      status.recovery_block ||
      (status.blocked_workspaces || []).includes(workspaceId)
    )
  );
}

async function collectFocusedEvidence(rootDir, focus, { includeSnippets = true, maxChars = SEARCH_OUTPUT_DEFAULT } = {}) {
  const normalized = String(focus || "").trim();
  if (!normalized) return null;
  const terms = dedupe([
    normalized,
    ...tokenizeSearch(normalized).filter((term) => term.length >= 3)
  ]).slice(0, 6);
  const resultSets = await Promise.all(terms.map(async (term) => {
    let matches = null;
    if (RG_BIN) matches = await ripgrepGrep(rootDir, term, { regex: false, limit: 24, glob: null });
    if (matches === null) matches = await gitGrep(rootDir, term, { regex: false, limit: 24, glob: null });
    if (matches === null) matches = await searchTree(rootDir, term, { regex: false, limit: 24, glob: null });
    return matches || [];
  }));
  const merged = new Map();
  for (const matches of resultSets) {
    for (const match of matches) {
      const key = `${match.path}:${match.line}`;
      if (!merged.has(key)) merged.set(key, { ...match, score: 0 });
      const current = merged.get(key);
      const haystack = `${current.path || ""} ${current.text || ""}`.toLowerCase();
      current.score += terms.reduce((score, term) => score + (haystack.includes(term.toLowerCase()) ? (term === normalized ? 8 : 2) : 0), 0);
    }
  }
  const ranked = [...merged.values()]
    .sort((a, b) => b.score - a.score || String(a.path).localeCompare(String(b.path)) || Number(a.line || 0) - Number(b.line || 0))
    .slice(0, 40);
  if (includeSnippets && ranked.length) await attachContext(ranked, 2);
  const limited = fitJsonItems(ranked, maxChars);
  return {
    focus: normalized,
    terms,
    count: ranked.length,
    returned: limited.items.length,
    truncated: limited.truncated,
    matches: limited.items
  };
}

export function recommendedReads({ importantFiles = [], treeEntries = [] }) {
  const picked = [];
  const add = (file, reason) => {
    if (!file || picked.some((item) => item.path === file)) return;
    picked.push({ path: file, reason });
  };
  for (const item of importantFiles) {
    const base = path.basename(item.path).toLowerCase();
    if (base.startsWith("readme")) add(item.path, "project overview");
    else if (base === "agents.md") add(item.path, "agent/project conventions");
    else if (base === "package.json") add(item.path, "scripts and dependencies");
    else if (base === "pyproject.toml" || base === "go.mod" || base === "cargo.toml" || base.endsWith(".csproj") || base.endsWith(".sln")) add(item.path, "main project manifest");
  }
  for (const entry of treeEntries) {
    if (picked.length >= 8) break;
    const normalized = entry.split(path.sep).join("/");
    if (/^(src|app|lib|server)\/(index|main|app|server)\.(js|ts|tsx|jsx|mjs|py|cs)$/.test(normalized)) {
      add(entry, "likely entrypoint");
    }
  }
  return picked.slice(0, 8);
}

function isSourceFile(file) {
  return /\.(js|ts|mjs|cjs|jsx|tsx|py|cs|go|rs|java)$/i.test(file) && !isTestFile(file);
}

function isTestFile(file) {
  return /(^|\/)(__tests__|tests?|spec)\//i.test(file) || /\.(test|spec)\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(file) || /(^|\/)test_.*\.py$/i.test(file) || /_test\.(py|go|rs)$/i.test(file);
}

function isConfigFile(file) {
  return /(^|\/)(package\.json|tsconfig.*\.json|pyproject\.toml|go\.mod|cargo\.toml|.*\.csproj|.*\.sln|dockerfile|docker-compose.*\.ya?ml|\.github\/workflows\/.*\.ya?ml)$/i.test(file);
}

function parseDiffSummary(diff) {
  const files = new Map();
  let current = null;
  let newLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const file = line.slice(4).replace(/^b\//, "").trim();
      if (file === "/dev/null") {
        current = null;
      } else {
        current = files.get(file) || { path: file, added: 0, deleted: 0 };
        files.set(file, current);
      }
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      newLine = match ? Number(match[1]) - 1 : 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      newLine++;
      current.added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deleted++;
    } else if (!line.startsWith("\\")) {
      newLine++;
    }
  }
  const changed = [...files.values()];
  return {
    changed_files: changed.length,
    source_files: changed.filter((f) => isSourceFile(f.path)).length,
    test_files: changed.filter((f) => isTestFile(f.path)).length,
    config_files: changed.filter((f) => isConfigFile(f.path)).length,
    added_lines: changed.reduce((sum, f) => sum + f.added, 0),
    deleted_lines: changed.reduce((sum, f) => sum + f.deleted, 0),
    files: changed.slice(0, 80)
  };
}

export function analyzeDiff(diff) {
  const findings = [];
  const summary = parseDiffSummary(diff);
  let currentFile = null;
  let lineNum = 0;
  let addedStreak = 0;
  let streakStart = 0;
  const secretPatterns = [
    { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: "github token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
    { name: "slack token", re: /xox[baprs]-[0-9A-Za-z-]{20,}/ },
    { name: "api key assignment", re: /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*['"][^'"]{10,}['"]/i }
  ];
  const addFinding = (priority, loc, issue) => {
    if (findings.length < 150) findings.push({ priority, loc, issue });
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      currentFile = line.slice(4).replace(/^b\//, "").trim();
      addedStreak = 0;
      streakStart = 0;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      lineNum = match ? Number(match[1]) - 1 : 0;
      addedStreak = 0;
      streakStart = 0;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lineNum++;
      addedStreak++;
      if (addedStreak === 1) streakStart = lineNum;
      const added = line.slice(1);
      const loc = `${currentFile}:${lineNum}`;
      for (const pattern of secretPatterns) {
        if (pattern.re.test(added)) addFinding("P1", loc, `Secret-like ${pattern.name} added`);
      }
      if (/\beval\s*\(/.test(added)) addFinding("P1", loc, "eval() usage; potential code injection");
      if (/\binnerHTML\s*=/.test(added)) addFinding("P1", loc, "innerHTML assignment; potential XSS");
      if (/dangerouslySetInnerHTML/.test(added)) addFinding("P1", loc, "dangerouslySetInnerHTML; XSS risk");
      if (/\bchild_process\.exec\s*\(/.test(added) || /\brequire\(['"]child_process['"]\)/.test(added)) addFinding("P1", loc, "child_process exec; command injection risk");
      if (/\b(subprocess\.(Popen|run|call)|os\.system)\s*\(/.test(added)) addFinding("P2", loc, "Process execution added; verify arguments are trusted");
      if (/\bconsole\.(log|debug|info)\s*\(/.test(added)) addFinding("P2", loc, "console.log/debug left in code");
      if (/\bdebugger\b/.test(added)) addFinding("P2", loc, "debugger statement");
      const todo = added.match(/\b(TODO|FIXME|HACK)\b/);
      if (todo) addFinding(todo[1].toUpperCase() === "HACK" ? "P3" : "P2", loc, `${todo[1]} comment added`);
      if (addedStreak === 101) addFinding("P3", `${currentFile}:~${streakStart}`, "Very large added block (>100 lines); consider splitting");
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Deleted lines do not advance the new-file line counter.
    } else if (!line.startsWith("\\")) {
      lineNum++;
      addedStreak = 0;
    }
  }

  if (summary.source_files > 0 && summary.test_files === 0) {
    const firstSource = summary.files.find((file) => isSourceFile(file.path));
    if (firstSource) addFinding("P3", firstSource.path, "Source file changed without a corresponding test file change");
  }
  return { summary, findings };
}


// ============================================================================
// v2.2 — Patch preview and validation
// ============================================================================

// Dry-run a unified diff: return per-file before/after + match status


// ============================================================================
// v2.3 — Smart Test / Build Runner
// ============================================================================

export async function detectTestCommands(rootDir) {
  const commands = { test: null, build: null, lint: null, dev: null, typecheck: null };

  async function tryRead(rel) {
    try { return await readFile(path.join(rootDir, rel), "utf8"); } catch { return null; }
  }

  // npm / Node
  const pkgJson = await tryRead("package.json");
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      const scripts = pkg.scripts || {};
      if (scripts.test) commands.test = `npm test`;
      if (scripts.build) commands.build = `npm run build`;
      if (scripts.lint) commands.lint = `npm run lint`;
      if (scripts.dev) commands.dev = `npm run dev`;
      if (scripts.typecheck || scripts["type-check"] || scripts["type:check"]) {
        commands.typecheck = `npm run ${Object.keys(scripts).find((k) => /typecheck|type.check/.test(k))}`;
      }
    } catch { /* skip */ }
  }

  // Python / pytest
  const pyproject = await tryRead("pyproject.toml");
  const reqTxt = await tryRead("requirements.txt");
  if (pyproject || reqTxt) {
    if (!commands.test) commands.test = "python -m pytest";
    if (!commands.lint) commands.lint = "python -m flake8";
  }

  // Go
  if (await tryRead("go.mod")) {
    if (!commands.test) commands.test = "go test ./...";
    if (!commands.build) commands.build = "go build ./...";
  }

  // Rust
  if (await tryRead("Cargo.toml")) {
    if (!commands.test) commands.test = "cargo test";
    if (!commands.build) commands.build = "cargo build";
    if (!commands.lint) commands.lint = "cargo clippy";
  }

  // Flutter
  if (await tryRead("pubspec.yaml")) {
    if (!commands.test) commands.test = "flutter test";
    if (!commands.build) commands.build = "flutter build";
  }

  // .NET
  let items;
  try { items = await readdir(rootDir); } catch { items = []; }
  if (items.some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) {
    if (!commands.test) commands.test = "dotnet test";
    if (!commands.build) commands.build = "dotnet build";
  }

  // Gradle
  if (await tryRead("build.gradle")) {
    if (!commands.test) commands.test = "gradle test";
    if (!commands.build) commands.build = "gradle build";
  }

  // Maven
  if (await tryRead("pom.xml")) {
    if (!commands.test) commands.test = "mvn test";
    if (!commands.build) commands.build = "mvn package";
  }

  return commands;
}

function parseTestFailures(output) {
  const failures = [];
  const lines = output.split(/\r?\n/);
  const patterns = [
    // Jest / Vitest: "FAIL src/foo.test.ts" or "✕ test name"
    /^(FAIL|FAILED)\s+(.+)$/,
    // Node assert / mocha
    /AssertionError/,
    // file:line:col error
    /^(.+):(\d+):(\d+):\s*(Error|error)/,
    // "expected X got Y"
    /expected.*got\b/i,
    // "× test name" (Unicode ×)
    /^[\s]*[×✕✗]\s+(.+)/
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of patterns) {
      const m = line.match(pat);
      if (m) {
        failures.push({ message: line.slice(0, 300), context: lines.slice(Math.max(0, i - 1), i + 3).join("\n").slice(0, 500) });
        break;
      }
    }
    if (failures.length >= 30) break;
  }
  return failures;
}

export async function runGatedCommand(command, cwd, timeoutMs = 120_000, workspaceRoot = PRIMARY_ROOT) {
  const result = await runShellCommand(command, cwd, undefined, timeoutMs, workspaceRoot);
  const output = (result.stdout + "\n" + result.stderr).trim();
  const ok = result.exit_code === 0;
  const failures = ok ? [] : parseTestFailures(output);
  const summary = output.slice(0, 3000);
  return { ok, command, exit_code: result.exit_code, timed_out: result.timed_out, summary, failures };
}


export function impactedTestStrategy(gates) {
  const scopes = new Set((gates || []).map((gate) => gate.command_scope).filter(Boolean));
  if (scopes.has("full_workspace_unknown_changes")) return "full_fallback_unknown_changes";
  if (scopes.has("package_impacted_tests") && scopes.size === 1) return "package_impacted_tests";
  if (scopes.has("package_impacted_tests")) return "mixed_impacted_and_full_package";
  if (scopes.has("full_package")) return "full_affected_packages";
  return "no_test_gate";
}
