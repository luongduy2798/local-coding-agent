import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
for (const entry of ["audit-reader.test.ts", "audit-reader-integration.test.ts"]) {
  const result = await build({
    entryPoints: [new URL(`./${entry}`, import.meta.url).pathname],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    plugins: [{
      name: "vscode-test-stub",
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          loader: "js",
          contents: `
            class EventEmitter {
              constructor() { this.listeners = new Set(); this.event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
              fire(value) { for (const listener of this.listeners) listener(value); }
              dispose() { this.listeners.clear(); }
            }
            module.exports = { EventEmitter };
          `,
        }));
      },
    }],
  });
  const source = result.outputFiles[0].text;
  const testModule = { exports: {} };
  new Function("require", "module", "exports", source)(require, testModule, testModule.exports);
  const completion = testModule.exports?.default;
  if (completion && typeof completion.then === "function") await completion;
}
