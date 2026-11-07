# Features

What AgenticOps Desk does and how to use it. The same material, shorter, is in the app under **Help** (F1). For how it is built, see [ARCHITECTURE.md](./ARCHITECTURE.md). For what protects your secrets and where that stops, see [SECURITY.md](./SECURITY.md).

## Contents

- [The window](#the-window)
- [Settings](#settings)
- [Projects and the sidebar](#projects-and-the-sidebar)
- [Chats](#chats)
- [Sending a message](#sending-a-message)
- [Engines and models](#engines-and-models)
- [Permissions](#permissions)
- [Privacy Mode](#privacy-mode)
- [Saved logins](#saved-logins)
- [Sync](#sync)
- [Setting up another computer](#setting-up-another-computer)
- [Where chats live and Cursor](#where-chats-live-and-cursor)
- [Deleting a project from the disk](#deleting-a-project-from-the-disk)
- [Files and the editor](#files-and-the-editor)
- [Around the chat](#around-the-chat)
- [Memory](#memory)
- [Plugins](#plugins)
- [Updates](#updates)
- [Keyboard](#keyboard)

## The window

- **Title bar:** the open project, and a short message after something you did, such as "Saved CLAUDE.md". The message clears after 8 seconds. First-launch download progress shows here too and stays until the download ends.
- **Left side:** projects and chats, or the folder tree (the icons on the far left switch between them).
- **Right side:** the conversation and message box. **Code** opens the editor beside it.
- **Under the message box:** Terminal, Git, Preview, Instructions and Rules.

There is no status bar. Sign-in state and the agent engine's state are in **Settings → Engine & sign-in**. If you are signed out, sending a message shows the error in the chat.

## Settings

**Settings** opens a list of sections. Pick one, and **‹ Back** returns to the list. Closing Settings starts at the list again.

| Section | What is in it |
|---|---|
| **Appearance** | Theme, window font size, agent list font size |
| **Privacy & logins** | Privacy Mode, Always hide these values, Saved logins |
| **Sync** | The sync repository, and what Cursor chats do |
| **Chats & projects** | Hidden items, Project cleanup, Where chats live, and Cursor folders in Git mode |
| **Engine & sign-in** | Claude Code status, Sign in, Check |
| **AI models** | Direct AI providers, Second opinion, Editor autocomplete, Auto model |
| **Plugins** | Browse, install and manage plugins |
| **Updates** | Check for a newer release, and Restart to update |

The command palette opens **Plugins** and **AI models** directly.

## Projects and the sidebar

The list has three sections, top to bottom:

| Section | What is in it |
|---|---|
| Main list | Projects with a GitHub remote, plus whatever is open or running now |
| **Other folders** | Everything else. One row until you open it |
| **Archive** | Projects not opened for 90 days, and any you moved there |

**Clicking a project**

- Clicking another project goes to the chat you used there last and opens its list.
- Clicking the project you are in collapses or reopens it. That never changes the chat on screen.
- An open project shows its five most recent chats, plus any that are running. **N more** and **Show less** change that.

**Running chats** show one word in the sidebar: Starting, Thinking, Working, Writing, Pushing, or Needs permission. The detail, such as which command is running, stays in the chat header. A collapsed project shows the same word on its row.

**The archive** is only a view. Nothing moves on disk, and search still finds archived projects.

- **To archive:** drag a project onto the **Show archive** row (it lights up), or right-click and choose **Move to archive**.
- **To bring one back:** open the archive and drag it onto any row outside, right-click and choose **Bring out of archive**, or open it. Bringing one back restarts its 90 days.
- A project with a running chat never counts as archived. A project that is open stays out of the automatic archive, but one you archived by hand stays there until you open it.
- Archive placement is saved per computer and is not synced.

**Other sidebar actions**

- **Add** puts a folder on the list. **New chat** starts one in the open project.
- Drag projects or chats to reorder them.
- Right-click a project to change or locate its folder, hide it, archive it, or delete its folder. Right-click a chat to rename, pin, branch, move, hide or delete it.
- Hidden items are listed in **Settings → Chats & projects**, with **Unhide all**.

**Projects keep their identity.** A project has a permanent ID. If its folder moves or disappears, it shows **no folder** and its chats stay with it. Use **Locate folder…** to point it at the new place. A chat stays in its project until you use **Move to project…**. **Settings → Chats & projects → Project cleanup** offers to merge one project found in two places.

## Chats

- Each chat resumes its own session, so a short reply like "yes" keeps its context.
- A chat opens at its last message. If you scroll up, it stays where you are until you scroll back to the end.
- Several chats can run at once. **Stop** ends only the chat on screen.
- Closing the window while a chat is working hides the app to the tray and keeps going. **Quit** from the tray icon stops it. A run cut off by quitting resumes the next time you send.
- Closing the window when nothing is running saves open chats first. On macOS the app stays open after its window closes, and a reopened window saves its chats the same way.
- On a message you sent: **Rewind** drops everything after it, **Retry** sends it again, and **Branch** copies the chat up to that point.
- Search looks inside messages as well as titles.

## Sending a message

- **Enter** sends, **Shift+Enter** starts a new line. Sending while a chat is working guides that run.
- The box grows to fit your text, up to 40% of the window, and then scrolls.
- **Drafts stay with their chat.** Switch away and come back, and your text is there with the cursor at the end.
- `@` attaches a file, or a function, class or type by name (`@handleLogin` points the agent at its file and line; this needs a git repository).
- Paste or drop images: up to 10, each under 5 MB.
- **Agent** edits and runs commands. **Plan** writes a plan and waits. **Auto-edit** applies edits without an extra prompt.
- The meter shows how full the chat's context is and a rough cost since the window opened.

## Engines and models

Picked in the model menu, per chat.

- **Claude Code** (default): the official agent, using your Claude sign-in and subscription. No separate CLI install is needed.
- **Direct:** the app's own agent loop, calling the Claude API, OpenAI, OpenRouter, Google Gemini, DeepSeek, or Ollama with your key. Billed per token by that provider, except local Ollama. DeepSeek's models are in the model menu; pick one and paste the key there. Agent runs turn DeepSeek thinking off, so a tool round does not wait out a chain of thought. A new command stops the DeepSeek reply that is streaming and any command it is running, and the run continues with your command. A failed call, such as a rejected key or a rate limit, still shows as an error. The other providers load their model list when you add a key, from the menu or from **Settings → AI models → Direct AI providers**.
- **Auto:** uses all of these, or the ones you pick in **Settings → AI models → Auto model**, in your order. On a rate limit, quota error, rejected key, unreachable service or refusal, the message moves to the next AI and the failed one rests for a few minutes. Errors about the work itself, such as a failing test, do not switch AIs.
- **Second opinion:** a model from another provider reviews each change against your request, and sends concerns back to the agent, for up to two rounds.

## Permissions

- File edits inside the open folder happen without asking, and appear on the change bar to review or undo.
- "Inside the folder" means where the file really is. A shortcut or junction in the project that points elsewhere is treated as outside, for the agent's file tools and for the editor.
- The first command in a folder asks once. After **Allow**, tests, git (including push), deletes and network commands run without asking.
- Disk format, administrator commands and shutdown still ask, once each, and are remembered if you allow them.
- Questions and plan approvals always ask.
- **Saved logins** always ask, once per chat for each login, even in a trusted folder.

## Privacy Mode

On by default, in **Settings → Privacy & logins**.

- Passwords, keys and tokens in what you send, in files the agent reads and in command output become placeholders like `{{SECRET_n}}` before anything reaches the AI. The real value goes back on your computer just before a tool runs.
- Key, certificate and credential files are blocked outright.
- **Always hide these values** covers secrets with no label next to them.
- **Local only** keeps every chat on an Ollama model on this computer. **Standard** turns filtering off.
- Images are not filtered, so crop out anything secret. Detection follows patterns, so an unusual secret can slip through; add it to Always hide first when it matters.

## Saved logins

**Settings → Privacy & logins → Saved logins** stores passwords, tokens and SSH keys that the agent can use by name without seeing them. Privacy Mode must be on.

**To add one:** give it a name such as `core-router`, pick **Password**, **Token or PAT**, or **SSH private key**, optionally add a username and host, and save. To change a value, use **Replace** and save with the same name. A saved value can't be read back, so keep your own copy if you might need it elsewhere.

**Using one:** ask the agent in plain words, for example "check uptime on the core router using core-router". The agent runs one of these:

| Use | Command |
|---|---|
| SSH | `desk-ssh NAME admin@10.0.0.1 "show version"` |
| File copy | `desk-scp NAME file user@host:/path`, `desk-sftp NAME user@host` |
| Telnet | `desk-telnet NAME host [port] --run "show version" --run "show clock"` |
| Git over HTTPS or SSH | `desk-git NAME push origin main` |
| Anything else | The variable `DESK_SECRET_NAME`, used in the command that needs it |

The variable name is the login's name in capitals with other characters as underscores, so `my-pat` becomes `DESK_SECRET_MY_PAT`:

```bash
curl -H "Authorization: Bearer $DESK_SECRET_MY_PAT" https://api.example.com
```

```powershell
Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:DESK_SECRET_MY_PAT" } https://api.example.com
```

**What to expect**

- You are asked once per chat before each login is first used. Read where the command sends it.
- An unknown SSH server is refused. The agent has to ask you before trusting a new one.
- SSH tries a password once, so a wrong one doesn't lock an account on network gear.
- One command can use one saved password. Split the work to use two.
- Telnet is unencrypted: the password crosses the network in the clear. Use SSH where the device supports it.

**Limits**

- Logins are per computer and do not sync. Add them again on another computer.
- Reinstalling Windows or changing Windows accounts makes the saved file unreadable.
- SSH keys with a passphrase aren't supported. Save a key without one.

See [SECURITY.md](./SECURITY.md#saved-logins) for what this does and doesn't protect against.

## Sync

**Settings → Sync** keeps your chats, memory, project list and settings in a private git repository shared by your computers.

- **Turning it on:** leave the address empty and click **Create repository and sync**. The app looks on your GitHub account and its organizations for a private repository named `desk-sync` or `desksync`, and creates a private `desk-sync` if there is none. This needs the GitHub CLI signed in. Or paste the address of any repository.
- **When it commits:** within about a second of sending a message or a reply ending. While a reply is streaming, at most every 30 seconds. Also every 3 minutes, and when the app starts and quits.
- **What goes up:** chats, project names and remotes, memory, and these settings: fonts, theme, code panel, hidden chats, Auto model list, reviewer and autocomplete model, privacy mode, and Cursor mode.
- **What stays on the computer:** API keys, saved logins, project folder paths, and the rest of the settings.
- **Hidden in the pushed copy:** passwords and tokens in chats become `[hidden]`. Your local copy keeps them, so the repository alone can't restore them.
- Your project code is not part of this. It stays in each project's own repository.

If two computers change the same chat at the same moment, that file can conflict. The error is shown and nothing is force-pushed.

Other git hosts work with a pasted address if it is `owner/repo` shaped. GitLab nested groups and Azure DevOps addresses are rejected for now. Creating the repository for you, and the pull request button, are GitHub only.

## Setting up another computer

1. Install [Git for Windows](https://git-scm.com) and the [GitHub CLI](https://cli.github.com) if you want Git or Hybrid. The setup signs in with `gh auth login`.
2. Install the app from the release's `-win-setup.exe`. Windows SmartScreen asks once, because the build isn't code-signed: choose **More info → Run anyway**. The setup asks Git, Local, or Hybrid, then whether to import Cursor. Git and Hybrid sign in to GitHub if needed and create the repository.
3. Sign in under **Settings → Engine & sign-in**.
4. A computer that skipped the questions can use **Settings → Sync**: leave the address empty and click **Create repository and sync**. It finds your existing repository, so your chats do not split across two.
5. Your chats, projects and memory come down. Passwords and tokens stay hidden in those chats, because the repository only holds the hidden copy.
6. On the first sync after each app start, projects with no folder here are matched against clones in your home folder, up to three levels deep. A match links only when there is no doubt.
7. For the rest, use **Find repositories…** to search a folder you pick, or **Clone all (N)…** to download them into one folder. These buttons appear only when a project with a remote has no folder on this computer.
8. Add your saved logins again in **Settings → Privacy & logins → Saved logins**.

**Needs a hand:**

- Two projects on one repository get one clone. Use **Locate folder…** on the second.
- A project with no git remote has its chats but no files to fetch.

## Where chats live and Cursor

The Windows setup asks where chats live, then which installed AI IDE to import. Git and Hybrid open GitHub sign-in when the GitHub CLI is not already signed in, and create the private repository. If the app is already open, or sign-in does not finish, setup stops and the choice stays on disk. Opening the app applies it. A silent install skips both questions. The first start still asks when Cursor chats are found and no choice was saved. **Settings → Chats & projects → Where chats live** can change it.

- **Git:** every chat is copied here at full length and synced through a private repository. **Settings → Chats & projects → Cursor folders** can then delete Cursor's folders. That's permanent, needs Cursor closed, copies again and backs up Cursor's databases first, and refuses if either fails. It never touches project folders, and it keeps `.cursor\worktrees`.
- **Hybrid:** the same copying and sync, and Cursor keeps its files.
- **Local:** chats stay in Cursor's database and are read from there. Nothing is copied or pushed.

**Catch up** hands one of those chats to the agent as a briefing. Nothing is written into the project folder.

## Deleting a project from the disk

Right-click a project and choose **Delete folder from this computer…**.

- **You are told first** what exists only here: uncommitted files, unpushed commits, stashes, no remote, or not a git repository. **Cancel** is the default button.
- **The folder goes to the Recycle Bin.** It can be restored from there, and the disk space comes back when you empty the bin. If Windows refuses the move, the app says so. Network and some removable drives may have no Recycle Bin, so treat a delete there as permanent.
- **Refused:** a whole drive, your home folder, the app's own folders, a folder holding other projects, and anything with a running chat.
- **What stays:** the project's chats. The project moves to the archive and can be cloned again. Other computers aren't affected.

Close any terminal or editor using the folder first, or Windows may refuse the move.

## Files and the editor

- **Files** in the sidebar is the folder tree. **Ctrl+P** opens a file by name.
- **Code** shows the editor, which loads the first time you open it. **Ctrl+S** saves.
- Right-click a file to create, rename, delete, copy its path, reveal it, or add it to the chat.
- **Quick edit (Ctrl+I):** select code, say what to change, and a small fast model rewrites that part. Ctrl+Z undoes it.
- **Autocomplete** (opt-in, **Settings → AI models → Editor autocomplete**): grey text suggests the next lines, and Tab accepts. Each pause in typing is one call to that model.
- Saving writes the file in place. The editor opens files up to 2 MB.
- **The change bar** lists files the agent edited, with a diff and undo for each.

## Around the chat

- **Terminal:** a shell in the project.
- **Git:** branch, changes, commit, fetch, pull, push, checkout, history, and a pull request through GitHub's `gh` command.
- **Preview:** loads a web address.
- **Instructions:** edits `CLAUDE.md`, `AGENTS.md` and the project's `.mcp.json`.
- **Rules:** standing orders for the folder: rules added to every run, paths the agent may not edit, and checks that must pass. Checks run on both engines when a run changed files. A failure goes back to the agent with the output, up to the attempt limit you set. A team can commit `.agenticops/orders.json` with rules and protected paths. Any `checks` in that file are ignored, so a cloned repository can't run commands by itself.
- **Inbox** lists everything waiting on you across chats. **Briefing** shows where recent chats stand. **Ctrl+Shift+P** opens the command palette.

## Memory

Plain markdown files that carry over between chats, in three scopes:

- **Global:** applies everywhere.
- **Organization:** shared by repositories with the same GitHub owner.
- **Project:** this codebase, in Claude Code's own memory folder.

The agent reads the indexes at the start of a run and writes to them as it learns. Memory syncs with your chats.

## Plugins

**Settings → Plugins** (or `/plugins`) browses, installs, updates and turns off Claude Code plugins. They add slash commands, skills, agents, hooks and MCP servers, and work with the Claude Code engine, not Direct models.

Clicking **Install** opens a confirmation under that row. If a plugin runs a setup command, you see that exact command and are asked again. A plugin runs with the agent's permissions, so install ones you trust.

## Updates

On Windows setup installs, the app checks git tags every six hours and when you press **Settings → Updates**. A beta prerelease counts. A draft release does not.

- If only the app's own code changed, it downloads a signed patch, which loads at the next start or from **Restart to update**. If a patch keeps the window from opening, the next start goes back to the code before it.
- A change to Electron or an installed package needs the full installer, and so do portable copies, macOS and Linux.
- The private repository is read with the GitHub CLI sign-in on this computer (`gh auth login`). The app does not carry a token. Without that sign-in, Settings → Updates says so and nothing is downloaded.

## Keyboard

| Keys | Action |
|---|---|
| Enter / Shift+Enter | Send (or guide a running chat) / new line |
| Ctrl+N | New chat |
| Ctrl+K | Focus the message box |
| Ctrl+P | Open a file |
| Ctrl+I | Quick edit |
| Ctrl+S | Save the file |
| Ctrl+Shift+E | Switch between chats and files |
| F1 | Help |
