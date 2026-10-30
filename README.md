# ClaudeDesk

Windows desktop frontend for the official **Claude Code CLI**, laid out like Cursor: explorer, editor, agent panel, status bar.

It does **not** reimplement Claude. It opens a folder, shows files, and runs:

```text
claude -p --output-format stream-json --verbose --permission-mode acceptEdits
```

in that folder, streaming JSONL back into the agent pane. Continue uses `claude -r <session>`.

## Requirements

- Node.js 20+
- Claude Code CLI: `npm i -g @anthropic-ai/claude-code`
- Then `claude auth login`

Electron was chosen because Rust/Tauri is not on this machine, and Cursor itself is Electron.

## Run

```powershell
cd $env:USERPROFILE\projects\claudedesk
npm install
npm run dev
```

## Layout

| Region | Role |
|--------|------|
| Title bar | Open folder |
| Activity bar | Explorer / Agent (Ctrl+K focuses the composer) |
| Sidebar | File tree (skips node_modules, .git, dist) |
| Center | Plain editor, Ctrl+S to save |
| Right | Composer → CLI stream, tool calls listed as they run |
| Status | CLI path, sign-in, last run |

Edits Claude makes on disk refresh the tree and the open file (unless you have unsaved editor changes). Ctrl+Enter sends. Continue resumes the last CLI session.
