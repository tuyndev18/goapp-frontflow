import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "ff-theme";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

let preference: ThemePreference = readPreference();

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Storage unavailable: use the default.
  }
  // Dark by default: the Linear design system is dark-first.
  return "dark";
}

function resolve(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") return darkQuery.matches ? "dark" : "light";
  return pref;
}

function apply(): void {
  const resolved = resolve(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  for (const l of listeners) l();
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not persisted; the choice still applies for this session.
  }
  apply();
}

/** Applies the saved theme before first render and keeps "system" in sync with the OS. */
export function initTheme(): void {
  darkQuery.addEventListener("change", () => {
    if (preference === "system") apply();
  });
  apply();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): { preference: ThemePreference; resolved: ResolvedTheme } {
  const pref = useSyncExternalStore(subscribe, () => preference);
  const resolved = useSyncExternalStore(subscribe, () => resolve(preference));
  return { preference: pref, resolved };
}
