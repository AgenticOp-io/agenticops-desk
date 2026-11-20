# Architecture

How AgenticOps Desk is built, for anyone changing it. Rules for agents working in this repo are in [`AGENTS.md`](../AGENTS.md). Security reasoning is in [SECURITY.md](./SECURITY.md).

## Overview

An Electron app with three layers:

```
Renderer (React, src/)            the window; no Node access
   │  window.desk.*  (electron/preload.ts)
Main process (electron/)          state, secrets, git, agent runs
   │
   ├─ Claude Code engine ── agent SDK ── Claude Code binary
   ├─ Direct engine ─────── provider APIs (Claude API, OpenAI-compatible, Ollama)
   ├─ git and gh ────────── project repos, sync repository
   └─ %APPDATA%\AgenticOps Desk   all app data
```

Nothing is written into a project folder by the app itself. Chats, transcripts and briefings stay in app data or the prompt.

## Main process modules

| Module | Role |
|---|---|
| `main.ts` | Window, tray, IPC handlers, workspace watcher, startup and timers |
| `preload.ts` | The renderer's whole API |
| **Engines** | |
| `claude.ts` | Claude Code runs: streaming, approvals, tool hooks, resume after restart |
| `capsules.ts` | Verified run records per chat (Intelligence Shorthand IS-T3), fed into the handoff brief; dropped when their files change. Also the running chat summaries the Summaries model writes after each run |
| `localModel.ts` | Local notes model: downloads llama.cpp's `llama-server` and the GGUF chosen in Settings (`localModelId`: brief notes, more detail, code heavy, or none) from Ollama's registry into `userData/llama`. Ready only when `/v1/models` lists that model. The installer's box leaves `local-model-setup.json`, which the first normal start consumes |
| `resourceGuard.ts` | Memory and CPU cap for that server: refuses to start without 3 GB spare, two threads, idle priority off the app's cores, and stops the server if free RAM drops under 1.5 GB. Python opened by the agent, the terminal, or a check is capped at two threads, kept off the app's cores, and stopped when memory is low, the window freezes, or the app quits |
| `claudeBinary.ts` | Finds or downloads the agent SDK and the binary for this computer; installers carry neither |
| `direct.ts` | Own agent loop and tools for API providers |
| `directMcp.ts` | MCP servers for Direct runs: config from `.mcp.json` and `~/.claude.json`, start, list tools, call, idle stop |
| `worktrees.ts` | A chat's own git worktree and branch: create, merge back, remove |
| `providers.ts` | Provider presets and encrypted keys |
| `autoRoute.ts` | The Auto model. Watches events through `setSendFilter` in `claude.ts` |
| `team.ts` | Manager chats. Gives a manager's Claude Code runs the in-process `desk` tools (`setToolServers` in `claude.ts`), watches workers through `onChatEvent`, and asks the window to start or message workers (`team:start`, `team:send`), so a worker is an ordinary chat. Saved in `team.json` |
| `opsTools.ts`, `opsTriage.ts`, `imageVision.ts`, `imageGen.ts` | The in-process `ops` tools every chat gets: local triage of a read-only git or gh command, image-to-text (local vision first), and OpenAI image generation (PNG to `userData/images`) |
| `activityLog.ts` | Append-only log of runs, tool and git operations, approvals and errors: labels and outcomes only. Shown in Settings → Activity log |
| `quickEdit.ts`, `review.ts`, `briefing.ts` | Quick edit and autocomplete, Second opinion, catch-up and morning briefings |
| **Permissions and safety** | |
| `gate.ts`, `allows.ts` | Folder trust and the commands that still ask |
| `orders.ts` | Standing orders and protected paths |
| `redact.ts`, `privacy.ts` | Finding secrets, the placeholder vault, Privacy Mode |
| `credentials.ts`, `credentialHelpers.ts` | Saved logins and the helper programs |
| **Data** | |
| `library.ts` | Projects and chats. Every `library.json` change goes through `withLibrary` |
| `jsonStore.ts` | `writeJsonAtomic`, serialized writes |
| `settings.ts` | `settings.json`, normalized on load |
| `memory.ts`, `memoryPath.ts` | Memory folders and the system-prompt addendum |
| `deskSync.ts` | Sync, repository creation, linking and cloning repos |
| `cursor.ts`, `cursorConvert.ts`, `cursorLink.ts`, `cursor-plugin/` | Cursor import, conversion, and archive integration |
| `ideImport.ts` | Claude Code terminal sessions and VS Code chats into the library |
| **Other** | |
| `features.ts` | `run` and `runGit`, git panel, terminal, project docs, update check |
| `plugins.ts` | `claude plugin` commands |
| `watch.ts`, `provenance.ts` | Log watches, and which chat changed which file |
| `patcher.ts`, `tarMember.ts` | Signed code patches, and the full setup checked against the signed manifest |
| `pureFeatures.ts` | Logic with no Electron dependency, so plain Node can unit test it. `staysInside` reads the disk to follow links |

