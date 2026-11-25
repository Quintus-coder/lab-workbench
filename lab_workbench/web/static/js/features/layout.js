// Workspace views, queue panel and the resizable console.
import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { initReadingLayout } from "./reading-layout.js";

export let readingLayout;

export function setView(name) {
  if (name !== "workspace") readingLayout.focus(false);
  S.view = name;
  $("workbench").hidden = name !== "workspace";
  $("history-panel").hidden = name !== "history";
  $("queue-toggle").setAttribute("aria-expanded", String(S.queueOpen && name === "workspace"));
  document.querySelectorAll("#main-navigation [data-view]").forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.view === name));
  });
}

export function setQueue(open) {
  S.queueOpen = open;
  $("workbench").classList.toggle("queue-open", open);
  $("queue-panel").hidden = !open;
  $("queue-toggle").setAttribute("aria-expanded", String(open));
  if (open) setView("workspace");
}

export function showConsole(name) {
  readingLayout.focus(false);
  setConsoleCollapsed(false);
  for (const pane of ["output", "shell"]) {
    $("console-" + pane + "-tab").setAttribute("aria-selected", String(pane === name));
    $("console-" + pane + "-tab").tabIndex = pane === name ? 0 : -1;
    $("console-" + pane).hidden = pane !== name;
  }
}

export let consoleSize = 260;
let consoleExpanded = false;
export function setConsoleCollapsed(collapsed) {
  $("job-dialog").classList.toggle("is-collapsed", collapsed);
  $("console-body").hidden = collapsed;
  $("console-resizer").hidden = collapsed;
  $("console-toggle").setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? "打开输出区" : "收起输出区";
  $("console-toggle").setAttribute("aria-label", label);
  $("console-toggle").title = label;
}
export function setConsoleSize(value) {
  const available = document.querySelector(".workbench-main").clientHeight;
  const maximum = Math.max(160, available - 190);
  const height = Math.round(Math.max(160, Math.min(maximum, value)));
  $("job-dialog").style.setProperty("--console-size", `${height}px`);
  $("console-resizer").setAttribute("aria-valuenow", String(height));
  $("console-resizer").setAttribute("aria-valuemax", String(maximum));
  return height;
}
function setConsoleExpanded(expanded) {
  consoleExpanded = expanded;
  setConsoleCollapsed(false);
  setConsoleSize(expanded ? document.querySelector(".workbench-main").clientHeight * .7 : consoleSize);
  $("console-expand").setAttribute("aria-pressed", String(expanded));
  const label = expanded ? "还原输出区高度" : "展开输出区";
  $("console-expand").setAttribute("aria-label", label);
  $("console-expand").title = label;
}

export function initLayout() {
  readingLayout = initReadingLayout();

  $("console-toggle").onclick = () => setConsoleCollapsed(!$("console-body").hidden);
  $("console-expand").onclick = () => setConsoleExpanded(!consoleExpanded);
  const resizer = $("console-resizer");
  resizer.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizer.focus();
    const startY = event.clientY;
    const startHeight = $("job-dialog").getBoundingClientRect().height;
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("is-dragging");
    const move = e => { consoleSize = setConsoleSize(startHeight + startY - e.clientY); };
    const finish = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("lostpointercapture", finish);
      resizer.classList.remove("is-dragging");
      setConsoleExpanded(false);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("lostpointercapture", finish);
  });
  resizer.addEventListener("keydown", event => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = $("job-dialog").getBoundingClientRect().height;
    consoleSize = setConsoleSize(event.key === "Home" ? 160 : event.key === "End" ? Infinity : current + (event.key === "ArrowUp" ? 24 : -24));
    setConsoleExpanded(false);
  });
  window.addEventListener("resize", () => {
    if (!$("workbench").hidden && !$("workspace").hidden) {
      setConsoleSize(consoleExpanded ? document.querySelector(".workbench-main").clientHeight * .7 : consoleSize);
    }
  });

  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => setView(b.dataset.view));
  $("queue-toggle").onclick = () => setQueue(S.view === "history" || !S.queueOpen);
  $("queue-close").onclick = () => {setQueue(false); $("queue-toggle").focus();};

  $("console-output-tab").onclick = () => showConsole("output");
  $("console-shell-tab").onclick = () => showConsole("shell");

  document.querySelector(".console-tabs").addEventListener("keydown", e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const output = $("console-output-tab").getAttribute("aria-selected") === "true";
    const name = e.key === "Home" ? "output" : e.key === "End" ? "shell" : output ? "shell" : "output";
    showConsole(name);
    $("console-" + name + "-tab").focus();
  });
}
