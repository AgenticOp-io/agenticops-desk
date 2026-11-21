import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-400-italic.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/greek-400.css";
import "@fontsource/source-serif-4/latin-400.css";
import "@fontsource/source-serif-4/latin-400-italic.css";
import "@fontsource/source-serif-4/latin-600.css";
import "@fontsource/source-serif-4/latin-600-italic.css";
import "@fontsource/source-serif-4/latin-700.css";
import "katex/dist/katex.min.css";
import { App } from "./App";
import { Canvas } from "./Canvas";
import { CodeWindow } from "./CodeWindow";

// A render error in any component would otherwise blank the whole window; this keeps a way back.
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("render error", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, color: "#ddd", font: "14px Inter, sans-serif" }}>
        <p>Something went wrong drawing this window. Your chats are saved.</p>
        <pre style={{ whiteSpace: "pre-wrap", opacity: 0.7 }}>{this.state.error.message}</pre>
        <button type="button" onClick={() => this.setState({ error: null })}>Try again</button>{" "}
        <button type="button" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}
import "./styles.css";

// The Canvas popup is this same page opened with ?canvas=<chatId>.
const canvasChat = new URLSearchParams(location.search).get("canvas");
const codeWindow = new URLSearchParams(location.search).get("code");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>{canvasChat ? <Canvas chatId={canvasChat} /> : codeWindow ? <CodeWindow /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
);
