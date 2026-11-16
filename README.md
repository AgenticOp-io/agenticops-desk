# AgenticOps Desk

**Desktop workspace for AI coding agents**: projects and chats in a sidebar, many agents running at once, permission prompts in the app, and memory that carries over between chats.

**Private by design.** Your code is never indexed or stored on a server of ours; there is no server of ours. Chats, memory and settings stay in `%APPDATA%\AgenticOps Desk`, and nothing is written into your repos. **Privacy Mode** (on by default) replaces passwords, keys and tokens with placeholders before anything reaches an AI, and puts the real values back only on your computer when a tool runs. **Local only** keeps every chat on an Ollama model on your machine, for code that must not leave it.

Each chat runs on one of two engines, picked in the composer's model menu:

- **Claude Code** (default): the official Claude Code agent, through [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). A packaged app downloads the binary for that computer on first launch. Running from source uses the copy `npm install` already fetched. Uses your Claude sign-in and subscription. No separate CLI install is needed.
- **Direct**: AgenticOps Desk's own agent loop calling a model API with your key: the Claude API, OpenAI, OpenRouter, Google Gemini, DeepSeek, or local models through Ollama. Billed per token by that provider. DeepSeek is in the model menu; pick it and paste a key. Other providers load their models when you add a key. It has file, search and PowerShell tools, and uses the same approvals, change review, standing orders and memory.

**Auto** in the same menu uses all of these, or the ones you pick in **Settings → AI models → Auto model**, in your order. When one hits a rate limit, runs out of quota, has its key rejected, is unreachable or declines, the message moves to the next one and the failed one rests for a few minutes.

**Quick edit** (**Ctrl+I** in the editor): select code, type what to change, and a small fast model rewrites just that part in seconds, without a full agent run. Ctrl+Z undoes it. **Autocomplete** (opt-in, **Settings → AI models → Editor autocomplete**) suggests the next lines as grey text; Tab accepts.

**AIs checking each other:** with a **Second opinion** model set, a model from another provider reviews every change against your request, and its concerns go back to the agent to fix (up to two rounds).

**Cheaper follow-ups:** every follow-up continues from a short summary written by a local model, plus work already verified in the chat. The earlier transcript is not sent again. **Set up local model** under **Settings → AI models → Summaries**, or the box in the Windows setup, installs Ollama and a free local model. Pick a different Summaries model only if you want one.

**@ symbols:** `@handleLogin` in the message box points the agent at that function's file and line, not just a file.

**Team rules:** commit `.agenticops/orders.json` (`{"rules": [...], "protect": [...]}`) and everyone working in the repo gets the same standing orders. The app only reads it, and ignores any `checks` in it, so a cloned repo cannot make it run commands.

**Plugins** (**Settings → Plugins**, or `/plugins`) browses, installs, updates and turns off Claude Code plugins from any marketplace, with one-click installs for Ponytail and Agent Skills. Their commands and skills show up in the composer's `/` menu.

**Saved logins** (**Settings → Privacy & logins**) keep passwords, tokens and SSH keys encrypted on this computer. An agent uses them by name for SSH, telnet, git and web services without seeing them, and asks you once per chat first.

## Documentation

| Document | What it covers |
|---|---|
| [Features](./docs/FEATURES.md) | Everything the app does and how to use it, including setting up another computer |
| [Security](./docs/SECURITY.md) | What protects your code and secrets, and where that stops |
| [Architecture](./docs/ARCHITECTURE.md) | How it is built, data files, key flows, testing and releasing |
| [`AGENTS.md`](./AGENTS.md) | Rules for agents working in this repo |

## Status

**Private beta, in daily use.** Built and used daily on Windows. macOS and Linux builds ship with every release; they get full installers but not code patches.

