# ClaudeDesk

**Windows desktop frontend for Claude Code**: projects and chats in a sidebar, many agents running at once, permission prompts in the app, and memory that carries over between chats.

It does not reimplement Claude. Each chat drives the official Claude Code CLI through [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), in the chat's project folder, and streams the reply back.

## Status

**Private, in daily use.** Windows only for now.

- **Chats:** each one resumes its own Claude Code session, so a short reply like "yes" keeps its context. Runs cut off by closing the app resume on the next launch.
- **Permissions:** the first action in a folder asks once. After that, edits, tests, git and network commands run without a prompt. Disk format, administrator commands and shutdown still ask. Questions and plans always ask.
- **Memory:** a global index under `%APPDATA%\ClaudeDesk\memory` and the project's Claude Code memory folder go into every run.
- **Imports:** Cursor chats and projects show up in the sidebar and can be handed to Claude with **Catch Claude up**.

## Requirements

- Windows 10/11, Node.js 20+
- Claude Code CLI, signed in: `npm i -g @anthropic-ai/claude-code`, then `claude auth login`
- Git for Windows (for the Bash tool); PowerShell 7 is optional

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
| `electron/claude.ts` | Agent SDK runs, streaming, approvals, resume after restart |
| `electron/allows.ts` | Folder trust and the commands that still ask |
| `electron/memory.ts` | Memory folders and system-prompt addendum |
| `electron/library.ts` | Projects, chats and saved threads (`%APPDATA%\ClaudeDesk`) |
| `electron/cursor.ts` | Cursor chat import and catch-up briefings |
| `src/App.tsx` | Sidebar, chat pane, composer, approval cards, code pane |

Keys: **Ctrl+Enter** sends, **Ctrl+N** new chat, **Ctrl+K** focuses the composer, **Ctrl+P** opens a file.

Agents working in this repo: read [`AGENTS.md`](./AGENTS.md).

---

AgenticOp-io · [agenticop.io](https://agenticop.io)
