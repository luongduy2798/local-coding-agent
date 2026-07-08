import assert from "node:assert/strict";
import test from "node:test";
import { createStudioSecurity, isAllowedOrigin, isLoopbackAddress } from "../core/security.mjs";

function request(headers = {}, remoteAddress = "127.0.0.1") {
  return { headers: { host: "127.0.0.1:5182", ...headers }, socket: { remoteAddress } };
}

test("security boundary accepts an authenticated same-origin JSON request", () => {
  const security = createStudioSecurity({ port: 5182, token: "test-token", nonce: "test-nonce" });
  const result = security.authorize(request({
    origin: "http://127.0.0.1:5182",
    "content-type": "application/json",
    "x-lca-studio-token": "test-token"
  }), { requireJson: true });
  assert.deepEqual(result, { ok: true });
});

test("security boundary rejects cross-origin browser requests", () => {
  const security = createStudioSecurity({ port: 5182, token: "test-token" });
  const result = security.authorize(request({
    origin: "https://evil.example",
    "content-type": "application/json",
    "x-lca-studio-token": "test-token"
  }), { requireJson: true });
  assert.equal(result.status, 403);
});

test("security boundary rejects missing tokens and simple-request content types", () => {
  const security = createStudioSecurity({ port: 5182, token: "test-token" });
  assert.equal(security.authorize(request(), {}).status, 401);
  assert.equal(security.authorize(request({
    "content-type": "text/plain",
    "x-lca-studio-token": "test-token"
  }), { requireJson: true }).status, 415);
});

test("security boundary rejects DNS rebinding hosts and non-loopback peers", () => {
  const security = createStudioSecurity({ port: 5182, token: "test-token" });
  assert.equal(security.authorize(request({ host: "evil.example:5182" }), { publicRoute: true }).status, 403);
  assert.equal(security.authorize(request({}, "192.168.1.20"), { publicRoute: true }).status, 403);
});

test("loopback and origin helpers cover IPv4, IPv6, and localhost", () => {
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isAllowedOrigin("http://localhost:5182", 5182), true);
  assert.equal(isAllowedOrigin("http://[::1]:5182", 5182), true);
  assert.equal(isAllowedOrigin("https://localhost:5182", 5182), false);
});
