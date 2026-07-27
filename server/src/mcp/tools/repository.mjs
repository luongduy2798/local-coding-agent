// Local Coding Agent MCP repository snapshot tools
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";
import { z } from "zod";

export function registerRepositoryTools(mcp, dependencies) {
  const {
    AGENT_POLICY,
    ALLOWED_ORIGINS,
    AUTH_TOKEN,
    CATALOG_VERSION,
    MODE,
    PRODUCT_TIER,
    RG_BIN,
    SEARCH_OUTPUT_DEFAULT,
    VERSION,
    buildTreeFast,
    collectImportantFiles,
    compactGitStatus,
    compactWorkspaceSnapshotForBudget,
    detectProjectProfile,
    focusedWorkspaceEvidence,
    isoNow,
    jsonResult,
    modelSafeGraphSnapshot,
    qualifyGitStatus,
    recommendNextActions,
    recommendedReads,
    reg,
    resolveWorkspacePath,
    sanitizeGraphSnapshot,
    toWorkspaceRel
  } = dependencies;

  reg(
    mcp,
    "workspace_snapshot",
    {
      title: "Workspace snapshot Pro",
      description: "Bounded workspace tree, profile, Git state and optional focused evidence.",
      inputSchema: {
        path: z.string().optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        depth: z.number().int().min(1).max(5).optional(),
        max_entries: z.number().int().min(20).max(1200).optional(),
        include_symbols: z.boolean().optional(),
        focus: z.string().optional(),
        include_matches: z.boolean().optional(),
        include_snippets: z.boolean().optional(),
        max_output_chars: z.number().int().min(2000).max(100000).optional(),
        refresh: z.boolean().optional()
      }
    },
    async ({
      path: rel = ".",
      workspace_id,
      task_token,
      depth = 3,
      max_entries = 180,
      include_symbols = false,
      focus,
      include_matches = Boolean(focus),
      include_snippets = true,
      max_output_chars = SEARCH_OUTPUT_DEFAULT,
      refresh = false
    }) => {
      const selected = await resolveWorkspacePath(rel, { workspaceId: workspace_id, taskToken: task_token });
      const rootDir = selected.path;
      const graphSnapshot = sanitizeGraphSnapshot(refresh || !selected.runtime.graph.coverage
        ? await selected.runtime.graph.refresh({ maxFiles: Math.max(max_entries * 20, 4_000), maxDepth: Math.max(depth, 4) })
        : selected.runtime.graph.snapshot());
      const [profile, treeResult, importantFiles, git] = await Promise.all([
        detectProjectProfile(rootDir).catch(() => ({ languages: [], frameworks: [], packageManagers: [], manifests: [], scripts: {} })),
        buildTreeFast(rootDir, depth, max_entries),
        collectImportantFiles(rootDir).catch(() => []),
        compactGitStatus(rootDir)
      ]);
      const formatPath = (absolute) => toWorkspaceRel(selected.workspace, absolute);
      const normalizedImportantFiles = importantFiles.map((item) => ({
        ...item,
        path: path.isAbsolute(item.path) ? formatPath(item.path) : item.path
      }));
      const tree = {
        depth,
        engine: treeResult.engine || "scan",
        dirs: treeResult.dirs.length,
        files: treeResult.files.length,
        truncated: treeResult.tree.length >= max_entries,
        entries: treeResult.tree.map((entry) => formatPath(String(entry).endsWith(path.sep) ? String(entry).slice(0, -1) : entry))
      };
      const next = recommendNextActions({ profile, git, truncated: tree.truncated });
      const evidence = focus && include_matches
        ? await focusedWorkspaceEvidence(selected.runtime.query, focus, { refresh, limit: 40 })
        : null;

      const payload = {
        kind: "workspace_snapshot",
        workspace_id: selected.workspace.id,
        pro: true,
        version: VERSION,
        tier: PRODUCT_TIER,
        ts: isoNow(),
        root: { workspace_id: selected.workspace.id, path: formatPath(rootDir) },
        roots: [{ workspace_id: selected.workspace.id, path: "." }],
        mode: MODE,
        policy: AGENT_POLICY,
        tool_catalog: "fixed",
        catalog_version: CATALOG_VERSION,
        auth: AUTH_TOKEN ? "bearer" : "none",
        safety: {
          file_tools_root_confined: true,
          command_cwd_root_confined: true,
          command_os_sandbox: false,
          browser_origin_mcp_default: ALLOWED_ORIGINS.size ? "allowlist" : "blocked"
        },
        profile: {
          languages: profile.languages || [],
          frameworks: profile.frameworks || [],
          packageManagers: profile.packageManagers || [],
          manifests: (profile.manifests || []).map((manifest) => ({
            workspace_id: selected.workspace.id,
            path: manifest
          })),
          scripts: profile.scripts || {}
        },
        git: qualifyGitStatus(selected.workspace, git),
        tree: {
          depth: tree.depth || depth,
          engine: tree.engine || "scan",
          dirs: tree.dirs || 0,
          files: tree.files || 0,
          truncated: Boolean(tree.truncated),
          entries: (tree.entries || []).slice(0, max_entries).map((entry) => ({ workspace_id: selected.workspace.id, path: entry }))
        },
        important_files: normalizedImportantFiles.slice(0, 40).map((item) => ({
          workspace_id: selected.workspace.id,
          ...item
        })),
        symbols: include_symbols
          ? selected.runtime.graph.getRecords().flatMap((record) =>
              record.symbols.map((symbol) => ({
                workspace_id: selected.workspace.id,
                path: record.path,
                line: symbol.line,
                kind: symbol.kind,
                name: symbol.name
              }))
            ).slice(0, 40)
          : undefined,
        evidence: evidence || undefined,
        graph: graphSnapshot,
        ripgrep: { available: Boolean(RG_BIN), bin: RG_BIN || null },
        cache: { hit: !refresh, generation: graphSnapshot.generation, freshness: graphSnapshot.freshness },
        recommended_reads: recommendedReads({
          importantFiles: normalizedImportantFiles,
          treeEntries: tree.entries || []
        }).map((item) => ({ workspace_id: selected.workspace.id, ...item })),
        workflow_hints: [
          "Use read_many for recommended_reads or multiple targeted files.",
          "Use search_text with context before reading many files.",
          "Use code_query for symbol and reference navigation.",
          "Use review_diff for a fast local heuristic review.",
          "Run tests/build/lint only when explicitly requested."
        ],
        next_best_actions: next
      };
      return jsonResult(compactWorkspaceSnapshotForBudget(payload, max_output_chars));
    }
  );

  reg(
    mcp,
    "project_profile",
    {
      title: "Project profile",
      description: "Detect languages, frameworks, package managers, and scripts in the workspace. Reads root manifests (package.json, pubspec.yaml, go.mod, Cargo.toml, etc.). Results are cached for 5 min.",
      inputSchema: {
        path: z.string().optional().describe("Root dir to inspect (default: primary root)."),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        refresh: z.boolean().optional().describe("Force re-scan even if cache is fresh.")
      }
    },
    async ({ path: rel = ".", workspace_id, task_token, refresh = false }) => {
      const selected = await resolveWorkspacePath(rel, { workspaceId: workspace_id, taskToken: task_token });
      const rootDir = selected.path;
      if (refresh || !selected.runtime.graph.coverage) await selected.runtime.graph.refresh();
      const profile = await detectProjectProfile(rootDir);
      return jsonResult({
        workspace_id: selected.workspace.id,
        root: { workspace_id: selected.workspace.id, path: toWorkspaceRel(selected.workspace, rootDir) },
        languages: profile.languages || [],
        frameworks: profile.frameworks || [],
        packageManagers: profile.packageManagers || [],
        scripts: profile.scripts || {},
        manifests: (profile.manifests || []).map((manifest) => ({
          workspace_id: selected.workspace.id,
          path: manifest
        })),
        cached: !refresh,
        graph: modelSafeGraphSnapshot(selected.runtime.graph)
      });
    }
  );




}
