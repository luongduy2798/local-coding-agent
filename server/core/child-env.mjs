// Child-process environment isolation for project commands.
// Keeps project environment variables while stripping LCA control-plane secrets.

export const INTERNAL_ENV_KEYS = new Set([
  "MCP_AUTH_TOKEN",
  "AGENT_APPROVAL_TOKEN",
  "CONTROL_PLANE_API_KEY",
  "CONTROL_PLANE_TUNNEL_ID",
  "MCP_AUTH_HEADER",
  "MCP_EXTRA_HEADERS"
]);

const INTERNAL_PREFIXES = [
  "LCA_INTERNAL_",
  "OPENAI_SECURE_MCP_"
];

export function isInternalControlEnvKey(key) {
  const name = String(key || "").toUpperCase();
  return INTERNAL_ENV_KEYS.has(name) || INTERNAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function buildChildEnv(baseEnv = process.env, extraEnv = {}, options = {}) {
  const excluded = new Set([
    ...INTERNAL_ENV_KEYS,
    ...(Array.isArray(options.exclude) ? options.exclude.map((key) => String(key).toUpperCase()) : [])
  ]);
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    const upper = key.toUpperCase();
    if (excluded.has(upper) || isInternalControlEnvKey(upper)) continue;
    if (value !== undefined) env[key] = String(value);
  }
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (value === undefined || value === null) continue;
    if (isInternalControlEnvKey(key) && options.allowInternal !== true) continue;
    env[key] = String(value);
  }
  return env;
}
