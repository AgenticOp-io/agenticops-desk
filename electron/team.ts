import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { app, type BrowserWindow } from "electron";
import { z } from "zod";
import { autoLive } from "./autoRoute";
import { capsulesBrief } from "./capsules";
import { chatState, lastAnswer, listModels, onChatEvent, setManagerLookup, setPlanAuthority, setToolServers } from "./claude";
import { loadAgentSdk } from "./claudeBinary";
import { fleetState, fleetSubmit } from "./fleet";
import { writeJsonAtomicSync } from "./jsonStore";
import { rememberedChats } from "./library";
import { loadSettings } from "./settings";
import { createWorktree, removeWorktree } from "./worktrees";

// A manager chat gets "desk" tools to start, message and wait on worker chats. The window creates each worker
// as an ordinary chat, so it shows in the sidebar, Waiting on you and Chat status like any other, and its
// approvals still come to the user. One level only: a worker never gets these tools.

export type PlanStep = { text: string; done: boolean };
// plans: a manager's ordered steps. While any step is open, the manager is sent back to work each time a run ends.
export type Team = { managers: string[]; workers: Record<string, string>; plans: Record<string, PlanStep[]> };
// Re-prods in a row with no step ticked off before the manager is left alone (stuck, or waiting on the user).
const MAX_IDLE_NUDGES = 3;
const nudges = new Map<string, number>();

// Under the agent's tool-call limit; the manager calls wait_for again if workers are still going.
const WAIT_MS = 20 * 60_000;
const TEXT_KEEP = 3000;
// The window creates a worker's chat after start_chat returns; if no run shows up in this long, it never started.
const START_MS = 60_000;

let team: Team | null = null;
const file = () => path.join(app.getPath("userData"), "team.json");

function load(): Team {
  if (team) return team;
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8")) as Partial<Team>;
    team = {
      managers: Array.isArray(raw.managers) ? raw.managers.filter((s): s is string => typeof s === "string") : [],
      workers:
        raw.workers && typeof raw.workers === "object"
          ? Object.fromEntries(Object.entries(raw.workers).filter(([, v]) => typeof v === "string"))
          : {},
      plans: {},
    };
    for (const [id, steps] of Object.entries(raw.plans ?? {})) {
      if (Array.isArray(steps)) team.plans[id] = steps.filter((s) => s && typeof s.text === "string").map((s) => ({ text: s.text, done: Boolean(s.done) }));
    }
  } catch {
    team = { managers: [], workers: {}, plans: {} };
  }
  return team;
}

// One step per line; blank lines and leading "1." / "-" markers are dropped. Empty text clears the plan.
export function setPlan(chatId: string, text: string): Team {
  const t = load();
  const steps = text.split("\n").map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim()).filter(Boolean);
  if (steps.length) t.plans[chatId] = steps.map((s) => ({ text: s, done: false }));
  else delete t.plans[chatId];
  nudges.delete(chatId);
  save();
  return t;
}
const save = () => writeJsonAtomicSync(file(), load());

export const teamView = () => load();

// Retires a finished, collected worker: it leaves the manager's roster and its worktree is torn down
// (only when the worktree is clean, so unmerged changes are never thrown away). The chat itself stays,
// so its history remains reviewable. Returns what happened, for the manager's reply.
async function retireWorker(managerId: string, id: string, t: Team): Promise<string> {
  if (t.workers[id] !== managerId) return "";
  if (!ended(id)) return "";
  if (!runs.get(id)?.collected) return "";
  delete t.workers[id];
  save();
  runs.delete(id);
  const w = getWindow?.();
  if (w && !w.isDestroyed()) w.webContents.send("team:retired", id); // the window archives the chat
  const removed = await removeWorktree(id, false);
  return removed.ok ? "" : removed.note;
}

export function setManager(chatId: string, on: boolean): Team | string {
  const t = load();
  if (on && t.workers[chatId]) return "A worker chat can't be a manager.";
  t.managers = on ? [...new Set([...t.managers, chatId])] : t.managers.filter((id) => id !== chatId);
  save();
  return t;
}

