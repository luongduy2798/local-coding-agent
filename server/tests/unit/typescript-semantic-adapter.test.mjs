// Local Coding Agent runtime project-local TypeScript semantic adapter tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CodeQueryEngine } from "../../src/coding/query-engine.mjs";
import {
  discoverTypeScriptSemanticAdapter,
  TypeScriptSemanticAdapterError
} from "../../src/coding/semantic/typescript-adapter.mjs";
import { WorkspaceGraph } from "../../src/workspace/graph/workspace-graph.mjs";
import {
  createIsolatedTestRoot,
  safeRemove
} from "../helpers/test-guard.mjs";

test("TypeScript semantic discovery uses only a project-local compiler", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-ts-discovery-",
    protectedPaths: [path.resolve("..")]
  });
  try {
    assert.equal(await discoverTypeScriptSemanticAdapter({ rootDir: context.fixtureDir }), null);

    const packageRoot = path.join(context.fixtureDir, "node_modules", "typescript");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(context.dataDir, "escaped.cjs"), "module.exports = {};\n", "utf8");
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "typescript",
      version: "0.0.0-escape-test",
      main: "../../../data/escaped.cjs"
    }), "utf8");

    await assert.rejects(
      discoverTypeScriptSemanticAdapter({ rootDir: context.fixtureDir }),
      (error) => error instanceof TypeScriptSemanticAdapterError &&
        error.code === "TYPESCRIPT_ENTRY_OUTSIDE_PACKAGE"
    );

    await safeRemove(packageRoot, context, { recursive: true, force: true });
    const outsidePackage = path.join(context.dataDir, "typescript");
    await mkdir(outsidePackage, { recursive: true });
    await writeFile(path.join(outsidePackage, "package.json"), JSON.stringify({
      name: "typescript",
      version: "0.0.0-link-test",
      main: "index.cjs"
    }), "utf8");
    await writeFile(path.join(outsidePackage, "index.cjs"), "module.exports = {};\n", "utf8");
    await symlink(outsidePackage, packageRoot, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      discoverTypeScriptSemanticAdapter({ rootDir: context.fixtureDir }),
      (error) => error instanceof TypeScriptSemanticAdapterError &&
        error.code === "TYPESCRIPT_PACKAGE_OUTSIDE_WORKSPACE"
    );
  } finally {
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("project-local TypeScript Language Service fulfills the semantic query contract", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-ts-semantic-",
    protectedPaths: [path.resolve("..")]
  });
  const root = context.fixtureDir;
  let graph;
  let adapter;
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(context.dataDir, "outside-secret.txt"), "must-not-be-readable\n", "utf8");
    await writeFile(
      path.join(root, "src", "helper.ts"),
      "export function helper(value: string) { return value.toUpperCase(); }\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "src", "api.ts"),
      [
        'import { helper } from "./helper.js";',
        "export function greet(name: string) { return helper(name); }",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "src", "run.ts"),
      [
        'import { greet } from "./api.js";',
        'export function run() { return greet("Ada"); }',
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFakeTypeScriptPackage(root);

    graph = new WorkspaceGraph({
      rootDir: root,
      workspaceId: "workspace-typescript-semantic",
      maxDepth: 8,
      maxFileBytes: 128 * 1024
    });
    await graph.refresh();
    adapter = await discoverTypeScriptSemanticAdapter({ rootDir: root });
    assert.ok(adapter);
    assert.equal(adapter.kind, "lsp");
    assert.equal(adapter.warm, false);

    const engine = new CodeQueryEngine({
      graph,
      semanticAdapters: {
        javascript: adapter,
        typescript: adapter
      }
    });
    const definition = await engine.query({ query: "greet", mode: "definition", depth: "semantic" });
    const references = await engine.query({ query: "greet", mode: "references", depth: "semantic" });
    const type = await engine.query({ query: "greet", mode: "type", depth: "semantic" });
    const callers = await engine.query({ query: "greet", mode: "callers", depth: "semantic" });
    const callees = await engine.query({ query: "greet", mode: "callees", depth: "semantic" });

    assert.equal(adapter.warm, true);
    for (const result of [definition, references, type, callers, callees]) {
      assert.equal(result.completeness.semantic_used, true);
      assert.equal(result.completeness.semantic_complete, true);
      assert.match(result.engine, /typescript-language-service/);
      assert.equal(result.fallback_reason, null);
      assert.ok(result.results.every((entry) =>
        entry.location.workspace_id === "workspace-typescript-semantic" &&
        !path.isAbsolute(entry.location.path) &&
        !entry.location.path.split("/").includes("..")
      ));
    }
    assert.ok(definition.results.some((entry) => entry.location.path === "src/api.ts"));
    assert.ok(references.results.some((entry) => entry.location.path === "src/run.ts"));
    assert.ok(type.results.some((entry) => entry.signature === "(name: string) => string"));
    assert.ok(callers.results.some((entry) => entry.name === "run" && entry.location.path === "src/run.ts"));
    assert.ok(callees.results.some((entry) => entry.name === "helper" && entry.location.path === "src/helper.ts"));

    const boundedAdapter = await discoverTypeScriptSemanticAdapter({ rootDir: root });
    const boundedEngine = new CodeQueryEngine({
      graph,
      semanticAdapters: { typescript: boundedAdapter }
    });
    const bounded = await boundedEngine.query({
      query: "greet",
      mode: "references",
      depth: "semantic",
      limit: 1
    });
    assert.equal(bounded.completeness.semantic_used, true);
    assert.equal(bounded.completeness.semantic_complete, false);
    assert.match(bounded.fallback_reason, /typescript_result_budget_exceeded/);
    await boundedAdapter.close();
  } finally {
    await adapter?.close();
    await graph?.close();
    await safeRemove(root, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("TypeScript semantic timeout hard-terminates a blocked compiler worker", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-ts-timeout-",
    protectedPaths: [path.resolve("..")]
  });
  const root = context.fixtureDir;
  let graph;
  let adapter;
  try {
    await writeFile(root + "/api.ts", "export function blocked() { return 1; }\nblocked();\n", "utf8");
    const packageRoot = path.join(root, "node_modules", "typescript");
    await mkdir(path.join(packageRoot, "lib"), { recursive: true });
    await writeFile(path.join(packageRoot, "lib", "lib.d.ts"), "interface String {}\n", "utf8");
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "typescript",
      version: "0.0.0-timeout-test",
      main: "index.cjs"
    }), "utf8");
    await writeFile(
      path.join(packageRoot, "index.cjs"),
      [
        "exports.ScriptSnapshot = { fromString(text) { return { getText(a, b) { return text.slice(a, b); }, getLength() { return text.length; } }; } };",
        "exports.createLanguageService = function createLanguageService() { while (true) {} };",
        ""
      ].join("\n"),
      "utf8"
    );
    graph = new WorkspaceGraph({ rootDir: root, workspaceId: "workspace-ts-timeout" });
    await graph.refresh();
    adapter = await discoverTypeScriptSemanticAdapter({ rootDir: root });
    const engine = new CodeQueryEngine({
      graph,
      semanticAdapters: { typescript: adapter },
      semanticColdTimeoutMs: 60,
      semanticWarmTimeoutMs: 60
    });
    const started = performance.now();
    const result = await engine.query({
      query: "blocked",
      mode: "references",
      depth: "semantic"
    });
    const elapsed = performance.now() - started;

    assert.equal(adapter.hardPreemptible, true);
    assert.equal(result.completeness.semantic_used, false);
    assert.match(result.fallback_reason, /semantic_timeout/);
    assert.ok(result.results.length >= 1, "lexical fallback should remain available");
    assert.ok(elapsed < 1_000, `blocked worker should be terminated quickly, elapsed=${elapsed}`);
  } finally {
    await adapter?.close();
    await graph?.close();
    await safeRemove(root, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

async function writeFakeTypeScriptPackage(root) {
  const packageRoot = path.join(root, "node_modules", "typescript");
  await mkdir(path.join(packageRoot, "lib"), { recursive: true });
  await writeFile(path.join(packageRoot, "lib", "lib.d.ts"), "interface String {}\n", "utf8");
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "typescript",
    version: "0.0.0-contract-test",
    main: "index.cjs"
  }), "utf8");
  await writeFile(
    path.join(packageRoot, "index.cjs"),
    [
      'const path = require("node:path");',
      "function snapshotText(host, file) {",
      "  const snapshot = host.getScriptSnapshot(file);",
      "  return snapshot.getText(0, snapshot.getLength());",
      "}",
      "function sourceFile(host, suffix) {",
      "  const file = host.getScriptFileNames().find((candidate) => candidate.endsWith(suffix));",
      "  if (!file) throw new Error(`missing fake source: ${suffix}`);",
      "  return file;",
      "}",
      "function span(host, file, needle, last = false) {",
      "  const text = snapshotText(host, file);",
      "  const start = last ? text.lastIndexOf(needle) : text.indexOf(needle);",
      "  if (start < 0) throw new Error(`missing fake span: ${needle}`);",
      "  return { start, length: needle.length };",
      "}",
      "exports.version = \"0.0.0-contract-test\";",
      "exports.ScriptTarget = { ESNext: 99, Latest: 99 };",
      "exports.JsxEmit = { Preserve: 1 };",
      "exports.ModuleResolutionKind = { NodeNext: 99, NodeJs: 2 };",
      "exports.ModuleKind = { NodeNext: 199, ESNext: 99, CommonJS: 1 };",
      "exports.sys = { useCaseSensitiveFileNames: true, newLine: \"\\n\" };",
      "exports.ScriptSnapshot = {",
      "  fromString(text) {",
      "    return {",
      "      getText(start, end) { return text.slice(start, end); },",
      "      getLength() { return text.length; },",
      "      getChangeRange() { return undefined; }",
      "    };",
      "  }",
      "};",
      "exports.getDefaultLibFilePath = () => path.join(__dirname, \"lib\", \"lib.d.ts\");",
      "exports.createLanguageService = function createLanguageService(host) {",
      "  const outside = path.join(host.getCurrentDirectory(), \"..\", \"data\", \"outside-secret.txt\");",
      "  if (host.readFile(outside) !== undefined || host.fileExists(outside)) {",
      "    throw new Error(\"language service host escaped workspace\");",
      "  }",
      "  const api = () => sourceFile(host, path.join(\"src\", \"api.ts\"));",
      "  const run = () => sourceFile(host, path.join(\"src\", \"run.ts\"));",
      "  const helper = () => sourceFile(host, path.join(\"src\", \"helper.ts\"));",
      "  return {",
      "    getNavigateToItems(query) {",
      "      if (query !== \"greet\") return [];",
      "      return [{ name: \"greet\", kind: \"function\", fileName: api(), textSpan: span(host, api(), \"greet\") }];",
      "    },",
      "    getDefinitionAtPosition() {",
      "      return [{ fileName: api(), textSpan: span(host, api(), \"greet\"), name: \"greet\", kind: \"function\", containerName: \"\" }];",
      "    },",
      "    getReferencesAtPosition() {",
      "      return [",
      "        { fileName: api(), textSpan: span(host, api(), \"greet\"), isWriteAccess: true },",
      "        { fileName: run(), textSpan: span(host, run(), \"greet\", true), isWriteAccess: false }",
      "      ];",
      "    },",
      "    getQuickInfoAtPosition() {",
      "      return {",
      "        kind: \"function\",",
      "        textSpan: span(host, api(), \"greet\"),",
      "        displayParts: [{ text: \"(name: string) => string\" }],",
      "        documentation: [{ text: \"Greets one person.\" }]",
      "      };",
      "    },",
      "    prepareCallHierarchy() {",
      "      return { name: \"greet\", kind: \"function\", file: api(), span: span(host, api(), \"greet\"), selectionSpan: span(host, api(), \"greet\") };",
      "    },",
      "    provideCallHierarchyIncomingCalls() {",
      "      const runSpan = span(host, run(), \"run\");",
      "      return [{ from: { name: \"run\", kind: \"function\", file: run(), span: runSpan, selectionSpan: runSpan }, fromSpans: [span(host, run(), \"greet\", true)] }];",
      "    },",
      "    provideCallHierarchyOutgoingCalls() {",
      "      const helperSpan = span(host, helper(), \"helper\");",
      "      return [{ to: { name: \"helper\", kind: \"function\", file: helper(), span: helperSpan, selectionSpan: helperSpan }, fromSpans: [span(host, api(), \"helper\", true)] }];",
      "    },",
      "    dispose() {}",
      "  };",
      "};",
      ""
    ].join("\n"),
    "utf8"
  );
}
