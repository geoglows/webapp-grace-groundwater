/**
 * Light and dark, for the app's own chrome.
 *
 * Everything the app paints reads the tokens in style.css, including the map
 * overlays that live in the arcgis-map's shadow DOM — custom properties inherit
 * across that boundary even though selectors do not — so a theme change is an
 * attribute on <html> and nothing else. The one exception is colour chosen in
 * JavaScript: the per-variable chart lines, which carry a hue per theme.
 *
 * Deliberately not tied to the basemap. Someone can read a light panel beside
 * satellite imagery, and the map's own symbology follows the basemap's
 * brightness on its own (see darkBasemap in main.js).
 */

const STORAGE_KEY = "ggg-theme";
const THEMES = ["dark", "light"];

let current = "dark";
const listeners = new Set();

const stored = () => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(v) ? v : null;
  } catch {
    return null; // private mode, or storage disabled
  }
};

/** Put a theme on the page. Dark is the default and carries no attribute. */
function applyTheme(theme) {
  current = THEMES.includes(theme) ? theme : "dark";
  if (current === "dark") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = current;
  // @geoglows/geoglows-auth styles its account menu from the nearest data-theme,
  // so the panel carries one of its own and has to be kept in step.
  const panel = document.querySelector(".rfs-panel");
  if (panel) panel.dataset.theme = current;
  for (const fn of listeners) fn(current);
}

/** Apply a theme and remember it as the user's choice. */
export function setTheme(theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, current);
  } catch { /* not being able to remember it is not worth an error */ }
}

export const theme = () => current;
export const isLight = () => current === "light";

/**
 * Called after every change, for the things a stylesheet cannot reach: a chart
 * whose colours were read at render time, and any symbol built in JavaScript.
 */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Read the remembered theme before first paint. No stored choice follows the
 * system, so the app matches the rest of the desktop rather than insisting on
 * dark; an explicit choice always wins over it.
 */
export function initTheme() {
  const saved = stored();
  if (saved) {
    setTheme(saved);
    return;
  }
  // applyTheme, not setTheme: following the system is not a choice the user made,
  // and recording it as one would stop the app following a later system change.
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  applyTheme(prefersLight ? "light" : "dark");
}
