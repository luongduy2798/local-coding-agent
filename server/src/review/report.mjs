// Local Coding Agent review inventory, diff and security evidence
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { TaskRouterError } from "../workspace/task-router.mjs";

let DEFAULT_CMD_TIMEOUT;
let MAX_COMMAND_OUTPUT;
let analyzeDiff;
let canonicalize;
let dedupe;
let isWithinRoots;
let resolveWorkspacePath;
let spawnCapture;
let toWorkspaceRel;
let transactionInDoubt;
let unmanagedChangeState;

export function configureReviewServices(dependencies) {
  ({
    DEFAULT_CMD_TIMEOUT,
    MAX_COMMAND_OUTPUT,
    analyzeDiff,
    canonicalize,
    dedupe,
    isWithinRoots,
    resolveWorkspacePath,
    spawnCapture,
    toWorkspaceRel,
    transactionInDoubt,
    unmanagedChangeState
  } = dependencies);
}

export const REVIEW_SOURCES = ["staged", "unstaged", "untracked"];
export const REVIEW_PAGE_SIZE_DEFAULT = 80;
export const REVIEW_PAGE_SIZE_MAX = 200;
const REVIEW_UNTRACKED_DIFF_MAX_BYTES = 200_000;

function reviewOutputTruncated(result) {
  return result?.stdout_truncated === true ||
    result?.stderr_truncated === true ||
    String(result?.stdout || "").length >= MAX_COMMAND_OUTPUT ||
    String(result?.stderr || "").length >= MAX_COMMAND_OUTPUT;
}

function safeReviewPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    return "<invalid-relative-path>";
  }
  return normalized.slice(0, 1_000);
}

function emptyReviewSourceState() {
  return {
    complete: false,
    truncated: false,
    timed_out: false,
    error_code: "REVIEW_NOT_COLLECTED"
  };
}

