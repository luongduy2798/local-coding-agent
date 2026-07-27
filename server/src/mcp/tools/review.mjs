// Local Coding Agent MCP review and security tools
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

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
      description: "Review staged, unstaged and untracked changes across the active task. Incomplete evidence never returns CLEAN or PASS.",
      inputSchema: {
        staged: z.boolean().optional().describe("Compatibility hint from V4; V5 still inventories and reviews all three change sources."),
        cwd: z.string().optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        cursor: z.string().max(500).optional().describe("Opaque cursor returned by a prior review_diff page."),
        page_size: z.number().int().min(1).max(REVIEW_PAGE_SIZE_MAX).optional()
      }
    },
    async ({ staged = false, cwd = ".", workspace_id, task_token, cursor, page_size = REVIEW_PAGE_SIZE_DEFAULT }) => {
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
      const workspaceResults = [];
      for (const workspaceId of workspaceIds) {
        workspaceResults.push(await reviewWorkspaceDiff({
          workspaceId,
          taskToken: task_token,
          taskId: routedTask?.id || null,
          cwd
        }));
      }

      const inventoryItems = workspaceResults.flatMap((result) => result._inventory_items);
      const failedPaths = workspaceResults.flatMap((result) => result._failed_paths);
      const summaryFiles = workspaceResults.flatMap((result) => result._summary_files);
      const findings = workspaceResults.flatMap((result) => result._findings);
      const evidenceRevision = createHash("sha256")
        .update(JSON.stringify({
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
        ...(workspaceIds.length === 1 ? { workspace_id: workspaceIds[0] } : {}),
        ok: verdict !== "BLOCK" && verdict !== "INCOMPLETE" && !unmanaged,
        verdict,
        complete,
        requested_view: staged ? "staged" : "all",
        analyzed_sources: [...REVIEW_SOURCES],
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
      return jsonResult(payload);
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
