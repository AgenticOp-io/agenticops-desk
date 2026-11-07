import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { runGit } from "./features";
import { readJson, serialized, writeJsonAtomic } from "./jsonStore";

// A chat can run in its own git worktree, so chats in one repository don't edit the same files. The worktree lives
// under the app's data folder and is per computer: worktrees.json is not synced.
// base is the chat's own folder, which can be below the repository root; sub is that offset inside the worktree.
export type Worktree = { path: string; branch: string; base: string; sub: string };

export const worktreeCwd = (tree: Worktree) => path.join(tree.path, tree.sub);

const file = () => path.join(app.getPath("userData"), "worktrees.json");
const safeId = (chatId: string) => chatId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
const samePath = (a: string, b: string) =>
  process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

async function load(): Promise<Record<string, Worktree>> {
  const data = await readJson(file()).catch(() => null);
  return data && typeof data === "object" ? (data as Record<string, Worktree>) : {};
}

function update(fn: (all: Record<string, Worktree>) => void) {
  return serialized(file(), async () => {
    const all = await load();
    fn(all);
    await writeJsonAtomic(file(), all);
  });
}

// The chat's worktree if it still exists and belongs to the folder the chat runs in.
export async function worktreeFor(chatId: string, base?: string): Promise<Worktree | null> {
  const tree = (await load())[chatId];
  if (!tree || !existsSync(tree.path)) return null;
  if (base && !samePath(tree.base, base)) return null;
  return tree;
}

export async function createWorktree(chatId: string, folder: string): Promise<Worktree | string> {
  const id = safeId(chatId);
  if (!id) return "This chat has no id yet. Send a message first.";
  const existing = await worktreeFor(chatId, folder);
  if (existing) return existing;
  const top = await runGit(folder, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return "This folder is not a git repository, so it can't have worktrees.";
  const root = path.resolve(top.output.trim());
  const tree: Worktree = {
    path: path.join(app.getPath("userData"), "worktrees", id),
    branch: `desk/${id.slice(0, 12)}`,
    base: path.resolve(folder),
    sub: path.relative(root, path.resolve(folder)),
  };
  if (tree.sub.startsWith("..") || path.isAbsolute(tree.sub)) tree.sub = "";
  const branchExists = (await runGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${tree.branch}`])).ok;
  const add = await runGit(root, ["worktree", "add", ...(branchExists ? [] : ["-b", tree.branch]), tree.path, ...(branchExists ? [tree.branch] : ["HEAD"])]);
  if (!add.ok) return `The worktree could not be created: ${add.output}`;
  await update((all) => {
    all[chatId] = tree;
  });
  return tree;
}

// Commits what the chat changed on its branch, then merges the branch into the branch checked out in the main folder.
// A conflict is aborted, so the main folder is left as it was.
export async function mergeWorktree(chatId: string): Promise<{ ok: boolean; note: string }> {
  const tree = await worktreeFor(chatId);
  if (!tree) return { ok: false, note: "This chat has no worktree." };
  await runGit(tree.path, ["add", "-A"]);
  const staged = await runGit(tree.path, ["diff", "--cached", "--quiet"]);
  if (!staged.ok) {
    const commit = await runGit(tree.path, ["commit", "-m", `Work from chat ${safeId(chatId).slice(0, 12)}`]);
    if (!commit.ok) return { ok: false, note: `Could not commit the chat's changes: ${commit.output}` };
  }
  const merge = await runGit(tree.base, ["merge", "--no-ff", "--no-edit", tree.branch]);
  if (merge.ok) return { ok: true, note: `Merged ${tree.branch} into the main folder.` };
  await runGit(tree.base, ["merge", "--abort"]);
  return { ok: false, note: `The merge stopped, and the main folder was left as it was. ${merge.output}` };
}

// Removes the worktree and its branch. Refuses while there is work that exists only there, unless force is set.
export async function removeWorktree(chatId: string, force = false): Promise<{ ok: boolean; note: string }> {
  const all = await load();
  const tree = all[chatId];
  if (!tree) return { ok: true, note: "" };
  if (existsSync(tree.path) && !force) {
    const dirty = (await runGit(tree.path, ["status", "--porcelain"])).output.trim();
    const unmerged = (await runGit(tree.base, ["log", "--oneline", `HEAD..${tree.branch}`])).output.trim();
    if (dirty || unmerged) return { ok: false, note: "The worktree has changes that aren't merged into the main folder." };
  }
  const removed = existsSync(tree.path) ? await runGit(tree.base, ["worktree", "remove", "--force", tree.path]) : { ok: true, output: "" };
  if (!removed.ok) return { ok: false, note: `The worktree could not be removed: ${removed.output}` };
  await runGit(tree.base, ["worktree", "prune"]);
  await runGit(tree.base, ["branch", "-D", tree.branch]);
  await update((next) => {
    delete next[chatId];
  });
  return { ok: true, note: "Removed the worktree and its branch." };
}
