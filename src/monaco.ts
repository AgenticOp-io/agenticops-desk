import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";

// Bundle Monaco with the app instead of loading it from a CDN, so the editor works offline.
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });

// Files open as plain text; Claude's edits on disk should not light the editor up with type errors.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });

const BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", md: "markdown", markdown: "markdown",
  css: "css", scss: "scss", less: "less", html: "html", htm: "html", xml: "xml", svg: "xml",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", cs: "csharp", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", hpp: "cpp", rb: "ruby", php: "php", swift: "swift", sql: "sql",
  sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell", psm1: "powershell",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", tex: "latex", dockerfile: "dockerfile",
  lua: "lua", r: "r", dart: "dart", vue: "html", graphql: "graphql", proto: "proto",
};

const FENCE: Record<string, string> = {
  ts: "typescript", js: "javascript", py: "python", sh: "shell", bash: "shell", ps: "powershell",
  pwsh: "powershell", yml: "yaml", rs: "rust", rb: "ruby", "c++": "cpp", cs: "csharp", txt: "plaintext",
};

export function languageForPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "shell";
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return BY_EXT[ext] ?? "plaintext";
}

export function languageForFence(lang: string): string {
  const l = lang.toLowerCase();
  return FENCE[l] ?? BY_EXT[l] ?? (monaco.languages.getLanguages().some((x) => x.id === l) ? l : "plaintext");
}
