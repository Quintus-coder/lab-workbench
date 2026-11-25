// Theme switcher (auto -> light -> dark).
import { $ } from "./dom.js";

const THEME_MODES = [
  { key: "auto", label: "自动", icon: "#i-monitor" },
  { key: "light", label: "浅色", icon: "#i-sun" },
  { key: "dark", label: "深色", icon: "#i-moon" }
];

function readSavedTheme() {
  try {
    const v = localStorage.getItem("gc_theme");
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

function applyTheme(mode) {
  const item = THEME_MODES.find(m => m.key === mode) || THEME_MODES[0];
  if (item.key === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = item.key;
  $("theme-icon").setAttribute("href", item.icon);
  $("theme-label").textContent = item.label;
  $("theme-toggle").title = `显示主题：${item.label}（点击切换）`;
  try {
    if (item.key === "auto") localStorage.removeItem("gc_theme");
    else localStorage.setItem("gc_theme", item.key);
  } catch {
    // Ignore storage errors in restricted contexts.
  }
}

export function initTheme() {
  applyTheme(readSavedTheme());
  $("theme-toggle").onclick = () => {
    const current = readSavedTheme();
    const next = THEME_MODES[(THEME_MODES.findIndex(m => m.key === current) + 1) % THEME_MODES.length];
    applyTheme(next.key);
  };
}
