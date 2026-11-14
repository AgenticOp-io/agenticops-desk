import { z } from "zod";
import { loadAgentSdk } from "./claudeBinary";
import { setToolServers } from "./claude";
import { opsTriage } from "./opsTriage";
import { describeImage } from "./imageVision";

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
    const img = tool(
      "describe_image",
      "Describe an attached image (screenshot, diagram, photo) as text, so you can act on it even on a text-only model. Local vision first, cloud fallback.",
      {
        mediaType: z.string().describe("Image MIME type, e.g. image/png"),
        data: z.string().describe("Base64 image data"),
      },
      async (args) => {
        const text = await describeImage({ mediaType: args.mediaType, data: args.data });
        if (!text) return { content: [{ type: "text", text: "The image could not be described (no local vision model and no Claude key)." }], isError: true };
        return { content: [{ type: "text", text: `Image description:\n${text}` }] };
      },
    );
    return {
      servers: { ops: createSdkMcpServer({ name: "ops", version: "1.0.0", tools: [op, img] }) },
      allowed: ["mcp__ops__ops_triage", "mcp__ops__describe_image"],
    };
  });
}
