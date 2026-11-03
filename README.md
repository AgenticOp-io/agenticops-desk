# AgenticOps Desk

**Desktop workspace for AI coding agents**: projects and chats in a sidebar, many agents running at once, permission prompts in the app, and memory that carries over between chats.

Each chat runs on one of two engines, picked in the composer's model menu:

- **Claude Code** (default): the official Claude Code agent, through [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). A packaged app downloads the binary for that computer on first launch. Running from source uses the copy `npm install` already fetched. Uses your Claude sign-in and subscription. No separate CLI install is needed.
- **Direct**: AgenticOps Desk's own agent loop calling a model API with your key: the Claude API, OpenAI, OpenRouter, Google Gemini, or local models through Ollama. Billed per token by that provider. It has file, search and PowerShell tools, and uses the same approvals, change review and memory.

**Auto** in the same menu uses all of these, or the ones you pick in **Settings → Auto model**, in your order. When one hits a rate limit, runs out of quota, has its key rejected, is unreachable or declines, the message moves to the next one and the failed one rests for a few minutes.

**Plugins** (**Settings → Plugins**, or `/plugins`) browses, installs, updates and turns off Claude Code plugins from any marketplace, with one-click installs for Ponytail and Agent Skills. Their commands and skills show up in the composer's `/` menu.

Formerly ClaudeDesk. The first launch of a renamed build moves `%APPDATA%\ClaudeDesk` to `%APPDATA%\AgenticOps Desk`; nothing else changes.

## Status

**Private, in daily use.** Windows only for now.

- **Chats:** each one resumes its own Claude Code session, so a short reply like "yes" keeps its context. Runs cut off by closing the app resume on the next launch.
- **Permissions:** the first action in a folder asks once. After that, edits, tests, git and network commands run without a prompt. Disk format, administrator commands and shutdown still ask. Questions and plans always ask.
- **Memory:** a global index under `%APPDATA%\AgenticOps Desk\memory` and the project's Claude Code memory folder go into every run.
- **Imports:** chats and projects from the editor you used before show up in the sidebar and can be handed to the agent with **Catch up**.

## Requirements

- Windows 10/11, Node.js 22+
- A Claude account: sign in from **Settings → Claude Code → Sign in** (no CLI install needed)
- For Direct chats, an API key per provider in **Settings → Direct AI providers** (Ollama needs none)
- Git for Windows (for Claude Code's Bash tool); PowerShell 7 is optional

## Run

```powershell
cd $env:USERPROFILE\projects\claudedesk
npm install
npm run dev
```

To run it without a terminal window, create the shortcuts once:

```powershell
.\scripts\install-shortcuts.ps1
```

That adds **AgenticOps Desk** to the Desktop and Start menu. It starts the same dev build hidden (output goes to `%APPDATA%\AgenticOps Desk\dev.log`), stops when you close the window, and a second launch just brings the open window forward.

## Installers

The **Release** workflow (Actions → Release → Run workflow, or push a `v*` tag) builds Windows, macOS and Linux, each for both chip types. The installers are about 100 MB. They do not contain Claude Code. On first launch, with a network connection, AgenticOps Desk downloads the one binary for that computer from npm and checks it against npm's SHA-512 fingerprint. Later launches work offline. Running from a source checkout does not download anything; it uses the binary from `node_modules`.

The Windows setup imports Cursor projects and chats while it installs, and opens the most recently used project if AgenticOps Desk does not already have one. A portable copy does the same import the first time it starts.

| Platform | Files |
|----------|-------|
| Windows x64 / ARM64 | `-setup.exe` installer, `-portable.exe` |
| macOS Apple Silicon / Intel | `.dmg`, `.zip` |
| Linux x64 / ARM64 | `.AppImage`, `.deb` |

The builds are not code-signed. Windows SmartScreen asks once ("More info → Run anyway"). On macOS, right-click the app and choose **Open** the first time, or run `xattr -cr /Applications/AgenticOps Desk.app`.

`npm run build` makes the installers for the computer you run it on, in `release/`.

## Layout

| Path | Role |
|------|------|
| `electron/main.ts` | Window, IPC, workspace watcher |
| `electron/claude.ts` | Claude Code engine: agent SDK runs, streaming, approvals, resume after restart |
| `electron/claudeBinary.ts` | Downloads the Claude Code binary for this computer and checks npm's fingerprint |
| `electron/direct.ts` | Direct engine: own tool loop for the Claude API and OpenAI-compatible providers |
| `electron/providers.ts` | Provider presets and API keys (encrypted with Windows' safeStorage) |
| `electron/autoRoute.ts` | The Auto model: picks an AI per run and fails over to the next on provider errors |
| `electron/plugins.ts` | Claude Code plugins and marketplaces, through the bundled `claude plugin` commands |
| `electron/allows.ts` | Folder trust and the commands that still ask |
| `electron/memory.ts` | Memory folders and system-prompt addendum |
| `electron/library.ts` | Projects, chats and saved threads (`%APPDATA%\AgenticOps Desk`) |
| `electron/cursor.ts` | Cursor chat import and catch-up briefings |
| `src/App.tsx` | Sidebar, chat pane, composer, approval cards, code pane |

Keys: **Ctrl+Enter** sends, **Ctrl+N** new chat, **Ctrl+K** focuses the composer, **Ctrl+P** opens a file.

Agents working in this repo: read [`AGENTS.md`](./AGENTS.md).

---

AgenticOp-io · [agenticop.io](https://agenticop.io)
