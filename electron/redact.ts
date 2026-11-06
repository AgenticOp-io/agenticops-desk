// Finds passwords, keys and tokens in text and swaps each for a placeholder like {{SECRET_3}}.
// The same value always gets the same placeholder, so Claude can still tell values apart and
// write them back: restore() puts the real value in on this computer just before a tool runs.

export type VaultData = { next: number; values: Record<string, string>; pinned: string[] };

const TOKEN = /\{\{SECRET_(\d+)\}\}/g;

// Whole matches that are secrets on their own.
const STANDALONE: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{24,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

// Words that mark the value after them as a secret.
const WORD = "(?:password|passwd|pwd|passphrase|passcode|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|psk|pre-?shared-?key|client[_-]?secret|credentials?|community)";
// Names that talk about a secret without holding one: password_file, max_tokens, secret_name, passwordPolicy.
const NOT_A_VALUE_NAME = /tokens|count|len|length|max|min|limit|expir|ttl|timeout|type|name|file|path|url|uri|endpoint|field|label|hint|prompt|polic|reset|rotat|requir|enabl|strength|placeholder|id$|_ids?\b|input|header|env|var/i;
// Values that are references or code, not secrets.
const NOT_A_SECRET =
  /^(?:\*+|x+|•+|\.\.\.|…|null|none|nil|undefined|true|false|string|number|boolean|bool|str|int|any|required|optional|changeme|redacted|hidden|empty|secret|password|token|<[^>]*>|\$\{?[\w:.-]+\}?|%[\w]+%|\$env:\w+|\{\{SECRET_\d+\}\})$/i;
const CODE_LIKE = /^[A-Za-z_$][\w$]*(?:\.[\w$]|\(|\[)|^(?:process\.env|os\.environ|getenv|env\.|config\.|self\.|this\.)/;
const PATH_LIKE = /^(?:[A-Za-z]:[\\/]|\/|~[\\/]|\.\.?[\\/])/;

// key = value, key: value, "key": "value", Password V2"=02:abc (SecureCRT), Pwd=abc; (connection strings)
const ASSIGNED = new RegExp(
  `([A-Za-z0-9_.-]*${WORD}[A-Za-z0-9_.-]*)((?:\\s+V\\d)?["']?\\s*(?::=|=>|[:=])\\s*)(?:"((?:[^"\\\\\\n]|\\\\.){1,512})"|'([^'\\n]{1,512})'|([^\\s;,'"\`<>)\\]}]{1,512}))`,
  "gi",
);
// Device configs: "set psksecret ENC abc", "enable secret 5 abc", "username admin password 0 abc", "key-string abc".
const DEVICE = new RegExp(
  `^([ \\t]*(?:set[ \\t]+|enable[ \\t]+|username[ \\t]+\\S+[ \\t]+(?:privilege[ \\t]+\\d+[ \\t]+)?|snmp-server[ \\t]+)?(?:[A-Za-z-]*${WORD}|key-string|key)[ \\t]+(?:ENC[ \\t]+|\\d[ \\t]+)?)(\\S+)`,
  "gim",
);
// Plain speech: "the password is hunter2", "my PSK was: abc".
const SPOKEN = new RegExp(`(\\b${WORD}\\s+(?:is|was|=|:)\\s*:?\\s*)(["']?)([^\\s"']{3,256})\\2`, "gi");
// user:pass@host in URLs.
const URL_CRED = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]{1,256})@/gi;
// Authorization: Bearer abc / Basic abc
const BEARER = /\b((?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{12,})/g;

export class Vault {
  private next: number;
  private byToken = new Map<string, string>();
  private byValue = new Map<string, string>();
  private pinned = new Set<string>();
  onChange: (() => void) | null = null;

  constructor(data?: Partial<VaultData>) {
    this.next = Math.max(1, Number(data?.next) || 1);
    for (const [token, value] of Object.entries(data?.values ?? {})) {
      if (typeof value !== "string" || !value) continue;
      this.byToken.set(token, value);
      this.byValue.set(value, token);
    }
    for (const v of data?.pinned ?? []) if (typeof v === "string" && v) this.pinned.add(v);
  }

  toJSON(): VaultData {
    return { next: this.next, values: Object.fromEntries(this.byToken), pinned: [...this.pinned] };
  }

  get size() {
    return this.byToken.size;
  }

  pinnedValues() {
    return [...this.pinned];
  }

  pin(value: string) {
    const v = value.trim();
    if (v.length < 3 || this.pinned.has(v)) return false;
    this.pinned.add(v);
    this.tokenFor(v);
    this.onChange?.();
    return true;
  }

  unpin(value: string) {
    if (!this.pinned.delete(value)) return false;
    this.onChange?.();
    return true;
  }

  // Forget every placeholder except the pinned values. Older chats will show placeholders that no longer restore.
  clear() {
    this.byToken.clear();
    this.byValue.clear();
    for (const v of this.pinned) this.tokenFor(v);
    this.onChange?.();
  }

  private tokenFor(value: string): string {
    const known = this.byValue.get(value);
    if (known) return known;
    const token = `{{SECRET_${this.next++}}}`;
    this.byToken.set(token, value);
    this.byValue.set(value, token);
    this.onChange?.();
    return token;
  }

  // Replace secrets with placeholders. Returns the scrubbed text and how many distinct values were hidden.
  scrub(text: string): { text: string; hidden: number } {
    if (!text) return { text, hidden: 0 };
    const seen = new Set<string>();
    const hide = (value: string) => {
      if (!value || value.includes("{{SECRET_")) return value;
      const token = this.tokenFor(value);
      seen.add(token);
      return token;
    };
    let out = text;
    // Pinned values first, longest first, so a value inside another is not split.
    for (const v of [...this.pinned].sort((a, b) => b.length - a.length)) {
      if (out.includes(v)) out = out.split(v).join(hide(v));
    }
    for (const re of STANDALONE) out = out.replace(re, (m) => hide(m));
    out = out.replace(URL_CRED, (_m, head: string, pass: string) => `${head}${keep(pass) ? pass : hide(pass)}@`);
    out = out.replace(BEARER, (_m, head: string, value: string) => `${head}${hide(value)}`);
    out = out.replace(ASSIGNED, (m, name: string, sep: string, dq?: string, sq?: string, bare?: string) => {
      if (NOT_A_VALUE_NAME.test(name.replace(new RegExp(WORD, "i"), ""))) return m;
      if (dq !== undefined) return keep(dq) ? m : `${name}${sep}"${hide(dq)}"`;
      if (sq !== undefined) return keep(sq) ? m : `${name}${sep}'${hide(sq)}'`;
      const v = bare ?? "";
      if (keep(v) || CODE_LIKE.test(v) || PATH_LIKE.test(v) || (/^\d{1,5}$/.test(v) && /token|secret|key/i.test(name))) return m;
      return `${name}${sep}${hide(v)}`;
    });
    out = out.replace(DEVICE, (m, head: string, value: string) => (keep(value) ? m : `${head}${hide(value)}`));
    out = out.replace(SPOKEN, (m, head: string, q: string, value: string) => {
      const v = value.replace(/[.,;:!?)]+$/, "");
      if (keep(v) || CODE_LIKE.test(v) || /^(?:the|a|an|not|set|stored|saved|in|on|from|required|correct|wrong|missing|empty|incorrect|invalid|valid|still|now|also)$/i.test(v)) return m;
      return `${head}${q}${hide(v)}${value.slice(v.length)}${q}`;
    });
    return { text: out, hidden: seen.size };
  }

  // Put real values back in place of placeholders this vault knows.
  restore(text: string): string {
    if (!text.includes("{{SECRET_")) return text;
    return text.replace(TOKEN, (m) => this.byToken.get(m) ?? m);
  }
}

function keep(value: string) {
  return value.length < 3 || NOT_A_SECRET.test(value) || value.includes("{{SECRET_") || value.startsWith("[hidden");
}

// Walk any JSON-shaped value and apply fn to every string. Base64 payloads (images, PDFs) are left alone.
export function mapStrings<T>(value: T, fn: (s: string) => string, key = ""): T {
  if (typeof value === "string") {
    if ((key === "base64" || key === "data") && value.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 4096))) return value;
    return fn(value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn, k);
    return out as T;
  }
  return value;
}

