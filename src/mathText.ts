const FENCE = /```[\s\S]*?```|`[^`\n]+`/g;

function convertTexDelimiters(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("$$", i)) {
      const end = src.indexOf("$$", i + 2);
      if (end !== -1) {
        out += src.slice(i, end + 2);
        i = end + 2;
        continue;
      }
    }
    if (src.startsWith("\\[", i)) {
      const end = src.indexOf("\\]", i + 2);
      if (end !== -1) {
        out += `$$${src.slice(i + 2, end)}$$`;
        i = end + 2;
        continue;
      }
    }
    if (src.startsWith("\\(", i)) {
      const end = src.indexOf("\\)", i + 2);
      if (end !== -1) {
        const inner = src.slice(i + 2, end);
        out += inner.includes("\n") ? `$$${inner}$$` : `$${inner}$`;
        i = end + 2;
        continue;
      }
    }
    out += src[i];
    i += 1;
  }
  return out;
}

export function normalizeMathDelimiters(text: string): string {
  const holes: string[] = [];
  const masked = text.replace(FENCE, (m) => {
    holes.push(m);
    return `\0${holes.length - 1}\0`;
  });
  return convertTexDelimiters(masked).replace(/\0(\d+)\0/g, (_, n) => holes[Number(n)] ?? "");
}
