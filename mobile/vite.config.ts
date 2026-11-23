import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The phone app: a separate bundle from the Electron renderer, wrapped by Capacitor (capacitor.config.json).
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist-mobile", emptyOutDir: true },
});