The renderer's main files: `App.tsx` (sidebar, chat pane, settings), `Composer.tsx`, `Conversation.tsx`, `Dock.tsx`, `Canvas.tsx` (the Canvas popup, this same page opened with `?canvas=<chatId>`; shows what the agent's `show_canvas` tool sent, sandboxed; the document lives in `canvas/<chatId>.json` through `electron/canvas.ts` and syncs with the chat in `deskSync.ts`; PDF and PNG via `canvas:export` in `main.ts`), `ActivityLog.tsx`, `CodePane.tsx`, `Windowed.tsx` (virtualized sidebar), `SyncSettings.tsx`, `SavedLogins.tsx`, `PrivacySettings.tsx`, `Plugins.tsx`, `Help.tsx`.

`boot/boot.mjs` is the packaged entry point. It chooses between the installed code and a patch, and falls back if a patch fails to open a window.

`build/installer.nsh` adds the Windows setup's three pages (where chats live, importing Cursor and other tools, and the local Summaries model) and runs the app with `--apply-install`.

## App data

All under `%APPDATA%\AgenticOps Desk`, or `AGENTICOPS_DESK_DATA` when set.

| Path | Contents | Synced |
|---|---|---|
| `library.json` | Projects, chat rows, deletions, merges | As `projects.json`, `chats.json`, `deleted.json`, `project-merges.json` |
| `threads\<id>.json` | Each chat's messages | Hidden copy |
| `settings.json` | Preferences | Portable subset |
| `memory\` | Global and organization memory | Yes |
| `credentials.json`, `providers.json`, `privacy-vault.json` | Encrypted secrets | No |
| `bin\`, `run\` | Login helpers, one-time secret files | No |
| `sync-config.json`, `desk-sync\` | Sync address and its working clone | n/a |
| `allows.json` | Folder trust | No |
| `claude-sessions.json`, `direct\` | Engine session state and Direct history | No |
| `activity.jsonl` | Activity log: labels and outcomes only, no prompts or secrets (`activityLog.ts`) | No |
| `usage.json` | Tokens and cost per day, source and model (60 days), plus the last plan-limit reading (`usageLog.ts`) | No |
| `capsules.json` | Verified run records per chat (last 12) | No |
| `chat-summaries.json` | Running summary per chat and how many turns it covers | No |
| `local-model-setup.json` | Left by the setup's local-model box; the next normal start deletes it and runs `setupLocalModel` | No |
| `claude-code\` | Downloaded agent SDK (`sdk.mjs`) and binary, per SDK version | No |
| `orders\`, `watches.json`, `provenance.json` | Standing orders, log watches, file origins | No |
| `cursor-archive\`, `cursor-converted.json`, `cursor-import.json` | Cursor import state | Partly, by Cursor mode |
| `backups\` | `library.json` and settings copies taken before cleanups | No |
| `install-choices.json`, `install-result.txt` | The setup's answers until the app applies them, and the line the setup prints | No |
| `worktrees\`, `worktrees.json` | Chats' own worktrees, and which chat has which | No |
| `mcp-approvals.json` | Project MCP servers the user allowed, by folder and exact entry | No |
| `tools-import.json` | When Claude Code and VS Code chats were last imported | No |

Project memory lives in Claude Code's folder: `~/.claude/projects/<encoded-path>/memory`. `memory.ts` also regenerates `chats-index.md` and `chats-train.jsonl` there from the newest 300 chats (`writeChatIndex`). A chat's memory addendum is built once and kept (`frozenMemory` in `claude.ts`) until the cache-expiry note at `RESUME_TTL_MS`, so it doesn't change the cached prompt prefix mid-chat. `settings.maxWorkers` (1–20) caps a manager's running workers (`team.ts`). Project folders on disk are per computer.

## Key flows

### A message

1. `App.tsx` saves the thread with `entered: true`, which schedules a sync, then calls the run IPC.
2. The run starts on the chat's engine, or through `autoRoute.ts`. Memory and standing orders go in the system prompt, through `privateAppend`.
3. Events stream back to the renderer as `ClaudeEvent`s: `status`, `tool`, `thinking`, `line`, `approval`, `changes`, `done`. Thinking is the model's reasoning, shown in the round and kept out of the text sent back on the next command.
4. The renderer saves the thread on a timer. Those saves schedule a sync with a 30-second wait (`SYNC_WHILE_WORKING`), and the save at `done` is another entered save.

### Tool hooks (Claude Code engine)

In `claude.ts`, under `hooks`:

- **PreToolUse, Bash and PowerShell:** restore placeholders, block secret files, check logins (`approveLogins`), ask permission, fill logins (`fillCredentials`), then `wrapCommand`, so a failing command's output still goes through the scrub.
- **PreToolUse, edits:** apply protected paths, snapshot the file for undo, and restore placeholders.
- **PostToolUse, every tool:** scrub the output before the agent sees it.
- **Stop:** standing-order checks run when the run changed files. A failure blocks the finish and goes back with the output, up to `maxFixes` times.

`direct.ts` does the equivalent in `runPrivateTool` and `runTool`, and runs the same checks through `orderFeedback` before a turn with no tool calls ends.

### Folder boundary

`staysInside` in `pureFeatures.ts` resolves links and junctions with `realpath`. A file that doesn't exist yet is judged by its nearest existing parent. `resolveIn` in `direct.ts` and `inWorkspace` in `main.ts` use it, so the agent's file tools and the editor's IPC can't reach outside the folder through a link. `insideFolder` in `gate.ts` is a string check that only decides whether to ask; it stays free of Node.

### Steering a Direct run

A message sent while a Direct run is going sets `session.guide`. For DeepSeek it also aborts `session.steer`, which cancels the HTTP call and any `run_command`, `web_fetch` or check in flight (`stopSignal`). The loop then adds the guide as the next user message. Only that abort is treated as a steer. Any other error from the call ends the run with the error. `session.abort` still stops the whole run.

### Own worktree

`worktrees.ts` runs `git worktree add` into `worktrees\<chat id>` on branch `desk/<id>`. `runFolder` in `main.ts` sends a chat's runs there when its worktree belongs to the folder the chat runs in. `runClaude` already starts a fresh session when the folder changes, with the chat's history. Merge commits in the worktree and runs `merge --no-ff` in the project folder, aborting on a conflict. `canTouch` and `fs:write` also accept files under `worktrees\`, so the change bar and editor work there.

### MCP on Direct

`mcpToolsFor` in `directMcp.ts` merges user, project and local entries as Claude Code does. An entry from `.mcp.json` needs an approval, asked with the `login` gate so folder trust can't answer it, and remembered by a hash of folder, name and entry. Connections are cached per entry and closed after 15 minutes unused or at quit. Tools are named `mcp__server__tool` (`mcpToolName`), offered next to the built-in ones, and go through `allowed` like any tool; `readOnlyHint` tools pass in Plan mode.

### Install

1. The setup writes `install-choices.json` (`{"storage":"github"|"hybrid"|"local","importCursor":bool,"importTools":bool,"localModel":bool}`) and waits on `--apply-install`.
2. `applyInstallChoices` in `main.ts` reads and deletes the file, imports Cursor or writes the skip marker, imports other tools' chats if asked (`importOtherTools`), writes `local-model-setup.json` if a local model was asked for, runs `ensureGitHubLogin` for Git and Hybrid, then `chooseChatStorage`.
3. The result line goes to `install-result.txt` for the setup to print. A non-zero exit stops the setup.
4. When the app is already open, `--apply-install` can't take the single-instance lock. It leaves the file in place, and the next normal start applies it.

### Handoff brief, capsules and summaries

A follow-up (`shouldHandOff` in `pureFeatures.ts`, true whenever the message has earlier turns) does not resume the session and does not send the transcript. `withBrief` in `claude.ts` builds the opening message. A review round and an interrupted run pass no history, so they keep the session. An interrupted run idle longer than `RESUME_TTL_MS` asks the user to send again.

1. `capsulesBrief` (`capsules.ts`) lists the chat's verified runs: a run whose checks (type check, tests, lint, build, commit) passed after its last edit leaves a capsule with the request, the outcome and the changed files' hashes. A capsule whose files have changed since is left out.
2. `ensureSummary` returns the chat's running summary when it covers every turn so far. Otherwise `summarizeRun` asks the Summaries model, or `direct:ollama:` plus `LOCAL_MODEL` when that setting is empty, to write one. The call gives up after 30 seconds. `sessionBrief` then clips the first request and the latest turns.
3. After each run, `refreshSummary` merges the new turns into the summary and shortens a long capsule outcome. Text goes through `scrubOutgoing` first. A failure keeps the plain brief. The Direct engine drops its saved message list on a follow-up and uses the same brief.
4. `chooseLearned` (`modelLearn.ts`) picks Sonnet or Opus for the chat from `model-learn.json` and one local call. A local recommendation still runs on Sonnet. A menu change away from the last pick is kept and counted, including an explicit local model. Auto skips this and tries the signed-in agent before any local model. `noteLearned` records the run’s model, a prompt prefix, and its cost when the run ends.
5. `paidPacket` (`gather.ts`) adds git status and a local summary to the prompt. A PostToolUse hook replaces a long read, search, or command result with `shrinkGatherResult`. Past `COMPACT_REREAD` cache-read tokens the run starts a fresh session from `continuationPacket`. Images go through `imagesToText` first. An empty reviewer setting uses the local model. Sonnet and the local model run at low effort. Opus does not.

### Local model setup

`setupLocalModel` in `localModel.ts`, one at a time, progress sent as `localModel:status`:

1. If `llama-server` is missing, download the CPU build for this computer into `userData/llama/server` and check its sha256 while it downloads.
2. If `model.gguf` is missing, download `LOCAL_MODEL` from `registry.ollama.ai` into `userData/llama/model.gguf` and check its sha256 while it downloads.
3. Start `llama-server` on `127.0.0.1:11434` with that file only when free RAM can hold the model and still leave 3 GB. It is not detached, and quit kills it. It runs at idle priority on at most two threads, off the app's first two CPU cores, with a small batch and no GPU. A watch stops it if free RAM falls under 1.5 GB, and a frozen window stops it immediately. Setup waits up to three minutes. The server is ready only when `GET /v1/models` lists `LOCAL_MODEL`. If something else is already on that port and does not list the model, setup stops and says so. A chat that wants a local completion does not wait on a cold start: it falls back, and the server keeps starting in the background only when the budget allows.
4. `pullProviderModels("ollama")`, then `patchSettings({ summarizer: "direct:ollama:<model>" })`.

### Saved login

`planCredentials` in `pureFeatures.ts` is the pure part. It turns a command naming logins into one that doesn't contain secrets, plus a list of variables to load. `fillCredentials` writes the one-time files and prepends the shell lines. `Vault.sealed` stops a saved value being filled in through a placeholder.

`credentials.ts` and `privacy.ts` import each other. Each only calls the other at run time, so this is safe, but don't add top-level calls across them.

### Sync

`doSync` in `deskSync.ts`, one at a time through `oneAtATime`:

1. `ensureRepo`: create or fix the clone, `fetch --prune`, pull. A non-chat clone facing an empty repository is renamed aside, not published. A pull that fails, or a rebase an older version left stopped, ends in `takeRemote`: reset to `origin/main`.
2. Merge settings, projects and merges. Link local repos, once per app run.
3. Merge chats (`mergeChats`), threads and memory. Threads in both places merge by message (`mergeThreads`); a thread goes up through `hideThreadForSync`.
4. Write sorted snapshots, so the files are the same whichever computer wrote them.
5. Commit, then push. Commits that are already there but not yet pushed go up too. On a rejected push, `takeRemote` and run steps 2–5 again, up to three times. Never force.

The clone is a snapshot built from this computer's library, threads and memory, which stay where they are. That is why dropping its commit for the other computer's loses nothing.

The project ID is the identity. Remotes are only a clue used to recognize a clone (`matchSyncedProjects`, `matchLocalRepos`), and a match needs to be free of doubt.

### Sidebar

`groups` joins projects and chats. `archivedKeys` decides the archive from `lastUsedAt` and `prefs.projectArchive` (`"in"` is archived by hand, a time is when it was brought out). `sideRows` flattens this into rows for `Windowed`. Row heights come from `sideRowHeight` and must match the CSS.

`lastUsedAt` comes from `lib.lastUsed` and chat use. Being added to the list doesn't count as being opened, because a bulk import would date every row at once.

## Building and testing

```powershell
npm install
npm run dev                     # dev server and app
npx tsc --noEmit                # types
npm test                        # unit tests
npx vite build; npm run smoke   # click-through of the built app on throwaway data
```

When testing on a copy of real data, read `AGENTICOPS_DESK_DATA` carefully. It doesn't isolate everything: on Windows the home folder still comes from the system (`app.setPath("home", ...)` fixes it), and a copied `settings.json` keeps `lastWorkspace`, so a Save in the Instructions panel writes to the real project.

To fake a git remote that looks like GitHub, use an `ssh://git@github.com/...` address with `GIT_SSH_COMMAND` pointing at a script that runs `git upload-pack` or `receive-pack` on a local bare repository. `insteadOf` doesn't work, because it also changes what `git remote get-url` returns.

