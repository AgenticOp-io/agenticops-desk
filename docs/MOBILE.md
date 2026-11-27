# Phone app (AgenticOps Remote)

Technical reference for the phone app (Android and iPhone): what it is, how it pairs with a desk, the files it reads and writes on GitHub, the three places it can send work, the native Android code, and how to build and release it. For the user-facing steps, see [FEATURES.md → Sync → Phone](./FEATURES.md#sync). For its security, see [SECURITY.md → Phone app](./SECURITY.md#phone-app).

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
- [Building for iPhone](#building-for-iphone)
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

It is a Capacitor app: the React code in `mobile/` runs in the phone's WebView, and a small native plugin, `DeskWatch`, adds what the WebView can't do: Java in `android/`, Swift in `ios/`. Both have the same methods, so the React code is the same on both. App ID `io.agenticop.desk`, name **AgenticOps Remote**.

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
| `ios/App/App/DeskWatch.swift` | The iPhone plugin: keychain secrets, Safari links, the pinned cloud call with the phone's client certificate, and the background check. `DeskViewController` registers it (`Main.storyboard`) |
| `ios/App/App/AppDelegate.swift`, `Info.plist` | Registers the background check at launch; camera, microphone, local network and background-fetch permissions |
| `.github/workflows/ios.yml` | Builds the iPhone app on a Mac runner |

The app reuses the desk's own `Conversation` and `ChatMarkdown` components from `src/`, so a chat renders the same as on the desk.

Desk side:

| Path | Role |
|---|---|
| `electron/features.ts` `phonePairQr` | Builds the pairing QR |
| `electron/pureFeatures.ts` `sealPairing`, `newPairCode`, `openPhoneEnvelope`, `parsePhoneMessage` | QR encryption, the 8-digit code, opening a sealed phone message, and validation of its contents |
| `electron/deskSync.ts` `phoneKey`, `syncProjectBranches`, `takeInbox`, `watchPhoneInbox`, `flushJobs`, `flushApprovals`, `noteJobEvent`, `phoneRepoList`, `setPhoneRepo` | The `desk-chats` branch, the inbox, the job log, prompts, and which repos the phone shows |
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
3. It builds the setup: `sign` (the desk's phone key, see [Sealed messages](#sealed-messages)), `ai` (the desk's saved Claude API key, if any) and `cloud` (`{url, token, pin, key, cert}` from `phoneCloudLogin`, the last two the phone's client certificate as base64 DER, if cloud agents are on or this desk joined a pool).
4. `sealPairing` encrypts `token\n<repos>\n<setup JSON>` with AES-256-GCM under a key from PBKDF2-SHA256(code, random salt, 300,000 rounds). `<repos>` is `phoneRepos()`: the `owner/name` of every desk project on GitHub that is ticked under Settings → Sync → Phone (at most 40), plus repos added there by hand.
5. The QR text is `ADPAIR2 <login> <id> <salt>.<iv>.<ciphertext+tag>` (base64url). Only the image reaches the desk window, never the token. The code shows beside it, and the pair hides itself after two minutes.
6. The phone scans it (`parsePairCode`), asks for the 8 digits, and decrypts (`openPairCode`, WebCrypto). A wrong code fails the GCM tag.
7. `signInWithPairCode` checks the token with `GET /user` and refuses it if the account ID doesn't match the QR. Then it stores the token, the repo list, the phone key, the API key and the cloud login. What the desk didn't send is cleared, so re-scanning is how the phone's setup changes.

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

The file is a sealed envelope (see [Sealed messages](#sealed-messages)). Inside it is `{...message, at}`:

| Field | Meaning |
|---|---|
| `chat` | An existing chat's ID. Absent for a new chat |
| `title` | Title for a new chat (≤ 80 characters) |
| `text` | The message (≤ 50,000 characters). Required unless `approve` or `stop` |
| `image` | A `data:image/jpeg;base64,…` photo under 3 MB. The phone shrinks photos to 1280 px |
| `host` | The computer that should run it: the one that last ran this chat, or this project. Another desk ignores it |
| `approve` | `{request, allow, answers?}` answering a prompt |
| `stop` | `true` to stop the chat's run |

The commit is authored `<login>-mobile <id+login@users.noreply.github.com>`, the same naming as the desk's `-desktop` commits. Its message says only what kind of message it is (`Message from phone`, `New chat from phone`, `Answer from phone`, `Stop from phone`), never the title.

### Sealed messages

Each desk has one **phone key**: 32 random bytes made the first time it shows a pairing QR (`phoneKey` in `deskSync.ts`), kept in `userData/phone-key.json` under the OS credential protection (`safeStorage`), and never synced. The QR carries it as `sign`, and the phone keeps it in its vault as `phone.sign`. Every phone paired with that desk shares it. It is made once, because a new key would unpair every phone.

`sealForDesk` in `mobile/github.ts` encrypts the message with AES-256-GCM under that key, with the file ID (the `<uuid>` in `inbox/<uuid>.json`) as associated data. The file is:

```json
{ "v": 2, "kid": "<first 16 hex of SHA-256(key)>", "iv": "<12 bytes, base64url>", "ct": "<ciphertext + 16-byte tag, base64url>" }
```

So someone else who can push to the repository can't read a message, can't write one the desk accepts, and can't change one or move it to another file name. `kid` tells the desk whether a file is meant for its key at all.

## How the desk takes a phone message

`takeInbox`, on each branch sync, for each `inbox/<id>.json`:

1. Skip if this ID is in `userData/phone-delivered.json` (already handed to the window; kept on disk for 7 days, so a restart never runs a message twice).
2. Skip if this desk has no phone key yet (no phone paired here).
3. **`openPhoneEnvelope`**: if `kid` is another key's, leave the file for the desk that has it. If the file doesn't open, its `at` is more than 7 days old or more than 10 minutes ahead, or `parsePhoneMessage` refuses what's inside, delete it without running it. Old unsealed files are deleted this way too.
4. Skip if `host` names another computer. If it names a chat this desk doesn't have yet, wait one sync, so the window has the chat first.
5. A photo is saved to `userData/phone-photos/<id>.jpg`, and the text gains `[Photo from the phone: <path>]` so the agent can open it.
6. Hand it to the window (`onPhoneMessage` in `main.ts`):

| Message | Becomes |
|---|---|
| `approve` with `chat` | `answerPhoneApproval` |
| `stop` with `chat` | Stop that chat's run |
| `text` with `chat` | `team:send`: a message in that chat |
| `text` without `chat` | `team:start`: a new chat titled `title` or "From phone", in the project, modeled on its most recently used chat |

7. If the window took it, record the ID as delivered, then delete the file; the sync commit then removes it from the inbox. If the window is closed, try again next sync.

A message runs on the next branch sync, which the inbox check below starts within seconds. Its reply reaches the phone on the sync after the run.

### How fast the desk sees it

`watchPhoneInbox` in `electron/deskSync.ts` runs `git ls-remote origin refs/heads/desk-chats` in each project clone every 15 seconds (`INBOX_POLL_MS`). It sends only the branch tip and uses no GitHub API quota. If the tip is neither what this desk last fetched nor its own `HEAD`, it syncs at once instead of waiting for the 3-minute batch. A phone message reaches the desk in about 15–30 seconds while the desk is on.

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

`mobile/secrets.ts` keeps four values: `gh.token`, `phone.sign` (the desk's phone key), `phone.ai` (API key) and `cloud.desk` (`{url, token, pin, key, cert}`). On an iPhone they live in the keychain (`Keychain` in `DeskWatch.swift`: this device only, readable after the first unlock so the background check can use the token; a fresh install wipes what an old install left there). On Android they live in `Vault.java`: AES-256-GCM under a non-exportable key in the Android Keystore (alias `agenticops-desk-vault`), stored in their own `SharedPreferences` file. They are read once at start so the getters stay synchronous. Values left in `localStorage` by older builds are moved into the vault once, and the old copy is deleted only after the vault write succeeds. A value that no longer opens (the key was lost, for example after a backup restore to another phone) reads as empty, which signs the app out.

**Sign out** clears the vault, `localStorage` and the background watcher.

## Alerts while the app is closed

Neither phone's WebView can post notifications, so alerts come from native code.

**iPhone:** `setup` stores the token in the keychain and asks iOS for a background refresh (`BGAppRefreshTask` `io.agenticop.desk.watch`) no sooner than 15 minutes ahead. The check (`DeskWatch.check`) reads the same files as the Android worker and posts the same two alerts. Alerts start from when the app leaves the screen. **Turn on notifications** asks for permission.

**Android:**

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
| Phone message runs on the desk | About 15–30 seconds while the desk is on (`watchPhoneInbox`) |
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

## Building for iPhone

`npm run ios` builds `mobile/` and copies it into `ios/App` (`cap sync ios`). The Xcode project uses Swift Package Manager, so there is no CocoaPods step. The rest needs a Mac with Xcode:

- **Check it compiles:** run the **iPhone app** workflow (`.github/workflows/ios.yml`) by hand on GitHub. Without signing secrets it makes a Simulator build.
- **A signed app for your own iPhones:** add the repository secrets `IOS_TEAM_ID` (Apple Developer team ID), `IOS_API_KEY_ID`, `IOS_API_ISSUER` and `IOS_API_KEY_P8` (an App Store Connect API key with the Developer role). The workflow then archives and exports a development-signed `AgenticOps-Remote-v<version>.ipa` for the team's registered devices, and attaches it to the release named in its `tag` input. Install it with Apple Configurator or Xcode's Devices window.
- **On a Mac directly:** `npm run ios`, then open `ios/App/App.xcodeproj` in Xcode, pick your team under Signing, and run.

`MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` come from `package.json` the same way as the Android version code.

## Releasing

`scripts/release-local.ps1` builds the APK when the Android SDK is set (from the environment, or the user-level `ANDROID_HOME`/`JAVA_HOME`), with `--no-daemon` so the script returns, and uploads it as `AgenticOps-Remote-<tag>.apk`. It is debug-signed: for sideloading, not the Play Store. Installing a new APK over the old one keeps the sign-in.

## Running it in a browser

`npx vite --config mobile/vite.config.ts` serves the app for layout work. Differences from the phone: secrets are in `localStorage`, not a vault; alerts use the browser's Notification API and only while the page is open; and there are no cloud agents, because the desk accepts only a client certificate, which only the native plugin presents. GitHub requests may hit CORS, which `CapacitorHttp` avoids on the phone.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Sign in to GitHub on this computer first" on the desk | `gh auth login` on the desk |
| "Wrong code" | The 8 digits don't match this QR. Show a new pair |
| "That code no longer works" | The desk's GitHub token changed. Show a new QR |
| A project is missing | It isn't on GitHub, is public, or is unticked in Settings → Sync → Phone. Add it there and scan again |
| A project shows but is empty | Its `desk-chats` branch doesn't exist yet. It appears after the desk's next sync |
| Message stays "waiting for the desk" | The desk is off, its window is closed, its sync is failing, or `host` names a computer that is off |
| Message vanished without running | It didn't open with the desk's phone key: sent by an app older than 0.1.77, or the desk's key was replaced. Scan the desk's code again |
| "This phone has no key for the desk" | The phone was paired before 0.1.77. Scan the desk's code again |
| No Cloud agents or AI target | The desk sent no cloud login or API key. Set them up on the desk and scan again |
| Cloud: "Could not reach the desk" | The phone isn't on the superadmin's network, or the address changed. Scan again |
| No alerts with the app closed | Notifications off, battery saver, or the app was force-stopped (Android cancels its work) |
| Signed out by itself | GitHub revoked the token (`401`), or the vault key was lost |

## Known gaps

- **QR and code on one screen.** A photo of the desk screen with both defeats the second factor (`shortcut:` in `pureFeatures.ts`; the upgrade is a TOTP the phone enrolls once).
- **The phone holds the desk's GitHub CLI token**, with that token's full scope, and the desk's Claude API key if one is saved. See [SECURITY.md → Phone app](./SECURITY.md#phone-app).
- **Only the phone's messages are sealed.** Chats, job lines and prompts that the desk writes to `desk-chats` are plain text (with secrets hidden), so anyone who can read the repository reads them. That is the same as `desk-sync`. Keep project repos private.
- **One key per desk, shared by its phones.** There is no way yet to unpair a single phone: a lost phone means revoking the GitHub CLI token, which also stops it reading the branch, and deleting `phone-key.json` on the desk so the next QR makes a new key.
- **The phone AI doesn't stream** and calls the Messages API with `fetch`, not `@anthropic-ai/sdk` as `AGENTS.md` asks.
- **Debug-signed APK.**
- **iPhone: no build on this PC.** An iPhone app needs a Mac to build. `.github/workflows/ios.yml` builds it on a GitHub Mac runner; installing on a real iPhone needs an Apple Developer team to sign it (see [Building for iPhone](#building-for-iphone)). iOS runs the background check when it chooses, often hours apart, and never after the app is swiped away, so iPhone alerts are less dependable than Android's.
- **No push notifications.** There is no push server: alerts come from the phone's own checks of GitHub. Sending Apple or Google pushes would need a server holding the push keys, which this design avoids.
