import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
// Flo's speech bubble is pixel art, lettering included; bundled for the CSP and offline use.
import "@fontsource/pixelify-sans/500.css";
import "@fontsource/pixelify-sans/700.css";
import "./styles.css";
import { FloWidget } from "./components/Flo.js";
import { initTheme, setThemePreference } from "./lib/theme.js";

// Flo's own window (see main/flo-window.ts). It shares the app's storage, so a theme change there arrives as a storage event.
initTheme();
window.addEventListener("storage", (e) => {
  if (e.key === "ff-theme" && (e.newValue === "light" || e.newValue === "dark" || e.newValue === "system")) setThemePreference(e.newValue);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FloWidget />
  </StrictMode>,
);
