// Settings pages and fields named in the help, so "Settings › AI models › Spending cap" stands out as one place.
// Add a name here when the help mentions a new one.
const SETTINGS_PART =
  "Chats & projects|Engine & sign-in|AI models|Privacy & logins|Saved logins|Import chats|Project cleanup|Editor autocomplete|Spending cap|Auto model|Summaries|Usage|Updates|Sync|Plugins|Appearance";
const TOKEN = new RegExp(
  `(Settings(?: › (?:${SETTINGS_PART}))+|(?:Ctrl|Shift|Alt)\\+[\\w/+]+|\\b(?:F1|Esc|Enter|Tab)\\b|(?<![\\w.])/[a-z]+\\b)`,
);

export type HelpPart = { kind: "text" | "place" | "key" | "command"; text: string };

// Plain help text to inline parts: places in bold, keys as key caps, slash commands as code.
export function helpParts(text: string): HelpPart[] {
  // split() with one capture group puts the matches at odd indexes.
  return text
    .split(TOKEN)
    .map((t, i): HelpPart => ({
      kind: i % 2 === 0 ? "text" : t.startsWith("Settings") ? "place" : t.startsWith("/") ? "command" : "key",
      text: t,
    }))
    .filter((p) => p.text);
}
