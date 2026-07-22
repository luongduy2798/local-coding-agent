// Local Coding Agent CLI approval decisions.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../process-lifecycle.mjs";
import { readJsonFile } from "./config.mjs";
import { cliRuntimeDataDir } from "./workspace.mjs";

const APPROVAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cliApprovalDir() {
  return join(cliRuntimeDataDir(), "approvals");
}

function readCliApproval(id) {
  if (!APPROVAL_ID_RE.test(String(id || ""))) throw new Error("Invalid approval request ID.");
  const file = join(cliApprovalDir(), `${id}.json`);
  if (!existsSync(file)) throw new Error(`Approval request not found: ${id}`);
  const record = readJsonFile(file, null);
  if (!record || record.id !== id) throw new Error(`Approval request is corrupt: ${id}`);
  return { file, record };
}

export async function approvalCommand(rest) {
  const [sub = "list", id] = rest;
  if (sub === "list") {
    const directory = cliApprovalDir();
    if (!existsSync(directory)) {
      console.log("No approval requests.");
      return [];
    }
    const requests = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJsonFile(join(directory, name), null))
      .filter((record) => record && APPROVAL_ID_RE.test(String(record.id || "")))
      .sort((left, right) => String(right.created || "").localeCompare(String(left.created || "")));
    for (const request of requests) {
      console.log(`${request.id}  ${request.status}  expires=${request.expires_at || "unknown"}  ${request.action || `batch:${request.actions?.length || 0}`}`);
    }
    if (!requests.length) console.log("No approval requests.");
    return requests;
  }
  if (!["approve", "deny"].includes(sub) || !id) {
    throw new Error("Usage: lca approval list|approve <request-id>|deny <request-id>");
  }
  const { file, record } = readCliApproval(id);
  if (record.status !== "pending") {
    throw new Error(`Approval request ${id} is ${record.status}; only pending requests can be decided.`);
  }
  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
    record.status = "expired";
    record.expired_at = new Date().toISOString();
    await atomicWriteJson(file, record);
    throw new Error(`Approval request ${id} has expired.`);
  }
  record.status = sub === "approve" ? "approved" : "denied";
  record[`${record.status}_at`] = new Date().toISOString();
  record[`${record.status}_via`] = "local_cli";
  await atomicWriteJson(file, record);
  console.log(`Approval request ${id}: ${record.status}.`);
  return record;
}



