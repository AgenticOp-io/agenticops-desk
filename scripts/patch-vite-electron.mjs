import fs from "node:fs";
import path from "node:path";

const file = path.join("node_modules", "vite-plugin-electron", "dist", "index.mjs");
if (!fs.existsSync(file)) process.exit(0);
const src = fs.readFileSync(file, "utf8");
if (src.includes("GPU/utility children")) process.exit(0);
const next = src.replace(
  "cp.execSync(`taskkill /pid ${pid} /T /F`);",
  `try {
      cp.execSync(\`taskkill /pid \${pid} /T /F\`);
    } catch {
      // GPU/utility children often refuse taskkill /T; the main pid is still gone.
    }`,
);
if (next === src) process.exit(0);
fs.writeFileSync(file, next);
console.log("patched vite-plugin-electron treeKillSync");
