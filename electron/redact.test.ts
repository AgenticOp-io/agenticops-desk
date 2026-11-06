import assert from "node:assert/strict";
import { test } from "node:test";
import { commandTouchesSecretFile, hideForSync, hideThreadForSync, isSecretFile, mapStrings, Vault, wrapCommand } from "./redact.ts";

const hidden = (text: string, v = new Vault()) => v.scrub(text).text;

test("a copy leaving this computer hides typed logins and keeps ordinary words", () => {
  assert.equal(hideForSync("dpeterson password123! is the login"), "dpeterson [hidden] is the login");
  assert.equal(hideForSync("ssh in, username ADMIN password PASSWORD, find it"), "ssh in, username ADMIN password [hidden] find it");
  assert.equal(hideForSync("the password is hunter2secret"), "the password is [hidden]");
  assert.equal(hideForSync("my vpn key abc-pin", ["abc-pin"]), "my vpn key [hidden]");
  assert.equal(hideForSync("see {{SECRET" + "_3}} here"), "see [hidden] here");
  assert.equal(hideForSync("- User: `bob`\n- Pass: `Abc123xyz%`"), "- User: `bob`\n- Pass: `[hidden]`");
  assert.equal(hideForSync("Default login: admin / unl0ck"), "Default login: admin / [hidden]");
  assert.equal(hideForSync("mongodb+srv://u:<db_password>@host"), "mongodb+srv://u:<db_password>@host");
  const plain = "add a password reset link. the password field is wrong";
  assert.equal(hideForSync(plain), plain);
  // Applied again on every sync, so the result must not change.
  for (const t of ["username ADMIN password PASSWORD", "password123!", "password: hunter2secret"]) assert.equal(hideForSync(hideForSync(t)), hideForSync(t));
});

test("random-looking words are hidden and code names are kept", () => {
  assert.equal(hideForSync("KEY=aB3dE9xQ2mZ7pL4k and `Xy7Qa2Bn9Kd4Lm1Z`"), "KEY=[hidden] and `[hidden]`");
  for (const name of ["getUserAccountById", "readComposerBubbles", "handleLogin2Factor", "chatLastUsedMap", "HTTP2ServerPush", "4f9a2b7c1d3e5f60"]) {
    assert.equal(hideForSync(name), name);
  }
});

test("a value found once is hidden everywhere in the chat", () => {
  const out = hideThreadForSync([
    { role: "user", text: "password airdata3 on the tower" },
    { role: "assistant", text: "`airdata3` did not help", parts: [{ kind: "text", text: "tried airdata3" }] },
  ]);
  assert.ok(!JSON.stringify(out).includes("airdata3"));
  assert.equal(out[0].role, "user");
  assert.deepEqual(hideThreadForSync(out), out);
});

test("config assignments are hidden and restore exactly", () => {
  const v = new Vault();
  const src = 'DB_PASSWORD=hunter2!\napi_key: "sk_9f8e7d6c5b4a"\nServer=x;User Id=sa;Pwd=S3cr3t;';
  const out = v.scrub(src);
  assert.equal(out.hidden, 3);
  assert.ok(!out.text.includes("hunter2") && !out.text.includes("sk_9f8e") && !out.text.includes("S3cr3t"));
  assert.equal(v.restore(out.text), src);
});

test("the same value gets the same placeholder everywhere", () => {
  const v = new Vault();
  const a = v.scrub("password=hunter22").text;
  const b = v.scrub("the password is hunter22.").text;
  const token = a.split("=")[1];
  assert.ok(b.includes(token));
  assert.equal(b, `the password is ${token}.`);
});

test("known token formats and private keys", () => {
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
  const out = hidden(`token ghp_${"a".repeat(36)} and AKIAABCDEFGHIJKLMNOP\n${key}\nsk-ant-api03-${"x".repeat(30)}`);
  assert.ok(!out.includes("ghp_") && !out.includes("AKIA") && !out.includes("PRIVATE KEY") && !out.includes("sk-ant"));
});

