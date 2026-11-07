// Mints the one-hour update token and reads one tag. Prints neither the token nor the key.
import { createSign } from "node:crypto";

const repo = "AgenticOp-io/agenticops-desk";
const appId = process.env.UPDATE_APP_ID?.trim() ?? "";
const installationId = process.env.UPDATE_APP_INSTALLATION_ID?.trim() ?? "";
const privateKey = (process.env.UPDATE_APP_PRIVATE_KEY ?? "").trim().replace(/\\n/g, "\n");
const pat = process.env.UPDATE_PAT?.trim() ?? "";

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function token() {
  if (appId && installationId && privateKey.includes("PRIVATE KEY")) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
    const unsigned = `${header}.${body}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(privateKey);
    const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${unsigned}.${b64url(sig)}`, Accept: "application/vnd.github+json", "User-Agent": "AgenticOps-Desk" },
    });
    if (!res.ok) throw new Error(`GitHub refused the app token (${res.status}).`);
    const data = await res.json();
    if (!data.token) throw new Error("GitHub did not return an app token.");
    console.log(`Minted a token that expires at ${data.expires_at}.`);
    return data.token;
  }
  if (!pat) {
    console.log("No update credential is stored yet. Set UPDATE_APP_ID, UPDATE_APP_INSTALLATION_ID and UPDATE_APP_PRIVATE_KEY, or UPDATE_PAT.");
    return "";
  }
  return pat;
}

const access = await token();
if (!access) process.exit(0);
const res = await fetch(`https://api.github.com/repos/${repo}/git/matching-refs/tags/v`, {
  headers: { Authorization: `Bearer ${access}`, Accept: "application/vnd.github+json", "User-Agent": "AgenticOps-Desk" },
});
if (!res.ok) throw new Error(`The credential could not read tags (${res.status}).`);
const expires = res.headers.get("github-authentication-token-expiration");
if (expires) {
  const left = Date.parse(expires) - Date.now();
  console.log(`Token expiration: ${expires}.`);
  if (pat && left < 14 * 24 * 60 * 60 * 1000) throw new Error("The read token expires within 14 days. Replace UPDATE_PAT and ship a build.");
}
const tags = await res.json();
console.log(`Read ${Array.isArray(tags) ? tags.length : 0} tags.`);
