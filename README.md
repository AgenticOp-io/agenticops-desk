# ClaudeDesk

**Windows desktop frontend for Claude Code**: projects and chats in a sidebar, many agents running at once, permission prompts in the app, and memory that carries over between chats.

Each chat runs on one of two engines, picked in the composer's model menu:

- **Claude Code** (default): the official Claude Code agent, bundled with ClaudeDesk through [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Uses your Claude sign-in and subscription. No separate CLI install is needed.
- **Direct**: ClaudeDesk's own agent loop calling a model API with your key: the Claude API, OpenAI, OpenRouter, Google Gemini, or local models through Ollama. Billed per token by that provider. It has file, search and PowerShell tools, and uses the same approvals, change review and memory.

## Status

**Private, in daily use.** Windows only for now.

- **Chats:** each one resumes its own Claude Code session, so a short reply like "yes" keeps its context. Runs cut off by closing the app resume on the next launch.
- **Permissions:** the first action in a folder asks once. After that, edits, tests, git and network commands run without a prompt. Disk format, administrator commands and shutdown still ask. Questions and plans always ask.
- **Memory:** a global index under `%APPDATA%\ClaudeDesk\memory` and the project's Claude Code memory folder go into every run.
- **Imports:** Cursor chats and projects show up in the sidebar and can be handed to Claude with **Catch Claude up**.

## Requirements

- Windows 10/11, Node.js 20+
- A Claude account: sign in from **Settings → Claude Code → Sign in** (no CLI install needed)
- For Direct chats, an API key per provider in **Settings → Direct AI providers** (Ollama needs none)
- Git for Windows (for Claude Code's Bash tool); PowerShell 7 is optional

## Run

```powershell
cd $env:USERPROFILE\projects\claudedesk
npm install
npm run dev
```

`npm run pack` typechecks, builds, and makes a portable `.exe` in `release/`.

## Layout

| Path | Role |
|------|------|
| `electron/main.ts` | Window, IPC, workspace watcher |
| `electron/claude.ts` | Claude Code engine: agent SDK runs, streaming, approvals, resume after restart |
| `electron/direct.ts` | Direct engine: own tool loop for the Claude API and OpenAI-compatible providers |
| `electron/providers.ts` | Provider presets and API keys (encrypted with Windows' safeStorage) |
| `electron/allows.ts` | Folder trust and the commands that still ask |
| `electron/memory.ts` | Memory folders and system-prompt addendum |
| `electron/library.ts` | Projects, chats and saved threads (`%APPDATA%\ClaudeDesk`) |
| `electron/cursor.ts` | Cursor chat import and catch-up briefings |
| `src/App.tsx` | Sidebar, chat pane, composer, approval cards, code pane |

Keys: **Ctrl+Enter** sends, **Ctrl+N** new chat, **Ctrl+K** focuses the composer, **Ctrl+P** opens a file.

Agents working in this repo: read [`AGENTS.md`](./AGENTS.md).

---

AgenticOp-io · [agenticop.io](https://agenticop.io)