// Each worker's run since the manager last started or messaged it. `collected` is set once the manager
// has read the result through wait_for, which makes the worker eligible for cleanup (its worktree and
// roster entry are released — the chat itself is left for review).
const runs = new Map<string, { done: boolean; started?: boolean; at: number; collected?: boolean; text: string }>();
const newRun = () => ({ done: false, at: Date.now(), text: "" });
// Over when the run said "done", or it ran and stopped without one (stopped or failed). Not over while the
// window has yet to start it: chatState is idle in that gap, which must not read as finished.
function ended(id: string): boolean {
  // Auto swallows a failed AI's "done" and hands over to the next one; idle in between is not finished.
  if (autoLive(id)) return false;
  const run = runs.get(id);
  const running = chatState(id).running;
  if (running && run) run.started = true;
  if (!run) return !running;
  if (run.done) return true;
  return !running && (Boolean(run.started) || Date.now() - run.at > START_MS);
}
const settled = new Set<() => void>();

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ ...ok(text), isError: true });

let getWindow: (() => BrowserWindow | null) | undefined;
export function initTeam(window: () => BrowserWindow | null) {
  getWindow = window;
  setManagerLookup((id) => load().workers[id]);
  setPlanAuthority((id) => {
    const t = load();
    return Boolean(t.plans[t.workers[id] ?? id]?.some((s) => !s.done));
  });
  onChatEvent((event) => {
    // A manager's run ended normally ("Done.", not a user stop) with plan steps left: send it back to work.
    const steps = event.chatId ? load().plans[event.chatId] : undefined;
    if (event.chatId && steps && event.kind === "done" && event.text === "Done." && steps.some((s) => !s.done)) {
      const n = (nudges.get(event.chatId) ?? 0) + 1;
      nudges.set(event.chatId, n);
      if (n <= MAX_IDLE_NUDGES) {
        const next = steps.findIndex((s) => !s.done);
        const left = steps.filter((s) => !s.done).length;
        setTimeout(() => getWindow?.()?.webContents.send("team:send", {
          id: event.chatId,
          text: `Plan not finished: ${left} step(s) left. Continue with step ${next + 1}: ${steps[next].text}. Call plan_done when a step is truly complete and checked. Do not stop until every step is done.`,
        }), 500);
      }
    }
    const run = event.chatId ? runs.get(event.chatId) : undefined;
    if (!run) return;
    run.started = true;
    if (event.kind === "line" || event.kind === "error") run.text = `${run.text}${event.kind === "error" ? "\nError: " : ""}${event.text ?? ""}`.slice(-TEXT_KEEP);
    if (event.kind === "done") {
      run.done = true;
      for (const fn of settled) fn();
    }
  });

  setToolServers(async (managerId, signal) => {
    const t = load();
    if (!t.managers.includes(managerId) || t.workers[managerId]) return null;
    const { tool, createSdkMcpServer } = await loadAgentSdk();
    const maxRunning = async () => (await loadSettings()).maxWorkers;
    const mine = (id: string) => t.workers[id] === managerId;
    const busy = (id: string) => !ended(id);
    // Retire finished-and-collected workers before each tool call, so the roster only ever holds live work.
    const prune = async () => {
      for (const id of Object.keys(t.workers)) {
        if (mine(id)) await retireWorker(managerId, id, t);
      }
    };
    const manager = async () => (await rememberedChats()).find((c) => c.id === managerId);
    const post = (channel: string, payload: unknown) => {
      const w = window();
      if (!w || w.isDestroyed()) return false;
      w.webContents.send(channel, payload);
      return true;
    };

    // The same menu the user picks from, minus providers still waiting on a key or model list: every AI that's
    // ready on this computer (Claude Code, and each Direct provider with a key, such as DeepSeek), nothing it can't run.
    const models = listModels().filter((m) => !("needsSetup" in m && m.needsSetup) && !m.value.startsWith("setup:"));
    const menu = models.map((m) => `${m.value} (${m.displayName}${m.group ? `, ${m.group}` : ""})`).join("; ");

    const tools = [
      tool(
        "plan_status",
        "Show your plan: every step and whether it is done. You must complete every step; you are sent back to work whenever you stop with steps left.",
        {},
        async () => {
          const steps = t.plans[managerId];
          return ok(steps?.length ? steps.map((s, i) => `${i + 1}. [${s.done ? "x" : " "}] ${s.text}`).join("\n") : "No plan is set.");
        },
      ),
      tool(
        "plan_done",
        "Mark a plan step complete, only after its result is verified. Numbers are 1-based, as plan_status shows them.",
        { step: z.number().int().min(1) },
        async (args) => {
          const s = t.plans[managerId]?.[args.step - 1];
          if (!s) return fail("No such step.");
          s.done = true;
          nudges.delete(managerId);
          save();
          const left = t.plans[managerId].filter((x) => !x.done).length;
          return ok(left ? `Step ${args.step} done. ${left} left; keep going.` : "Every step is done. The plan is complete.");
        },
      ),
      tool(
        "list_chats",
        "List the chats in this project: id, title, whether each is running, waiting on the user, or idle, and which are your workers.",
        {},
        async () => {
          await prune();
          const me = await manager();
          const chats = (await rememberedChats())
            .filter((c) => c.id !== managerId && (me?.projectId ? c.projectId === me.projectId : c.projectPath === me?.projectPath))
            .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
            .slice(0, 40);
          if (!chats.length) return ok("No other chats in this project.");
          return ok(
            chats
              .map((c) => {
                const s = chatState(c.id);
                return `${c.id} · ${c.title} · ${s.waiting ? "waiting on the user" : s.running ? "running" : "idle"}${mine(c.id) ? " · your worker" : ""}`;
              })
              .join("\n"),
          );
        },
      ),
      tool(
        "start_chat",
        `Start a worker chat in this project with its own task. It runs in its own git worktree by default, so workers don't edit the same files. Only a limited number of your workers run at once (set in Settings; start_chat says when you hit it). Returns the worker's id; then call wait_for. When you are done with a worker (its result read), call close_worker so it is cleaned up rather than left around.`,
        {
          title: z.string().min(1).max(80).describe("Short title shown in the sidebar"),
          prompt: z.string().min(1).describe("The full task. The worker can't see your chat, so include everything it needs."),
          model: z
            .string()
            .optional()
            .describe(
              "Pick the model that fits this task, from any provider listed. Cheap, fast models (Haiku, DeepSeek Flash, Gemini Flash, " +
                "GPT mini and the like) for simple, mechanical work: renames, formatting, docs, small tests, lookups. Mid models (Sonnet, " +
                "DeepSeek V4 Pro, GPT, Gemini Pro) for ordinary coding and bug fixes. The strongest (Opus, Fable) for hard design, tricky " +
                "debugging, security, or changes across many files. Spreading work across providers keeps any one allowance from running out. " +
                `"direct:" models run on the user's API key for that provider. Leave out to use your own model. Choose one of: ${menu}`,
            ),
          worktree: z.boolean().optional().describe("false to work in the project folder itself"),
        },
        async (args) => {
          await prune();
          const running = Object.keys(t.workers).filter((id) => mine(id) && busy(id)).length;
          const limit = await maxRunning();
          if (running >= limit) return fail(`${running} of your workers are still running and the limit is ${limit} (set in Settings). Call wait_for first.`);
          if (args.model && !models.some((m) => m.value === args.model)) return fail(`Unknown model "${args.model}". Choose one of: ${menu}`);
          const me = await manager();
          if (!me?.projectPath) return fail("This chat's project folder is not on this computer.");
          const model = args.model ?? me.model ?? "";
          const id = randomUUID();
          let where = "the project folder";
          if (args.worktree !== false) {
            const made = await createWorktree(id, me.projectPath);
            where = typeof made === "string" ? `the project folder (no worktree: ${made})` : "its own worktree";
          }
          t.workers[id] = managerId;
          save();
          runs.set(id, newRun());
          if (!post("team:start", { id, managerId, title: args.title, prompt: args.prompt, model })) {
            runs.delete(id);
            delete t.workers[id];
            save();
            return fail("The app window is closed, so no chat could start.");
          }
          return ok(`Started worker ${id} ("${args.title}") on ${model || "the default model"} in ${where}. Call wait_for with its id to get the result.`);
        },
      ),
      tool(
        "send_to_chat",
        "Send a follow-up message to one of your workers. If it is still running, the message steers the current run. " +
          "The worker keeps its conversation, so this beats starting a new worker. Set model to switch it: move up a tier " +
          "when its result is wrong, incomplete, or it is stuck; move down for easy leftover work; move to another provider " +
          "when one hits a usage limit.",
        {
          chat_id: z.string(),
          message: z.string().min(1),
          model: z.string().optional().describe(`Run this and later messages on another model. Leave out to keep its model. Choose one of: ${menu}`),
        },
        async (args) => {
          if (!mine(args.chat_id)) return fail("You can only message workers you started.");
          if (args.model && !models.some((m) => m.value === args.model)) return fail(`Unknown model "${args.model}". Choose one of: ${menu}`);
          // A running worker takes the message as a steer on its current run, which can't change model.
          if (args.model && chatState(args.chat_id).running) return fail("That worker is still running. Call wait_for first, then switch its model.");
          if (!chatState(args.chat_id).running) runs.set(args.chat_id, newRun());
          if (!post("team:send", { id: args.chat_id, text: args.message, model: args.model })) return fail("The app window is closed.");
          return ok(`Sent${args.model ? ` on ${args.model}` : ""}. Call wait_for to get its answer.`);
        },
      ),
      tool(
        "submit_work",
        "Submit work to either a local worker or a remote cloud agent. Local workers run here and appear in your sidebar; cloud agents run on remote machines and can handle bigger tasks. Asks you to pick, or use agent_type to skip the prompt.",
        {
          title: z.string().min(1).max(80).describe("Short title for this work"),
          task: z.string().min(1).describe("The full task description. Cloud agents can't see your chat, so include everything needed."),
          agent_type: z.enum(["local", "cloud"]).optional().describe("Pick 'local' for a worker in your sidebar, 'cloud' for a remote agent. Leave out to ask the user."),
          cloud_agent_id: z.string().optional().describe("If agent_type is 'cloud', optionally specify which cloud agent to use by its id. Leave out to let any available agent take it."),
          model: z.string().optional().describe(`Which model to use. Leave out for the default. Choose one of: ${menu}`),
        },
        async (args) => {
          // Validate model if provided
          if (args.model && !models.some((m) => m.value === args.model)) return fail(`Unknown model "${args.model}". Choose one of: ${menu}`);

          // Determine if we should use local or cloud
          let useCloud = args.agent_type === "cloud";
          if (!args.agent_type) {
            // Query available cloud agents to see if we have any
            const f = await fleetState();
            const available = f.agents.filter((a) => a.status === "approved" && a.online);
            
            if (!available.length) {
              // No cloud agents, must use local
              useCloud = false;
            } else {
              // Ask the user - return a formatted message describing the options
              const cloudList = available.map((a) => `${a.id} (${a.name}, ${a.os})`).join(", ");
              return ok(
                `Available agents:\nLocal: Create a worker chat in this project (appears in sidebar).\n` +
                `Cloud: Remote agent(s) available:\n${cloudList}\n\n` +
                `Call submit_work again with agent_type set to "local" or "cloud". ` +
                `If cloud, optionally set cloud_agent_id to pick a specific agent.`
              );
            }
          }

          if (useCloud) {
            // Cloud agent path
            const f = await fleetState();
            const available = f.agents.filter((a) => a.status === "approved" && a.online);
            
            if (!available.length) return fail("No cloud agents are online. Try local workers instead.");
            
            // If a specific agent was requested, check it exists
            if (args.cloud_agent_id) {
              const requested = available.find((a) => a.id === args.cloud_agent_id);
              if (!requested) return fail(`Cloud agent "${args.cloud_agent_id}" is not available. Available: ${available.map((a) => a.id).join(", ")}`);
            }

            // Submit the job to the cloud
            const err = await fleetSubmit({
              prompt: args.task,
              model: args.model,
              agentId: args.cloud_agent_id,
            });
            
            if (err) return fail(`Cloud submission failed: ${err}`);
            return ok(
              `Submitted work to cloud agent${args.cloud_agent_id ? ` ${args.cloud_agent_id}` : ""}. ` +
              `Check Settings > Cloud agents to monitor its progress.`
            );
          } else {
            // Local worker path (similar to start_chat)
            await prune();
            const running = Object.keys(t.workers).filter((id) => mine(id) && busy(id)).length;
            const limit = await maxRunning();
            if (running >= limit) return fail(`${running} of your workers are still running and the limit is ${limit}. Call wait_for first.`);
            
            const me = await manager();
            if (!me?.projectPath) return fail("This chat's project folder is not on this computer.");
            
            const model = args.model ?? me.model ?? "";
            const id = randomUUID();
            const made = await createWorktree(id, me.projectPath);
            const where = typeof made === "string" ? `the project folder (no worktree: ${made})` : "its own worktree";
            
            t.workers[id] = managerId;
            save();
            runs.set(id, newRun());
            
            if (!post("team:start", { id, managerId, title: args.title, prompt: args.task, model })) {
              runs.delete(id);
              delete t.workers[id];
              save();
              return fail("The app window is closed.");
            }
            
            return ok(`Started local worker ${id} ("${args.title}") on ${model || "the default model"} in ${where}. Call wait_for to get the result.`);
          }
        },
      ),
      tool(
        "close_worker",
        "Retire workers you are done with. A finished worker whose result you have already read is removed from your roster and its worktree is cleaned up; its chat history stays for review. Only returns after each worker is no longer running.",
        { chat_ids: z.array(z.string()).min(1).max(10) },
        async (args) => {
          const ids = args.chat_ids.filter(mine);
          if (!ids.length) return fail("None of those are your workers.");
          const notes: string[] = [];
          for (const id of ids) {
            const note = await retireWorker(managerId, id, t);
            if (note) notes.push(`${id}: ${note}`);
          }
          return ok(notes.length ? `Closed, with notes:\n${notes.join("\n")}` : "Closed those workers.");
        },
      ),
      tool(
        "wait_for",
        "Wait until the given workers finish, then get each one's result. Waits up to 20 minutes per call; call again for any still running. Approvals they need go to the user, not you.",
        { chat_ids: z.array(z.string()).min(1).max(10) },
        async (args) => {
          const ids = args.chat_ids.filter(mine);
          if (!ids.length) return fail("None of those are your workers.");
          // Finished either when the run emitted "done" or when nothing is running anymore. The second
          // case covers a worker that was stopped or failed without a "done" event, so wait_for does
          // not sit on the full 20-minute timer for a worker that already ended.
          const finished = ended;
          await new Promise<void>((resolve) => {
            const check = () => {
              if (!ids.every(finished) && !signal.aborted) return;
              finish();
            };
            const finish = () => {
              clearTimeout(timer);
              clearInterval(poll);
              settled.delete(check);
              signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, WAIT_MS);
            const poll = setInterval(check, 5000); // catches a start that never happens, which emits no event
            settled.add(check);
            signal.addEventListener("abort", finish);
            check();
          });
          const known = new Map((await rememberedChats()).map((c) => [c.id, c]));
          // Once the manager has read a finished worker's result, it is collected and can be cleaned up.
          for (const id of ids) {
            const run = runs.get(id);
            if (run && finished(id)) run.collected = true;
          }
          return ok(
            ids
              .map((id) => {
                const s = chatState(id);
                const run = runs.get(id);
                const state = finished(id) ? (run && !run.started && !run.done ? "finished (it never started)" : "finished") : s.waiting ? "still running, waiting on the user's approval" : "still running";
                const answer = (lastAnswer(id) || runs.get(id)?.text || "").slice(-TEXT_KEEP).trim();
                const verified = capsulesBrief(id).slice(-1500).trim();
                const c = known.get(id);
                return [
                  `## ${c?.title ?? id} (${id}): ${state}, on ${c?.model || "the default model"}`,
                  answer || "(no answer yet)",
                  verified && `Verified runs:\n${verified}`,
                ]
                  .filter(Boolean)
                  .join("\n");
              })
              .join("\n\n") +
              "\n\nIf a result is wrong, incomplete, or stuck, send_to_chat the same worker with a stronger model rather than starting over.",
          );
        },
      ),
      tool(
        "check_cloud_jobs",
        "Check the status of cloud jobs submitted via submit_work. Shows queued, running, and recently completed jobs.",
        {},
        async () => {
          const f = await fleetState();
          if (!f.jobs.length) return ok("No cloud jobs found.");
          
          const summary = f.jobs.slice(0, 20).map((j) => {
            const statusIcon = j.status === "done" ? "✓" : j.status === "failed" ? "✗" : j.status === "running" ? "⟳" : "○";
            const cost = j.costUsd ? ` · $${j.costUsd.toFixed(3)}` : "";
            const agent = j.agent ? ` on ${j.agent}` : " (waiting for agent)";
            return `${statusIcon} ${j.id.slice(0, 8)} · ${j.status} · ${j.prompt.slice(0, 60)}${cost}${agent}`;
          }).join("\n");
          
          return ok(
            `Recent cloud jobs:\n${summary}\n\nCheck Settings > Cloud agents for full details and results.`
          );
        },
      ),
    ];
    return {
      servers: { desk: createSdkMcpServer({ name: "desk", version: "1.0.0", tools }) },
      allowed: tools.map((x) => `mcp__desk__${x.name}`),
    };
  });
}
