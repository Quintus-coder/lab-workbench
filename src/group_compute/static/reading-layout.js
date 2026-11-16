"use strict";

// Layout only: no file requests, edits, or changes to task state.
function initReadingLayout() {
  const bench = document.getElementById("workbench");
  const handle = document.getElementById("files-divider");
  const panel = document.getElementById("files-pane");
  const toggle = document.getElementById("reading-mode");
  const desktop = matchMedia("(min-width: 761px)");
  const key = "gc_file_pane_width";
  let preferred = null, drag = null;
  const min = 196;
  try {
    const value = Number(localStorage.getItem(key));
    if (Number.isFinite(value) && value >= min && value <= 480) preferred = value;
  } catch { /* Layout still works without browser storage. */ }

  function limits() {
    // Reserve editor space even when the secondary queue is open.
    const queue = document.getElementById("queue-panel");
    return Math.max(min, Math.min(480, Math.floor(bench.clientWidth - (queue.hidden ? 0 : queue.offsetWidth + 10) - 420)));
  }
  function apply() {
    if (!desktop.matches || !bench.clientWidth || document.body.classList.contains("reading-focus")) return;
    const defaultWidth = parseInt(getComputedStyle(bench).getPropertyValue("--files-width"), 10);
    const max = limits();
    const width = Math.max(min, Math.min(preferred ?? defaultWidth, max));
    bench.style.setProperty("--effective-files-width", width + "px");
    handle.setAttribute("aria-valuemax", String(max));
    handle.setAttribute("aria-valuenow", String(width));
    handle.setAttribute("aria-valuetext", width + " 像素");
  }
  function change(value) {
    preferred = Math.round(Math.max(min, Math.min(value, limits())));
    apply();
  }
  function persist() {
    try { if (preferred === null) localStorage.removeItem(key); else localStorage.setItem(key, String(preferred)); } catch {}
  }
  handle.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    handle.focus();
    drag = {id: event.pointerId, x: event.clientX, width: panel.offsetWidth};
    handle.setPointerCapture(event.pointerId);
    bench.classList.add("resizing-files");
  });
  handle.addEventListener("pointermove", event => {
    if (drag?.id === event.pointerId) change(drag.width + event.clientX - drag.x);
  });
  handle.addEventListener("lostpointercapture", () => {
    drag = null; bench.classList.remove("resizing-files"); persist();
  });
  handle.addEventListener("dblclick", () => { preferred = null; apply(); persist(); });
  handle.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    change(event.key === "Home" ? min : event.key === "End" ? limits() : panel.offsetWidth + (event.key === "ArrowRight" ? 16 : -16));
    persist();
  });
  new ResizeObserver(apply).observe(bench);
  new MutationObserver(apply).observe(document.getElementById("queue-panel"), {attributes: true, attributeFilter: ["hidden"]});
  desktop.addEventListener("change", apply);
  handle.title = "拖动调整文件栏宽度 · 双击恢复默认 · 方向键微调";
  function focus(on) {
    document.body.classList.toggle("reading-focus", on);
    toggle.setAttribute("aria-pressed", String(on));
    toggle.querySelector("span").textContent = on ? "退出专注阅读" : "专注阅读";
    toggle.title = on ? "恢复工作区布局（Esc）" : "使用整个窗口查看此文件";
    if (!on) apply();
  }
  toggle.onclick = () => focus(!document.body.classList.contains("reading-focus"));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !document.querySelector("dialog[open]") && document.body.classList.contains("reading-focus")) {
      focus(false); toggle.focus();
    }
  });
  return {focus};
}
