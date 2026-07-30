// Local Coding Agent MCP review and security tools
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { withRequestSpan } from "../../shared/utils.mjs";
import { RESPONSE_MODES, isMinimalResponse, shouldCompactResponse } from "../response-mode.mjs";

function minimalReviewPayload(payload) {
  return {
    task_id: payload.task_id || null,
    workspace_id: payload.workspace_id || null,
    mutation_epoch: payload.mutation_epoch || 0,
    ok: payload.ok === true,
    verdict: payload.verdict,
    complete: payload.complete === true,
    evidence_revision: payload.evidence_revision,
    transaction_in_doubt: payload.transaction_in_doubt === true,
    unmanaged_changes: payload.unmanaged_changes === true,
    unmanaged_state_unknown: payload.unmanaged_state_unknown === true,
    incomplete_reasons: payload.incomplete_reasons || [],
    findings_count: payload.findings_count || 0,
    findings: payload.findings || [],
    p1: payload.p1 || 0,
    p2: payload.p2 || 0,
    p3: payload.p3 || 0,
    message: payload.message
  };
}

function compactReviewPayload(payload) {
  return {
    task_id: payload.task_id || null,
    workspace_id: payload.workspace_id || null,
    mutation_epoch: payload.mutation_epoch || 0,
    ok: payload.ok === true,
    verdict: payload.verdict,
    complete: payload.complete === true,
    requested_view: payload.requested_view,
    analyzed_sources: payload.analyzed_sources,
    summary: payload.summary,
    evidence_revision: payload.evidence_revision,
    transaction_in_doubt: payload.transaction_in_doubt === true,
    unmanaged_changes: payload.unmanaged_changes === true,
    unmanaged_state_unknown: payload.unmanaged_state_unknown === true,
    incomplete_reasons: payload.incomplete_reasons || [],
    findings_count: payload.findings_count || 0,
    findings_returned: payload.findings_returned || 0,
    findings: payload.findings || [],
    p1: payload.p1 || 0,
    p2: payload.p2 || 0,
    p3: payload.p3 || 0,
    scope: payload.scope,
    pagination: payload.pagination,
    inventory: {
      source_counts: payload.inventory?.source_counts || {},
      total: payload.inventory?.total || 0,
      returned: payload.inventory?.returned || 0,
      complete: payload.inventory?.complete === true,
      truncated: payload.inventory?.truncated === true,
      failed_paths_count: payload.inventory?.failed_paths_count || 0,
      page_has_more: payload.inventory?.page_has_more === true
    },
    workspaces: payload.workspaces,
    message: payload.message
  };
}

