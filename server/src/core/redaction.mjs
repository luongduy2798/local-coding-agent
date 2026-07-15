// Local Coding Agent — redaction helpers
// SPDX-License-Identifier: AGPL-3.0-or-later

// Fields whose values may carry secrets or large payloads. Keep these out of
// audit logs and compact summaries.
const AUDIT_REDACT = /^(content|body|diff|patch|old_text|new_text|command|token|approval_token|mcp_auth_token|control_plane_api_key|key|secret|password|authorization|auth|api[_-]?key)$/i;

export function redactDeep(value, depth = 0) {
  if (depth > 8) return "…";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactDeep(item, depth + 1));
  if (value && typeof value === "object") {
    const redacted = {};
    for (const [key, nested] of Object.entries(value)) {
      if (AUDIT_REDACT.test(key)) {
        redacted[key] = typeof nested === "string" ? `[redacted ${nested.length} chars]` : "[redacted]";
      } else {
        redacted[key] = redactDeep(nested, depth + 1);
      }
    }
    return redacted;
  }
  if (typeof value === "string" && value.length > 200) return `${value.slice(0, 200)}…(${value.length} chars)`;
  return value;
}

export function summarizeArgs(args) {
  try {
    const summary = JSON.stringify(redactDeep(args || {}));
    return summary.length > 800 ? `${summary.slice(0, 800)}…` : summary;
  } catch {
    return "<unserializable>";
  }
}
