import { useEffect, useState } from "react";
import type { ProviderStatus } from "./vite-env";

// Settings for the Direct engine: one row per AI provider, with an API key and (except Claude) model names.
function ProviderRow({ p, onSaved }: { p: ProviderStatus; onSaved: (list: ProviderStatus[]) => void }) {
  const [key, setKey] = useState("");
  const [models, setModels] = useState(p.models.join(", "));
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    setModels(p.models.join(", "));
    setBaseUrl(p.baseUrl);
  }, [p.models, p.baseUrl]);

  const fail = (err: unknown) =>
    err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);

  const save = async (patch: { key?: string | null; models?: string[]; baseUrl?: string }) => {
    try {
      let next = await window.desk.setProvider(p.id, patch);
      setKey("");
      if (typeof patch.key === "string" && patch.key.trim() && p.editableModels) {
        try {
          next = await window.desk.loadProviderModels(p.id);
          setMsg("Saved. Models loaded into the menu.");
        } catch (err) {
          setMsg(`${fail(err)} The key is saved.`);
        }
      } else setMsg("Saved");
      onSaved(next);
    } catch (err) {
      setMsg(fail(err));
    }
  };

  const loadModels = async () => {
    try {
      onSaved(await window.desk.loadProviderModels(p.id));
      setMsg("Models loaded into the menu.");
    } catch (err) {
      setMsg(fail(err));
    }
  };

  return (
    <div className={`provider ${p.ready ? "ready" : ""}`}>
      <div className="provider-head">
        <strong>{p.label}</strong>
        <span className={`provider-state ${p.ready ? "on" : ""}`}>
          {p.ready ? "Ready" : p.needsKey && !p.hasKey ? "No key" : "Add a model"}
        </span>
      </div>
      <p className="settings-hint">{p.keyHint}</p>
      {p.needsKey && (
        <div className="provider-line">
          <input
            type="password"
            placeholder={p.hasKey ? "Key saved. Paste a new one to replace it" : "API key"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
          />
          <button className="btn" disabled={!key.trim()} onClick={() => void save({ key })}>
            Save key
          </button>
          {p.hasKey && (
            <button className="btn danger" onClick={() => void save({ key: null })}>
              Remove
            </button>
          )}
        </div>
      )}
      {p.editableModels && (
        <>
          <div className="provider-line">
            <input
              placeholder="Model names, comma separated"
              value={models}
              onChange={(e) => setModels(e.target.value)}
            />
            <button className="btn" onClick={() => void save({ models: models.split(",") })}>
              Save models
            </button>
            <button className="btn" onClick={() => void loadModels()}>
              Load from API
            </button>
          </div>
          <div className="provider-line">
            <input placeholder="API address" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <button className="btn" disabled={baseUrl === p.baseUrl} onClick={() => void save({ baseUrl })}>
              Save address
            </button>
          </div>
        </>
      )}
      {msg && <div className="provider-msg">{msg}</div>}
    </div>
  );
}

export function ProvidersSettings({ onChanged }: { onChanged: () => void }) {
  const [list, setList] = useState<ProviderStatus[]>([]);
  useEffect(() => {
    void window.desk.listProviders().then(setList);
  }, []);
  return (
    <div className="providers">
      <div className="settings-label">Direct AI providers</div>
      <p className="settings-hint">
        Chats normally run through Claude Code with your Claude sign-in. API models are in the model menu. Pick one to
        add its key, or save a key here and load the models the provider offers. Direct chats are billed per token.
      </p>
      {list.map((p) => (
        <ProviderRow
          key={p.id}
          p={p}
          onSaved={(next) => {
            setList(next);
            onChanged();
          }}
        />
      ))}
    </div>
  );
}
