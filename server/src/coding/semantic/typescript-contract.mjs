// Local Coding Agent TypeScript semantic contract.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export const SUPPORTED_LANGUAGES = new Set(["javascript", "typescript"]);
export const SOURCE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"
]);
export const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

export class TypeScriptSemanticAdapterError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "TypeScriptSemanticAdapterError";
    this.code = code;
  }
}
