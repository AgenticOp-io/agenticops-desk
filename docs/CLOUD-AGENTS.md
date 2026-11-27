# Cloud agents

Technical reference for the cloud-agent system: what runs where, the git job channel, the cryptography, job handling, the desktop-worker pool, Linux packages, and how to operate and debug it. For the user-facing steps, see [FEATURES.md → Cloud agents](./FEATURES.md#cloud-agents). For what it protects and where that stops, see [SECURITY.md → Cloud agents](./SECURITY.md#cloud-agents).

The feature is **off by default**. Nothing listens on the network and nothing is pushed until the superadmin turns on **Settings → Cloud agents → Accept cloud agents and users**.

## Contents

- [Roles](#roles)
- [Components and files](#components-and-files)
- [How the pieces connect](#how-the-pieces-connect)
- [The job channel](#the-job-channel)
- [The desk's certificate authority](#the-desks-certificate-authority)
- [Adding an agent](#adding-an-agent)
- [HTTP routes](#http-routes)
- [Jobs](#jobs)
- [What an agent does with a job](#what-an-agent-does-with-a-job)
- [Users, devices and the pool](#users-devices-and-the-pool)
- [Manager chats and the pool](#manager-chats-and-the-pool)
- [Metering and the report](#metering-and-the-report)
- [Linux packages](#linux-packages)
- [Limits and timeouts](#limits-and-timeouts)
- [Operating it](#operating-it)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)
- [Known gaps](#known-gaps)

## Roles

| Role | What it is | What it can do |
|---|---|---|
| **Superadmin desk** | The AgenticOps Desk with cloud agents turned on. One per pool | Add and remove agents, add and pause desktop workers, mint join keys, run its own jobs (by hand or from a manager chat), read the monthly report |
| **Cloud agent** | `agent/agentd.mjs` running under Node 18+ with git on Windows, macOS or Linux | Take one job at a time from the job channel, run a tool loop in its own job folder with its own Claude API key, and push its progress and result back |
| **Desktop worker** | Another person's AgenticOps Desk that joined with a join key (`electron/pool.ts`) | Send jobs to the pool, see only its own jobs, and pair that person's phone into the pool under its user |
| **Device** | A phone signed in under a user | Send jobs, list them, cancel them |

The superadmin only controls access. A worker's prompts and results are not shown on the superadmin's page (`fleetState` returns only `ADMIN_USER` jobs). Their usage appears in the report as token, cost and minute totals.

There is no hosted cloud and no web UI. People work in their desk window or the phone app.

## Components and files

| Path | Runs on | Role |
|---|---|---|
| `electron/fleet.ts` | Superadmin desk (main process) | The job channel (`channelTick`), the mutual-TLS HTTPS server for workers and phones, Settings IPC (`fleetState`, `fleetSetup`, `fleetAddAgent`, `fleetRemoveAgent`, `fleetAddUser`, `fleetUpdateUser`, `fleetSubmit`, `fleetCancel`, `fleetReport`, `fleetExportCsv`, `fleetPhoneLogin`) |
| `electron/fleetCore.ts` | Desk, and plain Node in tests | State logic with no Electron: adding agents, users, devices, tokens, join keys, job queue, channel files (`signed`, `opened`, `jobOrders`, `applyReport`), report, CSV, the desk CA and certificates, `trustedCerts`, and `serveAgent`, which builds the agent file |
| `agent/agentd.mjs` | Agent machine | Channel loop (`tick`), job runner, model calls, tools. Only Node built-ins, so it runs from one file |
| `electron/pool.ts` | Desktop worker | Joining a pool with a join key, the pinned HTTPS client, `cloudPool` and `cloudSubmit`, `phoneCloudLogin` |
| `electron/team.ts` | Any desk | The manager tools `submit_work` and `check_cloud_jobs` |
| `src/FleetSettings.tsx` | Desk window | Settings → Cloud agents |
| `agent/pkg/` | Linux agent | `.deb`/`.rpm` contents: launcher, systemd unit, env file, install scripts, `nfpm.yaml` |
| `scripts/build-agent-packages.sh` | WSL or Linux | Builds the two packages with nfpm |

`fleet.ts` imports `agentd.mjs` with Vite's `?raw`, so the agent source ships inside `main.js`. A local patch, which carries only the build, therefore also updates the agent files the desk saves from then on.

### State on disk

**Superadmin:** `fleet.json` in the app data folder (`FleetState` in `fleetCore.ts`), and `fleet-channel/`, its working copy of the job channel:

| Field | Contents |
|---|---|
| `adminId`, `createdAt` | This superadmin's ID |
| `on`, `port`, `maxAgents` | Server switch, port (default 7377), how many agents may be approved (default 5) |
| `channel` | The job channel repository address |
| `tls.cert`, `tls.keyEnc`, `tls.server` | The desk CA certificate (PEM, never changes), its ECDSA private key encrypted with `safeStorage`, and the server certificate the CA signed with the same key. The same key signs every job |
| `agents[]` | `id`, `name`, `os`, `cert` (its certificate; its signature on channel files is checked against it), `aliveAt` (newest heartbeat), `status` (`approved`/`revoked`), `createdAt`, `lastSeen`. `pending`, `code` and `pub` remain from older flows; an agent with a `pub` is from before the channel |
| `users[]` | `id`, `name`, `maxAgents`, `agentIds` (empty = all), `code` (unredeemed join code), `enrolCert`/`enrolKeyEnc` (the client certificate in the join key, key encrypted), `devices[]` (`id`, `name`, `tokenHash`, `cert`, `createdAt`, `usedAt`), `paused`, `revoked`, plus a legacy single `tokenHash` |
| `jobs[]` | The last 2000 jobs, with log, result, tokens and cost |

Tokens are stored only as SHA-256 hashes. A token is shown once, when it is handed out. If `safeStorage` is not available, the desk refuses to make its key.

**Desktop worker:** `pool.json`: `url`, `pin`, `cert` (the superadmin's CA, from the join key), `clientCert` and `clientKeyEnc` (this desk's client certificate and its key, encrypted with `safeStorage`), `name` (the user name the superadmin gave), `tokenEnc` (the device token, encrypted).

**Agent:** everything is in the agent file itself (`const BUNDLE`, an `AgentBundle`): `deskCert` (the CA), `agentId`, `name`, `signKey` and `cert` (its signing key and desk-signed certificate), `channel`, `apiKey`. The desk saves it with mode 0600 and keeps neither the signing key nor the API key. The agent's home (`~/.agenticops-agent`, or `$AGENTICOPS_AGENT_HOME`) holds `channel/`, its working copy of the channel, and `jobs/<job id>/`.

## How the pieces connect

```
 superadmin desk (fleet.ts)                     job channel repo, branch agent-jobs                 agentd.mjs
 fleetSubmit / cloudSubmit (manager) ──┐        jobs/<agentId>/<jobId>.json   (desk-signed)  ◀── git fetch every 15 s
 /user/jobs (workers, phones) ─────────┼─▶ channelTick: fetch, read, assign, write, push ──▶      │
                                       │        agents/<agentId>/alive.json   (agent-signed) ◀── git push ── tick
                                       │        agents/<agentId>/<jobId>.json (agent-signed)       │
 HTTPS server, port 7377, mutual TLS:  │                                                        fetch ──▶ Claude API
   /user/redeem /user/me /user/jobs /user/jobs/:id/cancel /user/device                          (the agent's own key)
        ▲ device cert + Bearer token            ▲ device cert + Bearer token
   worker desk (pool.ts)                    phone (DeskWatchPlugin.cloud)
```

The desk and its agents never connect to each other. Neither needs an open port or a public address for this, so NAT doesn't matter. Worker desks and phones still connect in, to the HTTPS server on port 7377, so they need to reach the desk (same network, VPN or tunnel).

## The job channel

A git repository the superadmin names in Settings (`channel`). Use a private repository that only this desk and its agents can push to, not one holding code or chats: GitHub access is per repository, so anyone who can read it can read every job prompt. All traffic is on the `agent-jobs` branch:

| Path | Written by | Contents (`data`) |
|---|---|---|
| `README.md` | Desk | A note. It makes the branch exist before the first job, so agents can post a heartbeat |
| `jobs/<agentId>/<jobId>.json` | Desk | `{agentId, id, prompt, repo, model, cancelled}` for every running job, and for a cancelled one for an hour (`jobOrders`) |
| `agents/<agentId>/alive.json` | Agent | `{kind:"alive", agentId, at, os}`, renewed every 5 minutes |
| `agents/<agentId>/<jobId>.json` | Agent | `{kind:"result", agentId, jobId, status, log, usage, result?}`; `status` is `running`, `done` or `failed` |

**Signatures.** Every file is `{data, sig}`: an ECDSA P-256 SHA-256 signature over `JSON.stringify(data)`. The desk signs with its CA key; the agent checks with the CA certificate in its file. An agent signs with `signKey`; the desk checks with that agent's `cert`. Each side also checks that `agentId` is the right one and the file name matches the job ID. Anyone who can push to the repository can add or change files, but nothing they write without a key is believed. An agent also signature-checks its own earlier results before it republishes them, so a planted result can't be laundered through it.

**No merges.** Each side owns separate paths and rebuilds them from memory on every tick, on top of a fresh `git checkout -f -B agent-jobs origin/agent-jobs` and `git clean -fdx`. It then commits only if something changed and pushes. A push that is rejected because the other side pushed first is simply redone on the next tick. Signatures are randomised, so each side seals a file once per change and reuses the text; otherwise every tick would commit.

**Desk tick** (`channelTick`, every 15 s while on, and at once after a submit, cancel or remove; overlapping calls are coalesced):

1. Fetch and reset as above. If the branch doesn't exist yet, start it.
2. For each approved agent, open every file in `agents/<id>/` and apply it (`applyReport`): a newer heartbeat sets `lastSeen` and `os`; a result updates the log, tokens and cost of that agent's running job, and `done`/`failed` finishes it.
3. `sweep`, then give each online agent with no running job the oldest job it may take (`take`).
4. Rewrite `jobs/` from `jobOrders`, commit as `AgenticOps Desk`, push.

Errors show under the channel field on the page.

**Agent tick** (`tick` in `agentd.mjs`, every 15 s):

1. Fetch and reset. If the branch doesn't exist yet, wait.
2. Read its signed jobs, and its own signed results (from this run or an earlier one).
3. Drop results whose job file is gone (the desk is done with them).
4. A cancelled job that is running: abort the model call and kill the command tree. A job with a `running` result it isn't running: it restarted mid-job, so publish `failed` ("The agent restarted during this job."). A job with no result while idle: start it.
5. Rewrite `agents/<id>/` (heartbeat and results), commit as `AgenticOps agent`, push.

The agent machine's git must be able to push to the channel (an SSH deploy key or a credential helper for that user). `GIT_TERMINAL_PROMPT=0` makes a missing credential fail instead of waiting.

## The desk's certificate authority

The desk is its own CA. `fleetCore.ts` writes every certificate by hand (`buildCert`; Node can sign but cannot build X.509). All of them use ECDSA P-256 with `ecdsa-with-SHA256`, are issued by `CN=AgenticOps Desk`, and are valid for 10 years.

| Certificate | Made by | Subject, extensions | Key |
|---|---|---|---|
| Desk CA (`tls.cert`) | `makeDeskCert`, once | `CN=AgenticOps Desk`, self-signed, CA:true. Never re-issued, so what clients and agents trust never changes | The desk's key, which also signs jobs |
| Server (`tls.server`) | `makeServerCert` | `CN=AgenticOps Desk server`, CA:false, `subjectAltName` = `localhost`, `127.0.0.1`, the computer name and every non-link-local IPv4 address (`ipv4s` puts real adapters first, because the first address goes into the phone's QR) | The same desk key, so the public-key pin stays the same |
| Client (agents, worker desks, phones) | `newClientCert` | `CN=agent <id>`, `user <id>` or `phone of <user id>`, CA:false, extended key usage `clientAuth` | A fresh P-256 key made on the desk. Agents use theirs only to sign channel files |

**Re-issue on a new address.** On every `load`, if the server certificate doesn't cover all current names, the desk issues a new one covering the old and new names, with the same key, and swaps it into the running server with `setSecureContext`. The CA and the pin (`pubkeyPin`, base64 SHA-256 of the SPKI) don't change, so agents, worker desks and phones keep trusting it.

**The HTTPS server, both directions.**

| Side | Check |
|---|---|
| Server (`fleet.ts` `start`) | `requestCert`, `rejectUnauthorized`, `ca: <desk CA>`, TLS 1.2 or newer. No client certificate, or one the CA didn't sign, fails the handshake |
| Server, after the handshake | A prepended `secureConnection` listener destroys the socket unless the certificate's SHA-256 fingerprint is in `trustedCerts`: devices of users not revoked, and the join certificate of a user whose code is unused. Agents' certificates are not in it; agents never connect. `handle` checks again on every request, so a revoke also cuts an open keep-alive connection |
| Server, per route | `/user/redeem`: the connection must carry that user's join certificate. `/user/*`: the token must belong to the device whose certificate is on the connection |
| Worker desk (`pool.ts`) | TLS 1.3, `ca` = the CA from the join key, its client certificate from the join key, and a pin check |
| Phone app | `DeskWatchPlugin.cloud` in Java: a trust manager that accepts only a server key whose SHA-256 equals the pin from the QR, and a key manager with the phone's client certificate from the QR |

`fleetState` returns the URLs and the CA fingerprint (`tlsFingerprint`).

## Adding an agent

1. The superadmin sets the job channel, makes a Claude API key for the agent in the Claude Console (with a spend limit), types a name, pastes the key and clicks **Add agent**. `fleetAddAgent` asks where to save, then `addAgent` checks the channel, the key's shape and `maxAgents`, makes the agent's signing key and certificate (`newClientCert`), and records an `approved` agent with only the certificate.
2. `serveAgent` replaces `const BUNDLE = null;` with the `AgentBundle`. The result is one file with no dependencies, saved with mode 0600. `serveAgent` throws if the line is missing, so a refactor of `agentd.mjs` that drops it fails loudly.
3. The superadmin copies the file to the agent machine and runs `node agentd-NAME.mjs` (or installs it for the Linux service). On its first tick it posts a heartbeat; the desk shows it online on its next tick.

Nothing travels between the desk and the agent except through the repository, and nothing the agent believes is unsigned. The private key and the API key exist in one place: the file.

**Remove** sets the agent to `revoked` and fails its running job. The desk stops reading its files, and its job files disappear on the next tick. The API key is on the agent, so revoke it in the Claude Console too; the confirmation says so.

## HTTP routes

Only worker desks and phones use these, on the superadmin's port. Every one needs a trusted certificate first (see above). Responses carry `cache-control: no-store`. `POST` bodies are JSON up to 8 MB.

| Route | Auth | Purpose |
|---|---|---|
| `POST /user/redeem` | join certificate + one-time code | `{code, device}` → `{token, name}`; `403` for a wrong, used or revoked code, or a connection without that user's join certificate |
| `GET /user/me` | Bearer | `{name, maxAgents, agents:[{id,name,os,online}], jobs:[last 30, newest first]}` |
| `POST /user/jobs` | Bearer | `{prompt, repo?, agentId?, model?}` → the job; `400 {error}` with the reason |
| `POST /user/jobs/:id/cancel` | Bearer | Cancels that user's job |
| `POST /user/device` | Bearer | A worker pairing its phone: `{token, keyPem, certPem}`, a new device token and client certificate under the same user; `403` while paused |

Bearer tokens are 64 hex characters (`/^Bearer (\w{64})$/`). Any other form is a `401`. A revoked user's token, or a token sent with another device's certificate, is a `401` with "Access was revoked".

## Jobs

**Submit** (`submit` in `fleetCore.ts`):

1. The prompt must not be empty; it is cut to 20,000 characters.
2. A non-admin user must exist, not be revoked or paused, and have fewer than `maxAgents` jobs `queued` or `running`.
3. The user must have at least one usable agent (`usableAgents`: approved, and in `agentIds` when that list is set). A named `agentId` must be one of them.
4. `repo`, if given, must match `gitAddress` (`^(https://|git@|ssh://)[\w.@:/~+-]+$`). The agent checks the same pattern again and passes it to git as an argument, not through a shell.
5. `model` must be one of `MODELS` (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`), otherwise Sonnet.

**States:**

```
queued ──take()──▶ running ──agent result done/failed──▶ done | failed
   │                  │
   └── cancel ────────┴──▶ cancelled        running ──agent silent 20 min / removed / restarted──▶ failed
```

- **Take.** On each desk tick, an online agent with no running job gets the oldest queued job that names it, or that its user may run on it.
- **Restarted agents.** The agent itself fails a job it finds marked `running` by an earlier run of itself.
- **Sweep.** On each tick, before `/user/*` calls and when Settings reads the state, a running job whose agent is not approved, or that has sent nothing for 20 minutes, is failed. That frees the user's slot.
- **Cancel.** The job ends at once on the desk. A running one stays in the channel marked `cancelled` for an hour, so its agent kills the command tree on its next check (within about 30 seconds).
- **Pause / revoke** of a user cancels all that user's jobs.

The log keeps the last 200 lines of up to 2,000 characters each; the result keeps 50,000 characters. Device views show the last 30 log lines. Progress reaches the desk at most every 15 seconds (one agent tick plus one desk tick).

## What an agent does with a job

`runJob` in `agentd.mjs`:

1. Makes `jobs/<id>/` under the agent's home.
2. With a `repo`: `git clone --depth 50 <repo> .`, then `git checkout -b agent/<id>`. The clone uses that machine's own git sign-in.
3. A tool loop of up to 40 model rounds, each a `POST https://api.anthropic.com/v1/messages` with the agent's key (`anthropic-version: 2026-10-21`, `max_tokens` 16,000). The full reply content goes back into the conversation. A `refusal` stop ends the job as failed. The system prompt names the machine, its OS and shell (`cmd.exe` or `sh`), the job folder and the branch.
4. Tools, all confined to the job folder (`inside` resolves real paths, so a symlink cannot point outside):

| Tool | Limit |
|---|---|
| `list_files` | Skips `.git` and `node_modules`; stops at 2,000 files |
| `read_file` | Cuts at 100,000 characters |
| `write_file` | Creates parent folders |
| `run_command` | Shell in the job folder, 5-minute timeout, whole process tree killed on timeout or cancel (`taskkill /T /F` on Windows, process group on others). Output over 24,000 characters keeps 12,000 from each end |

5. Each text reply (first 500 characters) and each tool call is a log line, published with the token totals.
6. With a `repo`: `git add -A`, commit as `AgenticOps agent <agent@localhost>`, and `git push -u origin agent/<id>`. The result says whether it pushed, failed to push, or had nothing to commit.
7. The last text reply is the result.

The agent runs one job at a time. The job folder is left on disk.

## Users, devices and the pool

**Adding a desktop worker.** **Add worker** calls `addUser` with a name, an `Agents at once` limit and optional agent list. `userJoinKey` makes the user's join certificate (`enrolCert`, key kept encrypted as `enrolKeyEnc`) and shows a **join key**: `https://ADDRESS:PORT#<pin>#XXXX-XXXX#<key>#<cert>#<CA>`, the last three PEM in base64url (`joinKey`). `parseJoinKey` accepts only `https`, a 44-character base64 pin, a code in that shape and all three PEMs. **New join key** makes a new code and a new join certificate.

**Joining** (`poolJoin` in `pool.ts`, Settings → Cloud agents → **Join a pool**):

1. `POST /user/redeem` with the code and `"<hostname> (desktop)"` as the device name, over mutual TLS with the join certificate, trusting only the CA in the key and its pin.
2. The desk checks that the connection carries that user's join certificate, then makes it the new device's certificate and clears the code.
3. Save `pool.json` with the token and client key encrypted.

**Leave** only deletes `pool.json`. The superadmin removes the worker on its side.

**Devices.** Each redeemed code or phone pairing adds a `FleetDevice` with its own token and client certificate, so one device can be signed out alone, and removing it also cuts its connection. **Revoke device** removes one. **Delete** (revoke) signs all of them out and cancels the user's jobs. **Deny** sets `paused`, cancels the user's jobs and refuses new ones; **Allow** clears it.

**Phones.** The desk's phone pairing QR carries a cloud login, so nothing is typed on the phone (`phoneCloudLogin` in `pool.ts`):

- On the **superadmin**, `fleetPhoneLogin` uses one user named "Your phone" (limit = the desk's `maxAgents`, all agents) and adds a device token and client certificate to it for each QR.
- On a **worker**, it calls `POST /user/device` on the superadmin, which adds a device named "phone of <worker>" under that worker and returns its token and certificate.
- `pruneUnscanned` keeps every token that has been used and at most 3 that have not.
- The login holds `{url, token, pin, key, cert}`, the last two as bare base64 DER to keep the QR small (`phonePairQr` in `features.ts`).

Separately from cloud jobs, the phone app checks each paired repository's `desk-chats` branch for permission prompts and finished chats: every 20 seconds to 2 minutes while open, and every 15 minutes in the background (Android's shortest period), see [MOBILE.md](./MOBILE.md).

## Manager chats and the pool

`electron/team.ts` gives a manager chat two pool tools:

- **`submit_work`**: with no `agent_type`, lists the online agents and asks the manager to choose `local` (a worker chat in the sidebar) or `cloud`. With `cloud`, it checks there is an online agent (and that `cloud_agent_id`, if given, is one), then calls `cloudSubmit`. On the superadmin that is `fleetSubmit`, which queues the job and runs a channel tick at once, so the instruction is in git within seconds.
- **`check_cloud_jobs`**: lists the pool's queued, running and recent jobs.

`cloudPool` and `cloudSubmit` use the desk's own fleet when it is the superadmin, and otherwise the pool it joined.

## Metering and the report

Agents call the Claude API with their own keys, and report usage in every result: input, cache writes, cache reads and output tokens, summed over the job. `applyReport` turns that into the job's tokens and cost: input × input price, cache writes × 1.25 × input price, cache reads × read price, output × output price, from `priceFor` in `direct.ts`. These are the agent's own counts; the Claude Console shows the billed usage per key.

**Report** (`report`) totals, for jobs created in the chosen month, per user and per agent: jobs, failures, input and output tokens, cost, and minutes from start to end. Users come first, each group sorted by cost. **Export CSV** writes `kind,name,jobs,failed,input_tokens,output_tokens,cost_usd,minutes` through a save dialog.

## Linux packages

`scripts/build-agent-packages.sh` (run in WSL or Linux from the repo root) downloads nfpm 2.49.0 into `~/.cache`, checks its SHA-256 against the release checksums, and builds `release/agenticops-agent_<version>_all.deb` and `release/agenticops-agent-<version>-1.noarch.rpm`. The version is `package.json`'s.

| Installed file | Purpose |
|---|---|
| `/usr/bin/agenticops-agent` | Launcher. Checks Node ≥ 18 and git, and runs the agent file at `/etc/agenticops-agent/agentd.mjs` (`$AGENT_FILE`) |
| `/usr/lib/systemd/system/agenticops-agent.service` | Runs as user `agenticops-agent` in `/var/lib/agenticops-agent`, `Restart=on-failure` after 15 s, after `network-online.target` |
| `/etc/agenticops-agent/agent.env` | Setup notes. Mode 0600, a config file kept on upgrade |
| `/etc/agenticops-agent/agentd.mjs` | Not in the package: the agent file from the desk, installed `root:agenticops-agent` mode 0640 |

`postinstall.sh` creates the system user and its home and restarts the service if it was enabled. `preremove.sh` stops and disables it on removal, not on upgrade. The package depends on `git` and recommends `nodejs`. The `agenticops-agent` user needs its own git credentials for the channel (for example an SSH deploy key in `/var/lib/agenticops-agent/.ssh`).

The agent doesn't update itself; a new agent version means adding the agent again and replacing the file (`shortcut:` comment in the launcher). The release script builds these packages when it builds Linux.

## Limits and timeouts

| Constant | Value | Where |
|---|---|---|
| Default port | 7377 (desk, for workers and phones) | `emptyState` |
| Desk channel tick | every 15 s, and at once after a submit, cancel or remove | `startChannel`, `syncChannel` |
| Agent channel tick | every 15 s | `agentd.mjs` `main` |
| Agent heartbeat | every 5 min | `agentd.mjs` `tick` |
| Agent counts as online | heartbeat or result seen in the last 11 min | `ONLINE_MS` |
| Running job with a silent agent | failed after 20 min | `sweep` |
| Cancelled job kept in the channel | 1 h | `jobOrders` |
| Approved agents | `maxAgents`, default 5 | `addAgent` |
| Request body | 8 MB | `body` |
| Prompt | 20,000 characters | `submit` |
| Jobs kept | 2000 | `save` |
| Log | 200 lines × 2,000 characters | `addLog`, `applyReport` |
| Result | 50,000 characters | `finish`, `applyReport` |
| Model call | `max_tokens` 16,000 | `agentd.mjs` `model` |
| Agent rounds per job | 40 | `runJob` |
| Command timeout | 5 min; git 2 min | `run`, `git` |
| Unscanned phone tokens kept | 3 per user | `pruneUnscanned` |

## Operating it

**Turn it on.** Create a private repository for the job channel, set it under Settings → Cloud agents → **Job channel**, then tick **Accept cloud agents and users**. This desk's git must be able to push there. If the port is busy, the page shows "Could not listen on port …". Windows may ask to let the app through the firewall; allow private networks.

**Reach.** Agents need only git access to the channel and HTTPS to the Claude API; nothing connects to them and they connect to nothing of the desk's. The desk's own server binds `0.0.0.0` for worker desks and phones, which must reach one of the listed addresses. A VPN or tunnel is still the better choice over the open internet.

**Run an agent by hand.** **Add agent**, copy the saved file, and run `node agentd-NAME.mjs`. Run it again after a reboot, or install it as a service (Linux packages, or your own service manager on Windows and macOS).

**Move the desk or an agent.** Nothing to do for agents: they only know the repository. Phones need a new QR scan to learn the desk's new address.

**Change the channel.** Agents carry the address in their file, so add each again after a change.

**Rotate an agent's keys.** Remove it on the desk, add it again with a new API key, replace the file on the machine, and revoke the old key in the Claude Console.

**Upgrading from 0.1.77 or older.** Agents from before the job channel have no channel or API key in their file. The page marks them. Remove them and add them again. Joined worker desks and paired phones from before 0.1.77 have no client certificate: give each worker a **New join key** (they leave and join again), and scan the phone QR again.

**Back up.** `fleet.json` holds the pool. Its keys are encrypted for this Windows account, so a copy works only for the same account on the same computer. `fleet-channel/` can be deleted; it is cloned again.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Page shows "Can't reach the job channel" or "Can't push to the job channel" | This desk's git can't fetch or push the repository. Check the address and sign in (`gh auth login`, SSH key) |
| Agent stays "not seen yet" | The agent isn't running, its git can't push to the channel (its log says `git push failed`), or cloud agents are off on the desk |
| Agent prints "Job channel: git fetch failed" | That machine can't read the repository. Give it a deploy key or credential |
| Agent: "This copy has no agent identity…" | It's the plain `agentd.mjs` from the repo, or a file from before the channel. Use a file **Add agent** saved now |
| "Set the job channel repository first" | Fill in the job channel before adding agents |
| "This desk allows N agents" | Raise the limit or remove an agent |
| Job stays `queued` | No online agent that this user may use, or all are busy. Each agent runs one job at a time |
| Job fails "The agent stopped answering" | Nothing from the agent for 20 minutes: machine asleep, network down, process killed, or its pushes are failing |
| Job fails "The agent restarted during this job" | The agent process restarted mid-job |
| Model error in the job log | The agent's API key is wrong, revoked, out of credit or rate-limited |
| `git clone failed` | The agent machine has no access to the job's repository. Sign in there |
| Worker: "The desk's key does not match the join key" | The address now answers with another desk, or the superadmin's `fleet.json` was reset. Ask for a new join key |
| Phone: "Could not reach the desk" | The phone is not on the desk's network, or the address in the QR is stale. Scan a new QR |

## Testing

- `electron/fleetCore.test.ts`: added agents get a desk-signed certificate, and the desk keeps neither their key nor their API key; agents are not trusted by the HTTPS server; channel files open only with the right signature, an older heartbeat is ignored, and a result counts only for that agent's running job; the agent file parses as one script; **the real agent file, run against a local bare repository**, takes a desk-signed job, ignores a forged one, and its signed heartbeat and result come back through git; mutual TLS for devices (across a server re-issue; no certificate, another desk's, a signed but unlisted one, an unknown desk, plain HTTP and a removed device all fail); one-time codes with limits and the report; one token per device; unscanned-QR pruning; join keys; tokens bound to their certificate; pausing.
- It runs in `npm test`. The desk side of the channel (`channelTick` in `fleet.ts`) needs Electron and has no unit test; check it with a real agent against a dev desk on a copy with its own `userData` (see [ARCHITECTURE.md → Building and testing](./ARCHITECTURE.md#building-and-testing)).

## Known gaps

- **Anyone who can read the channel reads every job prompt and result.** Files are signed, not encrypted. Keep the repository private and use it for nothing else.
- **Push access lets someone disrupt, not command.** Without a key they can delete or roll back files (jobs stall or get re-sent) but not make an agent run anything or forge a result.
- **Keys travel once, out of band.** The agent file, join key and phone QR each carry a private key; the agent file also carries the API key. Whoever copies one can act as that agent or device until it is removed (and the API key revoked).
- **Usage is self-reported** by each agent; the Claude Console's per-key usage is the billed truth.
- **The agent calls the API with plain `fetch`**, because its file has no packages: no retries on rate limits or server errors, so such a call fails the job.
- **About 15–30 s of delay** each way, from polling. Commits pile up on the branch over time; it can be deleted and is recreated.
- **No agent self-update.** A new agent version means adding the agent again and replacing its file.
- **Phones on Android 7 to 9** have no TLS 1.3, so the server accepts TLS 1.2 too; worker desks insist on 1.3.
- **The agent has no sandbox** beyond its job folder for file tools. `run_command` is a real shell with that machine user's rights. Run agents under a dedicated account (the Linux package does) or a VM.
- **One job per agent.** More throughput means more agents.
- **Job folders are not cleaned up** on the agent.
- **Phones must be on the superadmin's network** for cloud jobs, because they connect directly.
- **macOS and Windows services** are not packaged; only Linux has a service package.
