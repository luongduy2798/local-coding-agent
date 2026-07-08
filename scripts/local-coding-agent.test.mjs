import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeDotEnvText,
  normalize,
  normalizeTunnelArch,
  parseDotEnv,
  ripgrepInstallCommand,
  setupSecurityDefaults,
  tunnelAssetName,
  tunnelAssetUrl
} from "./local-coding-agent.mjs";

test("normalizes default CLI port to 8789", () => {
  assert.equal(normalize({}).port, "8789");
});

test("maps tunnel-client release assets for supported platforms", () => {
  assert.equal(tunnelAssetName("v0.0.10", "darwin", "arm64"), "tunnel-client-v0.0.10-darwin-arm64.zip");
  assert.equal(tunnelAssetName("v0.0.10", "linux", "x64"), "tunnel-client-v0.0.10-linux-amd64.zip");
  assert.equal(tunnelAssetName("v0.0.10", "windows", "amd64"), "tunnel-client-v0.0.10-windows-amd64.zip");
  assert.equal(
    tunnelAssetUrl("v0.0.10", "windows", "arm64"),
    "https://github.com/openai/tunnel-client/releases/download/v0.0.10/tunnel-client-v0.0.10-windows-arm64.zip"
  );
});

test("normalizes supported CPU architectures", () => {
  assert.equal(normalizeTunnelArch("x64"), "amd64");
  assert.equal(normalizeTunnelArch("amd64"), "amd64");
  assert.equal(normalizeTunnelArch("aarch64"), "arm64");
  assert.equal(normalizeTunnelArch("arm64"), "arm64");
  assert.throws(() => normalizeTunnelArch("ia32"), /Unsupported CPU architecture/);
});

test("parses and merges dotenv without dropping unrelated values", () => {
  const existing = "KEEP=1\nCONTROL_PLANE_TUNNEL_ID=tunnel_old\n";
  const merged = mergeDotEnvText(existing, {
    CONTROL_PLANE_TUNNEL_ID: "tunnel_new",
    CONTROL_PLANE_API_KEY: "sk-proj-new"
  });
  assert.deepEqual(parseDotEnv(merged), {
    KEEP: "1",
    CONTROL_PLANE_TUNNEL_ID: "tunnel_new",
    CONTROL_PLANE_API_KEY: "sk-proj-new"
  });
});

test("empty dotenv merge starts with the requested key", () => {
  const merged = mergeDotEnvText("", { CONTROL_PLANE_TUNNEL_ID: "tunnel_new" });
  assert.equal(merged, "CONTROL_PLANE_TUNNEL_ID=tunnel_new\n");
});

test("setup defaults to safe and balanced unless flags override", () => {
  assert.deepEqual(setupSecurityDefaults({}), { mode: "safe", policy: "balanced" });
  assert.deepEqual(setupSecurityDefaults({ mode: "full", policy: "full" }), { mode: "full", policy: "full" });
});

test("selects ripgrep install command by platform", () => {
  assert.deepEqual(ripgrepInstallCommand({ id: "darwin" }, ["brew"]), {
    label: "Homebrew",
    command: "brew",
    args: ["install", "ripgrep"]
  });
  assert.deepEqual(ripgrepInstallCommand({ id: "win32" }, ["winget"]), {
    label: "winget",
    command: "winget",
    args: ["install", "--id", "BurntSushi.ripgrep.MSVC", "-e"]
  });
  const linux = ripgrepInstallCommand({ id: "linux" }, ["apt-get"]);
  assert.equal(linux.label, "apt-get");
  assert.match(`${linux.command} ${linux.args.join(" ")}`, /apt-get .*install -y ripgrep|apt-get install -y ripgrep/);
  assert.equal(ripgrepInstallCommand({ id: "linux" }, []), null);
});
