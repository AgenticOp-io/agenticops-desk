import { useEffect, useMemo, useRef, useState } from "react";
import type { AutoStatus, AvailablePlugin, InstalledPlugin, Marketplace, ModelOption, PluginCommand, PluginResult } from "./vite-env";

const errText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);

function minutesLeft(until: number) {
  const m = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return `${m} min`;
}

// ---------- Auto model ----------

// Which AIs the "Auto" model may use, and in what order. Nothing ticked means all of them.
export function AutoSettings({
  models,
  chosen,
  onChange,
}: {
  models: ModelOption[];
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const options = useMemo(
    () => [
      { value: "default", label: "Claude Code · default model" },
      ...models
        .filter((m) => m.value !== "auto" && !m.needsSetup)
        .map((m) => ({ value: m.value, label: `${(m.group ?? "Claude Code").replace(/^Direct · /, "")} · ${m.displayName}` })),
    ],
    [models],
  );
  const [status, setStatus] = useState<AutoStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void window.desk.autoStatus().then((s) => alive && setStatus(s)).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [chosen, models]);

  const all = chosen.length === 0;
  const picked = chosen.filter((v) => options.some((o) => o.value === v));
  const rest = options.filter((o) => !picked.includes(o.value));
  const label = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const move = (i: number, by: number) => {
    const next = [...picked];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const restingNow = status?.order.filter((o) => o.restingUntil) ?? [];

  return (
    <div className="auto-settings" id="settings-auto">
      <div className="settings-label">Auto model</div>
      <p className="settings-hint">
        Pick "Auto" in the model menu and AgenticOps Desk sends each message to the first AI below. When that AI hits a rate limit,
        runs out of quota, rejects its key, is down, or declines, the same message goes to the next one, and the failed one
        rests for a while (5 minutes after a rate limit or quota error, otherwise 1). A chat stays with the AI that last
        worked for it. If an AI stops partway, the next one is told which files were already changed.
      </p>
      <label className="settings-row">
        <span>Use every AI that is set up, in the order of the model menu</span>
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => onChange(e.target.checked ? [] : options.map((o) => o.value))}
        />
      </label>
      {!all && (
        <div className="auto-list">
          {picked.map((v, i) => (
            <div key={v} className="auto-item">
              <span className="auto-rank">{i + 1}</span>
              <span className="grow">{label(v)}</span>
              <button className="btn" title="Try earlier" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button className="btn" title="Try later" disabled={i === picked.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button className="btn" title="Don't use" onClick={() => onChange(picked.filter((x) => x !== v))}>
                ✕
              </button>
            </div>
          ))}
          {!picked.length && <p className="settings-hint">Nothing picked yet, so Auto would use everything.</p>}
          {rest.length > 0 && (
            <select value="" onChange={(e) => e.target.value && onChange([...picked, e.target.value])}>
              <option value="">Add an AI…</option>
              {rest.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {status && (
        <div className="auto-now">
          <div className="plugin-sub">Right now Auto tries</div>
          {status.order.length === 0 && (
            <p className="settings-hint">Nothing it may use. Add a provider key above, or turn off Local only.</p>
          )}
          <ol>
            {status.order.map((o) => (
              <li key={o.value} className={o.restingUntil ? "resting" : ""}>
                {o.label}
                {o.restingUntil && (
                  <span className="settings-hint">
                    {" "}
                    · resting {minutesLeft(o.restingUntil)}: {o.reason}{" "}
                    <button className="more-link" onClick={() => void window.desk.wakeAuto(o.value).then(setStatus)}>
                      Try it again now
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ol>
          {restingNow.length > 1 && (
            <button className="more-link" onClick={() => void window.desk.wakeAuto().then(setStatus)}>
              Wake all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Plugins ----------

// Plugins from the article "Claude Code is better with these plugins", one click each.
const FEATURED = [
  {
    id: "ponytail@ponytail",
    marketplace: "DietrichGebert/ponytail",
    name: "Ponytail",
    about: "Has Claude check existing code and built-in features before writing new code. Adds /ponytail-review and /ponytail-audit.",
  },
  {
    id: "agent-skills@addy-agent-skills",
    marketplace: "addyosmani/agent-skills",
    name: "Agent Skills",
    about: "Addy Osmani's set of 25 engineering workflow skills.",
  },
];

type Pending = { id: string; marketplace?: string; confirm?: { command: string; sha256: string } };

function CommandList({ list }: { list: PluginCommand[] }) {
  if (!list.length) return <p className="settings-hint">No slash commands or skills; it may add hooks, agents or MCP servers.</p>;
  return (
    <ul className="plugin-cmds">
      {list.map((c) => (
        <li key={c.command}>
          <code>/{c.command}</code>
          {c.kind === "skill" && <span className="plugin-kind">skill</span>} {c.description}
        </li>
      ))}
    </ul>
  );
}

export function PluginsSettings({ onChanged }: { onChanged?: () => void }) {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [available, setAvailable] = useState<AvailablePlugin[]>([]);
  const [markets, setMarkets] = useState<Marketplace[]>([]);
  const [cmds, setCmds] = useState<PluginCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState("");
  const [source, setSource] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [details, setDetails] = useState<{ id: string; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(40);
  const cardRef = useRef<HTMLDivElement>(null);

  const load = async (refresh = false) => {
    setLoading(true);
    try {
      const [list, m, c] = await Promise.all([
        window.desk.listPlugins(refresh),
        window.desk.listMarketplaces(),
        window.desk.pluginCommands(true),
      ]);
      setInstalled(list.installed);
      setAvailable(list.available);
      setMarkets(m);
      setCmds(c);
    } catch (err) {
      setMsg(`Could not list plugins: ${errText(err)}`);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (pending) cardRef.current?.scrollIntoView({ block: "nearest" });
  }, [pending]);

  const act = async (label: string, fn: () => Promise<PluginResult>) => {
    setBusy(label);
    setMsg(`${label}…`);
    try {
      const r = await fn();
      setMsg(r.ok ? `${label}: done. It applies from each chat's next message.` : `${label} failed: ${r.output}`);
      if (r.ok) {
        await load(true);
        onChanged?.();
      }
      return r;
    } catch (err) {
      setMsg(`${label} failed: ${errText(err)}`);
      return null;
    } finally {
      setBusy("");
    }
  };

  const showDetails = async (id: string) => {
    if (details?.id === id) {
      setDetails(null);
      return;
    }
    setDetails({ id, text: "Loading…" });
    const text = await window.desk.pluginDetails(id).catch((err) => errText(err));
    setDetails((cur) => (cur?.id === id ? { id, text } : cur));
  };

  const install = async (p: Pending) => {
    setPending(null);
    const same = (s?: string) => s?.toLowerCase() === p.marketplace?.toLowerCase();
    if (p.marketplace && !markets.some((m) => same(m.repo) || same(m.source))) {
      const added = await act(`Adding ${p.marketplace}`, () => window.desk.addMarketplace(p.marketplace!));
      if (!added?.ok) return;
    }
    const r = await act(`Installing ${p.id}`, () => window.desk.installPlugin(p.id, p.confirm?.sha256));
    // This plugin runs a setup command when installed; show it and ask again before running it.
    if (r?.confirm && !p.confirm) {
      setMsg("");
      setPending({ id: p.id, confirm: r.confirm });
    }
  };

  const installedIds = new Set(installed.map((p) => p.id));
  const q = query.trim().toLowerCase();
  const matches = available
    .filter((p) => !installedIds.has(p.pluginId))
    .filter((p) => !market || p.marketplaceName === market)
    .filter((p) => !q || `${p.name} ${p.pluginId} ${p.description ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0));
  const browse = matches.slice(0, shown);
  const marketNames = [...new Set(available.map((p) => p.marketplaceName))].sort();
  // Shown under the row that asked: this list is long, and a card at the top of it opens out of sight.
  const confirmCard = pending && (
    <div className="provider plugin-confirm" ref={cardRef}>
      <strong>Install {pending.id}?</strong>
      {pending.confirm ? (
        <>
          <p className="settings-hint">This plugin runs a setup command on your computer when it installs:</p>
          <pre className="plugin-cmd">{pending.confirm.command}</pre>
        </>
      ) : (
        <p className="settings-hint">
          {pending.marketplace ? `Adds the ${pending.marketplace} marketplace from GitHub, then installs it. ` : ""}
          It can run commands and read files in the folders your chats open. Details shows what it adds.
        </p>
      )}
      <div className="provider-line">
        <button className="btn primary" onClick={() => void install(pending)}>
          {pending.confirm ? "Run it and install" : "Install"}
        </button>
        {!pending.confirm && !pending.marketplace && (
          <button className="btn" onClick={() => void showDetails(pending.id)}>
            Details
          </button>
        )}
        <button className="btn" onClick={() => setPending(null)}>
          Cancel
        </button>
      </div>
      {details?.id === pending.id && <pre className="plugin-details">{details.text}</pre>}
    </div>
  );

  return (
    <div className="plugins" id="settings-plugins">
      <div className="settings-label">Plugins</div>
      <p className="settings-hint">
        Claude Code plugins add slash commands, skills, agents, hooks and MCP servers to Claude Code chats (not Direct ones).
        They are shared with the Claude Code command line (~/.claude/plugins). Type / in the message box to use their
        commands. A plugin runs on your computer with Claude Code's permissions, so install ones you trust.
      </p>
      {msg && <div className={`plugin-status ${busy ? "busy" : ""}`}>{msg}</div>}

      <div className="plugin-sub">Recommended</div>
      {FEATURED.map((f) => {
        const have = installed.find((p) => p.id === f.id);
        return (
          <div key={f.id} className="plugin-row">
            <div className="grow">
              <strong>{f.name}</strong>
              <div className="settings-hint">{f.about}</div>
            </div>
            {have ? (
              <span className="provider-state on">Installed</span>
            ) : (
              <button className="btn" disabled={Boolean(busy)} onClick={() => setPending({ id: f.id, marketplace: f.marketplace })}>
                Install
              </button>
            )}
            {pending?.id === f.id && <div className="plugin-more">{confirmCard}</div>}
          </div>
        );
      })}
      <div className="plugin-row">
        <div className="grow">
          <strong>Graphify</strong>
          <div className="settings-hint">
            Builds a knowledge graph of a project (in graphify-out/) so Claude can answer questions that span files. It is a
            Python tool, not a plugin: install it in a terminal with <code>uv tool install graphifyy</code>, then{" "}
            <code>graphify install --platform claude</code>. Its command then works in AgenticOps Desk chats.
          </div>
        </div>
        <button className="btn" onClick={() => void navigator.clipboard.writeText("uv tool install graphifyy && graphify install --platform claude")}>
          Copy commands
        </button>
      </div>

      <div className="plugin-sub">
        Installed{loading ? " · loading…" : ` (${installed.length})`}
        <button className="more-link" disabled={loading} onClick={() => void load(true)}>
          Refresh
        </button>
      </div>
      {!installed.length && !loading && <p className="settings-hint">No plugins installed yet.</p>}
      {installed.map((p) => {
        const mine = cmds.filter((c) => c.pluginId === p.id);
        const nCmd = mine.filter((c) => c.kind === "command").length;
        const nSkill = mine.length - nCmd;
        return (
          <div key={p.id} className={`plugin-row ${p.enabled ? "" : "off"}`}>
            <div className="grow">
              <strong>{p.id.split("@")[0]}</strong>
              <span className="settings-hint">
                {" "}
                {p.id.split("@")[1]}
                {p.version ? ` · ${p.version}` : ""}
                {p.scope ? ` · ${p.scope}` : ""}
              </span>
              <div>
                <button className="more-link" onClick={() => setOpen(open === p.id ? null : p.id)}>
                  {nCmd} command{nCmd === 1 ? "" : "s"}, {nSkill} skill{nSkill === 1 ? "" : "s"}
                </button>
              </div>
            </div>
            <label className="plugin-toggle" title={p.enabled ? "Turn off" : "Turn on"}>
              <input
                type="checkbox"
                checked={p.enabled}
                disabled={Boolean(busy)}
                onChange={(e) =>
                  void act(`${e.target.checked ? "Turning on" : "Turning off"} ${p.id}`, () => window.desk.enablePlugin(p.id, e.target.checked))
                }
              />
              On
            </label>
            <button className="btn" disabled={Boolean(busy)} onClick={() => void showDetails(p.id)}>
              Details
            </button>
            <button className="btn" disabled={Boolean(busy)} onClick={() => void act(`Updating ${p.id}`, () => window.desk.updatePlugin(p.id))}>
              Update
            </button>
            <button
              className="btn danger"
              disabled={Boolean(busy)}
              onClick={() => void act(`Removing ${p.id}`, () => window.desk.uninstallPlugin(p.id))}
            >
              Remove
            </button>
            {open === p.id && (
              <div className="plugin-more">
                <CommandList list={mine} />
              </div>
            )}
            {details?.id === p.id && <pre className="plugin-details">{details.text}</pre>}
          </div>
        );
      })}

      <div className="plugin-sub">Browse ({matches.length} of {available.length})</div>
      <div className="provider-line">
        <input
          className="plugin-search"
          placeholder="Search plugins"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShown(40);
          }}
        />
        <select value={market} onChange={(e) => setMarket(e.target.value)} title="Marketplace">
          <option value="">All marketplaces</option>
          {marketNames.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      {browse.map((p) => (
        <div key={p.pluginId} className="plugin-row">
          <div className="grow">
            <strong>{p.name}</strong>
            <span className="settings-hint">
              {" "}
              {p.marketplaceName}
              {p.installCount ? ` · ${p.installCount.toLocaleString()} installs` : ""}
            </span>
            {p.description && <div className="settings-hint">{p.description}</div>}
          </div>
          <button className="btn" disabled={Boolean(busy)} onClick={() => void showDetails(p.pluginId)}>
            Details
          </button>
          <button className="btn" disabled={Boolean(busy)} onClick={() => setPending({ id: p.pluginId })}>
            Install
          </button>
          {pending?.id === p.pluginId ? (
            <div className="plugin-more">{confirmCard}</div>
          ) : (
            details?.id === p.pluginId && <pre className="plugin-details">{details.text}</pre>
          )}
        </div>
      ))}
      {matches.length > shown && (
        <button className="more-link" onClick={() => setShown((n) => n + 40)}>
          Show more ({matches.length - shown} left)
        </button>
      )}

      <div className="plugin-sub">
        Marketplaces ({markets.length})
        <button
          className="more-link"
          disabled={Boolean(busy)}
          onClick={() => void act("Updating all marketplaces", () => window.desk.updateMarketplace())}
        >
          Update all
        </button>
      </div>
      {markets.map((m) => (
        <div key={m.name} className="plugin-row">
          <div className="grow">
            <strong>{m.name}</strong>
            <span className="settings-hint"> {m.repo ?? m.url ?? m.source ?? ""}</span>
          </div>
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={() => void act(`Updating marketplace ${m.name}`, () => window.desk.updateMarketplace(m.name))}
          >
            Update
          </button>
          <button
            className="btn danger"
            disabled={Boolean(busy)}
            onClick={() => void act(`Removing marketplace ${m.name}`, () => window.desk.removeMarketplace(m.name))}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="provider-line">
        <input placeholder="owner/repo or git URL" value={source} onChange={(e) => setSource(e.target.value)} />
        <button
          className="btn"
          disabled={!source.trim() || Boolean(busy)}
          onClick={() =>
            void act(`Adding ${source.trim()}`, () => window.desk.addMarketplace(source)).then((r) => r?.ok && setSource(""))
          }
        >
          Add marketplace
        </button>
      </div>
    </div>
  );
}
