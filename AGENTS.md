# Agent guidance — agenticops-desk

AgenticOps Desk is a **desktop workspace for AI coding agents**. Chats run on one of two engines: **Claude Code** (the default, through `@anthropic-ai/claude-agent-sdk`, using the user's Claude sign-in) or **Direct** (AgenticOps Desk's own agent loop in `electron/direct.ts`, calling the Claude API or an OpenAI-compatible provider with the user's API key). A source checkout uses the agent SDK and Claude Code binary in `node_modules`. A packaged app carries neither: it downloads the SDK's `sdk.mjs` and the binary for that computer from npm on first use, at the SDK version it was built with (`electron/claudeBinary.ts`).

## Mission

Make Claude Code comfortable to use all day on Windows: many chats at once, chats that survive restarts, permission prompts in the app, and memory that carries over between chats.

## Read first

1. [`README.md`](./README.md)
2. [`electron/claude.ts`](./electron/claude.ts) — runs, streaming, approvals, resume
3. [`electron/allows.ts`](./electron/allows.ts) — folder trust and the commands that still ask
4. [`electron/memory.ts`](./electron/memory.ts) — memory folders and the system-prompt addendum
5. [`electron/direct.ts`](./electron/direct.ts) and [`electron/providers.ts`](./electron/providers.ts) — the Direct engine and its provider keys
6. [`electron/autoRoute.ts`](./electron/autoRoute.ts) — the Auto model; it watches events through `setSendFilter` in `claude.ts`, so failover only ever swallows an `error` that `shouldFailOver` (`pureFeatures.ts`) matches, plus that run's `done`
7. [`electron/credentials.ts`](./electron/credentials.ts) — saved logins; read [`docs/SECURITY.md`](./docs/SECURITY.md) before changing them
8. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — modules, data files, flows, testing and releasing. [`docs/FEATURES.md`](./docs/FEATURES.md) is the user-facing guide: update it when behavior changes

## Do

- Run `npx tsc --noEmit` before calling a change done
- Send every `library.json` read-modify-write through `withLibrary` (`electron/library.ts`), and write JSON with `writeJsonAtomic`
- Test UI or main-process changes on a copy with its own `userData` (see below), not on the real app data
- Check folder boundaries with `staysInside` (`pureFeatures.ts`), which follows links, not with a path-string comparison
- Keep packages that Vite bundles (`openai`, React, Monaco…) in `devDependencies`; `dependencies` are copied into the installer as well
- Keep vendor product names (Claude, Claude Code, Cursor, OpenAI…) out of the app's own name and general UI text; say "the agent" or "the default engine". They may appear where the user picks or configures something: Settings, provider names, and the model menus

## Do not

- Replace the Claude Code engine with the Direct one; Direct is an addition, and Claude Code stays the default
- Add a way to read a saved login back into the renderer, put its value in command text, or let a placeholder fill it in. Every use goes through `approveLogins`
- Sync `credentials.json`, `providers.json` or `privacy-vault.json`
- Build a GitHub token or key into the app. Update checks use the GitHub CLI sign-in on that computer
- Call the Claude API with anything but `@anthropic-ai/sdk`, or send provider API keys to the renderer (they stay encrypted in the main process)
- Import values from `@anthropic-ai/claude-agent-sdk` (types are fine); get them from `loadAgentSdk()`, so installers never contain Anthropic's SDK
- Require a separately installed Claude CLI. Use `ensureClaudeBinary()` (`electron/claudeBinary.ts`): source runs use `node_modules`, packaged runs download the matching binary
- Let folder trust answer `AskUserQuestion` or `ExitPlanMode`; the user must read those
- Point the shell at the 0-byte WindowsApps `pwsh.exe` alias
- Write chats, transcripts, or briefings into a project folder; they belong in `%APPDATA%\AgenticOps Desk` or the prompt, never in a repo
- Commit or push unless the user asks

## Dev instance gotcha

Chats often run inside AgenticOps Desk itself, started with `npm run dev` (`CLAUDE_AGENT_SDK_CLIENT_APP=AgenticOps-Desk`). Saving a file under `electron/` rebuilds the main process. `vite.config.ts` then tells the running app new code is ready, and the app restarts itself once no chat is running, so a chat editing AgenticOps Desk is not cut off. The title bar says when new code is waiting. Editing `vite.config.ts` itself restarts the dev server immediately. `src/` changes only hot-reload.

## Remotes

- `origin` → `AgenticOp-io/agenticops-desk` (private)

## Git author

Always **AgenticOp-io** `<opensource@agenticop.io>`. The repo-local git config sets it.
