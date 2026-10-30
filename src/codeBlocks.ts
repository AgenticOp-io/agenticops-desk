export type CodeSnippet = { id: string; name: string; lang: string; code: string };

export function extractCodeBlocks(text: string, origin = "chat"): CodeSnippet[] {
  const out: CodeSnippet[] = [];
  const re = /```([\w.+-]*)[ \t]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let n = 1;
  while ((m = re.exec(text))) {
    const lang = (m[1] || "txt").trim();
    const code = m[2].replace(/\n$/, "");
    if (!code.trim()) continue;
    const name = lang && lang !== "txt" ? `${origin}-${n}.${lang}` : `${origin}-${n}`;
    out.push({ id: `${origin}-${n}`, name, lang, code });
    n += 1;
  }
  return out;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.left = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  }
}
