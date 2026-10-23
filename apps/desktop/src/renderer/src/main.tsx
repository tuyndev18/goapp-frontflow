import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "@xterm/xterm/css/xterm.css";
import "github-markdown-css/github-markdown.css";
import "highlight.js/styles/github.css";
import "./styles.css";
import { App } from "./App.js";
import { initTheme } from "./lib/theme.js";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
