const THEME_KEY = "cwa_theme";
const THEMES = new Set(["system", "light", "dark"]);

export function normalizeTheme(value) {
  return THEMES.has(value) ? value : "system";
}

export function themeAttribute(value) {
  const theme = normalizeTheme(value);
  return theme === "system" ? null : theme;
}

export function themeStorageKey() {
  return THEME_KEY;
}

export function loadTheme() {
  try { return normalizeTheme(localStorage.getItem(THEME_KEY)); }
  catch { return "system"; }
}

export function applyTheme(value) {
  const theme = normalizeTheme(value);
  if (typeof document !== "undefined") {
    const attr = themeAttribute(theme);
    if (attr) document.documentElement.dataset.theme = attr;
    else delete document.documentElement.dataset.theme;
  }
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  return theme;
}
