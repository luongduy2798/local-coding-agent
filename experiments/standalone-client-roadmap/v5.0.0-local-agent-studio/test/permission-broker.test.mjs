import assert from "node:assert/strict";
import test from "node:test";
import { PermissionBroker, PermissionDeniedError, privilegedIntent } from "../core/permission-broker.mjs";

test("permission broker requires structured confirmation for privileged actions", () => {
  const broker = new PermissionBroker();
  assert.throws(
    () => broker.require("mcp-server:start", {}, { route: "/api/server/start", target: "workspace" }),
    PermissionDeniedError
  );
  const allowed = broker.require("mcp-server:start", {
    intent: privilegedIntent("mcp-server:start")
  }, { route: "/api/server/start", target: "workspace" });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.risk, "high");
  assert.equal(broker.summary().recentDenied, 1);
});

test("permission broker public audit omits raw request payloads", () => {
  const broker = new PermissionBroker();
  broker.require("provider-key:set", {
    value: "sk-should-not-enter-audit",
    intent: privilegedIntent("provider-key:set")
  }, { route: "/api/secrets/openai", target: "openai" });
  const text = JSON.stringify(broker.publicAudit());
  assert.equal(text.includes("sk-should-not-enter-audit"), false);
  assert.match(text, /provider-key:set/);
});
