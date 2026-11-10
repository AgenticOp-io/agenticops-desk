import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";

// Content-Security-Policy for packaged builds. The dev server needs inline scripts and a websocket for
// hot reload, so it is only added to the built index.html. The preview pane may frame any http(s) page.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-src http: https:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "desk-csp",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" },
    ],
  };
}

type Startup = () => Promise<void>;
const electronApp = () => (process as NodeJS.Process & { electronApp?: ChildProcess }).electronApp;

async function start(startup: Startup) {
  await startup();
  electronApp()?.on("message", (msg) => {
    if (msg === "desk:restart") void start(startup);
  });
}

// Restarting Electron ends every running chat, including one that is editing this code. When the app is
// already running, tell it new code is ready; it asks for the restart once no chat is running. A build from
// before this handshake never answers, so after 3 seconds it is restarted the old way.
function onMainRebuilt(startup: Startup) {
  const running = electronApp();
  if (!running || running.exitCode !== null || !running.send) return start(startup);
  let acked = false;
  const onAck = (msg: unknown) => {
    if (msg === "desk:ack") acked = true;
  };
  running.on("message", onAck);
  running.send("desk:main-rebuilt");
  setTimeout(() => {
    running.off("message", onAck);
    if (!acked && electronApp() === running) void start(startup);
  }, 3000);
}

export default defineConfig({
  plugins: [
    react(),
    contentSecurityPolicy(),
    electron({
      main: {
        entry: "electron/main.ts",
        onstart: ({ startup }) => onMainRebuilt(startup),
        vite: {
          // Installers do not carry the agent SDK; the app downloads exactly this version (claudeBinary.ts).
          define: {
            __AGENT_SDK_VERSION__: JSON.stringify(
              JSON.parse(readFileSync("node_modules/@anthropic-ai/claude-agent-sdk/package.json", "utf8")).version,
            ),
          },
          build: {
            // The plugin leaves outDir alone (emptyOutDir: false), so stale hashed
            // main-*.js chunks from older builds pile up and get shipped in the
            // installer. Wipe dist-electron each build so only the current chunk runs.
            emptyOutDir: true,
            rollupOptions: {
              external: ["@anthropic-ai/claude-agent-sdk", "node:sqlite"],
            },
          },
        },
      },
      preload: { input: "electron/preload.ts" },
      renderer: {},
    }),
  ],
});
