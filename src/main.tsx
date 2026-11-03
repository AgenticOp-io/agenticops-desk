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
import "./styles.css";

// Saved choices from before the rename keep their values under the new key names.
for (const key of Object.keys(localStorage)) {
  if (!key.startsWith("claudedesk.")) continue;
  const next = `desk.${key.slice("claudedesk.".length)}`;
  if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key) ?? "");
  localStorage.removeItem(key);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