function splitTaskDiffLines(value) {
  const normalized = String(value || "").replace(/\r\n?/g, "\n");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

function appendFallbackLineDiff(before, after, beforeStart, beforeEnd, afterStart, afterEnd, output) {
  const beforeCount = beforeEnd - beforeStart;
  const afterCount = afterEnd - afterStart;
  if (beforeCount * afterCount > 50_000) {
    for (let index = beforeStart; index < beforeEnd; index++) output.push({ type: "delete", line: before[index] });
    for (let index = afterStart; index < afterEnd; index++) output.push({ type: "insert", line: after[index] });
    return;
  }
  const width = afterCount + 1;
  const matrix = new Uint32Array((beforeCount + 1) * width);
  for (let left = beforeCount - 1; left >= 0; left--) {
    for (let right = afterCount - 1; right >= 0; right--) {
      const cell = left * width + right;
      matrix[cell] = before[beforeStart + left] === after[afterStart + right]
        ? matrix[(left + 1) * width + right + 1] + 1
        : Math.max(matrix[(left + 1) * width + right], matrix[left * width + right + 1]);
    }
  }
  let left = 0;
  let right = 0;
  while (left < beforeCount && right < afterCount) {
    const beforeLine = before[beforeStart + left];
    const afterLine = after[afterStart + right];
    if (beforeLine === afterLine) {
      output.push({ type: "equal", line: beforeLine });
      left++;
      right++;
    } else if (matrix[(left + 1) * width + right] >= matrix[left * width + right + 1]) {
      output.push({ type: "delete", line: beforeLine });
      left++;
    } else {
      output.push({ type: "insert", line: afterLine });
      right++;
    }
  }
  while (left < beforeCount) output.push({ type: "delete", line: before[beforeStart + left++] });
  while (right < afterCount) output.push({ type: "insert", line: after[afterStart + right++] });
}

function patienceAnchors(before, after, beforeStart, beforeEnd, afterStart, afterEnd) {
  const beforeLines = new Map();
  const afterLines = new Map();
  for (let index = beforeStart; index < beforeEnd; index++) {
    const current = beforeLines.get(before[index]);
    beforeLines.set(before[index], current ? { count: current.count + 1, index } : { count: 1, index });
  }
  for (let index = afterStart; index < afterEnd; index++) {
    const current = afterLines.get(after[index]);
    afterLines.set(after[index], current ? { count: current.count + 1, index } : { count: 1, index });
  }
  const pairs = [];
  for (const [line, beforeEntry] of beforeLines) {
    const afterEntry = afterLines.get(line);
    if (beforeEntry.count === 1 && afterEntry?.count === 1) {
      pairs.push({ before: beforeEntry.index, after: afterEntry.index });
    }
  }
  pairs.sort((left, right) => left.before - right.before);
  if (!pairs.length) return [];
  const tails = [];
  const previous = new Int32Array(pairs.length).fill(-1);
  for (let index = 0; index < pairs.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (pairs[tails[middle]].after < pairs[index].after) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const anchors = [];
  let cursor = tails.at(-1);
  while (cursor !== undefined && cursor >= 0) {
    anchors.push(pairs[cursor]);
    cursor = previous[cursor];
  }
  return anchors.reverse();
}

function appendPatienceLineDiff(before, after, beforeStart, beforeEnd, afterStart, afterEnd, output) {
  while (beforeStart < beforeEnd && afterStart < afterEnd && before[beforeStart] === after[afterStart]) {
    output.push({ type: "equal", line: before[beforeStart] });
    beforeStart++;
    afterStart++;
  }
  let suffix = 0;
  while (
    beforeStart < beforeEnd - suffix &&
    afterStart < afterEnd - suffix &&
    before[beforeEnd - suffix - 1] === after[afterEnd - suffix - 1]
  ) suffix++;
  const middleBeforeEnd = beforeEnd - suffix;
  const middleAfterEnd = afterEnd - suffix;
  if (beforeStart === middleBeforeEnd || afterStart === middleAfterEnd) {
    for (let index = beforeStart; index < middleBeforeEnd; index++) output.push({ type: "delete", line: before[index] });
    for (let index = afterStart; index < middleAfterEnd; index++) output.push({ type: "insert", line: after[index] });
  } else {
    const anchors = patienceAnchors(before, after, beforeStart, middleBeforeEnd, afterStart, middleAfterEnd);
    if (!anchors.length) {
      appendFallbackLineDiff(before, after, beforeStart, middleBeforeEnd, afterStart, middleAfterEnd, output);
    } else {
      let leftCursor = beforeStart;
      let rightCursor = afterStart;
      for (const anchor of anchors) {
        appendPatienceLineDiff(before, after, leftCursor, anchor.before, rightCursor, anchor.after, output);
        output.push({ type: "equal", line: before[anchor.before] });
        leftCursor = anchor.before + 1;
        rightCursor = anchor.after + 1;
      }
      appendPatienceLineDiff(before, after, leftCursor, middleBeforeEnd, rightCursor, middleAfterEnd, output);
    }
  }
  for (let index = suffix; index > 0; index--) {
    output.push({ type: "equal", line: before[beforeEnd - index] });
  }
}

function createTaskSnapshotDiff(filePath, beforeContent, afterContent, beforeExists, afterExists, contextLines = 3) {
  const before = splitTaskDiffLines(beforeContent);
  const after = splitTaskDiffLines(afterContent);
  const operations = [];
  appendPatienceLineDiff(before, after, 0, before.length, 0, after.length, operations);
  if (!operations.some((entry) => entry.type !== "equal") && beforeExists === afterExists) return "";
  const oldName = beforeExists ? `a/${filePath}` : "/dev/null";
  const newName = afterExists ? `b/${filePath}` : "/dev/null";
  const entries = [];
  let oldLine = 1;
  let newLine = 1;
  for (const operation of operations) {
    entries.push({ ...operation, oldLine, newLine });
    if (operation.type !== "insert") oldLine++;
    if (operation.type !== "delete") newLine++;
  }
  const changed = entries.flatMap((entry, index) => entry.type === "equal" ? [] : [index]);
  if (!changed.length) {
    return [`--- ${oldName}`, `+++ ${newName}`, "@@ -0,0 +0,0 @@"].join("\n");
  }
  const ranges = [];
  for (const index of changed) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(entries.length, index + contextLines + 1);
    const previousRange = ranges.at(-1);
    if (previousRange && start <= previousRange.end) previousRange.end = Math.max(previousRange.end, end);
    else ranges.push({ start, end });
  }
  const lines = [`--- ${oldName}`, `+++ ${newName}`];
  for (const range of ranges) {
    const hunk = entries.slice(range.start, range.end);
    const first = hunk[0];
    const oldCount = hunk.filter((entry) => entry.type !== "insert").length;
    const newCount = hunk.filter((entry) => entry.type !== "delete").length;
    const oldStart = first.type === "insert" ? Math.max(0, first.oldLine - 1) : first.oldLine;
    const newStart = first.type === "delete" ? Math.max(0, first.newLine - 1) : first.newLine;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const entry of hunk) {
      lines.push(`${entry.type === "equal" ? " " : entry.type === "delete" ? "-" : "+"}${entry.line}`);
    }
  }
  return lines.join("\n");
}

