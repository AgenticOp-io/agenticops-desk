import { useMemo, useState } from "react";

type Section = { id: string; title: string; body: string[] };

const SECTIONS: Section[] = [
  {
    id: "start",
    title: "Start here",
    body: [
      "ClaudeDesk is a desktop window for Claude. The left side is your projects and chats. The right side is the conversation, and Code opens the files Claude is working in.",
      "Each chat keeps its own conversation. Send continues that chat, including a short reply like “yes”. Closing the app and opening it again brings the same chats back. A run that was cut off resumes the next time you send.",
      "Several chats can work at once. The list shows a short line for whatever each one is doing, such as “Reading src/App.tsx” or “Writing the reply”.",
    ],
  },
  {
    id: "projects",
    title: "Projects and chats",
    body: [
      "Add puts a folder on the list. The search box filters projects and chat titles. Click a folder to open the chat you used there last. Click any older chat to read it. Starting a new chat does not throw the old ones away.",
      "Each folder shows two chats. The project icon, or the more link, shows the rest. Folders stay open or closed as you left them.",
      "Drag a project or a chat to reorder it. Right-click to hide one. Hidden items come back from Settings, or from the same right-click menu.",
      "Chats that already lived in Cursor are imported with the Windows setup, or the first time a portable copy starts with an empty list. Catch Claude up hands one of those chats to Claude as a briefing. Nothing is written into the project folder.",
    ],
  },
  {
    id: "talk",
    title: "Sending a message",
    body: [
      "Type in the box and press Enter or Send. Shift+Enter starts a new line. While a chat is already working, Send guides that run instead of starting over.",
      "Type @ to attach a file from the open folder. You can also paste or drop images (up to 10, each under 5 MB).",
      "Agent is the usual mode: Claude edits files and runs commands. Plan reads and writes a plan, and waits for you before changing anything. Auto-edit applies file edits without an extra prompt. The permission rules below still apply.",
      "The model menu defaults to Claude Code, which uses your Claude sign-in. Models under Direct call that provider with the key you saved in Settings and are billed per token.",
      "Stop ends the run in the chat you are looking at. Other chats keep going.",
      "The meter under the box is how full this chat’s context is, and a rough cost since this window opened.",
    ],
  },
  {
    id: "status",
    title: "While it is working",
    body: [
      "The line under the chat title is the current step, in plain language: getting ready, thinking, reading or editing a file, searching, running a command, writing the reply, or pushing to main.",
      "You can type another instruction and press Enter while it is still working. That guides the run in progress. It does not wait for the run to finish, and it does not throw away the steps already done.",
      "The same line appears on that chat in the list, so you can see background work without opening it.",
      "A small trail under the current line is the last few steps. When Claude edits files, a small bar lists them. The changes are already kept: review a diff or undo a file if you want, or just keep working. Sending your next message clears the bar.",
    ],
  },
  {
    id: "permissions",
    title: "Permissions",
    body: [
      "The first time Claude needs to work in a folder, the app asks once. Allow means ordinary coding in that folder just runs: edits, tests, git (including push), delete, and network.",
      "Disk format, administrator commands (sudo or runas), and shutdown still ask, once each, and are remembered if you allow them.",
      "Questions and plan approvals always ask, even in a trusted folder. Allow on those does not by itself trust the folder. Deny never gets remembered.",
      "Sign in from Settings if the footer says you are not signed in to Claude.",
    ],
  },
  {
    id: "files",
    title: "Files and the editor",
    body: [
      "Files in the sidebar is the folder tree. Ctrl+Shift+E switches between Chats and Files. Ctrl+P opens a file by name.",
      "Code shows the editor. Ctrl+S saves the file you are editing. A dot on a tab means unsaved changes. Middle-click a tab to close it.",
      "Right-click a file to make a new file or folder, rename, delete, copy the path, reveal it in the system folder, or add it to the chat.",
      "Code blocks in a reply can be opened in the editor as a read-only snippet.",
    ],
  },
  {
    id: "memory",
    title: "Memory",
    body: [
      "Claude Code keeps notes for you in its own memory folder for that project, plus a global index ClaudeDesk keeps under its app data. Both are included in later chats in that project.",
      "ClaudeDesk does not write chat transcripts into the project. They stay in the app’s own data.",
      "Right-click a chat to rename it, pin it, branch it, or delete it. Search also looks inside messages, not only titles.",
      "On a message you sent: Rewind drops everything after it and the next send continues from there. Retry sends that message again. Branch copies the chat up to that point into a new chat. File edits stay on the change bar, where you can keep or undo them.",
      "Agent, Plan, and Auto-edit, and the model, are remembered on the chat you are in.",
    ],
  },
  {
    id: "around",
    title: "Around the chat",
    body: [
      "Terminal, Git, Preview, and Instructions sit under the message box. Git shows the branch and changes, commits tracked files, and can open a pull request with GitHub’s gh command. Preview loads a web address. Instructions edits CLAUDE.md, AGENTS.md, and the project’s .mcp.json for connected tools.",
      "When Claude writes a plan or a task list, they show above the messages.",
      "If you close the window while a chat is still working, ClaudeDesk hides to the tray and keeps going. Quit from the tray icon stops it. A notice appears when a chat finishes in the background or needs you and the window is not in front.",
      "Settings can switch to a light theme and check GitHub for a newer release. Installers are not code-signed; signing needs a certificate.",
    ],
  },
  {
    id: "keys",
    title: "Keyboard",
    body: [
      "Ctrl+N — new chat",
      "Ctrl+K — focus the message box",
      "Enter — send (or guide, if a run is already going)",
      "Shift+Enter — new line",
      "Ctrl+P — open a file",
      "Ctrl+Shift+E — Chats or Files",
      "Ctrl+S — save the open file",
      "F1 or Ctrl+/ — this help",
      "Ctrl+Shift+P — command palette",
      "Esc — close help, settings, or the file finder",
      "Type / in the message box for commands such as /plan, /terminal, /git, and /help.",
    ],
  },
];

export function Help({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      SECTIONS.map((s) => ({
        ...s,
        body: needle ? s.body.filter((p) => `${s.title} ${p}`.toLowerCase().includes(needle)) : s.body,
      })).filter((s) => s.body.length > 0),
    [needle],
  );

  return (
    <div className="modal" onClick={onClose}>
      <div className="help" role="dialog" aria-labelledby="help-title" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <strong id="help-title">Help</strong>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <input
          className="help-search"
          autoFocus
          placeholder="Search help"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {shown.length === 0 && <p className="settings-hint">Nothing in the help matches that.</p>}
        {shown.map((s) => (
          <section key={s.id} className="help-section">
            <h3>{s.title}</h3>
            {s.body.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
