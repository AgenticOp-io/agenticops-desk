import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { credentialNote, isSavedLogin } from "./credentials";
import { writeJsonAtomic } from "./jsonStore";
import { providerBaseUrl, type ProviderId } from "./providers";
import { Vault } from "./redact";

// Privacy Mode: passwords, keys and tokens are swapped for placeholders before anything reaches a model,
// and real values are put back on this computer just before a tool runs. The vault is encrypted with
// Windows' credential protection and never goes to the renderer.

export type PrivacyMode = "standard" | "protect" | "local";

let mode: PrivacyMode = "protect";
let vault: Vault | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function privacyMode(): PrivacyMode {
  return mode;
}

export function setPrivacyMode(next: unknown) {
  mode = next === "standard" || next === "local" ? next : "protect";
}

export function protecting() {
  return mode !== "standard";
}

function vaultFile() {
  return path.join(app.getPath("userData"), "privacy-vault.json");
}

export function privacyVault(): Vault {
  if (vault) return vault;
  let data;
  try {
    if (existsSync(vaultFile()) && safeStorage.isEncryptionAvailable()) {
      const raw = JSON.parse(readFileSync(vaultFile(), "utf8")) as { enc?: string };
      if (raw.enc) data = JSON.parse(safeStorage.decryptString(Buffer.from(raw.enc, "base64")));
    }
  } catch {
    /* unreadable: start empty rather than block chats */
  }
  vault = new Vault(data);
  vault.onChange = scheduleSave;
  vault.sealed = isSavedLogin;
  return vault;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveVault();
  }, 500);
}

export async function saveVault() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  // Without encryption the vault stays in memory only: placeholders work until AgenticOps Desk restarts.
  if (!vault || !safeStorage.isEncryptionAvailable()) return;
  const enc = safeStorage.encryptString(JSON.stringify(vault.toJSON())).toString("base64");
  await writeJsonAtomic(vaultFile(), { enc });
}

const PLACEHOLDER_NOTE = `

# Hidden secrets (AgenticOps Desk Privacy Mode)

Passwords, keys and tokens are replaced with placeholders like {{SECRET_3}} before you see them. The same value always has the same placeholder. Treat a placeholder as the real value: use it as-is in commands, edits and new files, and AgenticOps Desk fills in the real value on the user's computer just before the tool runs. Never try to reveal, guess or decode a hidden value, and do not report placeholders as a bug. Key, certificate and credential files are blocked; ask the user to check those themselves.`;

// The system-prompt addendum, scrubbed, with the placeholder note when Privacy Mode is on.
export function privateAppend(append: string): string {
  if (!protecting()) return append;
  return `${privacyVault().scrub(append).text}${PLACEHOLDER_NOTE}${credentialNote()}`;
}

// Scrub text bound for a model. Returns it unchanged when Privacy Mode is off.
export function scrubOutgoing(text: string): { text: string; hidden: number } {
  if (!protecting()) return { text, hidden: 0 };
  return privacyVault().scrub(text);
}

export function restoreIncoming(text: string): string {
  if (!protecting()) return text;
  return privacyVault().restore(text);
}

export function isLocalProvider(id: ProviderId): boolean {
  if (id !== "ollama") return false;
  try {
    const host = new URL(providerBaseUrl(id)).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

export const LOCAL_ONLY_MESSAGE =
  "Local only is on (Settings › Privacy), so this chat can't use a cloud model. Pick an Ollama model running on this computer, or change the privacy setting.";

// What Settings shows: counts and masked pinned values, never the values themselves.
export function privacyStatus() {
  const v = privacyVault();
  return {
    mode,
    stored: v.size,
    encrypted: safeStorage.isEncryptionAvailable(),
    pinned: v.pinnedValues().map((value, index) => ({ index, masked: mask(value) })),
  };
}

function mask(value: string) {
  if (value.length <= 4) return "•".repeat(value.length);
  return `${value.slice(0, 2)}${"•".repeat(Math.min(12, value.length - 3))}${value.slice(-1)}`;
}

export function pinSecret(value: string) {
  if (typeof value !== "string") return privacyStatus();
  privacyVault().pin(value);
  return privacyStatus();
}

export function unpinSecret(index: number) {
  const v = privacyVault();
  const value = v.pinnedValues()[index];
  if (value !== undefined) v.unpin(value);
  return privacyStatus();
}

export function forgetPlaceholders() {
  privacyVault().clear();
  return privacyStatus();
}
