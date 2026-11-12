export type TranscriptPart =
  | { kind: "text"; text: string }
  | { kind: "step"; text: string }
  | { kind: "thinking"; text: string };
export type TranscriptMsg = {
  role: "user" | "assistant" | "system" | "error";
  text: string;
  steer?: boolean;
  parts?: TranscriptPart[];
};

const STEP_CAP = 80;

export function appendStep(msgs: TranscriptMsg[], text: string): TranscriptMsg[] {
  const last = msgs[msgs.length - 1];
  if (last?.role === "assistant") {
    const parts = last.parts ?? (last.text ? [{ kind: "text" as const, text: last.text }] : []);
    const prev = parts[parts.length - 1];
    if (prev?.kind === "step" && prev.text === text) return msgs;
    return [...msgs.slice(0, -1), { ...last, parts: capSteps([...parts, { kind: "step", text }]) }];
  }
  return [...msgs, { role: "assistant", text: "", parts: [{ kind: "step", text }] }];
}

// Kept off `text`, so a later command is not sent the chain of thought.
export function appendThinking(msgs: TranscriptMsg[], chunk: string): TranscriptMsg[] {
  if (!chunk) return msgs;
  const last = msgs[msgs.length - 1];
  if (last?.role === "assistant") {
    const parts = last.parts ? [...last.parts] : last.text ? [{ kind: "text" as const, text: last.text }] : [];
    const prev = parts[parts.length - 1];
    if (prev?.kind === "thinking") parts[parts.length - 1] = { kind: "thinking", text: prev.text + chunk };
    else parts.push({ kind: "thinking", text: chunk });
    return [...msgs.slice(0, -1), { ...last, parts }];
  }
  return [...msgs, { role: "assistant", text: "", parts: [{ kind: "thinking", text: chunk }] }];
}

export function appendText(msgs: TranscriptMsg[], chunk: string): TranscriptMsg[] {
  const last = msgs[msgs.length - 1];
  if (last?.role === "assistant") {
    const parts = last.parts ? [...last.parts] : last.text ? [{ kind: "text" as const, text: last.text }] : [];
    const prev = parts[parts.length - 1];
    if (prev?.kind === "text") parts[parts.length - 1] = { kind: "text", text: prev.text + chunk };
    else parts.push({ kind: "text", text: chunk });
    return [...msgs.slice(0, -1), { ...last, text: last.text + chunk, parts }];
  }
  return [...msgs, { role: "assistant", text: chunk, parts: [{ kind: "text", text: chunk }] }];
}

function capSteps(parts: TranscriptPart[]): TranscriptPart[] {
  let steps = 0;
  for (const part of parts) if (part.kind === "step") steps += 1;
  if (steps <= STEP_CAP) return parts;
  let drop = steps - STEP_CAP;
  return parts.filter((part) => {
    if (part.kind === "step" && drop > 0) {
      drop -= 1;
      return false;
    }
    return true;
  });
}
