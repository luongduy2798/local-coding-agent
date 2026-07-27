// Local Coding Agent ChatGPT companion widget integration
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { z } from "zod";

export const WIDGET_URI = "ui://widget/lca-compact-input-v2.html";

const QUICK_ACTIONS = [{
  name: "plan",
  type: "mode",
  command: "/plan",
  label: "Plan mode",
  description: "Inspect context and propose a plan first. Do not edit files until the user approves."
}];

export function registerWidgetIntegration(mcp, {
  widgetPath,
  reg,
  currentTask,
  selectWorkspace
}) {
  mcp.registerResource("lca-companion-widget", WIDGET_URI, {}, async () => ({
    contents: [{
      uri: WIDGET_URI,
      mimeType: "text/html;profile=mcp-app",
      text: await readFile(widgetPath, "utf8"),
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] }
        },
        "openai/widgetDescription": "Compact LCA input composer for PiP with task-aware context and workflow shortcuts.",
        "openai/widgetPrefersBorder": true,
        "openai/widgetCSP": { connect_domains: [], resource_domains: [] }
      }
    }]
  }));

  reg(
    mcp,
    "lca_input",
    {
      title: "Open task composer widget",
      description: "Open the Apps SDK task composer for explicit widget, composer, PiP, @ context or / workflow requests.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        initial_input: z.string().optional().describe("Optional text to prefill in the companion composer.")
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] },
        "openai/outputTemplate": WIDGET_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Opening LCA input…",
        "openai/toolInvocation/invoked": "LCA input ready."
      }
    },
    async ({ initial_input = "" }) => {
      const task = await currentTask({ required: false });
      const selected = await selectWorkspace({
        workspaceId: task?.primary_workspace_id,
        requireTask: false
      });
      const payload = {
        initial_input,
        workspace: { workspace_id: selected.workspace.id, path: "." },
        task_id: task?.id || null,
        workspace_set_version: task?.version || null,
        context_revision: selected.runtime.graph.generation,
        shortcuts: QUICK_ACTIONS
      };
      return {
        structuredContent: payload,
        content: [{
          type: "text",
          text: "LCA input is ready. Use @ for context, / for workflows, or the Plan quick action."
        }]
      };
    }
  );
}
