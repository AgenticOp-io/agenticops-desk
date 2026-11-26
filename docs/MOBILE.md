# Phone app (AgenticOps Remote)

Technical reference for the Android app: what it is, how it pairs with a desk, the files it reads and writes on GitHub, the three places it can send work, the native Android code, and how to build and release it. For the user-facing steps, see [FEATURES.md → Sync → Phone](./FEATURES.md#sync). For its security, see [SECURITY.md → Phone app](./SECURITY.md#phone-app).

## Contents

- [What it is](#what-it-is)
- [Files](#files)
- [How it talks to the desk](#how-it-talks-to-the-desk)
- [Signing in](#signing-in)
- [The desk-chats branch](#the-desk-chats-branch)
- [Messages from the phone](#messages-from-the-phone)
- [How the desk takes a phone message](#how-the-desk-takes-a-phone-message)
- [Prompts on the phone](#prompts-on-the-phone)
- [The three send targets](#the-three-send-targets)
- [Secrets on the phone](#secrets-on-the-phone)
- [Alerts while the app is closed](#alerts-while-the-app-is-closed)
- [Screens](#screens)
- [Timings](#timings)
- [Building](#building)
- [Releasing](#releasing)
- [Running it in a browser](#running-it-in-a-browser)
- [Troubleshooting](#troubleshooting)
- [Known gaps](#known-gaps)

## What it is

A remote control for the desk, not a second desk. From the phone you:

- send work to the **desk** (a new chat, or a message in an existing one), to the **cloud agents**, or to an **AI** that runs on the phone itself;
- read chats and see which are running or finished;
- answer what the desk is waiting on: folder trust, risky commands, the agent's questions, and plan approvals;
- stop a running chat.

Everything is set up from the desk's pairing QR: the GitHub sign-in, which projects to show, the API key for the phone's AI, and the cloud-agent login. Nothing is configured on the phone. To change any of it, change it on the desk and scan again.

It is a Capacitor app: the React code in `mobile/` runs in Android's WebView, and a small Java plugin in `android/` adds what the WebView can't do. App ID `io.agenticop.desk`, name **AgenticOps Remote**.

## Files

| Path | Role |
|---|---|
| `mobile/main.tsx` | The app: sign-in, QR scanner (`jsqr`), tabs, inbox, chat view, send view, settings, photo shrinking, dictation |
| `mobile/github.ts` | Everything that talks to GitHub: device-flow sign-in, opening the pairing QR, listing repos, reading the `desk-chats` branch, writing inbox files, and the phone agent's file tools |
| `mobile/agent.ts` | The phone's own agent loop (Haiku first, `escalate` to Sonnet or Opus) |
| `mobile/cloud.tsx` | Cloud-agent jobs: start, list, cancel |
| `mobile/secrets.ts` | The `DeskWatch` plugin binding and the secret store (Keystore on the phone, `localStorage` in a browser) |
| `mobile/mobile.css`, `mobile/index.html` | Phone layout and the page shell. Also uses `src/styles.css` |
| `mobile/vite.config.ts` | Builds `mobile/` into `dist-mobile/` |
| `mobile/github.test.ts` | Pairing QR opens only with the right code |
| `capacitor.config.json` | App ID, name, `webDir: dist-mobile`, and `CapacitorHttp` on, so GitHub's missing CORS headers don't matter |
| `android/app/src/main/java/io/agenticop/desk/MainActivity.java` | Registers the plugin; tracks whether the app is on screen (`visible`) |
| `…/DeskWatchPlugin.java` | Plugin methods: `setup`, `stop`, `status`, `ask`, `open`, `secretGet`, `secretSet`, `cloud` |
| `…/DeskWatchWorker.java` | The background check that posts notifications |
| `…/Vault.java` | AES-GCM sealing under an Android Keystore key |
| `android/app/build.gradle` | Version from `package.json`, APK name `AgenticOps-Remote-<version>-debug.apk` |

The app reuses the desk's own `Conversation` and `ChatMarkdown` components from `src/`, so a chat renders the same as on the desk.

Desk side:

| Path | Role |
|---|---|
| `electron/features.ts` `phonePairQr` | Builds the pairing QR |
| `electron/pureFeatures.ts` `sealPairing`, `newPairCode`, `parsePhoneMessage` | QR encryption, the 8-digit code, and validation of a phone message |
| `electron/deskSync.ts` `syncProjectBranches`, `takeInbox`, `flushJobs`, `flushApprovals`, `noteJobEvent`, `phoneRepoList`, `setPhoneRepo` | The `desk-chats` branch, the inbox, the job log, prompts, and which repos the phone shows |
| `electron/claude.ts` `phoneApprovals`, `answerPhoneApproval` | Which prompts go to the phone, and answering one |
| `electron/pool.ts` `phoneCloudLogin`, `electron/fleet.ts` `fleetPhoneLogin` | The cloud login put in the QR |
| `src/SyncSettings.tsx` | Settings → Sync → Phone: the QR, the code, and the repo list |

## How it talks to the desk

```
 phone ── GitHub REST/GraphQL ──▶ <project repo> : desk-chats branch ◀── git push/pull ── desk (syncProjectBranches)
 phone ── HTTPS, pinned key ────▶ superadmin desk :7377 (cloud agents only)
 phone ── HTTPS ────────────────▶ api.anthropic.com (the phone's own AI only)
```

There is no push server and no relay. The desk and the phone never connect to each other for chats: GitHub is the only channel. That is why the phone works from anywhere, and why a desk message waits for the desk's next sync.

Only projects whose `origin` is a **private** GitHub repository get a `desk-chats` branch (`chatRepoOf`). Public repos and projects with no remote stay in the shared `desk-sync` repository, which the phone does not read.

## Signing in

### With the desk's QR (the normal way)

1. On the desk: Settings → Sync → Phone → **Show pairing code**. The desk needs the GitHub CLI signed in.
2. `phonePairQr` reads the GitHub CLI token (`gh auth token`) and the account's login and numeric ID, and makes an 8-digit code (`newPairCode`).
3. It builds the setup: `ai` (the desk's saved Claude API key, if any) and `cloud` (`{url, token, pin}` from `phoneCloudLogin`, if cloud agents are on or this desk joined a pool).
4. `sealPairing` encrypts `token\n<repos>\n<setup JSON>` with AES-256-GCM under a key from PBKDF2-SHA256(code, random salt, 300,000 rounds). `<repos>` is `phoneRepos()`: the `owner/name` of every desk project on GitHub that is ticked under Settings → Sync → Phone (at most 40), plus repos added there by hand.
5. The QR text is `ADPAIR2 <login> <id> <salt>.<iv>.<ciphertext+tag>` (base64url). Only the image reaches the desk window, never the token. The code shows beside it, and the pair hides itself after two minutes.
6. The phone scans it (`parsePairCode`), asks for the 8 digits, and decrypts (`openPairCode`, WebCrypto). A wrong code fails the GCM tag.
7. `signInWithPairCode` checks the token with `GET /user` and refuses it if the account ID doesn't match the QR. Then it stores the token, the repo list, the API key and the cloud login. What the desk didn't send is cleared, so re-scanning is how the phone's setup changes.

A photo of the QR alone is useless without the code. A photo of the screen with both is not (see [Known gaps](#known-gaps)).

### With GitHub's device flow

Only in builds given an OAuth app client ID (`VITE_GITHUB_CLIENT_ID` in `mobile/.env`). **Sign in with GitHub instead** asks GitHub for a device code with scope `repo read:user`, copies the user code, and opens github.com in the **system browser** (`DeskWatch.open`), never in the app's own WebView, which has no way back. The app polls `login/oauth/access_token` until it is approved. A device-flow sign-in has no repo list, so the app lists every repo the account can reach that has a `desk-chats` branch (GraphQL, up to 2,000 repos), and has no AI or cloud setup.

## The desk-chats branch

Each private project repo has a `desk-chats` branch, written by `syncProjectBranches` on each desk sync, from a separate clone in `userData/project-sync/<project id>/` (never the project folder). It holds only that project's chats.

| Path | Written by | Contents |
|---|---|---|
| `chats.json` | Desk | Chat rows for this project, sorted by ID (`id`, `title`, `updatedAt`, `projectId`, `projectName`, …) |
| `deleted.json` | Desk | Deletion tombstones, `{id: time}` |
| `threads/<chat id>.json` | Desk | Each chat's messages, with secrets replaced by `[hidden]` (`hideThreadForSync`) |
| `canvas/<chat id>.json` | Desk | The chat's Canvas document |
| `jobs/<computer>.jsonl` | Desk | One line `{"chat","ev":"start"|"end","at"}` when a run starts and when it ends. One file per computer, so two desks never conflict |
| `approvals/<computer>.json` | Desk | What that desk is waiting on now (see [Prompts on the phone](#prompts-on-the-phone)). Rewritten every sync, removed when nothing waits |
| `inbox/<uuid>.json` | Phone | One file per phone message. The desk deletes it once delivered |

The merge is the same as `desk-sync`: `mergeChats`, then `mergeThreadFiles`. If another computer pushed first, the desk takes its commit (`takeRemote`) and merges again, once. It never force-pushes.

Job lines wait in `userData/project-sync/<project id>.jobs.jsonl` until the next branch sync appends them (`noteJobEvent`, `flushJobs`).

## Messages from the phone

`sendMessage` in `mobile/github.ts` writes `inbox/<uuid>.json` on `desk-chats` with the GitHub contents API. One file per message, so two phones, or a phone and a desk, never edit the same file. On a `409` (the desk pushed at the same moment) it tries again, up to three times.

The file is `{...message, at}`:

| Field | Meaning |
|---|---|
| `chat` | An existing chat's ID. Absent for a new chat |
| `title` | Title for a new chat (≤ 80 characters) |
| `text` | The message (≤ 50,000 characters). Required unless `approve` or `stop` |
| `image` | A `data:image/jpeg;base64,…` photo under 3 MB. The phone shrinks photos to 1280 px |
| `host` | The computer that should run it: the one that last ran this chat, or this project. Another desk ignores it |
| `approve` | `{request, allow, answers?}` answering a prompt |
| `stop` | `true` to stop the chat's run |

The commit is authored `<login>-mobile <id+login@users.noreply.github.com>`, the same naming as the desk's `-desktop` commits.

## How the desk takes a phone message

`takeInbox`, on each branch sync, for each `inbox/<id>.json`:

1. Skip if this ID was already delivered in this app run.
2. `parsePhoneMessage` validates the shape. Skip if `host` names another computer.
3. If it names a chat this desk doesn't have yet, wait one sync, so the window has the chat first.
4. **`committedByMe`**: look up the commit that last touched the file through `gh api`, and accept it only if its GitHub committer is the desk's own GitHub CLI login. Otherwise delete the file without running it.
5. A photo is saved to `userData/phone-photos/<id>.jpg`, and the text gains `[Photo from the phone: <path>]` so the agent can open it.
6. Hand it to the window (`onPhoneMessage` in `main.ts`):

| Message | Becomes |
|---|---|
| `approve` with `chat` | `answerPhoneApproval` |
| `stop` with `chat` | Stop that chat's run |
| `text` with `chat` | `team:send`: a message in that chat |
| `text` without `chat` | `team:start`: a new chat titled `title` or "From phone", in the project, modeled on its most recently used chat |

7. If the window took it, delete the file; the sync commit then removes it from the inbox. If the window is closed, try again next sync.

So a message runs on the desk's next sync (about 3 minutes, `SYNC_BATCH_MS`), and its reply reaches the phone on the sync after that.

## Prompts on the phone

`phoneApprovals` in `claude.ts` lists, for the project's chats, every open approval **except** those asked with the `login` gate: saved logins and MCP server approvals never go to the phone. Each entry is `{chat, request, summary, detail, tool, questions?}`. A plan (`ExitPlanMode`) carries its full text, up to 20,000 characters; other prompts carry their preview. `flushApprovals` scrubs the text the same way as threads before writing `approvals/<computer>.json`, and keeps the IDs exact so the answer matches.

On the phone, each prompt is a card:

| Tool | Buttons |
|---|---|
| Permission (folder trust, risky command) | **Deny** / **Allow** |
| `AskUserQuestion` | Pick an option per question (multi-select joins labels with `, `), then **Answer** |
| `ExitPlanMode` | The plan rendered as Markdown, **Keep planning** / **Approve plan** |

An answered card hides at once. The answer reaches the desk on its next sync.

## The three send targets

**Send** shows only the targets the desk set up.

### Desk

Pick a project, write, optionally attach a photo or dictate. It becomes an inbox file as above. "Sent, waiting for the desk" lists it until the inbox file is gone.

### Cloud agents

Shown when the QR carried a cloud login with a pin. `startCloudJob` posts to `/user/jobs` on the superadmin desk with the prompt and, if a project is picked, `https://github.com/<owner/name>.git`. Any free agent takes it, on the desk's default model. The list below refreshes every 10 seconds and has **Cancel**. Calls go through `DeskWatchPlugin.cloud`, which trusts only the desk's pinned key, so no certificate is installed on the phone. The phone must be on a network that reaches the superadmin desk. See [CLOUD-AGENTS.md](./CLOUD-AGENTS.md).

### AI

Shown when the QR carried an API key. `runAgent` in `mobile/agent.ts` calls the Anthropic Messages API from the phone, up to 15 rounds of 4,096 tokens:

- Each turn starts on **Haiku**, which answers chat and lookups itself.
- For real work it calls `escalate` with `sonnet` (coding, debugging, multi-file) or `opus` (architecture, a hard bug, a failed attempt). The rest of the turn runs on that model and never steps back down.
- Tools work through the GitHub API on the chosen repo: `list_files` (first 500 files of the default branch), `read_file` (from `phone-work` if the file is there, else the default branch; 60,000 characters), `write_file` (only to a `phone-work` branch, created from the default branch on first write). It can't run code.
- Only text and tool calls are kept in the history, because one model's thinking blocks are refused when replayed to another.

## Secrets on the phone

`mobile/secrets.ts` keeps three values: `gh.token`, `phone.ai` (API key) and `cloud.desk` (`{url, token, pin}`). On the phone they live in `Vault.java`: AES-256-GCM under a non-exportable key in the Android Keystore (alias `agenticops-desk-vault`), stored in their own `SharedPreferences` file. They are read once at start so the getters stay synchronous. Values left in `localStorage` by older builds are moved into the vault once, and the old copy is deleted only after the vault write succeeds. A value that no longer opens (the key was lost, for example after a backup restore to another phone) reads as empty, which signs the app out.

**Sign out** clears the vault, `localStorage` and the background watcher.

## Alerts while the app is closed

Android's WebView has no Notification API, so alerts come from native code.

- On each refresh, the app calls `DeskWatch.setup({token, repos})`. The plugin seals the token with the vault and schedules `DeskWatchWorker` as unique periodic work every 15 minutes, only with a network.
- The worker, for each repo: read the `desk-chats` head. If unchanged, skip. Otherwise read the tree, and post a notification for each prompt in `approvals/*.json` it hasn't seen ("Needs your answer"), and for each `end` line in `jobs/*.jsonl` newer than its last check ("Chat finished", with the chat title from `chats.json`).
- It does nothing while the app is on screen (`MainActivity.visible`), since the app shows its own cards.
- A `401` deletes the token and stops checks until the app signs in again. Other errors retry later, keeping the repos it already read so their alerts don't repeat.
- A fresh setup starts from "now", so chats that ended before the watch began don't alert.
- **Turn on notifications** in Settings asks for `POST_NOTIFICATIONS` on Android 13 and later.

Battery saver and Doze can delay checks past 15 minutes. That is Android's WorkManager, not something the app controls.

While the app is open, it refreshes every 2 minutes when visible, and a chat view every 20 seconds when the chat is running or a message is waiting (60 seconds otherwise). A new prompt vibrates.

## Screens

- **Inbox:** "Needs you" (prompt cards), "Sent, waiting for the desk", "Running" (with the computer), "Finished" (last 30).
- **Chat:** the conversation, rendered with the desk's components; prompt cards for that chat; **Stop the run** while running; a composer.
- **Send:** target (Desk, Cloud agents, AI), project, composer, and cloud jobs or the AI chat.
- **Settings:** what the desk set up and **Scan the desk's code again**; notifications; account and **Sign out**; each desk's computer name and when it last ran a job.

The Android back button walks the WebView history; each screen is one history entry. The header shows the shield logo and "AgenticOps Remote".

A chat is shown as running when its last job line is a `start` less than 6 hours old (a crash leaves no `end` line).

## Timings

| What | When |
|---|---|
| Phone message runs on the desk | Desk's next sync, about 3 minutes |
| Reply visible on the phone | The sync after that, then the phone's next refresh |
| App refresh while open | Every 2 minutes; a chat view every 20 s while running, else 60 s |
| Cloud job list | Every 10 s |
| Background check, app closed | About every 15 minutes, network permitting |
| Pairing QR | Hides after 2 minutes |

## Building

Needs the Android SDK (`ANDROID_HOME`) and a JDK (`JAVA_HOME`).

```powershell
npm run android
```

That runs `vite build --config mobile/vite.config.ts` (into `dist-mobile/`), `cap sync android`, and `gradlew assembleDebug`. The APK is `android/app/build/outputs/apk/debug/AgenticOps-Remote-<version>-debug.apk`.

`android/app/build.gradle` reads `version` from `package.json`: `versionName` is that string, and `versionCode` is `major × 1,000,000 + minor × 1,000 + patch` (0.1.75 → 1075). So the phone app and the desk always carry the same version.

Install on a phone with USB debugging: `adb install -r <apk>`.

For device-flow sign-in, put `VITE_GITHUB_CLIENT_ID=<OAuth app client ID>` in `mobile/.env` before building. The client ID is public, not a secret. Without it, the app offers only the QR.

## Releasing

`scripts/release-local.ps1` builds the APK when the Android SDK is set (from the environment, or the user-level `ANDROID_HOME`/`JAVA_HOME`), with `--no-daemon` so the script returns, and uploads it as `AgenticOps-Remote-<tag>.apk`. It is debug-signed: for sideloading, not the Play Store. Installing a new APK over the old one keeps the sign-in.

## Running it in a browser

`npx vite --config mobile/vite.config.ts` serves the app for layout work. Differences from the phone: secrets are in `localStorage`, not a vault; alerts use the browser's Notification API and only while the page is open; and cloud calls use `fetch`, which needs the desk's certificate installed. GitHub requests may hit CORS, which `CapacitorHttp` avoids on the phone.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Sign in to GitHub on this computer first" on the desk | `gh auth login` on the desk |
| "Wrong code" | The 8 digits don't match this QR. Show a new pair |
| "That code no longer works" | The desk's GitHub token changed. Show a new QR |
| A project is missing | It isn't on GitHub, is public, or is unticked in Settings → Sync → Phone. Add it there and scan again |
| A project shows but is empty | Its `desk-chats` branch doesn't exist yet. It appears after the desk's next sync |
| Message stays "waiting for the desk" | The desk is off, its window is closed, its sync is failing, or `host` names a computer that is off |
| Message vanished without running | It wasn't committed by the desk's own GitHub account (another account's phone) |
| No Cloud agents or AI target | The desk sent no cloud login or API key. Set them up on the desk and scan again |
| Cloud: "Could not reach the desk" | The phone isn't on the superadmin's network, or the address changed. Scan again |
| No alerts with the app closed | Notifications off, battery saver, or the app was force-stopped (Android cancels its work) |
| Signed out by itself | GitHub revoked the token (`401`), or the vault key was lost |

## Known gaps

- **QR and code on one screen.** A photo of the desk screen with both defeats the second factor (`shortcut:` in `pureFeatures.ts`; the upgrade is a TOTP the phone enrolls once).
- **The phone holds the desk's GitHub CLI token**, with that token's full scope, and the desk's Claude API key if one is saved. See [SECURITY.md → Phone app](./SECURITY.md#phone-app).
- **Delivery tracking is in memory.** If a push fails just before the desk quits, a message can run twice (`shortcut:` in `deskSync.ts`).
- **Committer check.** A collaborator who can push to the private repo could forge the committer; they can already change its code (`shortcut:` in `deskSync.ts`).
- **The phone AI doesn't stream** and calls the Messages API with `fetch`, not `@anthropic-ai/sdk` as `AGENTS.md` asks.
- **Android only.** No iOS build.
- **Debug-signed APK.**
