# Features

What AgenticOps Desk does and how to use it. The same material, shorter, is in the app under **Help** (F1). For how it is built, see [ARCHITECTURE.md](./ARCHITECTURE.md). For what protects your secrets and where that stops, see [SECURITY.md](./SECURITY.md).

## Quick start

1. **Sign in** under **Settings → Engine & sign-in**. The first chat downloads the agent engine once.
2. **Add** a project folder in the sidebar, then **New chat** (Ctrl+N).
3. Type what you want and press **Enter**. The agent edits files and runs commands. The first command in a folder asks once; after you allow it, ordinary coding runs without asking.
4. Review what changed on the **change bar** under the chat: **Keep** or **Undo** each file.
5. Optional, all in Settings: **Set up local model** (cheaper follow-ups), **Sync** (your other computers), **Direct AI providers** (other models), **Privacy Mode** (on already).

Stuck? **F1** opens Help, and **Ctrl+Shift+P** searches every action.

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
- [Manager chats](#manager-chats)
- [Canvas](#canvas)
- [Activity log and recovery](#activity-log-and-recovery)
- [Memory](#memory)
- [Plugins](#plugins)
- [Updates](#updates)
- [Keyboard](#keyboard)
- [License](#license)

## The window

- **Messages:** a short note pops up after something you did, such as "Saved CLAUDE.md", and clears after 8 seconds. First-launch download progress shows the same way and stays until the download ends.
- **Top bar:** **Files** opens the Code window. On the right are **Waiting on you** (the inbox, with a count when something waits on you), **Help** and **Settings**. The sidebar is the projects and chats list.
- **Separate windows:** under Settings › Appearance › **Open in their own window**, tick any of Chats, Files, Waiting on you, Chat status, Help and Settings. A ticked panel opens as its own window, which you can move beside the chat, and it stays in sync with the main window. Its top-bar button opens or closes that window. Help and Settings are ticked to start with. When both Chats and Files are ticked, the sidebar goes away and the chat uses the full width. If a window can't open, the panel shows inside the main window instead.
- **Left side:** projects and chats, or the folder tree.
- **Right side:** the conversation and message box. **Code** (under the message box) opens the Code window.
- **Under the message box:** Terminal, Git and Preview. **Canvas** opens in its own window, **Status** shows the chat briefing, and **Open work** lists what the project still has open.

There is no status bar. Sign-in state and the agent engine's state are in **Settings → Engine & sign-in**. If you are signed out, sending a message shows the error in the chat.

## Settings

**Settings** opens a list of sections. Pick one, and **‹ Back** returns to the list. Closing Settings starts at the list again.

| Section | What is in it |
|---|---|
| **Appearance** | Theme, window font size, agent list font size, Code editor (Show the minimap, off by default; applies to editors opened afterwards) |
| **Privacy & logins** | Privacy Mode, Always hide these values, Saved logins |
| **Sync** | The sync repository, and what Cursor chats do |
| **Chats & projects** | Hidden items, Project cleanup, Where chats live, Import from other tools, Older chats, and Cursor folders in Git mode |
| **Engine & sign-in** | Claude Code status, Sign in, Check |
| **AI models** | Direct AI providers, Second opinion, Editor autocomplete, Summaries and the local model, Spending cap, Manager chats (worker limit), Auto model |
| **Instructions & rules** | What the agent reads (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`) and the standing orders the app enforces |
| **Usage** | Plan limits, and tokens and cost per engine, provider and model |
| **Activity log** | Recent runs, tool calls, git operations, approvals and errors |
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
- An open project lists every chat. The arrow collapses the project; clicking the name does not, so the chats stay in view. Opening a collapsed project shows them again. Two folders with the same name show the parent folder after the name.

**Running chats** show one word in the sidebar: Starting, Thinking, Working, Writing, Pushing, or Needs permission. The detail, such as which command is running, stays in the chat header. A collapsed project shows the same word on its row.

**The archive** is only a view. Nothing moves on disk, and search still finds archived projects.

- **To archive:** drag a project onto the **Show archive** row (it lights up), or right-click and choose **Move to archive**.
- **To bring one back:** open the archive and drag it onto any row outside, right-click and choose **Bring out of archive**, or open it. Bringing one back restarts its 90 days.
- A project with a running chat never counts as archived. A project that is open stays out of the automatic archive, but one you archived by hand stays there until you open it.
- Archive placement is saved per computer and is not synced.

**Older chats:** inside a project, chats not used for 14 days fold under a **Show N older chats** row at the end of its list. Open the row to see and read them. Search still finds them. The top chat, pinned chats, the open chat and running chats always stay in view. Change the number of days, or turn it off, in **Settings > Chats & projects > Older chats**.

**Other sidebar actions**

- **Add** puts a folder on the list. **New chat** starts one in the open project.
- Drag projects or chats to reorder them.
- Right-click a project to change or locate its folder, hide it, archive it, or delete its folder. Right-click a chat, or use the **⋯** that appears when you hover it, to rename, pin, branch, move, hide or delete it. Double-click or **F2** renames a chat in place; **Delete** deletes the selected one.
- Hidden chats, and chats in a hidden project, are listed under **Show hidden** at the bottom of the sidebar. Search finds them too. Opening one puts it back in the list. **Settings → Chats & projects** has the same list, with **Unhide all**.

**Projects keep their identity.** A project has a permanent ID. If its folder moves or disappears, it shows **no folder** and its chats stay with it. Use **Locate folder…** to point it at the new place. A chat stays in its project until you use **Move to project…**. **Settings → Chats & projects → Project cleanup** offers to merge one project found in two places.

## Chats

### How a follow-up works

A follow-up does **not** resume the old session or resend the transcript. That keeps long chats cheap. Instead, the next message carries:

1. **A short summary** of the chat, written on this computer by a local model after each run.
2. **The last two replies, word for word**, and any older markdown tables, so a table or plan you were just given is never lost to the summary.
3. **Work already verified.** A run whose checks (type check, tests, lint, build, commit) passed after its last edit leaves a small record: what was asked, the result and the files changed. The record is dropped once one of those files changes, so the agent trusts only what still holds and does not re-check it.
4. **A short local reading of the project** (what changed, which files matter), then your new request.

Project memory still applies, and the agent opens a file again only to change it.

If the local model is off or the summary isn't ready, the message carries a short brief of the first request and the latest replies instead. **Settings → AI models → Summaries** picks a different summary model.

### Keeping costs down

- **Long output is shortened** before the paid model sees it: a long file read, search or command result keeps its head and tail. A run that re-reads about 1.5 million tokens of its own tool output stops and continues from a short packet, with a note.
- **Each chat starts on Sonnet.** A local model reads the chat's record and the new message and can step it up to Opus. It never takes the chat unless you pick it in the menu. Sending the same request again, or switching the menu to a heavier model, moves the chat up; several accepted messages move it back down. Auto tries the signed-in agent first and uses a local model only when the others are unavailable.
- **Images are described on this computer** and the image itself isn't sent when that works.
- **A second opinion** uses the local model unless you pick another, and a fix round starts fresh instead of resuming the large session, with a note that the earlier tokens were left out.
- **Memory is fixed for the length of a chat's cache.** A memory written mid-chat reaches that chat's next run only after the cache has expired, so it doesn't invalidate the cached start of the conversation every turn.
- **Cold-cache warning.** A chat idle for a while loses its cache. If you continue one that was working about 45 minutes ago or more, a note says continuing resends the whole session and costs more than usual.
- **Interrupted runs.** A message sent while a run is going joins that run. A run cut off by quitting resumes its session if it is still recent (under about 45 minutes); after that it asks you to send again, and that message continues from the summary.

### Local model

**Settings → AI models → Summaries → Set up local model** (or the box on the installer's last page) downloads llama.cpp's small server and a 7B coding model (about 4.5 GB, the sizes are checked as they download), starts it on this computer, and turns Summaries on. No Ollama install is needed. Loading runs at low priority so the window keeps responding, and the server stops when you quit. Progress shows in Settings; if it fails, for example with no network, press the button again.

### Working in a chat

- A chat opens at its last message. If you scroll up, it stays where you are until you scroll back to the end.
- Several chats can run at once. **Stop** ends only the chat on screen.
- **Rounds:** each message you send starts a round: your request, a record of the work that stays open while it runs and folds away when the reply is in, then the reply. While the model is reasoning, that text streams in the round and folds away when the reply starts. Open **Thought** to read it again. It stays in the chat and is not sent back on the next command. An instruction sent mid-run joins the same round. A plan or task list the agent writes shows above the messages. Long chats show the latest rounds; earlier ones open from the top.
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
- **Spelling:** misspelled words are underlined. Right-click one for suggestions or **Add to dictionary**; right-click in any text box also gives Cut, Copy, Paste and Select all. In the message box, an obvious typo is fixed as you finish the word, such as *recieve* to *receive*. Ctrl+Z takes the fix back. Autocorrect leaves alone words under four letters, words with capitals, digits or symbols, and anything inside backticks.
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
- The meter shows how full the chat's context is, how much of the 5-hour allowance is used once the engine has reported it, and a rough cost since the window opened.
- **Settings → Usage** has one card per engine and provider. The Claude sign-in card shows the plan limits, such as the 5-hour session and the weekly limits, with the percent used and when each one resets; **Refresh** reads them again. Each card shows tokens for today, the last 7 days and the last 30 days, with a 14-day chart for each model. Cost appears where the provider reports a price. The first time you open it, the last 30 days are counted from the default engine's session logs. Second-opinion and autocomplete calls count tokens but not cost.
- **Settings → AI models → Spending cap** stops a run once it has spent $1–$50 (off by default). It covers the default engine and Claude API keys, which report cost; with a Claude sign-in that cost is an estimate. Other providers don't report a price and stop after 80 steps. A capped run leaves a note, and your next message continues the chat.

## Engines and models

Picked in the model menu, per chat. The menu opens a submenu for each engine or provider, and Claude models sit in a submenu per family (Fable, Opus, Sonnet, Haiku): **Claude Code → Opus → Opus 4.6**, for example. Under Claude Code, each family starts with **Latest**, which follows your sign-in's newest model, then every fixed version. Auto uses the default and Latest entries, not the fixed versions, since they share one sign-in's limits.

- **Claude Code** (default): the official agent, using your Claude sign-in and subscription. No separate CLI install is needed. The installer doesn't contain the agent itself: the first chat downloads Anthropic's agent SDK and the engine for this computer from npm (about 270 MB), checks npm's SHA-512 fingerprint, and keeps them in the app's data folder. Progress shows as a message. A new app version that needs a newer engine downloads it once and removes the old one.
- **Direct:** the app's own agent loop, calling the Claude API (every model it still serves: Fable 5.2 to 5, Opus 5.5 to 4.5, Sonnet 5.5 to 4.5, and Haiku 5.5 and 4.5; Mythos and the retired Opus 4.1, Opus 4 and Sonnet 4 are not listed), OpenAI (GPT-6.2 Astra, GPT-6.2 Sol, GPT-6.1 Terra, and GPT-6 Sol), OpenRouter, Google Gemini, DeepSeek, xAI Grok, Mistral, Qwen, or Ollama with your key. The model menu lists only providers that are ready: add a key (and, where needed, **Load models**) in **Settings → Providers** first. If a provider rejects its key, its models leave the menu and Settings shows **Key rejected** until you save a new key. Any other service that speaks the OpenAI chat API can be added in **Settings → AI models → Direct AI providers** with a name, address, and key; **Add and test** loads its models into the menu. Billed per token by that provider, except local Ollama. **Cloud GPU** is your own Ollama server reached through an SSH tunnel at `localhost:11435`; start the server and the tunnel yourself, then **Load models**. It counts as a cloud provider, so Privacy Mode still hides secrets before they are sent. DeepSeek's models are in the model menu; pick one and paste the key there. Agent runs turn DeepSeek thinking off, so a tool round does not wait out a chain of thought. A new command stops the DeepSeek reply that is streaming and any command it is running, and the run continues with your command. A failed call, such as a rejected key or a rate limit, still shows as an error. The other providers load their model list when you add a key, from the menu or from **Settings → AI models → Direct AI providers**.
- **Auto:** uses the signed-in agent first, then a cheaper ready model (DeepSeek Flash, Gemini Hydrogen, GPT Sol, and the other keys you have added), then a stronger paid model. A model on this computer or your own GPU is used only after those are off. **Settings → AI models → Auto model** can replace which hosted models are tried, and in what order. On a rate limit, quota error, a full 5-hour sign-in window, rejected key, unreachable service or refusal, that AI turns off and the same message goes to the next one. The chat does not show the provider error, including the sign-in limit sentence. The reason is listed under Auto model until the limit resets or you press **Try it again now**. While that 5-hour window is still full, Auto does not start the signed-in agent again. If nothing is left that can run, the chat says no AI models are available. Errors about the work itself, such as a failing test, stay in the chat. A chat keeps the last hosted AI that worked for it, and a label next to the model menu says which one answered. If an AI fails after changing files, the next one is told which files.
- **Second opinion:** a model from another provider reviews each change against your request, and sends concerns back to the agent, for up to two rounds.
- **MCP servers on Direct:** Direct chats use the same MCP servers as the default engine: the project's `.mcp.json`, and the servers in your user settings (`~/.claude.json`). A server from the project's `.mcp.json` came with the repository, so the chat asks once before starting it, and again if that entry changes. Each tool call goes through the same permissions as the agent's other tools. Servers stop after 15 minutes unused. Plugins' own servers still need the default engine.

## Permissions

- File edits inside the open folder happen without asking, and appear on the change bar to review or undo.
- "Inside the folder" means where the file really is. A shortcut or junction in the project that points elsewhere is treated as outside, for the agent's file tools and for the editor.
- The first command in a folder asks once. After **Allow**, tests, git (including push), deletes and network commands run without asking.
- Disk format, administrator commands and shutdown still ask, once each, and are remembered if you allow them.
- **Allow always** on either prompt remembers the answer for every folder, so new chats (each in its own new folder) don't ask again. To undo it, delete the `"*"` entry in `allows.json` in the app's data folder.
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
- **Who commits:** sync commits, and commits the agent makes in your projects, are authored as your GitHub CLI login plus `-desktop` (for example `octo-desktop`), with your own git email. Without the GitHub CLI it uses your global git name. The agent adds no co-author line.
- **Phone:** a project in a private GitHub repository keeps its chats, and a job log (one line when a chat's run starts and one when it ends), on a `desk-chats` branch of that repository. To sign the Android app in, open Settings → Sync → Phone on the desk, click Show pairing code, and tap Scan in the app. The code carries the desk's GitHub CLI sign-in, so treat it like a password; it hides itself after two minutes. The app then lists every project that has that branch, and shows its chats as they look on the desk. A message or new chat sent from the phone is picked up by the computer that last ran that chat on its next sync (within about 3 minutes) and runs there. Its reply reaches the phone on the sync after that. The desk only runs phone messages committed by its own GitHub CLI account. The Inbox tab lists chats running now and recently finished, and a "Needs you" section: folder-trust and risky-command prompts the desk is waiting on show Allow/Deny buttons, and an open chat has a Stop button. Questions, plan approvals and saved-login prompts never go to the phone. A photo (shrunk to 1280 px) is saved on the desk and named in the message; the Voice button dictates when the phone supports it. The app notifies about new prompts and finished chats only while it is running; there is no background push.

- **Plan authority and dashboard:** a manager with plan steps left, and its workers, allow their own permission prompts (not saved logins) and are told to decide questions themselves. Ctrl+Shift+D or the palette entry "Dashboard: all active work" opens a pane of every running chat (workers under their manager, plan progress, cost since launch) plus the eight most recently finished.
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
2. Install the app from the release's `-win-setup.exe`. Windows SmartScreen asks once, because the build isn't code-signed: choose **More info → Run anyway**. The setup asks Git, Local, or Hybrid, then whether to import Cursor, then whether to set up a free local model for chat summaries (ticked by default). Git and Hybrid sign in to GitHub if needed and create the repository. The local model downloads in the background once the app first opens. Under **Settings → AI models → Summaries** you can pick brief notes (about 1 GB), a model that keeps more detail (about 2 GB), a code-focused model (about 2 GB), or none. None keeps a short brief, and the agent can re-read details. It loads only when the computer has enough free memory, on two threads at idle priority, and it stops itself if memory runs low so the window keeps responding. If it fails, for example with no network, press **Set up local model** there to try again.
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

- **Files** and **Code** open the **Code window**: its own window with the project's folder tree and the editor. Click the folder name at the top of the tree to switch folders. Clicking a file path or a changed file in the chat opens it there. A file's changes from the agent open as a Keep/Undo diff. Right-click a file and pick the @ entry to mention it in the chat.
- **Source control** (the tab next to **Files** in the Code window) works like VS Code's. Changed files are listed under **Staged changes** and **Changes**. Hover a file to open it, stage it (+), unstage it (−) or discard it (↶; it asks first). Click a file to see its diff against the last commit, with **Stage** and **Discard** buttons. Write a message and press **Commit**, or Ctrl+Enter. With nothing staged, the button reads **Commit all**. **Amend** rewrites the last commit. The branch menu switches branches, checks out a remote branch, or makes a new one. The ↓/↑ button pulls and then pushes, and a branch with no upstream shows **Publish**. ⟳ fetches. **History** lists the last 60 commits.
- **Remote hosts:** for GitHub, GitLab, Bitbucket and Azure DevOps remotes, buttons open the repository, the branch, the open file, a new pull request, or the list of pull requests on the web. For GitHub and GitLab, **Show open pull requests** lists them in the app and lets you check one out. This needs the GitHub CLI (`gh`) or GitLab CLI (`glab`), installed and signed in. **Clone another repository** takes any https or ssh address, or lists your GitHub repositories, then opens the clone.
- **Ctrl+P** opens a file by name.
- The editor loads the first time you open it. **Ctrl+S** saves. A dot on a tab means unsaved changes; middle-click closes a tab. Code blocks in a reply open as read-only tabs.
- A file you pick yourself outside the project can be opened and revealed; other paths outside it are refused.
- Right-click a file to create, rename, delete, copy its path, reveal it, or add it to the chat.
- **Quick edit (Ctrl+I):** select code, say what to change, and a small fast model rewrites that part. Ctrl+Z undoes it.
- **Autocomplete** (opt-in, **Settings → AI models → Editor autocomplete**): grey text suggests the next lines, and Tab accepts. Each pause in typing is one call to that model.
- Saving writes the file in place. The editor opens files up to 2 MB.
- **The change bar** lists files the agent edited, with a diff, **Keep** and **Undo** for each. Undoing a file the agent created sends it to the Recycle Bin. Your next message clears the bar; the edits stay.

## Around the chat


- **Terminal:** a shell in the project, up to three at once. Output keeps collecting while the panel is hidden, and Restart ends the shell and everything it started. Python started from the agent, this terminal, or a standing-order check stays on two threads and off the window's cores. If memory runs low, the window freezes, or the app quits, that Python is stopped so it cannot keep the app.
- **Git:** branch, changes, commit, fetch, pull, push, checkout, history, and a pull request through GitHub's `gh` command.
- **Preview:** loads a web address. In a project with a `dev`, `start` or `serve` script, **Run npm run dev** (or the pnpm, yarn or bun form its lockfile names) starts it in the project's terminal and opens the local address it prints. The Terminal tab shows its output, and Restart there stops it.
- **Instructions:** edits `CLAUDE.md`, `AGENTS.md` and the project's `.mcp.json`.
- **Rules:** standing orders for the folder: rules added to every run, paths the agent may not edit, and checks that must pass. Checks run on both engines when a run changed files. A failure goes back to the agent with the output, up to the attempt limit you set. A team can commit `.agenticops/orders.json` with rules and protected paths. Any `checks` in that file are ignored, so a cloned repository can't run commands by itself.
- **Waiting on you** (the inbox) lists everything waiting on you across chats: a permission request from another chat waits there instead of covering the chat you are in. **Chat status** (the briefing) shows where the last three days of chats stand, and opens by itself when you come back after 8 hours away. **Ctrl+Shift+P** opens the command palette.
- Links in replies, and pages that try to open a new window, open in your browser. The Preview frame is sandboxed and can't take over the app's window.

## Manager chats

Right-click a chat and choose **Make manager**. A manager can start worker chats in the same project, send them follow-ups and wait for their results, so one agent can split a job across several. A manager needs the default engine; on a Direct model it has no worker tools.

**Workers**

- Each worker is an ordinary chat. It shows in Chats, and its questions and approvals come to you in **Waiting on you**; the manager can't answer them.
- **Allow** on a worker trusts that worker's folder only. If the manager's folder is already trusted, the worker doesn't ask again, and Chat status lists it.
- Workers run in their own git worktree unless the manager says otherwise, and a worker can't become a manager.
- Each worker's run has the same spending cap as any run.
- **How many run at once:** **Settings → AI models → Manager chats** (default 3, up to 20). More workers finish sooner but use more of your allowance at the same time. A change applies to the next worker a manager starts; a manager chat that is already open keeps telling the agent the old number until you start a new one.

**Models.** The manager picks each worker's model to fit its task, from every AI that is ready in your model menu: the default engine's models and each Direct provider you've added a key for. Cheap, fast models get simple mechanical work, mid models ordinary coding, and the strongest hard design and debugging. With a follow-up it can move a finished worker to another model and keep its conversation: up a tier when the result is wrong or stuck, down for easy leftovers, or to another provider when one hits a usage limit. The worker's model menu shows the choice, and you can change it.

**Watching.** The chat header shows **Manager · n running** on a manager and **Worker of …** on a worker, which opens its manager. Each running worker has a bubble next to the manager label: click it to watch that worker live in its own window, with its commands, their output and its replies as they arrive. Click **Manager · n running** to pick any of its workers, finished ones too. **Open chat** in that window opens the worker in the main window so you can reply.

## Canvas

**Canvas** is where the agent shows what it makes for you: reports, network and architecture diagrams, charts, tables and one-page summaries. Ask for one ("draw a network diagram of these servers", "write this up as a report") and it opens in its own window. The agent fills it with its `show_canvas` tool, as an HTML page, an SVG picture or Markdown.

- **Export:** PDF (real text, not a picture), PNG (one tall image, up to 16,000 px), HTML, SVG for a diagram, Markdown for a text document.
- **One per chat.** Each chat has its own canvas; asking again replaces it and updates the open window. The **Canvas** button in the chat header reopens it.
- **Part of the chat.** It is saved in `canvas/<chat id>.json` in the app data folder, survives restarts, goes with the chat in desk sync (secrets hidden the same way as in the chat) and is removed when you delete the chat.
- **Locked down.** Canvas pages can't run scripts or load anything from the internet, so images have to be embedded in the page.
- Canvas works with the default engine. Direct chats don't have the tool yet.

## Activity log and recovery

- **Activity log** (**Settings → Activity log**): a timeline of agent runs and their outcomes, each tool call and whether it failed, git operations, approvals and errors. It keeps labels and outcomes only, never prompts, replies or secrets.
- **Crash and freeze recovery:** if the window's page crashes, or stays frozen for 15 seconds, it reloads by itself. Chats run in the app's main process, so a reload never stops them.
- **Image tools for the agent:** every chat on the default engine can read an attached image as text (local vision first, cloud fallback) and run one read-only `git` or `gh` status command through a local-model summary (`ops_triage`), so busywork doesn't use the paid model. With an OpenAI key saved under **Settings → AI models → Direct AI providers**, it can also create an image from a prompt; the PNG goes to the app's data folder, not your project.

## Memory

Plain markdown files that carry over between chats, in three scopes:

- **Global:** applies everywhere.
- **Organization:** shared by repositories with the same GitHub owner.
- **Project:** this codebase, in Claude Code's own memory folder.

The agent reads the indexes at the start of a run and writes to them as it learns. Memory syncs with your chats.

**Past chats.** Each run also refreshes two generated files in the project's memory folder, from the newest 300 chats of that project (older ones drop out):

- `chats-index.md`: one line per chat (date, first request, transcript path), so the agent can find earlier work by searching it.
- `chats-train.jsonl`: plain prompt and reply pairs in the `messages` format most fine-tuning tools accept, for training a model yourself. Tool calls and injected text are left out, and key-like strings, tokens, `password=` values and `{{SECRET_n}}` placeholders become `[redacted]`. Redaction follows patterns, so read the file before you train on it. It stays on this computer and is not synced.

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

AgenticOps Desk is licensed under the Apache License 2.0 ([LICENSE](../LICENSE)). You may use, change and share it, including in closed products, as long as you keep the license and copyright notices. Anthropic's agent SDK and engine keep Anthropic's own terms and are not in the installer ([NOTICE](../NOTICE)).
