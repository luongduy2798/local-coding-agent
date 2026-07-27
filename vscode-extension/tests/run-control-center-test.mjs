import { createRequire } from "node:module";
import { build } from "esbuild";

const result = await build({
  entryPoints: [new URL("./control-center.test.ts", import.meta.url).pathname],
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
          const settings = { autoRefresh: true, refreshInterval: 1000 };
          const workspace = {
            workspaceFolders: [],
            isTrusted: true,
            getConfiguration: () => ({ get: (key, fallback) => key in settings ? settings[key] : fallback }),
            getWorkspaceFolder: (uri) => workspace.workspaceFolders.find(
              (folder) => folder.uri.toString() === uri.toString()
            ),
          };
          module.exports = {
            EventEmitter,
            workspace,
            window: { activeTextEditor: undefined },
          };
        `,
      }));
    },
  }],
});

const source = result.outputFiles[0].text;
const module = { exports: {} };
const require = createRequire(import.meta.url);
new Function("require", "module", "exports", source)(require, module, module.exports);
