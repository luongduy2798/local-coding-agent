// Local Coding Agent verification planner
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { realpath } from "node:fs/promises";
import path from "node:path";
import { WorkspaceGraph } from "../workspace/graph/workspace-graph.mjs";
import {
  DEFAULT_GATES,
  augmentPackageDependencies,
  boundedInteger,
  defaultExecute,
  discoverPackages,
  evaluateGates,
  expandAffectedDependents,
  findResult,
  gateId,
  gateReason,
  isVerificationRelevant,
  normalizeGitPrefix,
  normalizeRequestedGates,
  normalizeResult,
  normalizeWorkspacePath,
  qualifiedLocation,
  relativizeGitEntry,
  selectAffectedPackages,
  targetedTestSelectionFor,
  verificationChangeLocations
} from "./planner-helpers.mjs";
const DEFAULT_MAX_TARGETED_TEST_FILES = 64;
const DEFAULT_MAX_TARGETED_COMMAND_LENGTH = 8_192;

export class VerificationPlanner {
  constructor({
    rootDir,
    workspaceId,
    graph,
    execute = defaultExecute,
    maxFiles = 25_000,
    maxDepth = 24,
    maxTargetedTestFiles = DEFAULT_MAX_TARGETED_TEST_FILES,
    maxTargetedCommandLength = DEFAULT_MAX_TARGETED_COMMAND_LENGTH
  } = {}) {
    if (!rootDir && !graph?.requestedRoot && !graph?.rootDir) {
      throw new TypeError("VerificationPlanner requires rootDir or graph.");
    }
    this.requestedRoot = path.resolve(String(rootDir || graph.rootDir || graph.requestedRoot));
    this.rootDir = graph?.rootDir || null;
    this.workspaceId = workspaceId || graph?.workspaceId;
    this.graph = graph || new WorkspaceGraph({
      rootDir: this.requestedRoot,
      workspaceId,
      maxFiles,
      maxDepth
    });
    this.workspaceId ||= this.graph.workspaceId;
    this.execute = execute;
    this.maxFiles = maxFiles;
    this.maxDepth = maxDepth;
    this.maxTargetedTestFiles = boundedInteger(maxTargetedTestFiles, DEFAULT_MAX_TARGETED_TEST_FILES, 1, 5_000);
    this.maxTargetedCommandLength = boundedInteger(
      maxTargetedCommandLength,
      DEFAULT_MAX_TARGETED_COMMAND_LENGTH,
      256,
      128 * 1024
    );
  }

  async initialize() {
    this.rootDir ||= await realpath(this.requestedRoot);
    return this.rootDir;
  }

