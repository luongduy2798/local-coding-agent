import assert from "node:assert/strict";
import test from "node:test";
import { redactForSupport, redactText } from "../core/redaction.mjs";

test("redaction removes nested credentials without mutating safe fields", () => {
  const input = {
    workspace: "C:/repo",
    headers: { authorization: "Bearer abcdefghijklmnop" },
    nested: [{ api_key: "not-a-real-key" }],
    command: "TOKEN=super-secret-value npm test"
  };
  const output = redactForSupport(input);
  assert.equal(output.workspace, "C:/repo");
  assert.equal(output.headers.authorization, "[REDACTED]");
  assert.equal(output.nested[0].api_key, "[REDACTED]");
  assert.doesNotMatch(output.command, /super-secret-value/);
});

test("redaction strips bearer values and private key blocks", () => {
  const text = redactText("Bearer abcdefghijklmnop\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----");
  assert.doesNotMatch(text, /abcdefghijklmnop|\nsecret\n/);
  assert.match(text, /REDACTED/);
});
