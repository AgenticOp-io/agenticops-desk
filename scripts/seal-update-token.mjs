// Seals the private-repo credential into electron/updateSeal.ts before the app is bundled.
// A GitHub App key is preferred: the app then mints a token that expires in an hour.
// UPDATE_PAT is the fallback, a fine-grained token that can only read AgenticOp-io/agenticops-desk.
import { writeFileSync } from "node:fs";
import { sealSecret, UPDATE_SEAL_KEY } from "../electron/pureFeatures.ts";

const appId = process.env.UPDATE_APP_ID?.trim() ?? "";
const installationId = process.env.UPDATE_APP_INSTALLATION_ID?.trim() ?? "";
const privateKey = (process.env.UPDATE_APP_PRIVATE_KEY ?? "").trim().replace(/\\n/g, "\n");
const pat = process.env.UPDATE_PAT?.trim() ?? "";

let plain = "";
if (appId && installationId && privateKey.includes("PRIVATE KEY")) {
  plain = JSON.stringify({ kind: "app", appId, installationId, privateKey });
} else if (pat) {
  plain = JSON.stringify({ kind: "pat", token: pat });
}

const file = new URL("../electron/updateSeal.ts", import.meta.url);
if (!plain) {
  writeFileSync(file, 'export const updateSeal = { v: 0, iv: "", tag: "", data: "" };\n');
  console.log("No update credential to seal. Installed copies will use a GitHub CLI sign-in.");
  process.exit(0);
}
const box = sealSecret(plain, UPDATE_SEAL_KEY);
writeFileSync(file, `export const updateSeal = ${JSON.stringify({ v: 1, ...box })};\n`);
console.log(appId ? "Sealed the GitHub App key. Update checks mint a one-hour token." : "Sealed the read token.");
