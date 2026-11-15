import Anthropic from "@anthropic-ai/sdk";
import { providerKey } from "./providers";
import type { ImageAttachment } from "./claude";

// Turns an attached image into a plain-text description the agent can read, so a chat running on a text-only
// model (the local Ollama coder, most Claude Code default models) can still "see" a screenshot. Local vision
// first (cheap Ollama), then a cloud fallback (Claude); returns null when neither works, and the caller falls
// back to plain text.

const LOCAL_VISION_MODEL = "llama3.2-vision";
const OLLAMA_API = "http://127.0.0.1:11434";

const MAX_IMAGE_BYTES = 5_000_000; // matches the composer's own cap
const PROMPT = "Describe this image in plain detail so someone who cannot see it can act on it. Include any visible text, errors, numbers, UI labels, and what the person pointed at.";

async function describeViaOllama(img: ImageAttachment): Promise<string | null> {
  try {
    const list = await fetch(`${OLLAMA_API}/api/tags`, { signal: AbortSignal.timeout(4_000) });
    if (!list.ok) return null;
    const models = (await list.json()) as { models?: Array<{ name: string }> };
    if (!models.models?.some((m) => m.name.startsWith(LOCAL_VISION_MODEL))) return null;
    const res = await fetch(`${OLLAMA_API}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: LOCAL_VISION_MODEL, prompt: PROMPT, images: [img.data], stream: false, options: { num_predict: 300, temperature: 0 } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    return data.response?.trim() ? data.response.trim() : null;
  } catch {
    return null;
  }
}

async function describeViaClaude(img: ImageAttachment): Promise<string | null> {
  const key = providerKey("anthropic");
  if (!key) return null;
  try {
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create(
      {
        model: "claude-sonnet-5-5",
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: img.mediaType as "image/png", data: img.data } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      },
      { signal: AbortSignal.timeout(60_000) },
    );
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return text || null;
  } catch {
    return null;
  }
}

// A description from the local vision model only. Null when that model is not installed.
export async function describeImageLocally(img: ImageAttachment): Promise<string | null> {
  if (!img || typeof img.data !== "string" || img.data.length > MAX_IMAGE_BYTES) return null;
  return describeViaOllama(img);
}

// Replaces images the local model could see with text, so the paid model is not billed for the bytes.
export async function imagesToText(
  prompt: string,
  images?: ImageAttachment[],
): Promise<{ prompt: string; images?: ImageAttachment[] }> {
  if (!images?.length) return { prompt, images };
  const notes: string[] = [];
  const left: ImageAttachment[] = [];
  for (const img of images) {
    const text = await describeImageLocally(img);
    if (text) notes.push(img.name ? `${img.name}: ${text}` : text);
    else left.push(img);
  }
  if (!notes.length) return { prompt, images };
  return {
    prompt: `${prompt}\n\nWhat the attached image shows (described on this computer; the image itself was not sent):\n${notes.join("\n\n")}`,
    images: left.length ? left : undefined,
  };
}

// The only callers use: a single image description. Local first, cloud fallback.
export async function describeImage(img: ImageAttachment): Promise<string | null> {
  if (!img || typeof img.data !== "string" || img.data.length > MAX_IMAGE_BYTES) return null;
  try {
    return (await describeViaOllama(img)) ?? (await describeViaClaude(img));
  } catch {
    return null;
  }
}
