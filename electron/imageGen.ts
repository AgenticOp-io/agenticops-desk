import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { providerKey } from "./providers";

// Makes a picture from a text prompt through the OpenAI Images API, using the key saved in Settings.
// The PNG goes to AgenticOps Desk's own data folder (never a repo); the agent gets the path back.
// shortcut: OpenAI only, upgrade when a second image provider is wanted.

export async function generateImage(prompt: string, size: "1024x1024" | "1536x1024" | "1024x1536" = "1024x1024"): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const key = providerKey("openai");
  if (!key) return { ok: false, error: "No OpenAI key is saved. Add one in Settings > Providers to generate images." };
  try {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "gpt-image-1", prompt, size, n: 1 }),
      signal: AbortSignal.timeout(180_000),
    });
    const data = (await res.json()) as { data?: Array<{ b64_json?: string }>; error?: { message?: string } };
    const b64 = data.data?.[0]?.b64_json;
    if (!res.ok || !b64) return { ok: false, error: data.error?.message ?? `Image request failed (${res.status})` };
    const dir = path.join(app.getPath("userData"), "images");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `image-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
