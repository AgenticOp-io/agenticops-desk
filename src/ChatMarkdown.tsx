import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { copyText } from "./codeBlocks";
import { normalizeMathDelimiters } from "./mathText";

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

const macros: Record<string, string> = {
  "\\Var": "\\operatorname{Var}",
  "\\Cov": "\\operatorname{Cov}",
  "\\Corr": "\\operatorname{Corr}",
  "\\EE": "\\mathbb{E}",
  "\\E": "\\mathbb{E}",
  "\\PP": "\\mathbb{P}",
  "\\Prob": "\\operatorname{P}",
  "\\R": "\\mathbb{R}",
  "\\N": "\\mathbb{N}",
  "\\Z": "\\mathbb{Z}",
  "\\C": "\\mathbb{C}",
  "\\eps": "\\varepsilon",
  "\\Theta": "\\Theta",
};

const REMARK = [[remarkMath, { singleDollarTextMath: true }], remarkGfm] as const;

// Memoized: while a reply streams, only the message whose text changed is parsed again.
// Markdown and KaTeX parsing of every earlier message on each token was the main cost.
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK as never}
      rehypePlugins={[
        [
          rehypeKatex,
          {
            strict: "ignore",
            throwOnError: false,
            errorColor: "#cc0000",
            macros,
          },
        ],
      ]}
      components={{
        pre({ children }) {
          const text = nodeText(children);
          return (
            <div className="md-pre">
              <button type="button" className="copy-code" onClick={() => void copyText(text)}>
                Copy
              </button>
              <pre>{children}</pre>
            </div>
          );
        },
      }}
    >
      {normalizeMathDelimiters(text)}
    </ReactMarkdown>
  );
});
