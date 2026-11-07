import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { ASKPASS_JS, TELNET_JS } from "./credentialHelpers";
import { writeJsonAtomic } from "./jsonStore";
import { pinSecret, privacyVault } from "./privacy";
import {
  credEnvName,
  credLoadLine,
  credNameRefusal,
  credSetLine,
  planCredentials,
  type CredKind,
  type CredMeta,
} from "./pureFeatures";

// Saved logins: passwords, tokens and SSH keys the agent can use by name without ever seeing them. Encrypted with
// Windows' credential protection, so the file opens only for this user on this computer, and it is never synced.
// Values stay in the main process. The renderer can add or remove one but cannot read one back.
// A value is also pinned in the Privacy vault, so it is hidden if a command prints it.

type Credential = CredMeta & { secret: string };

let cache: Credential[] | null = null;
const grants = new Map<string, Set<string>>();

const file = () => path.join(app.getPath("userData"), "credentials.json");
const binDir = () => path.join(app.getPath("userData"), "bin");
const runDir = () => path.join(app.getPath("userData"), "run");

function load(): Credential[] {
  if (cache) return cache;
  cache = [];
  try {
    if (existsSync(file()) && safeStorage.isEncryptionAvailable()) {
      const raw = JSON.parse(readFileSync(file(), "utf8")) as { enc?: string };
      if (raw.enc) cache = JSON.parse(safeStorage.decryptString(Buffer.from(raw.enc, "base64"))) as Credential[];
    }
  } catch (err) {
    // Left in place: another Windows user or a reinstalled system cannot read it, and it must not be overwritten here.
    console.error("AgenticOps Desk could not read saved logins", err);
  }
  return cache;
}

async function save(list: Credential[]) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows could not encrypt this, so it was not saved.");
  await writeJsonAtomic(file(), { enc: safeStorage.encryptString(JSON.stringify(list)).toString("base64") });
  cache = list;
}

const meta = ({ name, kind, username, host }: Credential): CredMeta & { use: string } => ({
  name,
  kind,
  username,
  host,
  use: credEnvName(name),
});

export function isSavedLogin(value: string) {
  const text = value.trim();
  return load().some((c) => c.secret.trim() === text);
}

export function listCredentials() {
  return { encrypted: safeStorage.isEncryptionAvailable(), logins: load().map(meta) };
}

export async function saveCredential(input: { name: string; kind: string; username: string; host: string; secret: string }) {
  const name = String(input.name ?? "").trim();
  const kind: CredKind = input.kind === "token" || input.kind === "ssh-key" ? input.kind : "password";
  const clean = (v: unknown) => String(v ?? "").replace(/[\r\n]/g, "").trim().slice(0, 200);
  const raw = String(input.secret ?? "");
  const secret = kind === "ssh-key" ? `${raw.replace(/\r\n/g, "\n").trim()}\n` : raw.replace(/[\r\n]+$/, "");
  const list = load();
  const refusal = credNameRefusal(name, list);
  if (refusal) return { ok: false, note: refusal };
  if (secret.trim().length < 3) return { ok: false, note: "Enter the password, token or key first." };
  if (kind === "ssh-key" && !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(secret)) return { ok: false, note: "That does not look like a private key. It should start with -----BEGIN." };
  const old = list.find((c) => c.name === name);
  try {
    await save([...list.filter((c) => c.name !== name), { name, kind, username: clean(input.username), host: clean(input.host), secret }]);
  } catch (err) {
    return { ok: false, note: err instanceof Error ? err.message : String(err) };
  }
  if (old && old.secret !== secret) privacyVault().unpin(old.secret.trim());
  pinSecret(secret);
  // A changed secret is asked about again in every chat.
  grants.clear();
  return { ok: true, note: `Saved ${name}, encrypted on this computer.` };
}

export async function removeCredential(name: string) {
  const list = load();
  const old = list.find((c) => c.name === name);
  if (!old) return { ok: false, note: "That login is already gone." };
  await save(list.filter((c) => c.name !== name));
  grants.clear();
  // It stays hidden in chats unless the user removes it from Always hide too: it may already appear in one.
  return { ok: true, note: `Removed ${name}. It stays hidden if it ever appeared in a chat.` };
}