**Dev instance:** saving a file under `electron/` rebuilds the main process, and the app restarts itself once no chat is running. `src/` changes hot-reload. `dist-electron/main.js` is only a stub; the code is in a hashed chunk beside it.

**Working on this repo under Privacy Mode:** a numbered placeholder typed into a file edit is filled in with the real value before the file is written. Write `{{SECRET_n}}` in docs, or join the string in code and tests.

## Releasing

1. Bump `version` in `package.json` and the lockfile. Use a plain `X.Y.Z`: the patch manifest takes its version from there, and `patchRefusal` only accepts that form. Beta is the GitHub prerelease flag, not part of the tag.
2. Commit, tag `vX.Y.Z` on that commit, and push both.
3. (Tags no longer start the workflow; releases are built locally, see below. This describes the manual run.) The **Release** workflow creates a draft release, and each of the Windows, macOS and Linux builds (both chip types; Windows also signs the patch) attaches its files to it. Once all three succeed, the draft becomes a **beta** prerelease and every older release is deleted (their git tags stay). A failed build leaves the draft unpublished and the older release in place. The builds use no Actions artifacts: on a Team plan their 400 MB files overran the 2 GB storage quota, and a full quota fails every build until the billing month resets. Installed copies read the private repository with the GitHub CLI sign-in on that computer.
4. A beta is visible to installed copies. They read git tags with `gh auth token` (`checkForUpdate` in `features.ts`), then download the patch. A draft is not.

Runtime packages that Vite bundles (`openai`, React, Monaco, KaTeX) stay in `devDependencies`. Only `dependencies` are copied into the installer, and there are none: the agent SDK is a dev dependency that a packaged app downloads (`loadAgentSdk`). The main build keeps it and `node:sqlite` external.

An installed app takes the patch only if `shell` in its manifest matches: the Electron version and `dependencies`. Changing either means that release needs the full installer. `make-patch.mjs` also puts each `-win-<arch>-setup.exe` and its SHA-256 in `installers`, so **Download and install** (`installFullUpdate`) can check the unsigned setup against the signed manifest before running it with `/S --force-run`. The signing key is the `PATCH_SIGNING_KEY` secret and the release computer's `~/.agenticops-patch-key`. If it is lost, make a new pair and ship one full install (last done for 0.1.44).

`scripts/release-local.ps1` releases without GitHub Actions: it builds a clean clone of the tag, Windows on this computer (Linux AppImages in WSL only with `-Linux`) (`scripts/build-linux-wsl.sh`, needs Node in `~/.local/node`), then uploads, publishes and keeps the three newest releases. It cannot build macOS.

CI (`.github/workflows/ci.yml`) runs types, tests, build and smoke on Windows for every push to `main`.
