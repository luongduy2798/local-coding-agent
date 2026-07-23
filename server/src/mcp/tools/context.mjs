// Local Coding Agent MCP context tools
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export function registerContextTools(mcp, dependencies) {
  const {
    DEFAULT_RESPONSE_CHARS,
    MANIFEST_NAMES,
    MAX_BATCH_READ_CHARS,
    MAX_PAGE_OFFSET,
    MAX_READ_CHARS,
    READ_DEFAULT,
    READ_MANY_FILE_DEFAULT,
    RG_BIN,
    SEARCH_OUTPUT_DEFAULT,
    SKIP_DIRS,
    attachContext,
    buildTree,
    compareSearchMatch,
    decodePageCursor,
    dedupe,
    dedupeSearchMatches,
    findFiles,
    fitJsonItems,
    getChangeJournal,
    gitGrep,
    jsonResult,
    listEntries,
    listRepoFilesFast,
    pageMetadata,
    pageScope,
    reg,
    resolvePath,
    resolveWorkspacePath,
    ripgrepGrep,
    searchTree,
    toRel,
    toWorkspaceRel
  } = dependencies;
  reg(
    mcp,
    "list_files",
    {
      title: "List files",
      description: "List files and folders under a root (or absolute path inside a root).",
      inputSchema: {
        path: z.string().optional().describe("Directory path. Relative paths resolve against the primary root."),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        recursive: z.boolean().optional(),
        limit: z.number().int().min(1).max(2000).optional(),
        cursor: z.string().max(2048).optional(),
        max_output_chars: z.number().int().min(1000).max(200000).optional()
      }
    },
    async ({ path: rel = ".", workspace_id, task_token, recursive = false, limit = 200, cursor, max_output_chars = DEFAULT_RESPONSE_CHARS - 4_096 }) => {
      const selected = await resolveWorkspacePath(rel, { workspaceId: workspace_id, taskToken: task_token });
      const formatPath = (absolute) => toWorkspaceRel(selected.workspace, absolute);
      const scope = pageScope("list_files", {
        workspace_id: selected.workspace.id,
        path: formatPath(selected.path),
        recursive: Boolean(recursive)
      });
      const offset = decodePageCursor(cursor, { kind: "list_files", scope });
      const scanLimit = Math.min(MAX_PAGE_OFFSET + 1, offset + limit + 1);
      const entries = await listEntries(selected.path, { recursive, limit: scanLimit, formatPath });
      const page = entries.slice(offset, offset + limit);
      const fitted = fitJsonItems(page, max_output_chars);
      const hasMore = entries.length > offset + fitted.items.length || fitted.truncated;
      return jsonResult({
        workspace_id: selected.workspace.id,
        path: formatPath(selected.path),
        count: fitted.items.length,
        truncated: hasMore,
        pagination: pageMetadata({
          kind: "list_files",
          scope,
          offset,
          limit,
          returned: fitted.items.length,
          hasMore
        }),
        entries: fitted.items.map((entry) => ({ workspace_id: selected.workspace.id, ...entry }))
      });
    }
  );

  reg(
    mcp,
    "read_file",
    {
      title: "Read file",
      description: "Read one targeted UTF-8 file or range. Use read_many for several files. Avoid repeating an unchanged range; when another read is necessary after a repetition notice, provide evidence_gap describing the unresolved question.",
      inputSchema: {
        path: z.string().min(1),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        start_line: z.number().int().min(1).optional(),
        line_count: z.number().int().min(1).max(20000).optional(),
        max_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional(),
        known_version: z.string().optional(),
        skip_if_unchanged: z.boolean().optional(),
        evidence_gap: z.string().max(1000).optional().describe("Concrete unresolved question that justifies another similar evidence request.")
      }
    },
    async ({ path: rel, workspace_id, task_token, start_line, line_count, max_chars = READ_DEFAULT, known_version, skip_if_unchanged = false }) => {
      const selected = await resolveWorkspacePath(rel, { workspaceId: workspace_id, taskToken: task_token });
      const filePath = selected.path;
      const outputPath = toWorkspaceRel(selected.workspace, filePath);
      const buffer = await readFile(filePath);
      const journal = await getChangeJournal(selected.workspace.id);
      const version = journal.rememberRead(filePath, buffer);
      if (known_version && known_version === version && skip_if_unchanged) {
        return jsonResult({ workspace_id: selected.workspace.id, path: outputPath, version, unchanged: true, content_omitted: true });
      }
      const content = buffer.toString("utf8");
      const allLines = content.split(/\r?\n/);
      if (start_line || line_count) {
        const from = (start_line || 1) - 1;
        const to = line_count ? from + line_count : allLines.length;
        const slice = allLines.slice(from, to).join("\n");
        return jsonResult({
          workspace_id: selected.workspace.id,
          path: outputPath,
          version,
          total_lines: allLines.length,
          start_line: from + 1,
          returned_lines: Math.max(0, Math.min(to, allLines.length) - from),
          chars: slice.length,
          returned_chars: Math.min(slice.length, max_chars),
          content: slice.length > max_chars ? slice.slice(0, max_chars) : slice,
          truncated: slice.length > max_chars
        });
      }
      const truncated = content.length > max_chars;
      return jsonResult({
        workspace_id: selected.workspace.id,
        path: outputPath,
        version,
        total_lines: allLines.length,
        chars: content.length,
        returned_chars: Math.min(content.length, max_chars),
        truncated,
        content: truncated ? content.slice(0, max_chars) : content
      });
    }
  );


  reg(
    mcp,
    "search_text",
    {
      title: "Search text",
      description: "Search text with ripgrep, git or scan fallback. Prefer one focused query with context; avoid repeating an unchanged query unless evidence_gap states what new question remains.",
      inputSchema: {
        query: z.string().min(1),
        patterns: z.array(z.string().min(1)).max(16).optional().describe("Additional patterns searched in the same ripgrep process."),
        path: z.string().optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        regex: z.boolean().optional(),
        glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts".'),
        context: z.number().int().min(0).max(10).optional().describe("Lines of context before/after each match."),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().max(2048).optional(),
        max_output_chars: z.number().int().min(1000).max(200000).optional().describe(`Approximate JSON budget for matches (default ${SEARCH_OUTPUT_DEFAULT}).`),
        evidence_gap: z.string().max(1000).optional().describe("Concrete unresolved question that justifies another similar evidence request.")
      }
    },
    async ({ query, patterns = [], path: rel = ".", workspace_id, task_token, regex = false, glob, context = 0, limit = 100, cursor, max_output_chars = SEARCH_OUTPUT_DEFAULT }, extra) => {
      const selected = await resolveWorkspacePath(rel, { workspaceId: workspace_id, taskToken: task_token });
      const start = selected.path;
      const formatPath = (absolute) => toWorkspaceRel(selected.workspace, absolute);
      const searchPatterns = dedupe([query, ...patterns].map((value) => String(value).trim()).filter(Boolean));
      const scope = pageScope("search_text", {
        workspace_id: selected.workspace.id,
        path: formatPath(start),
        patterns: searchPatterns,
        regex: Boolean(regex),
        glob: glob || null,
        context
      });
      const offset = decodePageCursor(cursor, { kind: "search_text", scope });
      const scanLimit = Math.min(MAX_PAGE_OFFSET + 1, offset + limit + 1);
      // Tolerate a broken regex: fall back to a literal substring search instead
      // of erroring out.
      let useRegex = regex;
      let regexFallback = false;
      if (regex) {
        try {
          for (const pattern of searchPatterns) new RegExp(pattern);
        } catch {
          useRegex = false;
          regexFallback = true;
        }
      }
      let engine = "scan";
      let matches = null;
      const info = await stat(start).catch(() => null);
      const isDir = info && info.isDirectory();
      if (isDir && RG_BIN) {
        matches = await ripgrepGrep(start, searchPatterns, {
          regex: useRegex,
          limit: scanLimit,
          glob,
          formatPath,
          signal: extra?.signal
        });
        if (matches) engine = "ripgrep";
      }
      if (matches === null && isDir) {
        matches = await gitGrep(start, searchPatterns, { regex: useRegex, limit: scanLimit, glob, formatPath });
        if (matches) engine = "git";
      }
      if (matches === null) {
        const batches = [];
        for (const pattern of searchPatterns) {
          batches.push(...await searchTree(start, pattern, {
            regex: useRegex,
            limit: Math.max(1, scanLimit - batches.length),
            glob,
            formatPath
          }));
          if (batches.length >= scanLimit) break;
        }
        matches = dedupeSearchMatches(batches).slice(0, scanLimit);
      }
      matches.sort(compareSearchMatch);
      const page = matches.slice(offset, offset + limit);
      if (context > 0 && page.length) await attachContext(page, context, selected.root);
      const qualified = page.map((match) => ({ workspace_id: selected.workspace.id, ...match }));
      const limited = fitJsonItems(qualified, max_output_chars);
      const hasMore = matches.length > offset + limited.items.length || limited.truncated;
      return jsonResult({
        query,
        patterns: searchPatterns,
        workspace_id: selected.workspace.id,
        regex: useRegex,
        regex_fallback: regexFallback,
        engine,
        context,
        count: limited.items.length,
        returned: limited.items.length,
        truncated: hasMore,
        output_chars: limited.chars,
        pagination: pageMetadata({
          kind: "search_text",
          scope,
          offset,
          limit,
          returned: limited.items.length,
          hasMore
        }),
        matches: limited.items
      });
    }
  );

  reg(
    mcp,
    "find_files",
    {
      title: "Find files",
      description: "List file paths matching a name glob (ripgrep > git ls-files > scan). Fast way to locate files (e.g. glob \"*.config.ts\") instead of listing directories one by one.",
      inputSchema: {
        glob: z.string().min(1).describe('Name glob, e.g. "*.ts" or "**/Dockerfile".'),
        path: z.string().optional().describe("Directory to search under."),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        limit: z.number().int().min(1).max(2000).optional(),
        cursor: z.string().max(2048).optional(),
        max_output_chars: z.number().int().min(1000).max(200000).optional().describe(`Approximate JSON budget for paths (default ${SEARCH_OUTPUT_DEFAULT}).`)
      }
    },
    async ({ glob, path: rel = ".", workspace_id, task_token, limit = 300, cursor, max_output_chars = SEARCH_OUTPUT_DEFAULT }) => {
      const selected = await resolveWorkspacePath(rel, { workspaceId: workspace_id, taskToken: task_token });
      const formatPath = (absolute) => toWorkspaceRel(selected.workspace, absolute);
      const scope = pageScope("find_files", {
        workspace_id: selected.workspace.id,
        path: formatPath(selected.path),
        glob
      });
      const offset = decodePageCursor(cursor, { kind: "find_files", scope });
      const scanLimit = Math.min(MAX_PAGE_OFFSET + 1, offset + limit + 1);
      const { files, engine } = await findFiles(selected.path, glob, scanLimit, formatPath);
      files.sort((left, right) => String(left).localeCompare(String(right)));
      const page = files.slice(offset, offset + limit);
      const limited = fitJsonItems(page, max_output_chars);
      const hasMore = files.length > offset + limited.items.length || limited.truncated;
      return jsonResult({
        workspace_id: selected.workspace.id,
        glob,
        engine,
        count: limited.items.length,
        returned: limited.items.length,
        truncated: hasMore,
        pagination: pageMetadata({
          kind: "find_files",
          scope,
          offset,
          limit,
          returned: limited.items.length,
          hasMore
        }),
        files: limited.items.map((file) => ({ workspace_id: selected.workspace.id, path: file }))
      });
    }
  );

  reg(
    mcp,
    "read_many",
    {
      title: "Read many files",
      description: "Read up to 100 targeted files or line ranges concurrently. Avoid rereading the same unchanged requests; use evidence_gap when a repeated batch is needed for a specific unresolved question.",
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(100).optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        requests: z.array(z.object({
          path: z.string().min(1),
          workspace_id: z.string().optional(),
          start_line: z.number().int().min(1).optional(),
          line_count: z.number().int().min(1).max(10000).optional(),
          max_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional(),
          known_version: z.string().optional(),
          skip_if_unchanged: z.boolean().optional()
        })).min(1).max(100).optional(),
        max_chars_per_file: z.number().int().min(1).max(MAX_READ_CHARS).optional(),
        max_total_chars: z.number().int().min(1000).max(MAX_BATCH_READ_CHARS).optional(),
        concurrency: z.number().int().min(1).max(16).optional(),
        evidence_gap: z.string().max(1000).optional().describe("Concrete unresolved question that justifies another similar evidence request.")
      }
    },
    async ({ paths, requests, workspace_id, task_token, max_chars_per_file = READ_MANY_FILE_DEFAULT, max_total_chars = MAX_BATCH_READ_CHARS, concurrency = 8 }) => {
      if (paths?.length && requests?.length) throw new Error("Use either paths or requests, not both.");
      const items = requests?.length ? requests : (paths || []).map((p) => ({ path: p }));
      if (!items.length) throw new Error("Provide at least one path or read request.");

      const files = new Array(items.length);
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const index = cursor++;
          if (index >= items.length) return;
          const request = items[index];
          try {
            const selected = await resolveWorkspacePath(request.path, {
              workspaceId: request.workspace_id || workspace_id,
              taskToken: task_token
            });
            const fp = selected.path;
            const outputPath = toWorkspaceRel(selected.workspace, fp);
            const buffer = await readFile(fp);
            const journal = await getChangeJournal(selected.workspace.id);
            const version = journal.rememberRead(fp, buffer);
            if (request.known_version && request.known_version === version && request.skip_if_unchanged === true) {
              files[index] = { workspace_id: selected.workspace.id, path: outputPath, version, unchanged: true, content_omitted: true };
              continue;
            }
            const content = buffer.toString("utf8");
            const maxChars = request.max_chars || max_chars_per_file;
            if (request.start_line || request.line_count) {
              const lines = content.split(/\r?\n/);
              const start = request.start_line || 1;
              const count = request.line_count || lines.length;
              const selectedLines = lines.slice(start - 1, start - 1 + count).join("\n");
              files[index] = {
                workspace_id: selected.workspace.id,
                path: outputPath,
                version,
                total_lines: lines.length,
                start_line: start,
                returned_lines: Math.min(count, Math.max(0, lines.length - start + 1)),
                chars: selectedLines.length,
                returned_chars: Math.min(selectedLines.length, maxChars),
                truncated: selectedLines.length > maxChars,
                content: selectedLines.slice(0, maxChars)
              };
              continue;
            }
            files[index] = {
              workspace_id: selected.workspace.id,
              path: outputPath,
              version,
              chars: content.length,
              returned_chars: Math.min(content.length, maxChars),
              truncated: content.length > maxChars,
              content: content.slice(0, maxChars)
            };
          } catch (err) {
            files[index] = { path: request.path, error: String(err?.message || err) };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

      const batchLimit = Math.min(max_total_chars, MAX_BATCH_READ_CHARS);
      let remaining = batchLimit;
      let batchTruncated = false;
      for (const file of files) {
        if (typeof file.content !== "string") continue;
        if (file.content.length > remaining) {
          file.content = file.content.slice(0, Math.max(0, remaining));
          file.truncated = true;
          file.batch_truncated = true;
          batchTruncated = true;
        }
        remaining = Math.max(0, remaining - file.content.length);
      }
      return jsonResult({
        count: files.length,
        failed: files.filter((f) => f.error).length,
        chars_returned: batchLimit - remaining,
        max_batch_chars: batchLimit,
        batch_truncated: batchTruncated,
        files
      });
    }
  );

}
