# Security

What protects your code and secrets in AgenticOps Desk, and where that protection stops. This describes the current code. It has not had an outside security review.

## What leaves your computer

| Destination | What goes there | When |
|---|---|---|
| The AI provider you picked | Your messages, and files and command output the agent reads, with secrets replaced by placeholders under Privacy Mode | Each run, unless you use Local only |
| Your sync repository | Chats with secrets replaced by `[hidden]`, memory, project names and remotes, some settings | When sync is on |
| GitHub and npm | Update checks, patch downloads, and the Claude Code binary | Periodically, and on first launch |

There is no server of ours, and no telemetry in the app's own code. The Claude Code agent is Anthropic's software and follows Anthropic's terms.

## Where secrets are stored

| Secret | File in `%APPDATA%\AgenticOps Desk` | Protection | Syncs? |
|---|---|---|---|
| Saved logins | `credentials.json` | Encrypted with Electron `safeStorage` | No |
| Direct provider keys | `providers.json` | Encrypted with `safeStorage` | No |
| Placeholder values | `privacy-vault.json` | Encrypted with `safeStorage` | No |
| Chats | `threads\` | **Not encrypted.** Real values can appear in them | Hidden copy only |
| Past-chat files | `chats-index.md`, `chats-train.jsonl` in the project's memory folder | **Not encrypted.** The training file redacts key and token shapes by pattern, so an unusual secret can remain. Read it before training on it | Memory folders sync only where memory sync covers them; check before sharing |

On Windows, `safeStorage` uses DPAPI, which ties the data to your Windows account. It protects against someone reading the files from another account, or from a copied or stolen disk without your Windows login. It does **not** protect against software running as you.

If encryption isn't available, saved logins and provider keys refuse to save, and placeholders stay in memory until the app restarts.

## Privacy Mode

`electron/redact.ts` finds secrets by pattern and by your **Always hide** list, then swaps each for a placeholder (`{{SECRET_n}}`). The same value keeps the same placeholder. `restore()` puts the real value back on this computer just before a tool runs, so the AI can work with a config without seeing the password.

Limits:

- **Detection is pattern-based.** An unusual secret can slip through.
- **Images aren't filtered.**
- **The AI can have any hidden value used in a command or file**, by writing its placeholder. Placeholder numbers are sequential, so they can be guessed. This is how the feature works, and it applies to everything hidden except saved logins, which are sealed (below).
- **A filled-in value lands wherever the agent put it**, including a file in your project.

## Saved logins

Designed so an agent can use a secret without seeing it, and you decide when it may.

**How a login is used**

1. The agent writes a command that names the login, such as `desk-ssh core-router admin@host "uptime"`, or uses `$DESK_SECRET_CORE_ROUTER`.
2. The app asks you, once per chat for each login. This applies in trusted folders too, and a changed value is asked about again.
3. Only then, the value goes in a randomly named one-time file under the app's `run` folder. The command reads it into an environment variable for that command alone, and deletes it.
4. For a password, a small helper in the app's `bin` folder answers `ssh` or `git` from that variable. An SSH key stays in its file for about 60 seconds, since `ssh` needs to read it there. A key's passphrase is answered by the same helper, so it counts as the command's one password.
5. Command output is scrubbed before the agent sees it. Saved values are on the Always hide list.

**What this gives you**

- The agent receives names, not values.
- Secrets stay out of command text, which can end up in logs and transcripts.
- The window can add or remove a login, but no function can read one back.
- **Sealed:** a saved login's placeholder never fills in, so guessing a placeholder number can't get around the prompt.
- Unknown SSH servers are refused, since a helper won't answer a question about trusting one.
- Leftover one-time files are removed at the next start.

**What it does not protect against**

- **A hostile command you approved, or any later command that names the login in that chat.** The hiding catches the exact value only. A command could base64-encode the secret and send it elsewhere. Approval is once per chat, so it trusts the whole chat from that point. Be careful after an agent has read untrusted files, web pages or plugin output, since those can carry instructions.
- **Malware or another program running as you.** It can read the one-time files during their short life, and can ask Windows to decrypt the stored file just as the app does.
- **File permissions on Windows.** The restrictive mode set on one-time files has little effect there. They rely on the normal protection of your user folder.
- **Telnet.** It sends the password across the network unencrypted, where anyone on that network can read it.
- **Server identity beyond first use.** After you accept a host key, that trust follows OpenSSH's usual rules.
- **Memory.** Values are held in the app's memory while it runs, and aren't wiped.

Removing a login leaves it on the Always hide list, because it may already appear in a chat. Remove it there as well if you want it to stop being hidden.

## The app itself

- **Renderer isolation:** the window talks to the main process through `electron/preload.ts`. API keys and saved logins stay in the main process.
- **Permissions:** see `electron/gate.ts` and `electron/allows.ts`. A trusted folder runs ordinary commands without asking, including deletes, pushes and network calls. Trust a folder only if you would let the agent do those things there.
- **Folder boundary:** file reads and writes follow the real path. A shortcut inside the project cannot place an edit outside it. A shell in a trusted folder still can.
- **Credential files:** with Privacy Mode on, commands and reads naming key, certificate and credential files are blocked. The check is on the file's name in the command, so a script that opens one indirectly isn't caught.
- **Team rules:** a repository's `.agenticops/orders.json` can add rules and protected paths, but its `checks` are ignored, so cloning can't run commands. Checks you save yourself run on both engines.
- **Dependencies:** The app runs on Electron 45. `npm audit` still reports advisories in the DOMPurify copy inside Monaco 0.57, KaTeX's math plugins, and electron-builder (build-time only). Monaco and KaTeX run in the window. There is no forward fix for them yet, so `npm audit fix --force` is not used: it would downgrade packages.
- **Plugins:** a plugin runs with the agent's permissions. Install ones you trust.
- **MCP servers on Direct:** a server runs as a program with your permissions. One listed in a project's `.mcp.json` arrived with the repository, so it starts only after you approve it, and an edited entry asks again. Folder trust can't give that approval. Servers from your own user settings start without asking, as they do on the default engine.
- **Own worktree:** a chat's worktree sits in the app's data folder, and the editor and change bar may write there as they do in the project.
- **Updates:** patches are verified against an Ed25519 public key built into the app, with a SHA-256 check for every file. **Download and install** checks the full setup's SHA-256 against the same signed manifest before running it. The private key exists only as the `PATCH_SIGNING_KEY` GitHub secret and `~/.agenticops-patch-key` on the release computer. The private repository is read with the GitHub CLI sign-in on this computer. The app does not carry a token.
- **Binary download:** the Claude Code binary is checked against npm's SHA-512 fingerprint.
- **Installers are not code-signed**, so Windows and macOS can't vouch for who built them.

## Cloud agents

Details in [CLOUD-AGENTS.md](./CLOUD-AGENTS.md).

- **The desk is its own certificate authority, and TLS is checked both ways.** The desk's CA certificate never changes. It signs the server certificate, which is re-issued with the same key when the address changes, and a client certificate for every agent, worker desk and phone. Clients trust only the desk CA and its public-key pin. The server completes no handshake without a client certificate the desk signed. It then drops the connection, at the handshake and again on every request, unless that certificate belongs to a device or unused join key that is still trusted (`trustedCerts`). A device's token is accepted only together with its own certificate.
- **Agents and the desk never connect.** Jobs go through the agent-jobs branch of a git repository you choose. Every job is signed with the desk's key and every agent file with that agent's key, so someone who can push to the repository can stall jobs but can't make an agent run anything or fake a result. Files are not encrypted: anyone who can read the repository reads every prompt and result. Use a private repository for nothing else.
- **Keys are made on the desk and travel once.** The desk makes each private key and hands it over out of band: in the agent file, the join key or the phone pairing QR. Anyone who copies one of those can act as that agent or device until you remove it. Treat them like SSH keys. The desk keeps no agent private keys. Join-key keys are stored encrypted with the OS credential store until the key is used.
- **Each agent has its own Claude API key**, in its agent file and nowhere on the desk. Give each a spend limit in the Claude Console, and revoke it there when you remove the agent.
- **An agent has no sandbox.** `run_command` is a real shell with that machine user's rights. Run agents under a dedicated account (the Linux package does) or in a VM.

## Phone app

Details in [MOBILE.md](./MOBILE.md).

- **The pairing QR is encrypted** (AES-256-GCM, key from PBKDF2 over an 8-digit code). The QR alone is useless, but a photo of the screen showing both the QR and the code defeats this.
- **The phone holds the desk's GitHub CLI token**, with that token's full scope, plus the desk's phone key, Claude API key and cloud login if those were set up. On Android they are sealed with an Android Keystore key; on an iPhone they are in the keychain, for this device only. **Sign out** clears them; revoke the token on GitHub if the phone is lost.
- **Only a paired phone's messages run.** Each phone message is encrypted and authenticated (AES-256-GCM) under the desk's phone key, which only the desk and the phones scanned from its QR hold, with the file name bound in. Someone else who can push to the repository can't read a message, forge one, edit one, or replay one older than 7 days; the desk also remembers delivered IDs on disk for 7 days. The key sits in `phone-key.json` under the OS credential protection and is never synced. What the desk writes back (chats, job lines, prompts) is not encrypted.
- **Saved logins and MCP server approvals never go to the phone.** Other prompts, including plans, do, with secrets replaced by `[hidden]`.
- **The APK is debug-signed**, for sideloading only. The iPhone app is signed only when you give the build your Apple Developer team.

## Folder deletion

The only way the sidebar removes a project's folder is `project:trash` in `electron/main.ts`. It needs your confirmation in a system dialog with Cancel as the default, and it uses the Recycle Bin. That was tested on a local drive; a network or removable drive may have no bin, so treat a delete there as permanent. It refuses a drive, your home folder, the app's own folders, a folder holding other projects, and anything with a running chat.

## If something leaks

1. Change the secret at its source. Hiding or deleting it afterwards doesn't undo exposure.
2. Replace it in **Settings → Privacy & logins → Saved logins** or **Settings → AI models → Direct AI providers**.
3. If it reached the sync repository, remember that git keeps history. Treat it as exposed even after the file is fixed.

## Reporting a problem

Contact AgenticOp-io through [agenticop.io](https://agenticop.io).
