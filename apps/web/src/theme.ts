/** Theme choice: follow the system, or force light/dark. Stored per browser. */
export type Theme = "system" | "light" | "dark";
const KEY = "thaliyola.theme";

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme = getTheme()) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  syncThemeColor(theme);
}

/**
 * The browser chrome colour follows the page canvas. index.html ships one meta per system scheme;
 * a forced theme points both at that theme's --bg, and "system" restores what index.html said.
 */
function syncThemeColor(theme: Theme) {
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (!metas.length) return;
  const bg = theme === "system" ? "" : getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  metas.forEach((m) => {
    if (m.dataset.original === undefined) m.dataset.original = m.content;
    m.content = bg || m.dataset.original;
  });
}

export function setTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable: applies for this page only */
  }
  applyTheme(theme);
}
