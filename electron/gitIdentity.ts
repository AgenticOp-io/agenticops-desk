import { app } from "electron";
import { run } from "./features";
import { deviceGitIdentity } from "./pureFeatures";

let cached: { name: string; email: string } | null = null;
let loading: Promise<{ name: string; email: string }> | null = null;

// The GitHub CLI login when there is one, else the global git name. Read once per app run.
export function loadGitIdentity(): Promise<{ name: string; email: string }> {
  loading ??= (async () => {
    const home = app.getPath("home");
    const gh = await run("gh", ["api", "user", "--jq", `.login + " " + (.id|tostring)`], home, 20_000);
    const [login = "", id] = gh.ok ? gh.output.split("\n")[0].trim().split(" ") : [];
    const read = async (key: string) => {
      const res = await run("git", ["config", "--global", key], home);
      return res.ok ? res.output.split("\n")[0].trim() : "";
    };
    const email = await read("user.email");
    cached = deviceGitIdentity(login || (await read("user.name")), email.includes("@") ? email : "", "desktop", id);
    return cached;
  })();
  return loading;
}

// For a spawn that cannot wait: empty until loadGitIdentity has finished once.
export function gitIdentityEnv(): Record<string, string> {
  if (!cached) {
    void loadGitIdentity();
    return {};
  }
  return { GIT_AUTHOR_NAME: cached.name, GIT_AUTHOR_EMAIL: cached.email, GIT_COMMITTER_NAME: cached.name, GIT_COMMITTER_EMAIL: cached.email };
}
