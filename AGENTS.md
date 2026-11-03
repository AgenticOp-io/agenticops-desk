# Agent guidance — claudedesk

ClaudeDesk is a **Windows desktop frontend for Claude Code**. Chats run on one of two engines: **Claude Code** (the default, through `@anthropic-ai/claude-agent-sdk`, using the user's Claude sign-in) or **Direct** (ClaudeDesk's own agent loop in `electron/direct.ts`, calling the Claude API or an OpenAI-compatible provider with the user's API key). A source checkout uses the Claude Code binary in `node_modules`. A packaged app downloads the binary for that computer on first launch (`electron/claudeBinary.ts`).

## Mission

Make Claude Code comfortable to use all day on Windows: many chats at once, chats that survive restarts, permission prompts in the app, and memory that carries over between chats.

## Read first

1. [`README.md`](./README.md)
2. [`electron/claude.ts`](./electron/claude.ts) — runs, streaming, approvals, resume
3. [`electron/allows.ts`](./electron/allows.ts) — folder trust and the commands that still ask
4. [`electron/memory.ts`](./electron/memory.ts) — memory folders and the system-prompt addendum
5. [`electron/direct.ts`](./electron/direct.ts) and [`electron/providers.ts`](./electron/providers.ts) — the Direct engine and its provider keys
6. [`electron/autoRoute.ts`](./electron/autoRoute.ts) — the Auto model; it watches events through `setSendFilter` in `claude.ts`, so failover only ever swallows an `error` that `shouldFailOver` (`pureFeatures.ts`) matches, plus that run's `done`

## Do

- Run `npx tsc --noEmit` before calling a change done
- Send every `library.json` read-modify-write through `withLibrary` (`electron/library.ts`), and write JSON with `writeJsonAtomic`
- Test UI or main-process changes on a copy with its own `userData` (see below), not on the real app data

## Do not

- Replace the Claude Code engine with the Direct one; Direct is an addition, and Claude Code stays the default
- Call the Claude API with anything but `@anthropic-ai/sdk`, or send provider API keys to the renderer (they stay encrypted in the main process)
- Require a separately installed Claude CLI. Use `ensureClaudeBinary()` (`electron/claudeBinary.ts`): source runs use `node_modules`, packaged runs download the matching binary
- Let folder trust answer `AskUserQuestion` or `ExitPlanMode`; the user must read those
- Point the shell at the 0-byte WindowsApps `pwsh.exe` alias
- Write chats, transcripts, or briefings into a project folder; they belong in `%APPDATA%\ClaudeDesk` or the prompt, never in a repo
- Commit or push unless the user asks

## Dev instance gotcha

Chats often run inside ClaudeDesk itself, started with `npm run dev` (`CLAUDE_AGENT_SDK_CLIENT_APP=ClaudeDesk`). Saving a file under `electron/` rebuilds the main process. `vite.config.ts` then tells the running app new code is ready, and the app restarts itself once no chat is running, so a chat editing ClaudeDesk is not cut off. The title bar says when new code is waiting. Editing `vite.config.ts` itself restarts the dev server immediately. `src/` changes only hot-reload.

## Remotes

- `origin` → `AgenticOp-io/claudedesk` (private)

## Git author

Always **AgenticOp-io** `<opensource@agenticop.io>`. The repo-local git config sets it.
