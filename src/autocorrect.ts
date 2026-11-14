// Autocorrect for the message box: when a word is finished, swap it for the spell checker's best guess,
// only for plain lowercase words outside `code` and only when the guess is a near miss (a typo, not a different word).

// The word that a just-typed separator finished, or null when it should be left alone.
export function finishedWord(text: string, caret: number): { start: number; end: number; word: string } | null {
  const sep = text[caret - 1];
  if (!sep || !/[\s.,;:!?)]/.test(sep)) return null;
  const before = text.slice(0, caret - 1);
  // Four letters or more: shorter flagged words are mostly tool names (npm, git, cli), not typos.
  const m = /(^|[\s("])([a-z][a-z']{3,})$/.exec(before);
  if (!m) return null;
  if ((before.match(/`/g)?.length ?? 0) % 2 === 1) return null; // inside inline code or a fence
  const start = before.length - m[2].length;
  return { start, end: before.length, word: m[2] };
}

// Optimal string alignment distance: insertions, deletions, substitutions and swapped neighbours.
export function typoDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

export function acceptCorrection(word: string, guess: string | null | undefined): string | null {
  if (!guess || guess === word || /[^a-z']/i.test(guess)) return null;
  if (guess[0].toLowerCase() !== word[0]) return null;
  return typoDistance(word, guess.toLowerCase()) <= (word.length > 6 ? 2 : 1) ? guess.toLowerCase() : null;
}
