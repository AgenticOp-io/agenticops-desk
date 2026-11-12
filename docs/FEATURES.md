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
- [License](#license)

## The window

- **Messages:** a short note pops up after something you did, such as "Saved CLAUDE.md", and clears after 8 seconds. First-launch download progress shows the same way and stays until the download ends.
- **Far-left icons:** Inbox (with a count when something waits on you), Briefing, Help and Settings, then the switch between projects and chats or the folder tree.
- **Left side:** projects and chats, or the folder tree.
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
| **Chats & projects** | Hidden items, Project cleanup, Where chats live, Import from other tools, and Cursor folders in Git mode |
| **Engine & sign-in** | Claude Code status, Sign in, Check |
| **AI models** | Direct AI providers, Second opinion, Editor autocomplete, Spending cap, Auto model |
| **Plugins** | Browse, install and manage plugins |
| **Updates** | Check for a newer release, and Restart to update |

The command palette opens **Plugins** and **AI models** directly.

## Projects and the sidebar

The list has three sections, top to bottom:

| Section | What is in it |
|---|---|
| Main list | Projects on GitHub, projects that still have chats, and whatever is open or running now |
| **Other folders** | Folders with no chats. One row until you open it |
| **Archive** | Projects not opened for 90 days, and any you moved there |

**Clicking a project**

- Clicking another project goes to the chat you used there last and opens its list.
- Clicking the project you are in collapses or reopens it. That never changes the chat on screen.
- An open project lists every chat. Collapsing the project hides those rows; the chats stay, and opening it shows them again. Two folders with the same name show the parent folder after the name.

**Running chats** show one word in the sidebar: Starting, Thinking, Working, Writing, Pushing, or Needs permission. The detail, such as which command is running, stays in the chat header. A collapsed project shows the same word on its row.

**The archive** is only a view. Nothing moves on disk, and search still finds archived projects.

- **To archive:** drag a project onto the **Show archive** row (it lights up), or right-click and choose **Move to archive**.
- **To bring one back:** open the archive and drag it onto any row outside, right-click and choose **Bring out of archive**, or open it. Bringing one back restarts its 90 days.
- A project with a running chat never counts as archived. A project that is open stays out of the automatic archive, but one you archived by hand stays there until you open it.
- Archive placement is saved per computer and is not synced.

**Other sidebar actions**

- **Add** puts a folder on the list. **New chat** starts one in the open project.
- Drag projects or chats to reorder them.
- Right-click a project to change or locate its folder, hide it, archive it, or delete its folder. Right-click a chat, or use the **⋯** that appears when you hover it, to rename, pin, branch, move, hide or delete it. Double-click or **F2** renames a chat in place; **Delete** deletes the selected one.
- Hidden items are listed in **Settings → Chats & projects**, with **Unhide all**.

**Projects keep their identity.** A project has a permanent ID. If its folder moves or disappears, it shows **no folder** and its chats stay with it. Use **Locate folder…** to point it at the new place. A chat stays in its project until you use **Move to project…**. **Settings → Chats & projects → Project cleanup** offers to merge one project found in two places.

## Chats

- Each chat resumes its own session for about 45 minutes, so a short reply like "yes" keeps its context. After that, or once the context passes 150,000 tokens, the next message does not resume the session. Resuming would resend the whole history, including old file contents and command output. Instead the message carries a short brief: the first request and the latest replies. A note in the chat says so. Project memory still applies, and the agent reads again any file it needs. The size and the time of the last turn are remembered after a restart.
- A chat opens at its last message. If you scroll up, it stays where you are until you scroll back to the end.
- Several chats can run at once. **Stop** ends only the chat on screen.
- **Rounds:** each message you send starts a round: your request, a record of the work that stays open while it runs and folds away when the reply is in, then the reply. While the model is reasoning, that reasoning streams in the round and folds away when the reply starts. Open **Thought** to read it again. It stays in the chat and is not sent back on the next command. An instruction sent mid-run joins the same round. A plan or task list the agent writes shows above the messages. Long chats show the latest rounds; earlier ones open from the top.
- **Notifications:** when a chat finishes or needs you and the window isn't in front, a desktop notice appears. Clicking it brings the window back, even from the tray.
- Closing the window while a chat is working hides the app to the tray and keeps going. **Quit** from the tray icon stops it. A run cut off by quitting resumes the next time you send.
- Closing the window when nothing is running saves open chats first. On macOS the app stays open after its window closes, and a reopened window saves its chats the same way.
- On a message you sent: **Rewind** drops everything after it, **Retry** sends it again, **Branch** copies the chat up to that point, and **Replay on…** sends the same message to another model in a new branch, so you can compare the two answers.
- Search looks inside messages as well as titles.

**Watch a log file.** Right-click a chat and choose **Watch a log file…** (or use the palette or `/watch`) and pick a log. When new lines contain error, exception, failed, traceback, panic or fatal, the last 60 lines go to that chat, which starts investigating without being asked. It waits 4 seconds for the burst to finish and at most once every 2 minutes, so a noisy log can't loop. The chat shows a chip for each watched file; **×** stops it. Watches survive restarts.

**Why a file changed.** When the editor shows a file a chat edited, a line above it quotes the request that made the change and how long ago. Clicking it opens that chat.

**Own worktree.** In a git project, **Own worktree** in the chat header gives the chat its own copy of the repository on its own branch (`desk/…`), so two chats in one repository don't edit the same files. The copy lives in the app's data folder, never in the project, and is per computer. The chat's next message starts there with the chat's history.

- **Merge** commits what the chat changed and merges its branch into the branch checked out in the project folder. A conflict stops the merge and leaves the project folder as it was.
- **×** removes the worktree and its branch. If it holds work that isn't merged, you are asked first.
- Deleting a chat removes its worktree only when nothing in it is unmerged.

## Sending a message

- **Enter** sends, **Shift+Enter** starts a new line. Sending while a chat is working guides that run.
- The box grows to fit your text, up to 40% of the window, and then scrolls.
- **Drafts stay with their chat.** Switch away and come back, and your text is there with the cursor at the end.
- `@` attaches a file, or a function, class or type by name (`@handleLogin` points the agent at its file and line; this needs a git repository).
- Paste or drop images: up to 10, each under 5 MB.
- **Send preview:** while you type a longer message, a line under the box lists files whose names match its words and an earlier chat about the same thing, which you can click to open. It searches only this computer.
- Enter works with Windows text suggestions: the message sends once the suggested word lands.
- `/` opens the commands below, plus the commands of installed plugins.

| Command | Does |
|---|---|
| `/agent`, `/plan`, `/auto` | Switch to Agent, Plan or Auto-edit mode |
| `/catchup` | Hand this chat's history to the agent as a briefing |
| `/terminal`, `/git`, `/preview`, `/notes` | Open the Terminal, Git, Preview or Instructions panel |
| `/rename`, `/pin`, `/branch` | Rename, pin or branch this chat |
| `/watch` | Watch a log file for errors |
| `/plugins`, `/autopick` | Open Settings at Plugins, or at the Auto model list |
| `/theme`, `/palette`, `/help` | Switch light and dark, open the command palette, open Help |
- **Agent** edits and runs commands. **Plan** writes a plan and waits. **Auto-edit** applies edits without an extra prompt.
- The meter shows how full the chat's context is and a rough cost since the window opened.
- **Settings → AI models → Spending cap** stops a run once it has spent $1–$50 (off by default). It covers the default engine and Claude API keys, which report cost; with a Claude sign-in that cost is an estimate. Other providers don't report a price and stop after 80 steps. A capped run leaves a note, and your next message continues the chat.

## Engines and models

Picked in the model menu, per chat.

- **Claude Code** (default): the official agent, using your Claude sign-in and subscription. No separate CLI install is needed. The installer doesn't contain the agent itself: the first chat downloads Anthropic's agent SDK and the engine for this computer from npm (about 270 MB), checks npm's SHA-512 fingerprint, and keeps them in the app's data folder. Progress shows as a message. A new app version that needs a newer engine downloads it once and removes the old one.
- **Direct:** the app's own agent loop, calling the Claude API (every model it still serves: Fable 5.2 to 5, Opus 5.5 to 4.5, Sonnet 5.5 to 4.5, and Haiku 5.5 and 4.5; Mythos and the retired Opus 4.1, Opus 4 and Sonnet 4 are not listed), OpenAI, OpenRouter, Google Gemini, DeepSeek, or Ollama with your key. Billed per token by that provider, except local Ollama. DeepSeek's models are in the model menu; pick one and paste the key there. Agent runs turn DeepSeek thinking off, so a tool round does not wait out a chain of thought. A new command stops the DeepSeek reply that is streaming and any command it is running, and the run continues with your command. A failed call, such as a rejected key or a rate limit, still shows as an error. The other providers load their model list when you add a key, from the menu or from **Settings → AI models → Direct AI providers**.
- **Auto:** uses all of these, or the ones you pick in **Settings → AI models → Auto model**, in your order. On a rate limit, quota error, rejected key, unreachable service or refusal, the message moves to the next AI and the failed one rests for a few minutes. Errors about the work itself, such as a failing test, do not switch AIs. A chat keeps the AI that last worked for it, and a label next to the model menu says which one answered. If an AI fails after changing files, the next one is told which files. Settings shows which AIs are resting, and **Try it again now** wakes one early.
- **Second opinion:** a model from another provider reviews each change against your request, and sends concerns back to the agent, for up to two rounds.
- **MCP servers on Direct:** Direct chats use the same MCP servers as the default engine: the project's `.mcp.json`, and the servers in your user settings (`~/.claude.json`). A server from the project's `.mcp.json` came with the repository, so the chat asks once before starting it, and again if that entry changes. Each tool call goes through the same permissions as the agent's other tools. Servers stop after 15 minutes unused. Plugins' own servers still need the default engine.

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

**To add one:** give it a name such as `core-router`, pick **Password**, **Token or PAT**, or **SSH private key**, optionally add a username and host, and save. A key locked with a passphrase takes the passphrase in the field under it; ssh gets it the same way it gets a saved password. To change a value, use **Replace** and save with the same name. A saved value can't be read back, so keep your own copy if you might need it elsewhere.

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
- One command can use one saved password or key passphrase. Split the work to use two.
- Telnet is unencrypted: the password crosses the network in the clear. Use SSH where the device supports it.

**Limits**

- Logins are per computer and do not sync. Add them again on another computer.
- Reinstalling Windows or changing Windows accounts makes the saved file unreadable.
See [SECURITY.md](./SECURITY.md#saved-logins) for what this does and doesn't protect against.

## Sync

**Settings → Sync** keeps your chats, memory, project list and settings in a private git repository shared by your computers.

- **Turning it on:** leave the address empty and click **Create repository and sync**. The app looks on your GitHub account and its organizations for a private repository named `desk-sync` or `desksync`, and creates a private `desk-sync` if there is none. This needs the GitHub CLI signed in. Or paste the address of any repository.
- **When it commits:** within about a second of sending a message or a reply ending. While a reply is streaming, at most every 30 seconds. Also every 3 minutes, and when the app starts and quits.
- If the repository is emptied or recreated, the next sync fills it again from this computer. At startup, duplicate copies of a chat and empty leftover projects with no folder are removed; branches and blank chats are kept.
- **What goes up:** chats, project names and remotes, memory, and these settings: fonts, theme, code panel, hidden chats, Auto model list, reviewer and autocomplete model, privacy mode, and Cursor mode.
- **What stays on the computer:** API keys, saved logins, project folder paths, and the rest of the settings.
- **Hidden in the pushed copy:** passwords and tokens in chats become `[hidden]`. Your local copy keeps them, so the repository alone can't restore them.
- Your project code is not part of this. It stays in each project's own repository.

**Two computers, one chat.** If both add to the same chat between syncs, both sets of messages are kept, this computer's first. A rewind on the computer that changed the chat last stands. If another computer pushed first, sync takes its commit and merges again on top of it; nothing is force-pushed.

Other git hosts work with a pasted https or ssh address, including GitLab subgroups and Azure DevOps (`dev.azure.com`, `ssh.dev.azure.com` and `visualstudio.com` forms). Creating the repository for you, and the pull request button, are GitHub only.

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

**Other tools.** The setup also offers, and **Settings → Chats & projects → Import chats** does any time:

- **Claude Code sessions typed in a terminal**, from `~/.claude/projects`. Each becomes a chat in its folder, and its next message continues that same session. Sessions started by apps, this one included, are skipped.
- **VS Code chats**, from VS Code's workspace storage. Text only; the next message hands the transcript to the agent.

Importing again adds new ones and never overwrites a chat you continued here. Windsurf keeps its history encrypted, so it is not read.

## Deleting a project from the disk

Right-click a project and choose **Delete folder from this computer…**.

- **You are told first** what exists only here: uncommitted files, unpushed commits, stashes, no remote, or not a git repository. **Cancel** is the default button.
- **The folder goes to the Recycle Bin.** It can be restored from there, and the disk space comes back when you empty the bin. If Windows refuses the move, the app says so. Network and some removable drives may have no Recycle Bin, so treat a delete there as permanent.
- **Refused:** a whole drive, your home folder, the app's own folders, a folder holding other projects, and anything with a running chat.
- **What stays:** the project's chats. The project moves to the archive and can be cloned again. Other computers aren't affected.

Close any terminal or editor using the folder first, or Windows may refuse the move.

## Files and the editor

- **Files** in the sidebar is the folder tree. **Ctrl+P** opens a file by name.
- **Code** shows the editor, which loads the first time you open it. **Ctrl+S** saves. A dot on a tab means unsaved changes; middle-click closes a tab. Code blocks in a reply open as read-only tabs.
- A file you pick yourself outside the project can be opened and revealed; other paths outside it are refused.
- Right-click a file to create, rename, delete, copy its path, reveal it, or add it to the chat.
- **Quick edit (Ctrl+I):** select code, say what to change, and a small fast model rewrites that part. Ctrl+Z undoes it.
- **Autocomplete** (opt-in, **Settings → AI models → Editor autocomplete**): grey text suggests the next lines, and Tab accepts. Each pause in typing is one call to that model.
- Saving writes the file in place. The editor opens files up to 2 MB.
- **The change bar** lists files the agent edited, with a diff, **Keep** and **Undo** for each. Undoing a file the agent created sends it to the Recycle Bin. Your next message clears the bar; the edits stay.

## Around the chat

- **Terminal:** a shell in the project, up to three at once. Output keeps collecting while the panel is hidden, and Restart ends the shell and everything it started.
- **Git:** branch, changes, commit, fetch, pull, push, checkout, history, and a pull request through GitHub's `gh` command.
- **Preview:** loads a web address. In a project with a `dev`, `start` or `serve` script, **Run npm run dev** (or the pnpm, yarn or bun form its lockfile names) starts it in the project's terminal and opens the local address it prints. The Terminal tab shows its output, and Restart there stops it.
- **Instructions:** edits `CLAUDE.md`, `AGENTS.md` and the project's `.mcp.json`.
- **Rules:** standing orders for the folder: rules added to every run, paths the agent may not edit, and checks that must pass. Checks run on both engines when a run changed files. A failure goes back to the agent with the output, up to the attempt limit you set. A team can commit `.agenticops/orders.json` with rules and protected paths. Any `checks` in that file are ignored, so a cloned repository can't run commands by itself.
- **Inbox** lists everything waiting on you across chats: a permission request from another chat waits there instead of covering the chat you are in. **Briefing** shows where the last three days of chats stand, and opens by itself when you come back after 8 hours away. **Ctrl+Shift+P** opens the command palette.
- Links in replies, and pages that try to open a new window, open in your browser. The Preview frame is sandboxed and can't take over the app's window.

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
- A change to Electron or an installed package needs the full installer. On a Windows setup install, **Download and install** fetches the setup for this computer's chip, checks it against the release's signed list, and runs it once the app has saved and closed. The new version opens by itself. It waits while a chat is running. Copies on 0.1.20 or older don't have this button, so they need the setup downloaded by hand once.
- Portable copies, macOS and Linux need the installer from the release page.
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

The command palette (**Ctrl+Shift+P**) lists the same actions as the `/` commands, plus New chat, Open a file, Rules, Inbox, Briefing and Use the Auto model in this chat.

## License

AgenticOps Desk is free software under the GNU AGPL-3.0 ([LICENSE](../LICENSE)). You may use, change and share it; if you distribute a changed version or offer it as a network service, you must publish your changes under the same license. Anthropic's agent SDK and engine keep Anthropic's own terms and are not in the installer ([NOTICE](../NOTICE)). A commercial license for use without the AGPL's terms is available from opensource@agenticop.io. Contributions need a signed contributor license agreement ([CONTRIBUTING.md](../CONTRIBUTING.md)).