export async function collectReviewInventory(selected, rootDir) {
  const scopePath = toWorkspaceRel(selected.workspace, rootDir);
  const pathspec = scopePath === "." ? "." : `:(top,literal)${scopePath}`;
  const specifications = [
    ["staged", ["diff", "--staged", "--name-only", "-z", "--", pathspec]],
    ["unstaged", ["diff", "--name-only", "-z", "--", pathspec]],
    ["untracked", ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec]]
  ];
  const collected = await Promise.all(specifications.map(async ([source, args]) => ({
    source,
    result: await spawnCapture("git", args, selected.workspace.canonicalRoot, DEFAULT_CMD_TIMEOUT)
  })));
  const items = new Map();
  const failedPaths = [];
  const sourceStatus = {};
  const scopeRoot = canonicalize(rootDir);

  for (const { source, result } of collected) {
    const truncated = reviewOutputTruncated(result);
    const failed = result.exit_code !== 0 || result.timed_out === true;
    sourceStatus[source] = {
      complete: !failed && !truncated,
      truncated,
      timed_out: result.timed_out === true,
      error_code: result.timed_out
        ? "GIT_ENUMERATION_TIMED_OUT"
        : result.exit_code !== 0
          ? "GIT_ENUMERATION_FAILED"
          : truncated
            ? "GIT_ENUMERATION_TRUNCATED"
            : null
    };
    if (failed) continue;

    const names = String(result.stdout || "").split("\0").filter(Boolean);
    for (const rawName of names) {
      const absolutePath = path.resolve(selected.workspace.canonicalRoot, rawName);
      const canonicalPath = canonicalize(absolutePath);
      if (
        !isWithinRoots(canonicalPath, [selected.workspace.canonicalRoot]) ||
        !isWithinRoots(canonicalPath, [scopeRoot])
      ) {
        failedPaths.push({
          workspace_id: selected.workspace.id,
          path: safeReviewPath(rawName),
          source,
          reason: "path_outside_review_scope"
        });
        continue;
      }
      const relativePath = toWorkspaceRel(selected.workspace, absolutePath);
      const current = items.get(relativePath) || {
        workspace_id: selected.workspace.id,
        path: relativePath,
        sources: []
      };
      if (!current.sources.includes(source)) current.sources.push(source);
      items.set(relativePath, current);
    }
  }

  const ordered = [...items.values()]
    .map((item) => ({ ...item, sources: [...item.sources].sort() }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const sourceCounts = Object.fromEntries(REVIEW_SOURCES.map((source) => [
    source,
    ordered.filter((item) => item.sources.includes(source)).length
  ]));
  const truncated = REVIEW_SOURCES.some((source) => sourceStatus[source]?.truncated === true);
  const complete = REVIEW_SOURCES.every((source) => sourceStatus[source]?.complete === true) && failedPaths.length === 0;
  return {
    items: ordered,
    source_counts: sourceCounts,
    source_status: sourceStatus,
    complete,
    truncated,
    failed_paths: failedPaths
  };
}

export async function collectTrackedReviewDiff(selected, rootDir, source) {
  const scopePath = toWorkspaceRel(selected.workspace, rootDir);
  const pathspec = scopePath === "." ? "." : `:(top,literal)${scopePath}`;
  const args = source === "staged"
    ? ["diff", "--staged", "--no-ext-diff", "--", pathspec]
    : ["diff", "--no-ext-diff", "--", pathspec];
  const result = await spawnCapture("git", args, selected.workspace.canonicalRoot, DEFAULT_CMD_TIMEOUT);
  const truncated = reviewOutputTruncated(result);
  const failed = result.exit_code !== 0 || result.timed_out === true;
  return {
    source,
    diff: String(result.stdout || ""),
    complete: !failed && !truncated,
    truncated,
    timed_out: result.timed_out === true,
    failed_paths: [],
    bytes: Buffer.byteLength(String(result.stdout || "")),
    error_code: result.timed_out
      ? "GIT_DIFF_TIMED_OUT"
      : result.exit_code !== 0
        ? "GIT_DIFF_FAILED"
        : truncated
          ? "GIT_DIFF_TRUNCATED"
          : null
  };
}

export async function collectUntrackedReviewDiff(
  selected,
  inventory,
  maxBytes = REVIEW_UNTRACKED_DIFF_MAX_BYTES
) {
  const files = inventory.items.filter((item) => item.sources.includes("untracked"));
  const enumeration = inventory.source_status.untracked || emptyReviewSourceState();
  const chunks = [];
  const renderedFiles = [];
  const failedPaths = [];
  let used = 0;
  let truncated = enumeration.truncated === true;

  for (const location of files) {
    const absolutePath = path.resolve(selected.workspace.canonicalRoot, location.path);
    const canonicalPath = canonicalize(absolutePath);
    if (!isWithinRoots(canonicalPath, [selected.workspace.canonicalRoot])) {
      failedPaths.push({ ...location, source: "untracked", reason: "path_outside_workspace" });
      continue;
    }
    let fileInfo;
    try {
      fileInfo = await stat(absolutePath);
    } catch {
      failedPaths.push({ ...location, source: "untracked", reason: "stat_failed" });
      continue;
    }
    if (!fileInfo.isFile()) {
      failedPaths.push({ ...location, source: "untracked", reason: "not_a_regular_file" });
      continue;
    }
    if (fileInfo.size > maxBytes - used) {
      truncated = true;
      failedPaths.push({ ...location, source: "untracked", reason: "diff_budget_exceeded" });
      break;
    }
    let buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch {
      failedPaths.push({ ...location, source: "untracked", reason: "read_failed" });
      continue;
    }
    let chunk;
    if (buffer.includes(0)) {
      chunk = `diff --git a/${location.path} b/${location.path}\nnew file mode 100644\nBinary files /dev/null and b/${location.path} differ\n`;
    } else {
      const lines = buffer.toString("utf8").split(/\r?\n/);
      chunk = [
        `diff --git a/${location.path} b/${location.path}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${location.path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
        ""
      ].join("\n");
    }
    const bytes = Buffer.byteLength(chunk);
    if (used + bytes > maxBytes) {
      truncated = true;
      failedPaths.push({ ...location, source: "untracked", reason: "diff_budget_exceeded" });
      break;
    }
    chunks.push(chunk);
    renderedFiles.push(location);
    used += bytes;
  }

  const complete = enumeration.complete === true &&
    !truncated &&
    failedPaths.length === 0 &&
    renderedFiles.length === files.length;
  return {
    source: "untracked",
    diff: chunks.join("\n"),
    files,
    rendered_files: renderedFiles,
    complete,
    truncated,
    timed_out: enumeration.timed_out === true,
    failed_paths: failedPaths,
    bytes: used,
    error_code: complete
      ? null
      : truncated
        ? "UNTRACKED_DIFF_TRUNCATED"
        : enumeration.error_code || "UNTRACKED_DIFF_INCOMPLETE"
  };
}

export function reviewEvidenceDescriptor(evidence) {
  return {
    complete: evidence.complete === true,
    truncated: evidence.truncated === true,
    timed_out: evidence.timed_out === true,
    bytes: Number(evidence.bytes || 0),
    failed_paths_count: evidence.failed_paths?.length || 0,
    error_code: evidence.error_code || null,
    ...(evidence.source === "untracked"
      ? {
          files: evidence.files?.length || 0,
          rendered_files: evidence.rendered_files?.length || 0
        }
      : {})
  };
}

function qualifyReviewFinding(workspaceId, finding) {
  const rawLocation = String(finding.loc || "");
  const match = rawLocation.match(/^(.*?):(\d+)$/);
  const location = {
    workspace_id: workspaceId,
    path: match ? match[1] : rawLocation || ".",
    ...(match ? { line: Number(match[2]) } : {})
  };
  return {
    workspace_id: workspaceId,
    priority: finding.priority,
    location,
    issue: finding.issue
  };
}

function failedReviewWorkspace(workspaceId, error) {
  const sourceStatus = Object.fromEntries(REVIEW_SOURCES.map((source) => [source, emptyReviewSourceState()]));
  return {
    workspace_id: workspaceId,
    ok: false,
    verdict: "INCOMPLETE",
    complete: false,
    summary: {
      changed_files: 0,
      source_files: 0,
      test_files: 0,
      config_files: 0,
      added_lines: 0,
      deleted_lines: 0,
      untracked_files: 0,
      files: []
    },
    inventory: {
      source_counts: { staged: 0, unstaged: 0, untracked: 0 },
      source_status: sourceStatus,
      total: 0,
      complete: false,
      truncated: false,
      failed_paths_count: 0
    },
    evidence: {
      staged: reviewEvidenceDescriptor({}),
      unstaged: reviewEvidenceDescriptor({}),
      untracked: reviewEvidenceDescriptor({ source: "untracked" }),
      transaction_in_doubt: true,
      unmanaged_state: { known: false, detected: false, error_code: "REVIEW_WORKSPACE_UNAVAILABLE" }
    },
    incomplete_reasons: [error?.code || "REVIEW_WORKSPACE_UNAVAILABLE"],
    findings_count: 0,
    p1: 0,
    p2: 0,
    p3: 0,
    _inventory_items: [],
    _failed_paths: [],
    _summary_files: [],
    _findings: []
  };
}

export async function reviewWorkspaceDiff({ workspaceId, taskToken, taskId, cwd }) {
  let selected;
  try {
    selected = await resolveWorkspacePath(cwd, { workspaceId, taskToken });
  } catch (error) {
    return failedReviewWorkspace(workspaceId, error);
  }
  const inventory = await collectReviewInventory(selected, selected.path);
  const [stagedEvidence, unstagedEvidence, untrackedEvidence, unmanagedState] = await Promise.all([
    collectTrackedReviewDiff(selected, selected.path, "staged"),
    collectTrackedReviewDiff(selected, selected.path, "unstaged"),
    collectUntrackedReviewDiff(selected, inventory),
    unmanagedChangeState(selected.workspace.id, taskId)
  ]);
  const transactionBlocked = transactionInDoubt(selected.workspace.id);
  const incompleteReasons = [];
  for (const source of REVIEW_SOURCES) {
    const status = inventory.source_status[source] || emptyReviewSourceState();
    if (status.truncated) incompleteReasons.push(`${source}_enumeration_truncated`);
    else if (!status.complete) incompleteReasons.push(`${source}_enumeration_failed`);
  }
  if (inventory.failed_paths.length) incompleteReasons.push("inventory_path_resolution_failed");
  for (const evidence of [stagedEvidence, unstagedEvidence, untrackedEvidence]) {
    if (evidence.truncated) incompleteReasons.push(`${evidence.source}_diff_truncated`);
    else if (!evidence.complete) incompleteReasons.push(`${evidence.source}_diff_incomplete`);
  }
  if (transactionBlocked) incompleteReasons.push("transaction_in_doubt");
  if (unmanagedState.unknown === true) incompleteReasons.push("unmanaged_state_unknown");
  if (inventory.source_counts.staged > 0 && !stagedEvidence.diff.trim()) {
    incompleteReasons.push("staged_content_missing");
  }
  if (inventory.source_counts.unstaged > 0 && !unstagedEvidence.diff.trim()) {
    incompleteReasons.push("unstaged_content_missing");
  }
  if (inventory.source_counts.untracked > 0 && !untrackedEvidence.diff.trim()) {
    incompleteReasons.push("untracked_content_missing");
  }

  const combinedDiff = [stagedEvidence.diff, unstagedEvidence.diff, untrackedEvidence.diff]
    .filter(Boolean)
    .join("\n");
  const analyzed = combinedDiff.trim()
    ? analyzeDiff(combinedDiff)
    : {
        summary: {
          changed_files: 0,
          source_files: 0,
          test_files: 0,
          config_files: 0,
          added_lines: 0,
          deleted_lines: 0,
          files: []
        },
        findings: []
      };
  const summaryFiles = (analyzed.summary.files || []).map((file) => ({
    workspace_id: selected.workspace.id,
    ...file
  }));
  const findings = analyzed.findings.map((finding) => qualifyReviewFinding(selected.workspace.id, finding));
  if (findings.length >= 150) incompleteReasons.push("finding_limit_reached");
  const reasons = dedupe(incompleteReasons);
  const p1 = findings.filter((finding) => finding.priority === "P1").length;
  const unmanaged = unmanagedState.detected === true && unmanagedState.adopted !== true;
  const riskVerdict = p1 > 0
    ? "BLOCK"
    : findings.length > 0 || unmanaged
      ? "WARN"
      : combinedDiff.trim()
        ? "PASS"
        : "CLEAN";
  const verdict = reasons.length ? "INCOMPLETE" : riskVerdict;
  return {
    workspace_id: selected.workspace.id,
    ok: verdict !== "BLOCK" && verdict !== "INCOMPLETE" && !unmanaged,
    verdict,
    risk_verdict: riskVerdict,
    complete: reasons.length === 0,
    summary: {
      ...analyzed.summary,
      untracked_files: inventory.source_counts.untracked,
      files: summaryFiles
    },
    inventory: {
      source_counts: inventory.source_counts,
      source_status: inventory.source_status,
      total: inventory.items.length,
      complete: inventory.complete,
      truncated: inventory.truncated,
      failed_paths_count: inventory.failed_paths.length
    },
    evidence: {
      staged: reviewEvidenceDescriptor(stagedEvidence),
      unstaged: reviewEvidenceDescriptor(unstagedEvidence),
      untracked: reviewEvidenceDescriptor(untrackedEvidence),
      transaction_in_doubt: transactionBlocked,
      unmanaged_state: {
        known: unmanagedState.unknown !== true,
        detected: unmanaged,
        adopted: unmanagedState.adopted === true,
        ...(unmanagedState.unknown ? { error_code: unmanagedState.error_code } : {})
      }
    },
    incomplete_reasons: reasons,
    findings_count: findings.length,
    p1,
    p2: findings.filter((finding) => finding.priority === "P2").length,
    p3: findings.filter((finding) => finding.priority === "P3").length,
    _inventory_items: inventory.items,
    _failed_paths: [...inventory.failed_paths, ...untrackedEvidence.failed_paths],
    _summary_files: summaryFiles,
    _findings: findings
  };
}

export function encodeReviewCursor(scope, offset) {
  return Buffer.from(JSON.stringify({ version: 1, scope, offset }), "utf8").toString("base64url");
}

export function decodeReviewCursor(cursor, scope, maximum) {
  if (!cursor) return 0;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
  } catch {
    throw new TaskRouterError("INVALID_CURSOR", "review_diff cursor is invalid.");
  }
  const offset = Number(parsed?.offset);
  if (
    parsed?.version !== 1 ||
    parsed?.scope !== scope ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > maximum
  ) {
    throw new TaskRouterError(
      parsed?.scope && parsed.scope !== scope ? "STALE_CURSOR" : "INVALID_CURSOR",
      parsed?.scope && parsed.scope !== scope
        ? "review_diff evidence changed; restart pagination without a cursor."
        : "review_diff cursor is invalid."
    );
  }
  return offset;
}

export function compactReviewWorkspace(result) {
  const {
    _inventory_items: _inventoryItems,
    _failed_paths: _failedPaths,
    _summary_files: _summaryFiles,
    _findings: _findings,
    summary,
    ...publicResult
  } = result;
  return {
    ...publicResult,
    summary: {
      ...summary,
      files: undefined,
      files_total: summary?.changed_files || 0
    }
  };
}

export function aggregateReviewSummary(workspaceResults, files) {
  const numericFields = [
    "changed_files",
    "source_files",
    "test_files",
    "config_files",
    "added_lines",
    "deleted_lines",
    "untracked_files"
  ];
  const summary = Object.fromEntries(numericFields.map((field) => [
    field,
    workspaceResults.reduce((total, result) => total + Number(result.summary?.[field] || 0), 0)
  ]));
  return {
    ...summary,
    files,
    files_returned: files.length,
    files_total: summary.changed_files
  };
}

export function aggregateReviewVerdict(workspaceResults) {
  if (workspaceResults.some((result) => result.verdict === "INCOMPLETE")) return "INCOMPLETE";
  if (workspaceResults.some((result) => result.verdict === "BLOCK")) return "BLOCK";
  if (workspaceResults.some((result) => result.verdict === "WARN")) return "WARN";
  if (workspaceResults.some((result) => result.verdict === "PASS")) return "PASS";
  return "CLEAN";
}

export async function collectChangedSecurityCandidates(selected, rootDir, maxFiles = 300) {
  const repoResult = await spawnCapture(
    "git",
    ["rev-parse", "--show-toplevel"],
    rootDir,
    DEFAULT_CMD_TIMEOUT
  );
  if (repoResult.exit_code !== 0) {
    return {
      files: [],
      changed: [],
      skipped: [],
      complete: false,
      incomplete_reasons: ["git_repository_unavailable"],
      source_counts: { unstaged: 0, staged: 0, untracked: 0 }
    };
  }

  const gitRoot = path.resolve(String(repoResult.stdout || "").trim());
  if (!gitRoot || !isWithinRoots(canonicalize(gitRoot), [selected.workspace.canonicalRoot])) {
    return {
      files: [],
      changed: [],
      skipped: [],
      complete: false,
      incomplete_reasons: ["git_root_outside_workspace"],
      source_counts: { unstaged: 0, staged: 0, untracked: 0 }
    };
  }

  const commands = [
    ["unstaged", ["diff", "--name-only", "-z", "--"]],
    ["staged", ["diff", "--staged", "--name-only", "-z", "--"]],
    ["untracked", ["ls-files", "--others", "--exclude-standard", "-z", "--"]]
  ];
  const results = await Promise.all(commands.map(async ([source, args]) => ({
    source,
    result: await spawnCapture("git", args, gitRoot, DEFAULT_CMD_TIMEOUT)
  })));
  const incompleteReasons = [];
  const sourceCounts = { unstaged: 0, staged: 0, untracked: 0 };
  const candidates = new Map();
  const scopeRoot = canonicalize(rootDir);

  for (const { source, result } of results) {
    if (result.exit_code !== 0) {
      incompleteReasons.push(`${source}_enumeration_failed`);
      continue;
    }
    if (String(result.stdout || "").length >= MAX_COMMAND_OUTPUT) {
      incompleteReasons.push(`${source}_enumeration_truncated`);
    }
    const names = String(result.stdout || "").split("\0").filter(Boolean);
    sourceCounts[source] = names.length;
    for (const name of names) {
      const absolutePath = path.resolve(gitRoot, name);
      const canonicalPath = canonicalize(absolutePath);
      if (!isWithinRoots(canonicalPath, [selected.workspace.canonicalRoot])) {
        incompleteReasons.push("changed_path_outside_workspace");
        continue;
      }
      if (!isWithinRoots(canonicalPath, [scopeRoot])) continue;
      const relativePath = toWorkspaceRel(selected.workspace, absolutePath);
      const existing = candidates.get(relativePath) || {
        workspace_id: selected.workspace.id,
        path: relativePath,
        absolutePath,
        sources: []
      };
      if (!existing.sources.includes(source)) existing.sources.push(source);
      candidates.set(relativePath, existing);
    }
  }

  const changed = [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (changed.length > maxFiles) incompleteReasons.push("changed_file_limit_reached");
  const files = [];
  const skipped = [];
  for (const candidate of changed.slice(0, maxFiles)) {
    let fileStat;
    try {
      fileStat = await stat(candidate.absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        skipped.push({
          workspace_id: selected.workspace.id,
          path: candidate.path,
          reason: "deleted_or_missing"
        });
        continue;
      }
      skipped.push({
        workspace_id: selected.workspace.id,
        path: candidate.path,
        reason: "stat_failed"
      });
      incompleteReasons.push("changed_file_stat_failed");
      continue;
    }
    if (!fileStat.isFile()) {
      skipped.push({
        workspace_id: selected.workspace.id,
        path: candidate.path,
        reason: "not_a_regular_file"
      });
      continue;
    }
    files.push(candidate);
  }

  return {
    files,
    changed: changed.map(({ absolutePath: _absolutePath, ...item }) => item),
    skipped,
    complete: incompleteReasons.length === 0,
    incomplete_reasons: dedupe(incompleteReasons),
    source_counts: sourceCounts
  };
}
