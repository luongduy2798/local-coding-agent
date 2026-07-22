// Local Coding Agent workspace registry contract.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export class WorkspaceRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkspaceRegistryError";
    this.code = code;
    this.details = details;
  }
}
