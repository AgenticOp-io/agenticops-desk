import { z } from "zod";
import { loadAgentSdk } from "./claudeBinary";
import { setToolServers } from "./claude";
import { opsTriage } from "./opsTriage";
import { describeImage } from "./imageVision";
import { generateImage } from "./imageGen";
import { showCanvas } from "./canvas";
import { recall, startRecall } from "./recall";

// The ops desk tool, available to every chat. It runs ONE read-only git or gh status command and hands the
// output to the local Ollama model for a short triage summary, so busywork (build status, repo state) is
// done cheaply/locally instead of the cloud agent looping on the same queries.

let started = false;

export function initOpsTools() {
  if (started) return;
  started = true;
  startRecall();
  setToolServers(async (chatId, _signal, cwd) => {
    const { tool, createSdkMcpServer } = await loadAgentSdk();
    const op = tool(
      "ops_triage",
      "Run one read-only git or gh status command locally and get a short local-model summary of what it shows. Use this instead of repeating shell checks for build/CI/repo status.",
      {
        command: z.string().min(1).max(400).describe("A single read-only command: e.g. 'git status', 'gh run list --limit 3', or 'gh release list'."),
      },
      async (args) => {
        const r = await opsTriage(args.command, cwd);
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
    const gen = tool(
      "generate_image",
      "Create a new image from a text prompt (needs an OpenAI key in Settings). Saves a PNG and returns its file path; copy it into the project if it belongs there.",
      {
        prompt: z.string().min(1).max(4000),
        size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional(),
      },
      async (args) => {
        const r = await generateImage(args.prompt, args.size);
        if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
        return { content: [{ type: "text", text: `Image saved to ${r.path}` }] };
      },
    );
    const canvas = tool(
      "show_canvas",
      "Show a document to the user in this chat's Canvas window: a report, network or architecture diagram, chart, table, or one-page summary. It is saved with the chat, and the user can export it as PDF, PNG, HTML, SVG or Markdown. KEEP IT SIMPLE UNLESS ASKED: only make a canvas when the user asks for one or a picture explains something better than a few lines of text would; never add one as decoration. Draw the simplest thing that answers the question: one diagram with the few boxes that matter, not an infographic, dashboard, feature cards, icons, gradients, shadows or extra sections. Go bigger or more detailed only when the user asks for it (e.g. 'infographic', 'all the features', 'detailed'). Use html for reports (a full page with inline CSS; inline SVG for diagrams and charts; scripts and outside files do not load, so embed images as data: URLs), svg for a single diagram, markdown for plain text documents. PICTURES OVER PROSE, BUT REAL TECHNICAL CONTENT: draw boxes and arrows, not paragraphs, yet every box must carry real information: the file or module name, the function, protocol, port, data file or key it uses (e.g. 'claude.ts: loadAgentSdk()', 'HTTPS, pinned cert'). A diagram with only generic labels ('Desk', 'Agent') is too vague; do not do that. DIAGRAM RULES (readability matters more than completeness): use kind svg with a viewBox (about 1200x800) and no width/height, so it scales to the window. Draw boxes and arrows, not paragraphs: a bold title line per box plus up to 4 short detail lines (file, function, protocol, data), arrow labels of 1 to 4 words, no sentences. Font size 18 or more for box titles, 14 or more for detail lines and arrow labels; never shrink text to fit, split the diagram instead. At most about 16 boxes per diagram; for more detail make a second diagram, not smaller text. Lay out left to right or top to bottom, boxes at least 160x60 with 40+ gaps, no crossing arrows where avoidable, arrowheads via a marker, white text on dark fills or dark text on light fills, a few colors with a one-line legend. Put step lists in a short numbered legend inside the SVG, not in tables. BRANDING: the app already adds the agenticop.io header and footer, so do not draw your own title bar or logo. Use the AgenticOps palette (from its shield logo): background #020617, boxes #0f172a with #22d3ee or #06b6d4 outlines, accent purple #a855f7, green #10b981 for ok, slate #94a3b8 for secondary text, light text #f0fdfa on dark fills. Calling it again replaces what is shown.",
      {
        title: z.string().min(1).max(120),
        kind: z.enum(["html", "svg", "markdown"]),
        content: z.string().min(1).max(2_000_000),
      },
      async (args) => {
        await showCanvas({ chatId, ...args });
        return { content: [{ type: "text", text: `Shown in Canvas: ${args.title}` }] };
      },
    );
    const mem = tool(
      "recall",
      "Search every past chat on this computer (all projects and worktrees, AgenticOps Desk/Claude Code and Cursor) for earlier requests, decisions, fixes, errors, commands and results. Returns the best-matching user/assistant exchanges with their date and transcript path. Use it FIRST whenever the user refers to earlier work you do not have in context ('that bug', 'like last time', 'continue', 'did we fix X'), after a restart, or before re-deriving something that was likely settled before; it is far cheaper than reading or grepping transcripts. Ask with specific words: file names, function names, error text, feature names.",
      {
        query: z.string().min(2).max(500).describe("What to look for, with the specific names or error text you expect to appear."),
        limit: z.number().int().min(1).max(15).optional().describe("How many exchanges to return (default 6)."),
      },
      async (args) => {
        try {
          return { content: [{ type: "text", text: await recall(args.query, args.limit) }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Recall failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    );
    return {
      servers: { ops: createSdkMcpServer({ name: "ops", version: "1.0.0", tools: [op, img, gen, canvas, mem] }) },
      allowed: ["mcp__ops__ops_triage", "mcp__ops__describe_image", "mcp__ops__generate_image", "mcp__ops__show_canvas", "mcp__ops__recall"],
    };
  });
}