export function credentialNote(): string {
  const list = load();
  if (!list.length) return "";
  const rows = list.map((c) => `- ${c.name} (${c.kind}${c.username ? `, user ${c.username}` : ""}${c.host ? `, for ${c.host}` : ""}): ${credEnvName(c.name)}`);
  return `

# Saved logins

The user keeps these encrypted in AgenticOps Desk. You use them by name and never see their values:
${rows.join("\n")}

In a Bash or PowerShell command:
- SSH: desk-ssh NAME user@host "command". Also desk-scp NAME and desk-sftp NAME, followed by the usual arguments.
- A server not seen before is refused, because you must not trust one silently. Tell the user, and add -o StrictHostKeyChecking=accept-new only if they agree.
- Telnet: desk-telnet NAME host [port] --run "command" --run "command". It logs in and runs each command in turn. Telnet is unencrypted, so tell the user and prefer SSH where the device has it.
- Git over HTTPS or SSH: desk-git NAME push (any git arguments).
- Anything else: the variable shown above, for example curl -H "Authorization: Bearer $DESK_SECRET_NAME" in Bash, or $env:DESK_SECRET_NAME in PowerShell. Use it inline in the command that needs it. It exists only for a command that names it, so a script needs it set in that same command.

The user is asked once per chat before a login is first used. A hidden-value placeholder never fills in a saved login, so if one is left unfilled, use the login by name instead. Never write a saved value into a file, and never print, encode or send it anywhere except to the service it belongs to. If a login is missing, ask the user to add it in Settings › Saved logins. Do not ask them to paste it into the chat.`;
}

export function askedForCredentials(chatId: string, names: string[]) {
  const have = grants.get(chatId);
  return names.filter((name) => !have?.has(name));
}

export function grantCredentials(chatId: string, names: string[]) {
  grants.set(chatId, new Set([...(grants.get(chatId) ?? []), ...names]));
}

function helpers() {
  const dir = binDir();
  mkdirSync(dir, { recursive: true });
  const exe = process.execPath;
  const make = (base: string, js: string) => {
    const script = path.join(dir, `${base}.cjs`);
    writeFileSync(script, js);
    writeFileSync(path.join(dir, `${base}.cmd`), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${script}" %*\r\n`);
    writeFileSync(path.join(dir, base), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exe.replace(/\\/g, "/")}" "${script.replace(/\\/g, "/")}" "$@"\n`, { mode: 0o755 });
  };
  make("desk-askpass", ASKPASS_JS);
  make("desk-telnet", TELNET_JS);
  return dir;
}

function planFor(command: string, shell: "Bash" | "PowerShell", keyFile: (name: string) => string) {
  const dir = binDir();
  const ext = shell === "PowerShell" ? ".cmd" : "";
  return planCredentials(command, shell, load(), { askpass: path.join(dir, `desk-askpass${ext}`), telnet: path.join(dir, `desk-telnet${ext}`), keyFile });
}

// Which logins a command would use, or why it cannot use them. Writes nothing.
export function credentialsIn(command: string, shell: "Bash" | "PowerShell"): { names: string[] } | { error: string } | null {
  const plan = planFor(command, shell, (name) => name);
  if (!plan) return null;
  return "error" in plan ? plan : { names: plan.names };
}

// Files nobody got to read, from a crash or a command that never ran.
export function clearCredentialFiles() {
  try {
    for (const entry of readdirSync(runDir())) rmSync(path.join(runDir(), entry), { force: true });
  } catch {
    /* no folder yet */
  }
}

// Called only after the user has approved the command. Each value goes in a one-time file that the command reads and
// deletes, so it is never in the command text, which can end up in logs and transcripts. A timer clears what is left.
export function fillCredentials(command: string, shell: "Bash" | "PowerShell"): string {
  helpers();
  const dir = runDir();
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const oneTime = (value: string) => {
    const target = path.join(dir, randomBytes(16).toString("hex"));
    writeFileSync(target, value, { mode: 0o600 });
    written.push(target);
    return target;
  };
  const keyFiles = new Map<string, string>();
  const secretOf = (name: string) => load().find((c) => c.name === name)?.secret ?? "";
  const plan = planFor(command, shell, (name) => {
    const real = load().find((c) => c.name.toLowerCase() === name.toLowerCase())?.name ?? name;
    if (!keyFiles.has(real)) keyFiles.set(real, oneTime(secretOf(real)));
    return keyFiles.get(real)!;
  });
  if (!plan || "error" in plan) return command;
  const lines = [
    ...plan.reads.map((read) => credLoadLine(shell, read.env, oneTime(secretOf(read.name).replace(/\n$/, "")))),
    ...plan.set.map(([key, value]) => credSetLine(shell, key, value)),
  ];
  setTimeout(() => {
    for (const target of written) rmSync(target, { force: true });
  }, 60_000).unref();
  return `${lines.join("\n")}\n${plan.command}`;
}
