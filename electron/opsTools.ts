import { z } from "zod";
import { loadAgentSdk } from "./claudeBinary";
import { setToolServers } from "./claude";
import { opsTriage } from "./opsTriage";

// The ops desk tool, available to every chat. It runs ONE read-only git or gh status command and hands the
// output to the local Ollama model for a short triage summary, so busywork (build status, repo state) is
// done cheaply/locally instead of the cloud agent looping on the same queries.

let started = false;

export function initOpsTools() {
  if (started) return;
  started = true;
  setToolServers(async () => {
    const { tool, createSdkMcpServer } = await loadAgentSdk();
    const op = tool(
      "ops_triage",
      "Run one read-only git or gh status command locally and get a short local-model summary of what it shows. Use this instead of repeating shell checks for build/CI/repo status.",
      {
        command: z.string().min(1).max(400).describe("A single read-only command: e.g. 'git status', 'gh run list --limit 3', or 'gh release list'."),
      },
      async (args) => {
        const r = await opsTriage(args.command);
        if (!r.ok) return { content: [{ type: "text", text: r.raw }], isError: true };
        return {
          content: [
            {
              type: "text",
              text: r.summary ? `${r.summary}\n\n---\n${r.raw}` : r.raw,
            },
          ],
        };
      },
    );
    return {
      servers: { ops: createSdkMcpServer({ name: "ops", version: "1.0.0", tools: [op] }) },
      allowed: ["mcp__ops__ops_triage"],
    };
  });
}
