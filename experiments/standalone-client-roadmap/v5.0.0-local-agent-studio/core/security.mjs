import { randomBytes, timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function createStudioSecurity({ host = "127.0.0.1", port, token, nonce } = {}) {
  const expectedPort = Number(port);
  const sessionToken = token || randomBytes(32).toString("base64url");
  const cspNonce = nonce || randomBytes(18).toString("base64url");

  if (!LOOPBACK_HOSTS.has(normalizeHost(host))) {
    throw new Error("Local Agent Studio only supports loopback listeners.");
  }
  if (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535) {
    throw new Error(`Invalid Studio port: ${port}`);
  }

  return {
    token: sessionToken,
    nonce: cspNonce,
    authorize(req, { publicRoute = false, requireJson = false } = {}) {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        return denied(403, "Only loopback clients may access Local Agent Studio.");
      }

      const hostCheck = validateHostHeader(req.headers?.host, expectedPort);
      if (!hostCheck.ok) return hostCheck;

      const origin = req.headers?.origin;
      if (origin && !isAllowedOrigin(origin, expectedPort)) {
        return denied(403, "Cross-origin requests are not allowed.");
      }

      if (publicRoute) return { ok: true };

      const supplied = firstHeader(req.headers?.["x-lca-studio-token"]);
      if (!constantTimeEqual(supplied, sessionToken)) {
        return denied(401, "Missing or invalid Studio session token.");
      }

      if (requireJson) {
        const contentType = firstHeader(req.headers?.["content-type"]).toLowerCase();
        if (!contentType.startsWith("application/json")) {
          return denied(415, "State-changing requests require application/json.");
        }
      }

      return { ok: true };
    },
    htmlHeaders() {
      return {
        ...baseSecurityHeaders(),
        "content-security-policy": [
          "default-src 'none'",
          `script-src 'nonce-${cspNonce}'`,
          `style-src 'nonce-${cspNonce}'`,
          "img-src 'self' data:",
          "connect-src 'self'",
          "font-src 'self'",
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'none'"
        ].join("; ")
      };
    },
    staticHtmlHeaders() {
      return {
        ...baseSecurityHeaders(),
        "content-security-policy": [
          "default-src 'none'",
          "script-src 'self'",
          "style-src 'self'",
          "img-src 'self' data:",
          "connect-src 'self'",
          "font-src 'self'",
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'none'"
        ].join("; ")
      };
    },
    apiHeaders() {
      return baseSecurityHeaders();
    }
  };
}

export function isAllowedOrigin(value, port) {
  try {
    const origin = new URL(value);
    const actualPort = Number(origin.port || (origin.protocol === "http:" ? 80 : 443));
    return origin.protocol === "http:" && LOOPBACK_HOSTS.has(normalizeHost(origin.hostname)) && actualPort === Number(port);
  } catch {
    return false;
  }
}

export function isLoopbackAddress(value) {
  const address = String(value || "").toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function validateHostHeader(value, port) {
  try {
    const parsed = new URL(`http://${firstHeader(value)}`);
    const actualPort = Number(parsed.port || 80);
    if (!LOOPBACK_HOSTS.has(normalizeHost(parsed.hostname)) || actualPort !== Number(port)) {
      return denied(403, "Invalid Host header.");
    }
    return { ok: true };
  } catch {
    return denied(403, "Invalid Host header.");
  }
}

function normalizeHost(value) {
  return String(value || "").replace(/^\[|\]$/g, "").toLowerCase();
}

function firstHeader(value) {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function denied(status, error) {
  return { ok: false, status, error };
}

function baseSecurityHeaders() {
  return {
    "cache-control": "no-store",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}