async function loadTaskReviewScope({ getChangeJournal, task, workspaceId }) {
  if (!task || !getChangeJournal) return null;
  if (["unmanaged_changes", "unmanaged_state_unknown"].includes(task.orchestration?.integrity_status)) {
    return {
      mode: "task",
      paths: [],
      diff: null,
      unavailable: [],
      error: task.orchestration.integrity_status === "unmanaged_changes"
        ? "UNMANAGED_CHANGES"
        : "UNMANAGED_STATE_UNKNOWN"
    };
  }
  try {
    const journal = await getChangeJournal(workspaceId);
    const change = await journal.getChange(task.id, { taskId: task.id });
    const results = await Promise.all((change.files || []).map(async (file) => {
      try {
        const [before, after] = await Promise.all([
          journal.getContent(task.id, { path: file.path, side: "before", taskId: task.id }),
          journal.getContent(task.id, { path: file.path, side: "after", taskId: task.id })
        ]);
        return {
          path: file.path,
          diff: createTaskSnapshotDiff(file.path, before.content, after.content, before.exists, after.exists),
          unavailable: null
        };
      } catch (error) {
        return {
          path: file.path,
          diff: "",
          unavailable: { path: file.path, reason: error?.code || "journal_content_unavailable" }
        };
      }
    }));
    const paths = [...new Set(results.map((entry) => String(entry.path || "")).filter(Boolean))].sort();
    return {
      mode: "task",
      paths,
      diff: results.map((entry) => entry.diff).filter(Boolean).join("\n"),
      unavailable: results.flatMap((entry) => entry.unavailable ? [entry.unavailable] : []),
      error: null
    };
  } catch (error) {
    return {
      mode: "task",
      paths: [],
      diff: null,
      unavailable: [],
      error: error?.code === "change_not_found"
        ? "JOURNAL_EVIDENCE_MISSING"
        : error?.code || "TASK_REVIEW_SCOPE_UNAVAILABLE"
    };
  }
}

function aggregateTaskReviewScope(workspaceIds, taskScopes) {
  const workspaces = workspaceIds.map((workspaceId, index) => ({
    workspace_id: workspaceId,
    mode: taskScopes[index]?.mode || "workspace",
    paths_count: Array.isArray(taskScopes[index]?.paths) ? taskScopes[index].paths.length : null,
    exact_journal_diff: typeof taskScopes[index]?.diff === "string",
    error: taskScopes[index]?.error || null
  }));
  const modes = new Set(workspaces.map((entry) => entry.mode));
  return {
    mode: modes.size === 1 ? workspaces[0]?.mode || "workspace" : "mixed",
    paths_count: workspaces.reduce((total, entry) => total + Number(entry.paths_count || 0), 0),
    workspaces
  };
}

