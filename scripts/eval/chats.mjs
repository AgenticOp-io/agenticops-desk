// node scripts/eval/chats.mjs [--max-chars 14000] [--leave-out word,word]   → eval/train/chats.jsonl
// The same collection the app's "Train your own model" setting runs (electron/trainData.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collectChats } from "../../electron/trainData.ts";
import { args, EVAL_DIR } from "./lib.mjs";

const a = args();
const set = await collectChats({
  deskDir: path.dirname(EVAL_DIR),
  maxChars: Number(a["max-chars"] ?? 14_000),
  leaveOut: String(a["leave-out"] ?? "").split(","),
});
mkdirSync(path.join(EVAL_DIR, "train"), { recursive: true });
const out = path.join(EVAL_DIR, "train", "chats.jsonl");
writeFileSync(out, set.rows.join("\n") + "\n");
console.log(`${set.chats} chats read, ${set.leftOut} left out, ${set.rows.length} examples (claude ${set.claude}, cursor ${set.cursor}) in ${out}`);