// How logins appear in chats: "user password123!", "username ADMIN password PASSWORD", "Pass: `abc`", "admin / abc".
const TYPED_LOGINS = [
  /\b((?:user(?:name)?|login)\s+\S+\s+(?:password|passwd|pass|pwd)\s+)(\S+)/gi,
  /\b((?:password|passwd|pwd|passphrase)\s+)(\S*[\d!@#$%^&*]\S*)/gi,
  /\b((?:pass(?:word|wd)?|pwd)\*{0,2}\s*[:=]\s*\*{0,2}\s*[`"'])([^`"'\n]+)/gi,
  /\b(pass\*{0,2}\s*[:=]\s*\*{0,2}\s*)([^\s`"']{3,})/gi,
  /\b((?:admin|administrator|root|ubnt)\s+\/\s+[`"']?)([^\s`"',;]+)/gi,
  /()\bpass(?:word|wd)?\d+\S*/gi,
  /\b((?:user(?:name)?|usr|login)\b\s*[:=]?\s*[`"']?[\w.@-]+[`"']?\s*[,/|]\s*[`"']?)([^\s`"',;|)\]]*[\d!@#$%^&][^\s`"',;|)\]]*)/gi,
  /()\b[A-Za-z]{3,}\d{1,6}[!@#$%^&]+/g,
];

// Generated passwords flip between cases and digits far more often than a camelCase name does.
export function looksRandom(word: string): boolean {
  if (!/[a-z]/.test(word) || !/[A-Z]/.test(word) || !/\d/.test(word)) return false;
  return (word.match(/[a-z]+|[A-Z]+|\d+|[^A-Za-z0-9]+/g)?.length ?? 0) / word.length > 0.4;
}

// For a copy leaving this computer: nothing there can put a value back, so this errs towards hiding and keeps no values.
// Placeholders become [hidden] too, because on another computer a placeholder would restore to a different secret.
export function hideForSync(text: string, pinned: string[] = [], found?: Set<string>): string {
  const vault = new Vault({ pinned });
  let out = vault.scrub(text).text;
  for (const re of TYPED_LOGINS) {
    out = out.replace(re, (whole: string, head: string, value?: string) => {
      const secret = typeof value === "string" ? value : whole.slice(head.length);
      if (secret === "[hidden]" || secret.includes("<")) return whole;
      found?.add(secret);
      return `${head}[hidden]`;
    });
  }
  out = out.replace(/[A-Za-z0-9%!@#$^&*+]{12,64}/g, (word) => {
    if (!looksRandom(word)) return word;
    found?.add(word);
    return "[hidden]";
  });
  for (const value of Object.values(vault.toJSON().values)) found?.add(value);
  return out.replace(/\{\{SECRET_\d+\}\}/g, "[hidden]");
}

// A value found once is hidden everywhere in the chat, since agents repeat passwords back.
export function hideThreadForSync<T>(messages: T, pinned: string[] = []): T {
  const found = new Set<string>();
  mapStrings(messages, (text) => hideForSync(text, pinned, found));
  const known = [...pinned, ...[...found].filter((value) => value.length >= 4 && value !== "[hidden]")];
  return mapStrings(messages, (text) => hideForSync(text, known));
}

// Files that are secrets as a whole, often binary, so scrubbing their text cannot help.
const SECRET_FILE =
  /(?:^|[\\/])(?:[^\\/]*\.(?:pfx|p12|key|pem|jks|keystore|kdbx|kdb|ppk|ovpn|asc|gpg|sops)|id_(?:rsa|dsa|ecdsa|ed25519)|\.netrc|_netrc|\.pgpass|credentials(?:\.json)?|\.git-credentials|known_hosts\.old)$/i;
const ALLOWED_FILE = /\.pub$|(?:^|[\\/])(?:package-lock|yarn\.lock)/i;

export function isSecretFile(file: string): boolean {
  const f = file.trim().replace(/^["']|["']$/g, "");
  return SECRET_FILE.test(f) && !ALLOWED_FILE.test(f);
}

// A shell command that names a secret file, e.g. `cat ~/.ssh/id_rsa` or `Get-Content .\server.key`.
export function commandTouchesSecretFile(command: string): string | null {
  for (const raw of command.split(/[\s|;&<>()]+/)) {
    const word = raw.replace(/^["']|["']$/g, "");
    // A bare word like "credentials" is prose; a path or file name is not.
    if (word && (/[\\/.]/.test(word) || /^id_/.test(word)) && isSecretFile(word)) return word;
  }
  return null;
}

// Failed commands skip the output hook, so their output would reach the model unscrubbed.
// Run the command so the shell itself always succeeds and reports the real exit code in the output.
export function wrapCommand(tool: "Bash" | "PowerShell", command: string): string {
  if (tool === "Bash") return `(\n${command}\n)\necho "[exit code: $?]"`;
  // The child starts in the process folder, not the PowerShell location, so carry the location over.
  const child = `Set-Location -LiteralPath $env:DESK_LOC\n${command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`;
  const encoded = Buffer.from(child, "utf16le").toString("base64");
  return [
    `$env:DESK_LOC = (Get-Location).ProviderPath`,
    `$__cd = (Get-Process -Id $PID).Path`,
    `& $__cd -NoProfile -NonInteractive -EncodedCommand ${encoded} 2>&1 | Out-String -Width 4096 -Stream`,
    `"[exit code: $LASTEXITCODE]"`,
    `exit 0`,
  ].join("\n");
}
