// Builds the code patch for a release from dist/ and dist-electron/ (run `npx vite build` first).
// PATCH_SIGNING_KEY is the Ed25519 private key; the app only accepts a manifest signed by it.
import { execFileSync } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, process.argv[2] ?? "release");
const key = process.env.PATCH_SIGNING_KEY;
if (!key) throw new Error("PATCH_SIGNING_KEY is not set.");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const electron = JSON.parse(readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8")).version;

const files = [];
for (const top of ["dist", "dist-electron"]) {
  for (const entry of readdirSync(path.join(root, top), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files.push({ path: path.relative(root, file).replaceAll("\\", "/"), sha256: sha256(readFileSync(file)) });
  }
}

mkdirSync(out, { recursive: true });
// The app runs a setup only if its hash is in this signed manifest.
const installers = {};
for (const name of readdirSync(out)) {
  if (/^AgenticOps-Desk-.+-win-(x64|arm64)-setup\.exe$/.test(name)) installers[name] = sha256(readFileSync(path.join(out, name)));
}
const tar = path.join(out, "patch.tar.gz");
execFileSync("tar", ["-czf", path.relative(root, tar).replaceAll("\\", "/"), "dist", "dist-electron"], { cwd: root });

const manifest = Buffer.from(
  JSON.stringify({
    version: pkg.version,
    // Same as patchShell in electron/pureFeatures.ts: a patch only replaces code, so what is outside it must match.
    shell: `${electron}|${JSON.stringify(pkg.dependencies ?? {})}`,
    tar: sha256(readFileSync(tar)),
    files,
    installers,
  }),
);
writeFileSync(path.join(out, "patch-manifest.json"), manifest);
writeFileSync(path.join(out, "patch-manifest.sig"), sign(null, manifest, key).toString("base64"));
console.log(`patch ${pkg.version}: ${files.length} files, ${Object.keys(installers).length} installers`);