test("URL credentials and bearer tokens", () => {
  const out = hidden("postgres://admin:pa55word@db:5432/app\nAuthorization: Bearer abcdefghijklmnop123");
  assert.ok(out.includes("postgres://admin:{{SECRET_"), out);
  assert.ok(!out.includes("pa55word") && !out.includes("abcdefghijklmnop123"));
});

test("network device configs", () => {
  const out = hidden(
    "config vpn ipsec phase1-interface\n    set psksecret ENC kQ9x2mPz/Ab==\n    set password ENC Zm9vYmFy\nenable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0\nusername admin privilege 15 password 0 Cisco123",
  );
  for (const s of ["kQ9x2mPz", "Zm9vYmFy", "hx5rVt7r", "Cisco123"]) assert.ok(!out.includes(s), `${s} leaked:\n${out}`);
  assert.ok(out.includes("set psksecret ENC {{SECRET_"));
});

test("SecureCRT saved passwords", () => {
  const out = hidden('S:"Password V2"=02:7b9f2c1d0e8a4b6c\nS:"Username"=dpeterson');
  assert.ok(!out.includes("7b9f2c1d") && out.includes("dpeterson"), out);
});

test("code and references are left alone", () => {
  const code = [
    "const password = req.body.password;",
    "password: string;",
    "max_tokens = 4096",
    "token_url = https://auth.example.com/token",
    "password_file=/etc/app/pass",
    'secret = os.environ["APP_SECRET"]',
    "PASSWORD=${DB_PASSWORD}",
    "api_key: <your key>",
    "password=********",
    "set password to the one in the vault",
  ].join("\n");
  assert.equal(hidden(code), code);
});

test("pinned values are hidden anywhere, even without a keyword", () => {
  const v = new Vault();
  v.pin("correct horse battery");
  assert.equal(v.scrub("echo correct horse battery").text, "echo {{SECRET_1}}");
  assert.equal(v.restore("echo {{SECRET_1}}"), "echo correct horse battery");
});

test("unknown placeholders stay as they are", () => {
  assert.equal(new Vault().restore("x={{SECRET_99}}"), "x={{SECRET_99}}");
});

test("vault survives a save and load", () => {
  const v = new Vault();
  const t = v.scrub("password=abc123xyz").text;
  const again = new Vault(JSON.parse(JSON.stringify(v.toJSON())));
  assert.equal(again.restore(t), "password=abc123xyz");
  assert.equal(again.scrub("password=abc123xyz").text, t);
  assert.equal(again.scrub("password=newvalue1").text, "password={{SECRET_2}}");
});

test("tool results are scrubbed field by field, images untouched", () => {
  const v = new Vault();
  const img = "A".repeat(400);
  const out = mapStrings({ stdout: "password=hunter2", file: { content: "token: abcdef123" }, source: { data: img } }, (s) => v.scrub(s).text);
  assert.equal(out.stdout, "password={{SECRET_1}}");
  assert.equal(out.file.content, "token: {{SECRET_2}}");
  assert.equal(out.source.data, img);
});

test("secret files", () => {
  for (const f of ["C:\\certs\\server.key", "~/.ssh/id_ed25519", "D:\\FIEL\\x.pfx", ".git-credentials", "vault.kdbx"]) assert.ok(isSecretFile(f), f);
  for (const f of ["src/key.ts", "id_rsa.pub", "README.md", "src/keyboard.tsx"]) assert.ok(!isSecretFile(f), f);
  assert.equal(commandTouchesSecretFile("cat ~/.ssh/id_rsa | head"), "~/.ssh/id_rsa");
  assert.equal(commandTouchesSecretFile('Get-Content ".\\server.key"'), ".\\server.key");
  assert.equal(commandTouchesSecretFile("echo saved credentials here"), null);
});

test("wrapped commands always succeed and report the exit code", () => {
  assert.equal(wrapCommand("Bash", "exit 3"), '(\nexit 3\n)\necho "[exit code: $?]"');
  const ps = wrapCommand("PowerShell", "exit 3");
  assert.ok(ps.endsWith("exit 0") && ps.includes("-EncodedCommand"));
});