- **Chats:** a follow-up continues from a short local summary instead of resending the session. A message sent while a run is still going joins that run. A run cut off by quitting resumes on the next launch if it is still recent.
- **Permissions:** the first action in a folder asks once. After that, edits, tests, git and network commands run without a prompt. Disk format, administrator commands and shutdown still ask. Questions and plans always ask.
- **Memory:** a global index under `%APPDATA%\AgenticOps Desk\memory` and the project's Claude Code memory folder go into every run.
- **Imports:** chats and projects from the editor you used before show up in the sidebar and can be handed to the agent with **Catch up**.
- **Sidebar:** GitHub projects stay in the list, other folders sit behind one row, and projects not opened for 90 days move to an archive you can drag in and out of. Right-click a project to send its folder to the Recycle Bin, after being told what isn't pushed.
- **Projects:** a chat stays in its project until you use **Move to project…**. A moved or deleted folder does not refile anything: the project shows **no folder**, and **Locate folder…** points it at the new place. A chat with no folder asks before it runs, instead of running in whichever folder is open. Editor scans only decide a chat's project the first time it is imported. **Settings → Chats & projects → Project cleanup** offers to merge one project found in two places.
- **Sync:** Settings finds your sync repository or creates a private one with the GitHub CLI, or uses an address you paste. Chats, memory and settings push there as soon as a message is sent, and come down on your other computers, where existing clones are linked and **Clone all** fetches the rest ([setup steps](./docs/FEATURES.md#setting-up-another-computer)). API keys and saved logins stay on each machine, and passwords and tokens in a chat are replaced with `[hidden]` in the copy that leaves this computer. A project keeps a permanent ID and its chats on every computer; its folder is per computer, and its git remote recognizes a clone or a moved folder when only one project could match. The same setting chooses whether Cursor chats stay put, are archived into that repository, or are also added back to Cursor's chat list. The Git panel fetches, pulls, pushes, checks out a branch, and shows recent history.

## Requirements

- Windows 10/11 (macOS and Linux builds are beta). Node.js 22+ to run from source
- A Claude account: sign in from **Settings → Engine & sign-in** (no CLI install needed)
- For Direct chats, an API key per provider in **Settings → AI models → Direct AI providers** (Ollama needs none)
- Git for Windows (for Claude Code's Bash tool); PowerShell 7 is optional
- The GitHub CLI signed in (`gh auth login`) for sync, Git or Hybrid storage, and update checks on the private repository

## Run

```powershell
git clone https://github.com/AgenticOp-io/agenticops-desk.git
cd agenticops-desk
npm install
npm run dev
```

To run it without a terminal window, create the shortcuts once:

```powershell
.\scripts\install-shortcuts.ps1
```

That adds **AgenticOps Desk** to the Desktop and Start menu. It starts the same dev build hidden (output goes to `%APPDATA%\AgenticOps Desk\dev.log`), stops when you close the window, and a second launch just brings the open window forward.

## Tests

```powershell
npm test                 # logic: permissions, privacy, Auto, parsers
npx vite build; npm run smoke   # starts the built app with a throwaway data folder and clicks through it
```

CI runs both on every push. Setting `AGENTICOPS_DESK_DATA` points any run at a separate data folder.

## Installers

The **Release** workflow (Actions → Release → Run workflow, or push a `v*` tag) builds Windows, macOS and Linux, each for both chip types. The installers are about 100 MB. They do not contain Claude Code. On first launch, with a network connection, AgenticOps Desk downloads the one binary for that computer from npm and checks it against npm's SHA-512 fingerprint. Later launches work offline. Running from a source checkout does not download anything; it uses the binary from `node_modules`.

The Windows setup asks two questions before it copies files. First, where chats live: **Git**, **Local**, or **Hybrid**. Next it looks for Cursor, Visual Studio Code, Windsurf, and Claude. Cursor is the one whose projects and chats can be imported, and that box starts unchecked. Git and Hybrid then open GitHub's sign-in if the GitHub CLI is not already signed in, and create the private repository for chats. Local finishes the install without that. If AgenticOps Desk is already open, or sign-in does not finish, the setup stops and keeps the answer; the next start applies it. A silent install skips the questions. A portable copy, or a setup that did not get an answer, asks on first start when Cursor chats are found, and opens the most recently used project if AgenticOps Desk does not already have one. **Settings → Chats & projects → Where chats live** can change it:

- **Git:** every chat is copied at full length with a permanent project (a chat whose messages are gone falls back to what you typed, from Cursor's search index), along with Cursor's raw transcripts, plans and agent files (`%APPDATA%\AgenticOps Desk\cursor-archive`), and syncs through a private repository. **Settings → Chats & projects → Cursor folders** can then delete Cursor's folders. That is permanent, needs Cursor closed, copies again and backs up Cursor's databases first, and refuses if either fails. It never touches project folders, and it keeps `.cursor\worktrees` because those hold code.
- **Hybrid:** the same copying and sync, and Cursor keeps all its files.
- **Local:** chats stay in Cursor's local database and are read from there. Nothing is copied or pushed.

| Platform | Files |
|----------|-------|
| Windows | `-win-setup.exe` and `-win-portable.exe` hold x64 and ARM64 and pick the right one. `-win-x64-` and `-win-arm64-` files are single-chip and smaller |
| macOS Apple Silicon / Intel | `.dmg`, `.zip` |
| Linux x64 / ARM64 | `.AppImage`, `.deb` |

**Code updates (Windows setup installs):** the app checks git tags on the private repository every six hours and when you press **Settings → Updates**. A beta prerelease counts. The check uses the GitHub CLI sign-in on this computer (`gh auth login`). The app does not carry a token. If only the app's own code changed, it downloads a small signed patch, builds it in a folder of its own and checks every file; it loads at the next start, or from **Restart to update**. If a patch keeps the window from opening, the next start goes back to the code before it. A change to Electron or an installed package still needs the full installer, and so do portable copies, macOS and Linux.

The builds are not code-signed. Windows SmartScreen asks once ("More info → Run anyway"). On macOS, right-click the app and choose **Open** the first time, or run `xattr -cr /Applications/AgenticOps Desk.app`.

`npm run build` makes the installers for the computer you run it on, in `release/`.

## Layout

The full module list, data files and key flows are in [Architecture](./docs/ARCHITECTURE.md).

Keys: **Enter** sends (Shift+Enter for a new line), **Ctrl+I** quick edit, **Ctrl+N** new chat, **Ctrl+K** focuses the composer, **Ctrl+P** opens a file.

Agents working in this repo: read [`AGENTS.md`](./AGENTS.md).

## License

AgenticOps Desk is licensed under the [Apache License 2.0](./LICENSE). The Claude Agent SDK and Claude Code keep Anthropic's own terms and are not in the installer (see [`NOTICE`](./NOTICE)). Contributing: see [`CONTRIBUTING.md`](./CONTRIBUTING.md).

---

AgenticOp-io · [agenticop.io](https://agenticop.io)
