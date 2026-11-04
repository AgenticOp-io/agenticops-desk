import { useMemo, useState } from "react";

type Section = { id: string; title: string; body: string[] };

const SECTIONS: Section[] = [
  {
    id: "start",
    title: "Start here",
    body: [
      "AgenticOps Desk is a desktop workspace for AI coding agents. The left side is your projects and chats. The right side is the conversation, and Code opens the files the agent is working in.",
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
      "Chats from the editor you used before are imported with the Windows setup, or the first time a portable copy starts with an empty list. Catch up hands one of those chats to the agent as a briefing. Nothing is written into the project folder.",
      "Settings › Sync points at a private git repository. Chats, memory and settings push there and come down on your other computers. API keys stay on each computer. A project is remembered by its git remote; Clone puts that repository on this computer.",
    ],
  },
  {
    id: "talk",
    title: "Sending a message",
    body: [
      "Type in the box and press Enter or Send. Shift+Enter starts a new line. While a chat is already working, Send guides that run instead of starting over.",
      "Type @ to attach a file from the open folder, or a function, class or type by name (@handleLogin points the agent at its file and line; this needs a git repository). You can also paste or drop images (up to 10, each under 5 MB).",
      "Agent is the usual mode: the agent edits files and runs commands. Plan reads and writes a plan, and waits for you before changing anything. Auto-edit applies file edits without an extra prompt. The permission rules below still apply.",
      "The model menu's first entry is the default engine, which uses the account you signed in with under Settings. Models under Direct call that provider with the key you saved in Settings and are billed per token. Auto moves between them on its own (see The Auto model).",
      "Stop ends the run in the chat you are looking at. Other chats keep going.",
      "The meter under the box is how full this chat’s context is, and a rough cost since this window opened.",
    ],
  },
  {
    id: "auto",
    title: "The Auto model",
    body: [
      "Auto, at the top of the model menu, uses every AI you have set up: the default engine with your sign-in, plus any provider with a key under Direct AI providers. Settings › Auto model can narrow that to the ones you pick, in your order. /autopick opens it.",
      "Each message goes to the first AI on the list. If it hits a rate limit, runs out of quota or credit, has its key rejected, cannot be reached, or declines the request, the same message goes to the next one. A line in the chat says which AI failed and why. The one that failed rests for 5 minutes after a rate limit or quota error, or 1 minute otherwise. Settings shows which AIs are resting and can wake them early.",
      "Errors about the work itself, such as a failing test or a standing-order check, do not switch AIs.",
      "A chat keeps using the AI that last worked for it, so its context carries over. The label next to the model menu shows which AI answered. If an AI fails after it has already changed files, the next one is told which files so it does not redo the work.",
      "With Local only privacy, Auto only uses Ollama on this computer. Stop ends the run without handing it to another AI.",
    ],
  },
  {
    id: "plugins",
    title: "Plugins",
    body: [
      "Settings › Plugins (or /plugins) manages agent plugins: slash commands, skills, agents, hooks and MCP servers that other people publish in marketplaces. It uses the same plugins as the default engine's command line.",
      "Recommended has one-click installs for Ponytail and Agent Skills. Browse searches every plugin in your marketplaces. Details shows what a plugin adds before you install it. Add a marketplace with owner/repo from GitHub, or a git address.",
      "Installing always asks first. If a plugin runs a setup command when it installs, AgenticOps Desk shows you that exact command and asks again.",
      "Installed plugins can be turned off, updated or removed. Their commands and skills appear when you type / in the message box. Picking one fills it in, and the default engine runs it when you send. Changes apply from each chat's next message. Plugins work with the default engine, not Direct models.",
      "Graphify is a Python tool rather than a plugin. Copy commands gives the two lines to run in a terminal.",
    ],
  },
  {
    id: "privacy",
    title: "Privacy Mode and secrets",
    body: [
      "Privacy Mode is on by default (Settings, at the top). Passwords, keys and tokens in what you send, in files the agent reads and in command output are swapped for placeholders like {{SECRET_3}} before anything reaches the AI. The same value always gets the same placeholder.",
      "The agent works with the placeholders. When it runs a command or edits a file, AgenticOps Desk puts the real value back on this computer just before the tool runs, so a config can be fixed without the AI ever seeing the password. Approval prompts show you the real command.",
      "Key, certificate and credential files (.key, .pem, .pfx, SSH keys, password databases) are blocked outright. Values with no label next to them, like a VPN key, can be added under “Always hide these values”.",
      "Local only runs chats on an Ollama model on this computer and turns cloud models off. Standard turns filtering off. Images you attach are never filtered, so crop out anything secret before attaching.",
      "Detection follows patterns, so an unusual secret can still slip through. When it matters, add it to Always hide first.",
    ],
  },
  {
    id: "status",
    title: "While it is working",
    body: [
      "The word next to the chat title is the current step: getting ready, thinking, reading or editing a file, searching, running a command, writing the reply, or pushing to main. The same word appears on that chat in the list.",
      "Each message you send starts a round. While it works, that round lists what it is doing. The list stays open for the round in progress and closes when the reply is in, so the answer is what you read. Open it again to see the steps. A long chat shows the latest rounds. Earlier rounds open from the top.",
      "You can type another instruction and press Enter while it is still working. That guides the run in progress. The added line shows in the same round. It does not wait for the run to finish, and it does not throw away the steps already done.",
      "When the agent edits files, a small bar lists them. The changes are already kept: review a diff or undo a file if you want, or just keep working. Sending your next message clears the bar.",
    ],
  },
  {
    id: "permissions",
    title: "Permissions",
    body: [
      "File edits inside the open folder never wait for you: they happen, then show on the change bar to review or undo. The first time the agent needs to run a command in a folder, the app asks once. Allow means ordinary coding in that folder just runs: tests, git (including push), delete, and network.",
      "Disk format, administrator commands (sudo or runas), and shutdown still ask, once each, and are remembered if you allow them.",
      "Questions and plan approvals always ask, even in a trusted folder. Allow on those does not by itself trust the folder. Deny never gets remembered.",
      "Sign in from Settings if the footer says you are not signed in.",
    ],
  },
  {
    id: "files",
    title: "Files and the editor",
    body: [
      "Files in the sidebar is the folder tree. Ctrl+Shift+E switches between Chats and Files. Ctrl+P opens a file by name.",
      "Code shows the editor. It loads the first time you open it. Ctrl+S saves the file you are editing. A dot on a tab means unsaved changes. Middle-click a tab to close it.",
      "Right-click a file to make a new file or folder, rename, delete, copy the path, reveal it in the system folder, or add it to the chat.",
      "Code blocks in a reply can be opened in the editor as a read-only snippet.",
      "Quick edit: select some code (or just put the cursor on a line), press Ctrl+I or right-click › Edit with AI, type what to change, and press Enter. A small fast model rewrites only that part in a few seconds, without a full agent run. Ctrl+Z undoes it, and nothing is saved until you press Ctrl+S. With Local only, it uses your Ollama model.",
      "Autocomplete: pick a fast model under Settings › Editor autocomplete (a Claude API key with Haiku, or a local Ollama model). After a short pause in typing, grey text suggests the next lines; Tab accepts, and typing on ignores it. Each pause is one call to that model, so it is off until you choose one.",
    ],
  },
  {
    id: "memory",
    title: "Memory",
    body: [
      "The agent keeps notes for you in a memory folder for that project, plus a global index AgenticOps Desk keeps under its app data. Both are included in later chats in that project.",
      "AgenticOps Desk does not write chat transcripts into the project. They stay in the app’s own data.",
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
      "When the agent writes a plan or a task list, they show above the messages.",
      "Rules holds standing orders for the folder: rules added to every run, protected paths the agent may not edit, and checks that must pass. A team can commit .agenticops/orders.json in the repo with the same rules and protected paths, so everyone gets them; checks in that file are ignored, so a cloned repo can never run commands on its own.",
      "Second opinion (Settings): after a run changes files, a model from another provider checks the change against what you asked. If it raises concerns, they go back to the agent to fix, up to two rounds, and both sides show in the chat.",
      "If you close the window while a chat is still working, AgenticOps Desk hides to the tray and keeps going. Quit from the tray icon stops it. A notice appears when a chat finishes in the background or needs you and the window is not in front.",
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
      "Ctrl+I — quick edit the selected code in the editor",
      "F1 or Ctrl+/ — this help",
      "Ctrl+Shift+P — command palette",
      "Esc — close help, settings, or the file finder",
      "Type / in the message box for commands such as /plan, /terminal, /git, /plugins and /help, and for the commands of installed plugins.",
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
