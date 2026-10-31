# Agent guidance — claudedesk

ClaudeDesk is a **Windows desktop frontend for Claude Code**. It drives the official CLI through `@anthropic-ai/claude-agent-sdk`. It does not reimplement Claude.

## Mission

Make Claude Code comfortable to use all day on Windows: many chats at once, chats that survive restarts, permission prompts in the app, and memory that carries over between chats.

## Read first

1. [`README.md`](./README.md)
2. [`electron/claude.ts`](./electron/claude.ts) — runs, streaming, approvals, resume
3. [`electron/allows.ts`](./electron/allows.ts) — folder trust and the commands that still ask
4. [`electron/memory.ts`](./electron/memory.ts) — memory folders and the system-prompt addendum

## Do

- Run `npx tsc --noEmit` before calling a change done
- Send every `library.json` read-modify-write through `withLibrary` (`electron/library.ts`), and write JSON with `writeJsonAtomic`
- Test UI or main-process changes on a copy with its own `userData` (see below), not on the real app data

## Do not

- Re-implement the CLI or call the Anthropic API directly; go through the agent SDK
- Let folder trust answer `AskUserQuestion` or `ExitPlanMode`; the user must read those
- Point the shell at the 0-byte WindowsApps `pwsh.exe` alias
- Write chats, transcripts, or briefings into a project folder; they belong in `%APPDATA%\ClaudeDesk` or the prompt, never in a repo
- Commit or push unless the user asks

## Dev instance gotcha

Chats often run inside ClaudeDesk itself, started with `npm run dev` (`CLAUDE_AGENT_SDK_CLIENT_APP=ClaudeDesk`). Saving any file under `electron/` rebuilds the main process and restarts the app, which cuts off the current turn. Put `electron/` edits together near the end of a turn. `src/` changes only hot-reload.

## Remotes

- `origin` → `AgenticOp-io/claudedesk` (private)

## Git author

Always **AgenticOp-io** `<opensource@agenticop.io>`. The repo-local git config sets it.
