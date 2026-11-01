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
    name: "claudedesk-csp",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" },
    ],
  };
}

export default defineConfig({
  plugins: [
    react(),
    contentSecurityPolicy(),
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            rollupOptions: {
              external: ["@anthropic-ai/claude-agent-sdk"],
            },
          },
        },
      },
      preload: { input: "electron/preload.ts" },
      renderer: {},
    }),
  ],
});
