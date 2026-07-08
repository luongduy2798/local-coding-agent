const SENSITIVE_KEY = /(?:authorization|api[-_]?key|access[-_]?token|auth[-_]?token|password|passwd|secret|private[-_]?key|approval[-_]?token|cookie)/i;
const SECRET_PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{12,}/gi, "[REDACTED_API_KEY]"],
  [/\b(?:ghp|github_pat|glpat|xox[baprs])_[A-Za-z0-9_-]{10,}/gi, "[REDACTED_TOKEN]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\b((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD))\s*=\s*([^\s"']+)/g, "$1=[REDACTED]"]
];

export function redactForSupport(value, options = {}) {
  const maxString = Number(options.maxString || 20_000);
  return redactValue(value, new WeakSet(), maxString);
}

export function redactText(value, maxString = 20_000) {
  let output = String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement);
  if (output.length > maxString) output = `${output.slice(0, maxString)}\n[TRUNCATED ${output.length - maxString} chars]`;
  return output;
}

function redactValue(value, seen, maxString) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactText(value, maxString);
  if (Buffer.isBuffer(value)) return `[BUFFER ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactValue(item, seen, maxString));
  if (typeof value !== "object") return redactText(String(value), maxString);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 500)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(item, seen, maxString);
  }
  return output;
}
