# Cloud agents

Technical reference for the cloud-agent system: what runs where, the wire protocol, the cryptography, job handling, the desktop-worker pool, Linux packages, and how to operate and debug it. For the user-facing steps, see [FEATURES.md → Cloud agents](./FEATURES.md#cloud-agents). For what it protects and where that stops, see [SECURITY.md → Cloud agents](./SECURITY.md#cloud-agents).

The feature is **off by default**. Nothing listens on the network until the superadmin turns on **Settings → Cloud agents → Accept cloud agents and users**.

## Contents

- [Roles](#roles)
- [Components and files](#components-and-files)
- [How the pieces connect](#how-the-pieces-connect)
- [The desk's TLS certificate](#the-desks-tls-certificate)
- [Pairing an agent](#pairing-an-agent)
- [The encrypted session](#the-encrypted-session)
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
| **Superadmin desk** | The AgenticOps Desk with cloud agents turned on. One per pool | Pair and remove agents, add and pause desktop workers, mint join keys, run its own jobs, read the monthly report. Holds the Claude API key every agent uses |
| **Cloud agent** | `agent/agentd.mjs` running under Node 18+ on Windows, macOS or Linux | Take one job at a time, run a tool loop in its own job folder, and send each model call to the desk |
| **Desktop worker** | Another person's AgenticOps Desk that joined with a join key (`electron/pool.ts`) | Send jobs to the pool, see only its own jobs, and pair that person's phone into the pool under its user |
| **Device** | A phone or browser signed in under a user | Send jobs, list them, cancel them |

The superadmin only controls access. A worker's prompts and results are not shown on the superadmin's page (`fleetState` returns only `ADMIN_USER` jobs). Their usage appears in the report as token, cost and minute totals.

There is no hosted cloud and no web UI for people to work in. The browser page at `/` is a small job form for devices that have a code. People work in their desk window.

## Components and files

| Path | Runs on | Role |
|---|---|---|
| `electron/fleet.ts` | Superadmin desk (main process) | HTTPS server, session table, keepalive stream, model proxy, Settings IPC (`fleetState`, `fleetSetup`, `fleetApprove`, `fleetRemoveAgent`, `fleetAddUser`, `fleetUpdateUser`, `fleetSubmit`, `fleetCancel`, `fleetReport`, `fleetExportCsv`, `fleetPhoneLogin`), and the browser page `PAGE` |
| `electron/fleetCore.ts` | Desk, and plain Node in tests | State logic with no Electron: pairing, approval, users, devices, tokens, join keys, job queue, report, CSV, self-signed certificate, public-key pin, and `serveAgent`, which builds the agent script |
| `agent/wire.mjs` | Both sides | X25519 keys, pairing code, session key agreement, the sealed message channel. Only `node:crypto`, because it is pasted into the served agent |
| `agent/agentd.mjs` | Agent machine | Pairing, keepalive loop, job runner, tools |
| `agent/wire.d.mts` | Build only | Types for the TypeScript import of `wire.mjs` |
| `electron/pool.ts` | Desktop worker | Joining a pool with a join key, the pinned HTTPS client, `cloudPool` and `cloudSubmit`, `phoneCloudLogin` |
| `electron/team.ts` | Any desk | The manager tools `submit_work` and `check_cloud_jobs` |
| `src/FleetSettings.tsx` | Desk window | Settings → Cloud agents |
| `agent/pkg/` | Linux agent | `.deb`/`.rpm` contents: launcher, systemd unit, env file, install scripts, `nfpm.yaml` |
| `scripts/build-agent-packages.sh` | WSL or Linux | Builds the two packages with nfpm |

`fleet.ts` imports `agentd.mjs` and `wire.mjs` with Vite's `?raw`, so the agent source ships inside `main.js`. A local patch, which carries only the build, therefore also updates the agent that the desk serves.

### State on disk

**Superadmin:** `fleet.json` in the app data folder (`FleetState` in `fleetCore.ts`):

| Field | Contents |
|---|---|
| `adminId`, `createdAt` | This superadmin's ID |
| `on`, `port`, `maxAgents` | Server switch, port (default 7377), how many agents may be approved (default 5) |
| `deskPub`, `deskPrivEnc` | The desk's long-term X25519 key. The private half is encrypted with Electron `safeStorage` |
| `tls.cert`, `tls.keyEnc` | The desk's certificate (PEM) and its ECDSA private key, encrypted with `safeStorage` |
| `agents[]` | `id`, `name`, `os`, `code`, `pub` (the agent's X25519 key), `status` (`pending`/`approved`/`revoked`), `createdAt`, `lastSeen` |
| `users[]` | `id`, `name`, `maxAgents`, `agentIds` (empty = all), `code` (unredeemed join code), `devices[]` (`id`, `name`, `tokenHash`, `createdAt`, `usedAt`), `paused`, `revoked`, plus a legacy single `tokenHash` |
| `jobs[]` | The last 2000 jobs, with log, result, tokens and cost |

Tokens are stored only as SHA-256 hashes. A token is shown once, when it is handed out. If `safeStorage` is not available, the server refuses to start.

**Desktop worker:** `pool.json`: `url`, `pin`, `cert` (the superadmin's certificate as last fetched), `name` (the user name the superadmin gave), `tokenEnc` (the device token, encrypted with `safeStorage`).

**Agent:** `~/.agenticops-agent/config.json` (or `$AGENTICOPS_AGENT_HOME`), mode 0600: `desk`, `name`, `deskKey` (fingerprint), `deskCert`, `keys` (the agent's X25519 pair), `agentId`, `deskPub`. Job folders are under `jobs/<job id>/` in the same place.

## How the pieces connect

```
                         ┌───────────────── superadmin desk (fleet.ts, port 7377, HTTPS only) ─────────────────┐
 agentd.mjs ── HTTPS ──▶ │ /agent/pair  /agent/hello  /agent/s  (sealed: stream | model | event)                │ ── @anthropic-ai/sdk ──▶ Claude API
   (pins the desk cert)  │ /user/redeem  /user/me  /user/jobs  /user/jobs/:id/cancel  /user/device              │
                         │ /  /agent.mjs  /desk.crt                                                             │
                         └──────────────────────────────────────────────────────────────────────────────────────┘
                                ▲ Bearer token, pinned key                 ▲ Bearer token, pinned key
                     worker desk (pool.ts)                      phone (DeskWatchPlugin.cloud) / browser page
```

Every connection goes to the superadmin desk. Agents never accept incoming connections, and nothing talks to an agent directly. The desk reaches an agent only by answering the agent's own open request.

## The desk's TLS certificate

`makeDeskCert` in `fleetCore.ts` writes a self-signed X.509 v3 certificate by hand (Node can sign, but cannot build X.509):

- ECDSA P-256 key, `ecdsa-with-SHA256` signature, subject and issuer `CN=AgenticOps Desk`, valid for 10 years.
- `basicConstraints` CA:true (critical), so it can be installed as a CA on a phone or browser.
- `subjectAltName` lists `localhost`, `127.0.0.1`, the computer name and every non-link-local IPv4 address. `ipv4s` puts real adapters before WSL, Hyper-V, Docker and VM adapters, because the first address goes into the phone's QR.

**Re-issue on a new address.** On every `load`, if the current names are not all covered, the desk issues a new certificate **with the same key** that covers the old names plus the new ones, and swaps it into the running server with `setSecureContext`. Open agent streams are not dropped. The **public-key pin** (`pubkeyPin`, base64 SHA-256 of the SPKI, the form `curl --pinnedpubkey` takes) stays the same, so agents, workers and phones keep working. The certificate's SHA-256 fingerprint shown on the page does change.

**Who trusts it, and how:**

| Client | Trust check |
|---|---|
| Agent download (`curl`) | `--pinnedpubkey sha256//<pin>` |
| `agentd.mjs` | `ca: deskCert` plus `checkServerIdentity` comparing the certificate's SHA-256 fingerprint with the copy built into the script. The host name is not checked; the pin is stronger and survives address changes |
| Worker desk (`pool.ts`) | Fetches `/desk.crt` with verification off, sends nothing, and accepts it only if its key matches the pin in the join key. After that, requests use `ca: cert` plus a pin check. If a request fails with a certificate error (the superadmin re-issued), it fetches the certificate again and retries once |
| Phone app | `DeskWatchPlugin.cloud` in Java, a trust manager that accepts only a server key whose SHA-256 equals the pin from the QR. No certificate is installed |
| Browser page | Must install `/desk.crt` as a CA, or click through the warning |

`fleetState` returns the URLs, the pin (`tlsPin`), the certificate fingerprint (`tlsFingerprint`) and the desk key fingerprint (`deskKey`), so the Settings page can show the download command and the values to compare.

## Pairing an agent

1. The Settings page shows a command per platform. It downloads `/agent.mjs` pinned to the desk's key and runs it with `--desk https://ADDRESS:PORT --key <desk key fingerprint>`.
2. `/agent.mjs` is built by `serveAgent`: the `import … from "./wire.mjs"` line is replaced with the text of `wire.mjs` (its `export`s removed), and `const DESK_CERT = null;` becomes the desk's certificate. The result is one file with no dependencies. `serveAgent` throws if either line is missing, so a refactor of `agentd.mjs` that drops them fails loudly.
3. On first run the agent makes an X25519 key pair, saves it, and prints its **pairing code**: the first 8 bytes of `sha256("agenticops pair" ‖ pub)`, mapped to the 32-letter alphabet without 0/O/1/I, as `XXXX-XXXX`.
4. It posts `{pub, name, os}` to `/agent/pair` every 3 seconds. The desk computes the same code from the key and records a `pending` agent (at most 20 pending at a time, otherwise `busy`).
5. The superadmin types the code into **Pair**. `approve` normalizes it, finds the pending agent with that code and marks it `approved`, unless `maxAgents` is already reached.
6. The next `/agent/pair` reply is `{status: "approved", agentId, desk: deskPub}`. The agent checks `fingerprint(deskPub)` against `--key`. A mismatch stops pairing with an "intercepting" error. Without `--key`, the agent warns that it trusts whichever desk answers first.

Because the code is a hash of the agent's key, typing it approves exactly that key. Nothing secret travels in pairing.

**Remove** sets the agent to `revoked`, drops its sessions, fails its running job, and wakes its open stream. The agent's next `hello` gets `403`, and it deletes its keys and exits with "Run again to pair with a new code".

## The encrypted session

Everything after pairing goes through `/agent/s` inside a sealed envelope (`agent/wire.mjs`). TLS protects the connection; the session adds end-to-end keys that only the paired agent and its desk hold, and it survives a TLS-terminating proxy.

**Hello.** The agent makes a fresh ephemeral key and posts `{agentId, e}` to `/agent/hello`. The desk makes its own ephemeral key and answers `{sid, e}`. Both sides compute three X25519 results:

| | Agent computes | Desk computes |
|---|---|---|
| ee | agentEph × deskEph | deskEph × agentEph |
| es | agentLong × deskEph | deskEph × agentLong |
| se | agentEph × deskLong | deskLong × agentEph |

HKDF-SHA256 over `ee‖es‖se`, salt `sha256(agentEph‖deskEph)`, info `"agenticops fleet v1"`, gives 64 bytes: `up` (agent → desk) and `down` (desk → agent). Only the real agent and the real desk can compute both `es` and `se`, and the ephemeral keys give forward secrecy: recorded traffic stays sealed if a long-term key leaks later. Session keys live only in memory.

A new session is unconfirmed until its first sealed message opens. That message proves the agent holds its key, and the desk then drops that agent's older sessions. Unconfirmed sessions expire after 60 seconds, confirmed ones after 15 minutes idle. The desk keeps at most 500 sessions. The agent starts a new session every 30 minutes, and at once if the desk answers `401` (for example after a desk restart).

**Each message** (`channel(sid, sendKey, recvKey)`):

- A counter `n` and a random 16-byte salt. HKDF over the session key with that salt and `"<sid>:<n>"` gives an encryption key, a MAC key, and one byte that picks the cipher ("hopping"): AES-256-GCM, or AES-256-CTR, -CBC or -CFB, each with an HMAC (SHA-256, -512 or -384) over `aad‖iv‖ciphertext`, cut to 16 bytes. The choice is not on the wire. Every hop has the same layout, so an observer cannot tell which was used.
- The JSON is padded with spaces to a multiple of 64 bytes, which also hides exact sizes.
- Envelope: `{s: sid, n, z: salt, d: iv‖ciphertext‖tag}`, all base64url.
- `open` refuses a foreign `sid`, a counter already seen, or one more than 1024 behind the highest seen, and any message whose tag fails. The desk answers such a message with `400`.

ChaCha20 is not among the hops because Electron's BoringSSL does not have it.

Inside, the agent sends `{p, b}` and the desk answers `{status, data}`. `p` is one of:

| `p` | Body | Reply |
|---|---|---|
| `stream` | `{jobId?}`: the job the agent is running, if any | `{messages: [...]}` after at most 25 s. Always ends with `{type:"ping"}`, and may hold `{type:"job", job:{id,prompt,repo,model}}` and `{type:"cancel", jobId}` |
| `model` | `{jobId, system, tools, messages, max_tokens}` | The Claude Messages API response, or `502 {error}` |
| `event` | `{jobId, log?}` or `{jobId, done:true, failed?, result}` | `{ok:true}` |

`model` and `event` answer `404` for a job that is not this agent's, and `409` once the job is no longer `running`. The agent treats `409` as a cancel.

## HTTP routes

All routes are on the superadmin's HTTPS port. Responses carry `access-control-allow-origin: *` and `cache-control: no-store`. `POST` bodies are JSON up to 8 MB.

| Route | Auth | Purpose |
|---|---|---|
| `GET /` | none | The browser job page |
| `GET /agent.mjs` | none | The agent script with `wire.mjs` and this desk's certificate built in |
| `GET /desk.crt` | none | The desk's certificate (`application/x-x509-ca-cert`) |
| `POST /agent/pair` | none | `{pub, name, os}` → `{status: pending|approved|revoked|busy|invalid, agentId?, desk?}` |
| `POST /agent/hello` | approved `agentId` | `{agentId, e}` → `{sid, e}`; `403 removed` for an unknown or removed agent; `503` over 500 sessions |
| `POST /agent/s` | session | A sealed `{p, b}`; `401 session` when the session is unknown |
| `POST /user/redeem` | one-time code | `{code, device}` → `{token, name}`; `403` for a wrong, used or revoked code |
| `GET /user/me` | Bearer | `{name, maxAgents, agents:[{id,name,os,online}], jobs:[last 30, newest first]}` |
| `POST /user/jobs` | Bearer | `{prompt, repo?, agentId?, model?}` → the job; `400 {error}` with the reason |
| `POST /user/jobs/:id/cancel` | Bearer | Cancels that user's job |
| `POST /user/device` | Bearer | A worker pairing its phone: a new device token under the same user; `403` while paused |

Bearer tokens are 64 hex characters (`/^Bearer (\w{64})$/`). Any other form is a `401`. A revoked user's token is a `401` with "Access was revoked".

## Jobs

**Submit** (`submit` in `fleetCore.ts`):

1. The prompt must not be empty; it is cut to 20,000 characters.
2. A non-admin user must exist, not be revoked or paused, and have fewer than `maxAgents` jobs `queued` or `running`.
3. The user must have at least one usable agent (`usableAgents`: approved, and in `agentIds` when that list is set). A named `agentId` must be one of them.
4. `repo`, if given, must match `^(https://|git@|ssh://)[\w.@:/~+-]+$`, because the agent puts it in a shell line. The agent checks the same pattern again.
5. `model` must be one of `MODELS` (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`), otherwise Sonnet.

**States:**

```
queued ──take()──▶ running ──event done──▶ done | failed
   │                  │
   └── cancel ────────┴──▶ cancelled        running ──agent silent 10 min / removed / lost──▶ failed
```

- **Take.** On each `stream` call from an idle agent, `take` gives it the oldest queued job that names it, or that its user may run on it. Submitting a job emits `kick`, which wakes every waiting stream at once.
- **Lost jobs.** A `stream` call that does not report a job the desk thinks the agent is running fails that job ("The agent lost this job"). This covers an agent restart and a reply that dropped on the way.
- **Sweep.** Before `/user/*` calls and when Settings reads the state, a running job whose agent is not approved, or silent for 10 minutes, is failed. That frees the user's slot.
- **Cancel.** A queued job just ends. A running one also queues `{type:"cancel"}` in that agent's outbox and wakes its stream, so the agent kills the command tree in progress.
- **Pause / revoke** of a user cancels all that user's jobs.

The log keeps the last 200 lines of up to 2,000 characters each; the result keeps 50,000 characters. Device views show the last 30 log lines.

## What an agent does with a job

`runJob` in `agentd.mjs`:

1. Makes `jobs/<id>/` under the agent's home.
2. With a `repo`: `git clone --depth 50 "<repo>" .`, then `git checkout -b agent/<id>`. `GIT_TERMINAL_PROMPT=0` makes a missing credential fail instead of waiting. The clone uses that machine's own git sign-in.
3. A tool loop of up to 40 model rounds. The system prompt names the machine, its OS and shell (`cmd.exe` or `sh`), the job folder and the branch.
4. Tools, all confined to the job folder (`inside` resolves real paths, so a symlink cannot point outside):

| Tool | Limit |
|---|---|
| `list_files` | Skips `.git` and `node_modules`; stops at 2,000 files |
| `read_file` | Cuts at 100,000 characters |
| `write_file` | Creates parent folders |
| `run_command` | Shell in the job folder, 5-minute timeout, whole process tree killed on timeout or cancel (`taskkill /T /F` on Windows, process group on others). Output over 24,000 characters keeps 12,000 from each end |

5. Each text reply (first 500 characters) and each tool call is sent as a log line.
6. With a `repo`: `git add -A`, commit as `AgenticOps agent <agent@localhost>`, and `git push -u origin agent/<id>`. The result says whether it pushed, failed to push, or had nothing to commit.
7. The last text reply is the result.

The agent runs one job at a time. The job folder is left on disk.

## Users, devices and the pool

**Adding a desktop worker.** **Add worker** calls `addUser` with a name, an `Agents at once` limit and optional agent list, and shows a **join key**: `https://ADDRESS:PORT#<pin>#XXXX-XXXX` (`joinKey`). `parseJoinKey` accepts only `https`, a 44-character base64 pin and a code in that shape.

**Joining** (`poolJoin` in `pool.ts`, Settings → Cloud agents → **Join a pool**):

1. Fetch `/desk.crt` and accept it only if its key matches the pin.
2. `POST /user/redeem` with the code and `"<hostname> (desktop)"` as the device name, trusting only that certificate.
3. Save `pool.json` with the token encrypted.

**Leave** only deletes `pool.json`. The superadmin removes the worker on its side.

**Devices.** Each redeemed code or phone pairing adds a `FleetDevice` with its own token, so one device can be signed out alone. **New join key** gives a user one more code; existing devices stay. **Revoke device** removes one. **Delete** (revoke) signs all of them out and cancels the user's jobs. **Deny** sets `paused`, cancels the user's jobs and refuses new ones; **Allow** clears it.

**Phones.** The desk's phone pairing QR carries a cloud login, so nothing is typed on the phone (`phoneCloudLogin` in `pool.ts`):

- On the **superadmin**, `fleetPhoneLogin` uses one user named "Your phone" (limit = the desk's `maxAgents`, all agents) and adds a device token to it for each QR.
- On a **worker**, it calls `POST /user/device` on the superadmin, which adds a device named "phone of <worker>" under that worker.
- `pruneUnscanned` keeps every token that has been used and at most 3 that have not (QRs nobody scanned). `userFor` marks a device's first use.
- The login holds `{url, token, pin}`. The phone trusts only that pin.

## Manager chats and the pool

`electron/team.ts` gives a manager chat two pool tools:

- **`submit_work`**: with no `agent_type`, lists the online agents and asks the manager to choose `local` (a worker chat in the sidebar) or `cloud`. With `cloud`, it checks there is an online agent (and that `cloud_agent_id`, if given, is one), then calls `cloudSubmit`.
- **`check_cloud_jobs`**: lists the pool's queued, running and recent jobs.

`cloudPool` and `cloudSubmit` use the desk's own fleet when it is the superadmin, and otherwise the pool it joined.

## Metering and the report

Every agent model call goes through `modelCall` in `fleet.ts`, which uses `@anthropic-ai/sdk` with the superadmin's saved Claude API key (`providerKey("anthropic")`). If there is none, the call fails with "The superadmin desk has no Claude API key". `max_tokens` is capped at 16,000.

Per job it adds input tokens (including cache writes and reads), output tokens, and cost: input × input price, cache writes × 1.25 × input price, cache reads × read price, output × output price, from `priceFor` in `direct.ts`.

**Report** (`report`) totals, for jobs created in the chosen month, per user and per agent: jobs, failures, input and output tokens, cost, and minutes from start to end. Users come first, each group sorted by cost. **Export CSV** writes `kind,name,jobs,failed,input_tokens,output_tokens,cost_usd,minutes` through a save dialog.

## Linux packages

`scripts/build-agent-packages.sh` (run in WSL or Linux from the repo root) downloads nfpm 2.49.0 into `~/.cache`, checks its SHA-256 against the release checksums, and builds `release/agenticops-agent_<version>_all.deb` and `release/agenticops-agent-<version>-1.noarch.rpm`. The version is `package.json`'s.

| Installed file | Purpose |
|---|---|
| `/usr/bin/agenticops-agent` | Launcher. Checks Node ≥ 18, downloads `agentd.mjs` from `$DESK/agent.mjs` with `curl --pinnedpubkey sha256//$PIN`, falls back to the last good copy if the desk is unreachable, then runs it with `--desk`, `--key` and optional `--name` |
| `/usr/lib/systemd/system/agenticops-agent.service` | Runs as user `agenticops-agent` in `/var/lib/agenticops-agent`, `Restart=on-failure` after 15 s, after `network-online.target` |
| `/etc/agenticops-agent/agent.env` | `DESK`, `KEY`, `PIN`, optional `NAME`. Mode 0600, a config file kept on upgrade |

`postinstall.sh` creates the system user and its home and restarts the service if it was enabled. `preremove.sh` stops and disables it on removal, not on upgrade. The package depends on `curl` and recommends `nodejs`.

Because the launcher downloads `agentd.mjs` on each start, an agent always runs the version its desk serves.

The release script does not build these packages. Run `scripts/build-agent-packages.sh` and upload the files by hand.

## Limits and timeouts

| Constant | Value | Where |
|---|---|---|
| Default port | 7377 | `emptyState` |
| Approved agents | `maxAgents`, default 5 | `approve` |
| Pending agents | 20 | `pair` |
| Agent counts as online | seen in the last 60 s | `ONLINE_MS` |
| Keepalive wait | 25 s | `agentCall` |
| Running job with a silent agent | failed after 10 min | `sweep` |
| Sessions | 500; unconfirmed 60 s, idle 15 min; agent renews every 30 min | `fleet.ts`, `agentd.mjs` |
| Replay window | 1024 messages | `wire.mjs` |
| Request body | 8 MB | `body` |
| Prompt | 20,000 characters | `submit` |
| Jobs kept | 2000 | `save` |
| Log | 200 lines × 2,000 characters | `addLog` |
| Result | 50,000 characters | `finish` |
| Model call | `max_tokens` ≤ 16,000 (agent asks 8,000) | `modelCall` |
| Agent rounds per job | 40 | `runJob` |
| Command timeout | 5 min | `run` |
| Unscanned phone tokens kept | 3 per user | `pruneUnscanned` |

## Operating it

**Turn it on.** Save a Claude API key under Settings → AI models → Direct AI providers, then Settings → Cloud agents → **Accept cloud agents and users**. If the port is busy, the page shows "Could not listen on port …". Windows may ask to let the app through the firewall; allow private networks.

**Reach.** The server binds `0.0.0.0`. Agents and phones must reach one of the listed addresses. Over the open internet, put it behind a VPN or tunnel: the pairing code is 40 bits (see [Known gaps](#known-gaps)).

**Run an agent by hand.** Copy the command from the page. The agent keeps its config in `~/.agenticops-agent`. Run it again after a reboot, or install it as a service (Linux packages, or your own service manager on Windows and macOS).

**Move the desk.** A new address re-issues the certificate with the same key, so agents and joined desks keep working. Agents must still be able to reach the new address: change `--desk` (or `DESK` in `agent.env`). Phones need a new QR scan to learn the new address.

**Rotate the agent key of a machine.** Remove it on the desk, delete `~/.agenticops-agent/config.json` on the machine, and pair again.

**Back up.** `fleet.json` holds the pool. Its keys are encrypted for this Windows account, so a copy works only for the same account on the same computer.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Agent prints "Can't reach the desk yet" | Wrong address, firewall, or server off. Check `listening` on the page and the firewall prompt |
| Agent: "The desk's certificate is not the one this agent trusts" | The desk made a new key (fresh `fleet.json`). Download the agent again with the page's command |
| Agent: "…not <key>. Something between this machine and the desk may be intercepting" | `--key` doesn't match the desk that answered. Check the address; copy the full command again |
| "No agent is waiting with that code" | The agent can't reach the desk, or the code was mistyped. The code is shown again on each agent start |
| "This desk allows N agents" | Raise the limit or remove an agent |
| Job stays `queued` | No online agent that this user may use, or all are busy. Each agent runs one job at a time |
| Job fails "The agent stopped answering" | The agent went silent for 10 minutes: machine asleep, network down, or process killed |
| Job fails "The agent lost this job" | The agent restarted mid-job |
| Model error in the job log | The desk's API key is missing, rejected or rate-limited |
| `git clone failed` | The agent machine has no access to the repository. Sign in there (`gh auth login`, SSH key) |
| Worker: "The desk's key does not match the join key" | The address now answers with another desk, or the superadmin's `fleet.json` was reset. Ask for a new join key |
| Phone: "Could not reach the desk" | The phone is not on the desk's network, or the address in the QR is stale. Scan a new QR |

## Testing

- `electron/fleetCore.test.ts`: pairing only after the code is typed, the agent limit, the certificate and its pin, the served script parses as one file, one-time codes with limits and the report, one token per device, unscanned-QR pruning, join keys and pausing, and trust by pin across a certificate re-issue.
- `agent/wire.test.mjs`: messages both ways with every cipher hop at the same size; tampering, replay and a wrong session refused; an interceptor without a long-term key can't read the session.
- Both run in `npm test`. An end-to-end check is a real agent against a dev desk on a copy with its own `userData` (see [ARCHITECTURE.md → Building and testing](./ARCHITECTURE.md#building-and-testing)).

## Known gaps

- **Pairing code strength.** 40 bits. Someone on the network path during pairing would need about 2^40 key tries to fake an agent with the same code. Fine on a LAN; lengthen the code before pairing over the open internet (`shortcut:` comment in `wire.mjs`).
- **The agent has no sandbox** beyond its job folder for file tools. `run_command` is a real shell with that machine user's rights. Run agents under a dedicated account (the Linux package does) or a VM.
- **One job per agent.** More throughput means more agents.
- **No streaming** of model replies to the agent; each call returns whole.
- **Job folders are not cleaned up** on the agent.
- **Phones must be on the superadmin's network**, because they connect directly.
- **macOS and Windows services** are not packaged; only Linux has a service package.
- **The release script does not build the agent packages.**