  async inspectChanges({ baseHead = null, requireBaseline = false } = {}) {
    const rootDir = await this.initialize();
    const gitRootResult = await this.execute("git", ["rev-parse", "--show-toplevel"], rootDir);
    if (gitRootResult.exit_code !== 0) {
      return {
        workspace_id: this.workspaceId,
        is_git_repo: false,
        git_root: null,
        git_root_scope: null,
        head: null,
        branch: null,
        baseline_head: baseHead || null,
        baseline_unknown: requireBaseline,
        head_changed: false,
        clean: null,
        dirty_unknown: true,
        files: [],
        staged: [],
        unstaged: [],
        untracked: [],
        summary: { changed_files: 0, staged: 0, unstaged: 0, untracked: 0 },
        error: "Git repository unavailable."
      };
    }

    const gitRoot = String(gitRootResult.stdout || "").trim();
    const workspacePrefix = normalizeGitPrefix(path.relative(gitRoot, rootDir));
    const normalizedBaseHead = typeof baseHead === "string" && /^[a-f0-9]{40,64}$/i.test(baseHead)
      ? baseHead
      : null;
    const [statusResult, headResult, branchResult, baselineResult] = await Promise.all([
      this.execute("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], rootDir),
      this.execute("git", ["rev-parse", "HEAD"], rootDir),
      this.execute("git", ["branch", "--show-current"], rootDir),
      normalizedBaseHead
        ? this.execute("git", ["diff", "--name-status", "-z", "--find-renames", normalizedBaseHead, "--", "."], rootDir)
        : Promise.resolve(null)
    ]);
    if (
      statusResult.exit_code !== 0 ||
      statusResult.timed_out === true ||
      statusResult.stdout_truncated === true
    ) {
      const error = new Error("Could not inspect Git changes.");
      error.code = "GIT_STATUS_FAILED";
      throw error;
    }
    const baselineUnknown = requireBaseline && !normalizedBaseHead;
    if (
      baselineResult && (
        baselineResult.exit_code !== 0 ||
        baselineResult.timed_out === true ||
        baselineResult.stdout_truncated === true
      )
    ) {
      const error = new Error("Could not inspect changes since the task baseline.");
      error.code = "GIT_BASELINE_DIFF_FAILED";
      throw error;
    }
    const statusFiles = parsePorcelainZ(statusResult.stdout)
      .map((entry) => relativizeGitEntry(entry, workspacePrefix))
      .filter(Boolean)
      .map((entry) => {
        const { path: entryPath, original_path: originalPath, ...status } = entry;
        return {
          ...status,
          location: qualifiedLocation(this.workspaceId, entryPath),
          original_location: originalPath
            ? qualifiedLocation(this.workspaceId, originalPath)
            : null
        };
      });
    const filesByPath = new Map(statusFiles.map((entry) => [entry.location.path, entry]));
    const committed = [];
    if (baselineResult) {
      for (const entry of parseNameStatusZ(baselineResult.stdout)) {
        const relative = relativizeGitEntry(entry, workspacePrefix);
        if (!relative) continue;
        const existing = filesByPath.get(relative.path);
        const merged = {
          index_status: existing?.index_status || " ",
          worktree_status: existing?.worktree_status || " ",
          staged: existing?.staged === true,
          unstaged: existing?.unstaged === true,
          untracked: existing?.untracked === true,
          ignored: existing?.ignored === true,
          renamed: existing?.renamed === true || relative.renamed === true,
          copied: existing?.copied === true || relative.copied === true,
          deleted: existing?.deleted === true || relative.deleted === true,
          ...existing,
          committed: true,
          baseline_status: relative.baseline_status,
          location: qualifiedLocation(this.workspaceId, relative.path),
          original_location: relative.original_path
            ? qualifiedLocation(this.workspaceId, relative.original_path)
            : existing?.original_location || null
        };
        filesByPath.set(relative.path, merged);
        committed.push(merged.location);
      }
    }
    const files = [...filesByPath.values()].sort((left, right) =>
      left.location.path.localeCompare(right.location.path)
    );
    const staged = files.filter((entry) => entry.staged).map((entry) => entry.location);
    const unstaged = files.filter((entry) => entry.unstaged).map((entry) => entry.location);
    const untracked = files.filter((entry) => entry.untracked).map((entry) => entry.location);
    const head = headResult.exit_code === 0 && headResult.timed_out !== true
      ? String(headResult.stdout).trim() || null
      : null;
    const headChanged = Boolean(normalizedBaseHead && head && normalizedBaseHead !== head);
    return {
      workspace_id: this.workspaceId,
      is_git_repo: true,
      git_root: workspacePrefix ? null : { workspace_id: this.workspaceId, path: "." },
      git_root_scope: workspacePrefix ? "ancestor" : "workspace",
      head,
      branch: branchResult.exit_code === 0 ? String(branchResult.stdout).trim() || null : null,
      baseline_head: normalizedBaseHead,
      baseline_unknown: baselineUnknown,
      head_changed: headChanged,
      clean: files.length === 0,
      worktree_clean: statusFiles.length === 0,
      dirty_unknown: baselineUnknown || (requireBaseline && !head),
      files,
      staged,
      unstaged,
      untracked,
      committed,
      summary: {
        changed_files: files.length,
        staged: staged.length,
        unstaged: unstaged.length,
        untracked: untracked.length,
        committed: committed.length,
        head_changed: headChanged
      }
    };
  }

  async plan({
    include = DEFAULT_GATES,
    results = {},
    unmanaged_changes = false,
    unmanaged_state_unknown = false,
    transaction_in_doubt = false,
    refresh = true,
    base_head = null,
    require_baseline = false
  } = {}) {
    const requestedGates = normalizeRequestedGates(include);
    const changes = await this.inspectChanges({ baseHead: base_head, requireBaseline: require_baseline });
    if (refresh || !this.graph.coverage) {
      await this.graph.ensureFresh({
        force: Boolean(refresh),
        maxFiles: this.maxFiles,
        maxDepth: this.maxDepth
      });
    }
    const packages = augmentPackageDependencies(
      discoverPackages(this.graph.getRecords()),
      this.graph.dependencyGraph()
    );
    const relevantChanges = verificationChangeLocations(changes.files)
      .filter((entry) => isVerificationRelevant(entry.location.path));
    let affectedPackages = expandAffectedDependents(
      packages,
      selectAffectedPackages(packages, relevantChanges)
    );
    if (changes.head_changed && relevantChanges.length === 0) {
      affectedPackages = packages.length
        ? packages.map((pkg) => ({
            ...pkg,
            affected_files: [],
            impact_reason: "baseline_head_changed"
          }))
        : [{
            cwd: ".",
            ecosystem: "unknown",
            manifest: null,
            commands: {},
            affected_files: [],
            impact_reason: "baseline_head_changed"
          }];
    }
    if (relevantChanges.length && !affectedPackages.length) {
      affectedPackages.push({
        cwd: ".",
        ecosystem: "unknown",
        manifest: null,
        commands: {},
        affected_files: relevantChanges.map((entry) => entry.location)
      });
    }

    const gates = [];
    for (const pkg of affectedPackages) {
      const impact = this.graph.impactedTests(
        pkg.affected_files.map((location) => location.path),
        { packageCwds: [pkg.cwd] }
      );
      for (const kind of requestedGates) {
        const fullCommand = pkg.commands[kind] || null;
        const targetedSelection = kind === "test"
          ? targetedTestSelectionFor(pkg, impact, {
              maxFiles: this.maxTargetedTestFiles,
              maxCommandLength: this.maxTargetedCommandLength
            })
          : { command: null, fallbackReason: null };
        const targetedTestCommand = targetedSelection.command;
        const detectedCommand = targetedTestCommand || fullCommand;
        const id = gateId(this.workspaceId, pkg, kind);
        const supplied = findResult(results, id, kind, pkg.cwd);
        const normalizedResult = normalizeResult(supplied);
        let status = detectedCommand ? "pending" : "missing";
        let command = detectedCommand;
        if (normalizedResult) {
          if (!detectedCommand && normalizedResult.status === "pass" && !normalizedResult.command) {
            status = "missing";
          } else {
            status = normalizedResult.status;
            command = normalizedResult.command || detectedCommand;
          }
        }
        gates.push({
          id,
          workspace_id: this.workspaceId,
          kind,
          cwd: qualifiedLocation(this.workspaceId, pkg.cwd),
          ecosystem: pkg.ecosystem,
          manifest: pkg.manifest ? qualifiedLocation(this.workspaceId, pkg.manifest) : null,
          command,
          command_scope: targetedTestCommand ? "package_impacted_tests" : "full_package",
          full_command: targetedTestCommand ? fullCommand : null,
          targeted_test_fallback_reason: targetedSelection.fallbackReason,
          required: true,
          status,
          reason: gateReason(status, kind, pkg),
          affected_files: pkg.affected_files || [],
          impact: kind === "test" ? impact : null,
          result: normalizedResult
        });
      }
    }

    const coverage = this.graph.snapshot().coverage;
    const evaluation = evaluateGates({
      changes,
      relevantChanges,
      gates,
      unmanagedChanges: Boolean(unmanaged_changes),
      unmanagedStateUnknown: Boolean(unmanaged_state_unknown),
      transactionInDoubt: Boolean(transaction_in_doubt),
      coverage
    });
    return {
      workspace_id: this.workspaceId,
      status: evaluation.status,
      reasons: evaluation.reasons,
      changes,
      unmanaged_changes: Boolean(unmanaged_changes),
      unmanaged_state_unknown: Boolean(unmanaged_state_unknown),
      transaction_in_doubt: Boolean(transaction_in_doubt),
      requested_gates: requestedGates,
      packages: affectedPackages.map((pkg) => ({
        package_id: pkg.id || `${pkg.ecosystem}:${pkg.cwd}`,
        name: pkg.name || null,
        cwd: qualifiedLocation(this.workspaceId, pkg.cwd),
        ecosystem: pkg.ecosystem,
        manifest: pkg.manifest ? qualifiedLocation(this.workspaceId, pkg.manifest) : null,
        affected_files: pkg.affected_files || [],
        impact_reason: pkg.impact_reason || "direct_change",
        dependency_source_packages: pkg.dependency_source_packages || [],
        internal_dependencies: pkg.internal_dependencies || [],
        dependents: pkg.dependents || [],
        targeted_test_support: pkg.targeted_test_support === true
      })),
      gates,
      gate_summary: evaluation.summary,
      coverage
    };
  }

  evaluate(plan, results = {}, options = {}) {
    const gates = (plan?.gates || []).map((gate) => {
      const supplied = findResult(results, gate.id, gate.kind, gate.cwd?.path || gate.cwd);
      const normalized = normalizeResult(supplied);
      if (!normalized) return gate;
      if (!gate.command && normalized.status === "pass" && !normalized.command) return gate;
      return {
        ...gate,
        command: normalized.command || gate.command,
        status: normalized.status,
        reason: gateReason(normalized.status, gate.kind, gate),
        result: normalized
      };
    });
    const relevantChanges = verificationChangeLocations(plan?.changes?.files || [])
      .filter((entry) => isVerificationRelevant(entry.location?.path || entry.path));
    const evaluation = evaluateGates({
      changes: plan.changes,
      relevantChanges,
      gates,
      unmanagedChanges: options.unmanaged_changes ?? plan.unmanaged_changes,
      unmanagedStateUnknown: options.unmanaged_state_unknown ?? plan.unmanaged_state_unknown,
      transactionInDoubt: options.transaction_in_doubt ?? plan.transaction_in_doubt,
      coverage: plan.coverage
    });
    return {
      ...plan,
      status: evaluation.status,
      reasons: evaluation.reasons,
      unmanaged_changes: Boolean(options.unmanaged_changes ?? plan.unmanaged_changes),
      unmanaged_state_unknown: Boolean(options.unmanaged_state_unknown ?? plan.unmanaged_state_unknown),
      transaction_in_doubt: Boolean(options.transaction_in_doubt ?? plan.transaction_in_doubt),
      gates,
      gate_summary: evaluation.summary
    };
  }
}

export function evaluateVerificationPlan(plan, results = {}, options = {}) {
  if (!plan?.workspace_id) throw new TypeError("A verification plan is required.");
  const planner = Object.create(VerificationPlanner.prototype);
  return planner.evaluate(plan, results, options);
}

export function parsePorcelainZ(raw) {
  const tokens = String(raw || "").split("\0");
  const output = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token.length < 3) continue;
    const indexStatus = token[0];
    const worktreeStatus = token[1];
    const code = `${indexStatus}${worktreeStatus}`;
    const filePath = normalizeWorkspacePath(token.slice(3));
    let originalPath = null;
    if (/[RC]/.test(code) && tokens[index + 1]) {
      originalPath = normalizeWorkspacePath(tokens[++index]);
    }
    const untracked = code === "??";
    const ignored = code === "!!";
    output.push({
      path: filePath,
      original_path: originalPath,
      index_status: indexStatus,
      worktree_status: worktreeStatus,
      staged: !untracked && !ignored && indexStatus !== " ",
      unstaged: !untracked && !ignored && worktreeStatus !== " ",
      untracked,
      ignored,
      deleted: indexStatus === "D" || worktreeStatus === "D",
      renamed: indexStatus === "R" || worktreeStatus === "R",
      copied: indexStatus === "C" || worktreeStatus === "C"
    });
  }
  return output.filter((entry) => !entry.ignored);
}

export function parseNameStatusZ(raw) {
  const tokens = String(raw || "").split("\0");
  const output = [];
  for (let index = 0; index < tokens.length;) {
    let statusToken = tokens[index++];
    if (!statusToken) continue;
    let filePath = null;
    const tab = statusToken.indexOf("\t");
    if (tab >= 0) {
      filePath = statusToken.slice(tab + 1);
      statusToken = statusToken.slice(0, tab);
    } else {
      filePath = tokens[index++] || null;
    }
    const kind = statusToken[0];
    if (!/^[ACDMRTUXB]$/.test(kind) || !filePath) {
      throw new Error("Git returned invalid baseline name-status output.");
    }
    let originalPath = null;
    if (kind === "R" || kind === "C") {
      originalPath = filePath;
      filePath = tokens[index++] || null;
      if (!filePath) throw new Error("Git returned an incomplete rename/copy record.");
    }
    output.push({
      path: normalizeWorkspacePath(filePath),
      original_path: originalPath ? normalizeWorkspacePath(originalPath) : null,
      baseline_status: statusToken,
      deleted: kind === "D",
      renamed: kind === "R",
      copied: kind === "C"
    });
  }
  return output;
}
