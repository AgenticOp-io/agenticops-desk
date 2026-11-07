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
| `claudeBinary.ts` | Finds or downloads the binary for this computer |
| `direct.ts` | Own agent loop and tools for API providers |
| `providers.ts` | Provider presets and encrypted keys |
| `autoRoute.ts` | The Auto model. Watches events through `setSendFilter` in `claude.ts` |
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
| **Other** | |
| `features.ts` | `run` and `runGit`, git panel, terminal, project docs, update check |
| `plugins.ts` | `claude plugin` commands |
| `watch.ts`, `provenance.ts` | Log watches, and which chat changed which file |
| `patcher.ts`, `tarMember.ts` | Signed code patches |
| `pureFeatures.ts` | Logic with no Electron or Node dependency, so it can be unit tested |

The renderer's main files: `App.tsx` (sidebar, chat pane, settings), `Composer.tsx`, `Conversation.tsx`, `Dock.tsx`, `CodePane.tsx`, `Windowed.tsx` (virtualized sidebar), `SyncSettings.tsx`, `SavedLogins.tsx`, `PrivacySettings.tsx`, `Plugins.tsx`, `Help.tsx`.

`boot/boot.mjs` is the packaged entry point. It chooses between the installed code and a patch, and falls back if a patch fails to open a window.

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
| `claude-code\` | Downloaded binary | No |
| `orders\`, `watches.json`, `provenance.json` | Standing orders, log watches, file origins | No |
| `cursor-archive\`, `cursor-converted.json`, `cursor-import.json` | Cursor import state | Partly, by Cursor mode |
| `backups\` | `library.json` and settings copies taken before cleanups | No |

Project memory lives in Claude Code's folder: `~/.claude/projects/<encoded-path>/memory`. Project folders on disk are per computer.

## Key flows

### A message

1. `App.tsx` saves the thread with `entered: true`, which schedules a sync, then calls the run IPC.
2. The run starts on the chat's engine, or through `autoRoute.ts`. Memory and standing orders go in the system prompt, through `privateAppend`.
3. Events stream back to the renderer as `ClaudeEvent`s: `status`, `tool`, `line`, `approval`, `changes`, `done`.
4. The renderer saves the thread on a timer. Those saves schedule a sync with a 30-second wait (`SYNC_WHILE_WORKING`), and the save at `done` is another entered save.

### Tool hooks (Claude Code engine)

In `claude.ts`, under `hooks`:

- **PreToolUse, Bash and PowerShell:** restore placeholders, block secret files, check logins (`approveLogins`), ask permission, fill logins (`fillCredentials`), then `wrapCommand`, so a failing command's output still goes through the scrub.
- **PreToolUse, edits:** apply protected paths, snapshot the file for undo, and restore placeholders.
- **PostToolUse, every tool:** scrub the output before the agent sees it.

`direct.ts` does the equivalent in `runPrivateTool` and `runTool`.

### Saved login

`planCredentials` in `pureFeatures.ts` is the pure part. It turns a command naming logins into one that doesn't contain secrets, plus a list of variables to load. `fillCredentials` writes the one-time files and prepends the shell lines. `Vault.sealed` stops a saved value being filled in through a placeholder.

`credentials.ts` and `privacy.ts` import each other. Each only calls the other at run time, so this is safe, but don't add top-level calls across them.

### Sync

`doSync` in `deskSync.ts`, one at a time through `oneAtATime`:

1. `ensureRepo`: create or fix the clone, `fetch --prune`, pull. A non-chat clone facing an empty repository is renamed aside, not published.
2. Merge settings, projects and merges. Link local repos, once per app run.
3. Merge chats (`mergeChats`), threads and memory. A thread goes up through `hideThreadForSync`.
4. Write sorted snapshots, so the files are the same whichever computer wrote them.
5. Commit, then push. Commits that are already there but not yet pushed go up too. On a rejected push, pull and retry. Never force.

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

1. Bump `version` in `package.json` and the lockfile.
2. Commit, tag `vX.Y.Z` on that commit, and push both.
3. The **Release** workflow builds Windows, macOS and Linux, both chip types, signs the patch, and publishes a **beta** prerelease with every installer. Installed copies read the private repository with the GitHub CLI sign-in on that computer.
4. A beta is visible to installed copies. They read git tags, then download the patch. A draft is not.

An installed app takes the patch only if `shell` in its manifest matches: the Electron version and `dependencies`. Changing either means that release needs the full installer. The signing key exists only as the `PATCH_SIGNING_KEY` secret. If it is lost, make a new pair and ship one full install.

CI (`.github/workflows/ci.yml`) runs types, tests, build and smoke on Windows for every push to `main`.