export function registerReviewTools(mcp, dependencies) {
  const {
    REVIEW_PAGE_SIZE_DEFAULT,
    REVIEW_PAGE_SIZE_MAX,
    REVIEW_SOURCES,
    RG_BIN,
    TEST_RUNTIME_DIAGNOSTICS,
    aggregateReviewSummary,
    aggregateReviewVerdict,
    buildTree,
    collectChangedSecurityCandidates,
    compactReviewWorkspace,
    currentTask,
    decodeReviewCursor,
    dedupe,
    encodeReviewCursor,
    getChangeJournal,
    jsonResult,
    reg,
    resolveWorkspacePath,
    reviewWorkspaceDiff,
    ripgrepGrep,
    searchTree,
    selectWorkspace,
    toWorkspaceRel
  } = dependencies;

  reg(
    mcp,
    "review_diff",
    {
      title: "Review diff",
      description: "Canonical review of the current task change set. scope=task (default) requires compact journal before/after diffs and limits Git evidence to task paths; missing, unmanaged, or unavailable task journal evidence returns INCOMPLETE and never falls back to workspace review. scope=workspace explicitly reviews all staged, unstaged and untracked changes in the selected workspace/cwd.",
      inputSchema: {
        staged: z.boolean().optional().describe("Compatibility hint from V4; V5 still inventories and reviews all three change sources."),
        cwd: z.string().optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        scope: z.enum(["task", "workspace"]).optional().describe("task (default) reviews the active task change set; workspace reviews every staged, unstaged and untracked Git change under cwd."),
        response_mode: z.enum(RESPONSE_MODES).optional().describe("auto, minimal, compact, full, or diagnostic response shaping."),
        cursor: z.string().max(500).optional().describe("Opaque cursor returned by a prior review_diff page."),
        page_size: z.number().int().min(1).max(REVIEW_PAGE_SIZE_MAX).optional()
      }
    },
    async ({ staged = false, cwd = ".", workspace_id, task_token, scope: requestedScope = "task", response_mode = "auto", cursor, page_size = REVIEW_PAGE_SIZE_DEFAULT }) => {
      const routedTask = await currentTask({
        taskToken: task_token,
        required: !TEST_RUNTIME_DIAGNOSTICS
      });
      const fallbackSelection = routedTask
        ? null
        : await selectWorkspace({ workspaceId: workspace_id, taskToken: task_token });
      const workspaceIds = workspace_id
        ? [workspace_id]
        : routedTask?.workspace_ids || [fallbackSelection.workspace.id];
      const taskScopes = routedTask && requestedScope === "task"
        ? await Promise.all(workspaceIds.map((selectedWorkspaceId) => loadTaskReviewScope({
            getChangeJournal,
            task: routedTask,
            workspaceId: selectedWorkspaceId
          })))
        : workspaceIds.map(() => null);
      const workspaceResults = await Promise.all(workspaceIds.map((selectedWorkspaceId, index) => withRequestSpan(
        "review_workspace",
        () => reviewWorkspaceDiff({
          workspaceId: selectedWorkspaceId,
          taskToken: task_token,
          taskId: routedTask?.id || null,
          cwd,
          reviewPaths: taskScopes[index]?.paths ?? null,
          managedDiff: taskScopes[index]?.diff ?? null,
          managedDiffUnavailable: taskScopes[index]?.unavailable || [],
          taskScopeError: taskScopes[index]?.error || null
        })
      )));

      const inventoryItems = workspaceResults.flatMap((result) => result._inventory_items);
      const failedPaths = workspaceResults.flatMap((result) => result._failed_paths);
      const summaryFiles = workspaceResults.flatMap((result) => result._summary_files);
      const findings = workspaceResults.flatMap((result) => result._findings);
      const scope = aggregateTaskReviewScope(workspaceIds, taskScopes);
      const evidenceRevision = createHash("sha256")
        .update(JSON.stringify({
          scope,
          inventory: inventoryItems,
          failed_paths: failedPaths,
          summary_files: summaryFiles,
          findings
        }))
        .digest("hex")
        .slice(0, 20);
      const cursorScope = createHash("sha256")
        .update(JSON.stringify({
          task_id: routedTask?.id || null,
          workspace_ids: workspaceIds,
          cwd,
          staged,
          requested_scope: requestedScope,
          scope,
          evidence_revision: evidenceRevision
        }))
        .digest("hex")
        .slice(0, 20);
      const maximum = Math.max(
        inventoryItems.length,
        failedPaths.length,
        summaryFiles.length,
        findings.length
      );
      const offset = decodeReviewCursor(cursor, cursorScope, maximum);
      const pageEnd = Math.min(maximum, offset + page_size);
      const nextCursor = pageEnd < maximum ? encodeReviewCursor(cursorScope, pageEnd) : null;
      const inventoryPage = inventoryItems.slice(offset, pageEnd);
      const failedPathPage = failedPaths.slice(offset, pageEnd);
      const summaryFilePage = summaryFiles.slice(offset, pageEnd);
      const findingPage = findings.slice(offset, pageEnd);
      const sourceCounts = Object.fromEntries(REVIEW_SOURCES.map((source) => [
        source,
        workspaceResults.reduce((total, result) => total + Number(result.inventory.source_counts[source] || 0), 0)
      ]));
      const verdict = aggregateReviewVerdict(workspaceResults);
      const unmanaged = workspaceResults.some((result) => result.evidence.unmanaged_state.detected === true);
      const complete = workspaceResults.every((result) => result.complete === true);
      const incompleteByWorkspace = workspaceResults
        .filter((result) => result.incomplete_reasons.length)
        .map((result) => ({
          workspace_id: result.workspace_id,
          reasons: result.incomplete_reasons
        }));
      const payload = {
        ...(routedTask?.id ? { task_id: routedTask.id } : {}),
        mutation_epoch: Number(routedTask?.orchestration?.mutation_epoch || 0),
        ...(workspaceIds.length === 1 ? { workspace_id: workspaceIds[0] } : {}),
        ok: verdict !== "BLOCK" && verdict !== "INCOMPLETE" && !unmanaged,
        verdict,
        complete,
        requested_view: staged ? "staged" : "all",
        analyzed_sources: [...REVIEW_SOURCES],
        scope,
        workspaces: workspaceResults.map(compactReviewWorkspace),
        summary: aggregateReviewSummary(workspaceResults, summaryFilePage),
        inventory: {
          source_counts: sourceCounts,
          total: inventoryItems.length,
          returned: inventoryPage.length,
          items: inventoryPage,
          complete: workspaceResults.every((result) => result.inventory.complete === true),
          truncated: workspaceResults.some((result) => result.inventory.truncated === true),
          failed_paths_count: failedPaths.length,
          failed_paths_returned: failedPathPage.length,
          failed_paths: failedPathPage,
          page_has_more: nextCursor !== null
        },
        evidence_revision: evidenceRevision,
        transaction_in_doubt: workspaceResults.some((result) => result.evidence.transaction_in_doubt === true),
        unmanaged_changes: unmanaged,
        unmanaged_state_unknown: workspaceResults.some((result) => result.evidence.unmanaged_state.known !== true),
        incomplete_reasons: incompleteByWorkspace,
        findings_count: findings.length,
        findings_returned: findingPage.length,
        findings: findingPage,
        p1: workspaceResults.reduce((total, result) => total + result.p1, 0),
        p2: workspaceResults.reduce((total, result) => total + result.p2, 0),
        p3: workspaceResults.reduce((total, result) => total + result.p3, 0),
        pagination: {
          offset,
          page_size,
          next_cursor: nextCursor,
          has_more: nextCursor !== null,
          collections: {
            inventory: inventoryItems.length,
            failed_paths: failedPaths.length,
            summary_files: summaryFiles.length,
            findings: findings.length
          }
        },
        message: verdict === "INCOMPLETE"
          ? "Review evidence is incomplete; inspect incomplete_reasons and retry after recovery or with a narrower scope."
          : verdict === "CLEAN"
            ? "No staged, unstaged or untracked changes were found in the reviewed task workspaces."
            : "Review completed for staged, unstaged and untracked changes."
      };
      if (isMinimalResponse(response_mode)) return jsonResult(minimalReviewPayload(payload));
      return jsonResult(shouldCompactResponse(response_mode, routedTask?.effective_profile)
        ? compactReviewPayload(payload)
        : payload);
    }
  );

  reg(
    mcp,
    "security_scan",
    {
      title: "Security scan",
      description: "Scan changed (or all, capped) files for secret patterns (AWS keys, private keys, API tokens, etc.) and unsafe usage. Reports file:line — never echoes the secret value.",
      inputSchema: {
        path: z.string().optional().describe("Dir to scan (default primary root)."),
        changed_only: z.boolean().optional().describe("Only scan files changed in git diff (default false)."),
        cwd: z.string().optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional()
      }
    },
    async ({ path: rel, changed_only = false, cwd = ".", workspace_id, task_token }) => {
      const selected = await resolveWorkspacePath(rel || cwd || ".", { workspaceId: workspace_id, taskToken: task_token });
      const rootDir = selected.path;
      const SECRET_PATTERNS = [
        { name: "AWS Access Key", re: /AKIA[0-9A-Z]{16}/ },
        { name: "Private Key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
        { name: "Generic API key", re: /['"](api[_-]?key|apikey|api_secret)['"]\s*[:=]\s*['"][^'"]{10,}['"]/i },
        { name: "Password assignment", re: /\b(password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i },
        { name: "Token assignment", re: /\b(token|access_token|auth_token|bearer)\s*[:=]\s*['"][^'"]{10,}['"]/i },
        { name: "Slack token", re: /xox[baprs]-[0-9A-Za-z]{10,}/ },
        { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
        { name: "Generic secret", re: /\bsecret\s*[:=]\s*['"][^'"]{10,}['"]/i }
      ];

      let filesToScan = [];
      let changedFiles = [];
      let skippedFiles = [];
      let scanComplete = true;
      let incompleteReasons = [];
      let sourceCounts;
      if (changed_only) {
        const changed = await collectChangedSecurityCandidates(selected, rootDir, 300);
        filesToScan = changed.files.map((file) => file.absolutePath);
        changedFiles = changed.changed;
        skippedFiles = changed.skipped;
        scanComplete = changed.complete;
        incompleteReasons = changed.incomplete_reasons;
        sourceCounts = changed.source_counts;
      } else {
        const { tree, files } = await buildTree(rootDir, 4, 500);
        filesToScan = files.filter((f) => {
          const ext = path.extname(f).toLowerCase();
          return [".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".py", ".json", ".env", ".sh", ".yml", ".yaml"].includes(ext);
        });
        if (tree.length >= 500) incompleteReasons.push("workspace_tree_limit_reached");
        if (filesToScan.length > 300) incompleteReasons.push("scan_file_limit_reached");
        scanComplete = incompleteReasons.length === 0;
      }

      const hits = [];
      let scannedFiles = 0;
      for (const fp of filesToScan.slice(0, 300)) {
        let content;
        try {
          content = await readFile(fp, "utf8");
          scannedFiles++;
        } catch {
          skippedFiles.push({
            workspace_id: selected.workspace.id,
            path: toWorkspaceRel(selected.workspace, fp),
            reason: "read_failed"
          });
          incompleteReasons.push("file_read_failed");
          scanComplete = false;
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          for (const pat of SECRET_PATTERNS) {
            if (pat.re.test(lines[i])) {
              hits.push({
                workspace_id: selected.workspace.id,
                path: toWorkspaceRel(selected.workspace, fp),
                line: i + 1,
                pattern: pat.name
              });
              break;
            }
          }
          if (hits.length >= 100) break;
        }
        if (hits.length >= 100) break;
      }

      if (hits.length >= 100 && scannedFiles < Math.min(filesToScan.length, 300)) {
        incompleteReasons.push("finding_limit_reached");
        scanComplete = false;
      }
      const verdict = hits.length > 0 ? "FAIL" : scanComplete ? "PASS" : "INCOMPLETE";
      return jsonResult({
        workspace_id: selected.workspace.id,
        ok: verdict === "PASS",
        verdict,
        complete: scanComplete,
        changed_only,
        scanned_files: scannedFiles,
        candidate_files: filesToScan.length,
        ...(changed_only
          ? {
              changed_files_count: changedFiles.length,
              changed_files: changedFiles,
              source_counts: sourceCounts
            }
          : {}),
        skipped_files_count: skippedFiles.length,
        skipped_files: skippedFiles.slice(0, 100),
        incomplete_reasons: dedupe(incompleteReasons),
        hits_count: hits.length,
        hits
      });
    }
  );

  reg(
    mcp,
    "todo_scan",
    {
      title: "TODO scan",
      description: "Find all TODO/FIXME/HACK/XXX comments in the workspace. Returns file:line locations.",
      inputSchema: {
        path: z.string().optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional()
      }
    },
    async ({ path: rel = ".", workspace_id, task_token, limit = 200 }) => {
      const selected = await resolveWorkspacePath(rel, { workspaceId: workspace_id, taskToken: task_token });
      const start = selected.path;
      const formatPath = (absolute) => toWorkspaceRel(selected.workspace, absolute);
      let matches;
      if (RG_BIN) {
        matches = await ripgrepGrep(start, "TODO|FIXME|HACK|XXX", { regex: true, limit, glob: null, formatPath });
      }
      if (!matches) {
        matches = await searchTree(start, "TODO|FIXME|HACK|XXX", { regex: true, limit, glob: null, formatPath });
      }
      const categorized = (matches || []).map((m) => {
        const kind = m.text.match(/\b(TODO|FIXME|HACK|XXX)\b/i)?.[1]?.toUpperCase() || "TODO";
        return { workspace_id: selected.workspace.id, ...m, kind };
      });
      return jsonResult({ workspace_id: selected.workspace.id, count: categorized.length, items: categorized });
    }
  );

}
