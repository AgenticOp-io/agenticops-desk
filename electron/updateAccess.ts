import { createSign } from "node:crypto";
import { openSecret, UPDATE_SEAL_KEY, type SecretBox } from "./pureFeatures";
import { updateSeal } from "./updateSeal";

type Pat = { kind: "pat"; token: string };
type AppKey = { kind: "app"; appId: string; installationId: string; privateKey: string };
type Credential = Pat | AppKey;

let cached: { token: string; until: number } | null = null;

function credential(): Credential | null {
  if (updateSeal.v !== 1 || !updateSeal.iv || !updateSeal.tag || !updateSeal.data) return null;
  const plain = openSecret(updateSeal as SecretBox, UPDATE_SEAL_KEY);
  if (!plain) return null;
  try {
    const parsed = JSON.parse(plain) as Credential;
    if (parsed.kind === "pat" && parsed.token) return parsed;
    if (parsed.kind === "app" && parsed.appId && parsed.installationId && parsed.privateKey) return parsed;
  } catch {
    /* a damaged seal is the same as no seal */
  }
  return null;
}

function b64url(bytes: Buffer) {
  return bytes.toString("base64url");
}

// A GitHub App seal mints a token that GitHub expires after an hour, so each check revolves it.
async function mintAppToken(app: AppKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.until > Date.now() + 5 * 60_000) return cached.token;
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.appId })));
  const unsigned = `${header}.${body}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(app.privateKey);
  const jwt = `${unsigned}.${b64url(sig)}`;
  const res = await fetch(`https://api.github.com/app/installations/${app.installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "AgenticOps-Desk" },
  });
  if (!res.ok) return "";
  const data = (await res.json()) as { token?: string; expires_at?: string };
  if (!data.token) return "";
  cached = { token: data.token, until: data.expires_at ? Date.parse(data.expires_at) : Date.now() + 50 * 60_000 };
  return data.token;
}

// The credential that can read the private repository. Empty when this build was not sealed and gh is the fallback.
export async function sealedGithubToken(): Promise<string> {
  const cred = credential();
  if (!cred) return "";
  if (cred.kind === "pat") return cred.token;
  try {
    return await mintAppToken(cred);
  } catch {
    return "";
  }
}
