"use strict";
const $ = id => document.getElementById(id);
const S = {
  me: null,
  config: null,
  projects: [],
  project: null,
  files: [],
  jobs: [],
  transfers: [],
  selected: [],
  resumeTarget: null,
  busy: false,
  detail: null,
  offset: 0,
  log: "",
  pendingSubmit: null,
  editor: null,
  editingBusy: false,
  submitting: false,
  fileFilter: "",
  jobFilter: "all",
  view: "workspace",
  queueOpen: false,
  openDirs: new Set()
};
const states = {
  queued: "等待中",
  starting: "启动中",
  running: "运行中",
  cancelling: "取消中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断"
};
const terminal = state => ["succeeded", "failed", "cancelled", "interrupted"].includes(state);
const size = n => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

function node(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function svgIcon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", id);
  svg.append(use);
  return svg;
}

// Theme switcher (auto -> light -> dark)
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

applyTheme(readSavedTheme());
$("theme-toggle").onclick = () => {
  const current = readSavedTheme();
  const next = THEME_MODES[(THEME_MODES.findIndex(m => m.key === current) + 1) % THEME_MODES.length];
  applyTheme(next.key);
};

let messageTimer;
function message(text, error = false) {
  clearTimeout(messageTimer);
  const box = $("message");
  box.dataset.tone = error ? "error" : "info";
  $("message-icon").setAttribute("href", error ? "#i-alert" : "#i-check");
  $("message-text").textContent = text;
  box.hidden = false;
  if (!error) messageTimer = setTimeout(() => { box.hidden = true; }, 5000);
}
$("message-close").onclick = () => {
  clearTimeout(messageTimer);
  $("message").hidden = true;
};

$("dismiss-notice").onclick = () => {
  $("preview-notice").hidden = true;
};

async function api(path, method = "GET", data) {
  const options = { method, credentials: "same-origin", headers: {} };
  if (method !== "GET") {
    options.headers["X-Requested-With"] = "GroupCompute";
    options.headers["Content-Type"] = "application/json";
    if (data !== undefined) options.body = JSON.stringify(data);
  }
  const r = await fetch(path, options);
  let body;
  try {
    body = await r.json();
  } catch {
    body = { error: "服务器未返回有效响应，请重试" };
  }
  if (!r.ok) {
    const e = new Error(body.error || `请求失败 (${r.status})`);
    e.status = r.status;
    throw e;
  }
  return body;
}

function guarded(fn) {
  return async (...args) => {
    const event = args[0] instanceof Event ? args[0] : null;
    const button = event?.submitter || (event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null);
    if (button?.getAttribute("aria-busy") === "true") { event.preventDefault(); return; }
    button?.setAttribute("aria-busy", "true");
    try {
      await fn(...args);
    } catch (e) {
      message(e.message, true);
    } finally {
      button?.removeAttribute("aria-busy");
    }
  };
}

function ask(text) {
  return new Promise(resolve => {
    const d = $("confirm-dialog");
    $("confirm-message").textContent = text;
    d.returnValue = "";
    d.addEventListener("close", () => resolve(d.returnValue === "yes"), { once: true });
    d.showModal();
  });
}

const readingLayout = initReadingLayout();
let consoleBeforePdf = null;

// Measure the pane, not the window: the file tree and queue can both change its width.
new ResizeObserver(([entry]) => {
  const tools = $("document-tools");
  const menuSlot = $("compact-document-tools");
  const reading = $("reading-mode");
  if (entry.contentRect.width < 590) {
    if (tools.parentElement !== menuSlot) menuSlot.append(tools);
  } else if (tools.parentElement !== reading.parentElement) {
    reading.before(tools);
  }
}).observe(document.querySelector(".editor-heading"));

function setView(name) {
  if (name !== "workspace") readingLayout.focus(false);
  S.view = name;
  $("workbench").hidden = name !== "workspace";
  $("history-panel").hidden = name !== "history";
  $("queue-toggle").setAttribute("aria-expanded", String(S.queueOpen && name === "workspace"));
  document.querySelectorAll("#main-navigation [data-view]").forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.view === name));
  });
}

function setQueue(open) {
  S.queueOpen = open;
  $("workbench").classList.toggle("queue-open", open);
  $("queue-panel").hidden = !open;
  $("queue-toggle").setAttribute("aria-expanded", String(open));
  if (open) setView("workspace");
}

function linkFor(path, text, iconId) {
  const a = node("a");
  a.href = path;
  if (iconId) a.append(svgIcon(iconId));
  a.append(node("span", text));
  return a;
}

function syncRoleCards(value) {
  document.querySelectorAll(".role-card").forEach(btn => {
    btn.setAttribute("aria-pressed", String(btn.dataset.member === value));
  });
}

document.querySelectorAll(".role-card").forEach(btn => {
  btn.onclick = () => {
    $("login-member").value = btn.dataset.member;
    syncRoleCards(btn.dataset.member);
  };
});
if ($("login-member")) $("login-member").onchange = () => syncRoleCards($("login-member").value);

function editorLines() {
  $("editor-lines").textContent = $("editor-text").value.split("\n").map((_, i) => i + 1).join("\n");
  $("editor-lines").scrollTop = $("editor-text").scrollTop;
}

function updateTelemetry() {
  const waiting = S.jobs.filter(j => !terminal(j.state)).length;
  const parts = [];
  if (S.project) parts.push(`${S.files.length} 个文件`);
  if (S.editor) parts.push(`${S.editor.path.split("/").pop()}${S.editor.dirty ? " · 未保存" : ""}`);
  parts.push(`等待队列 ${waiting}`);
  $("workspace-telemetry").textContent = parts.join(" · ");
}

function editorControls() {
  const e = S.editor;
  const documentMode = Boolean(e?.kind && e.kind !== "text");
  $("editor-delete").disabled = !e || e.version === null || S.editingBusy || S.busy;
  $("editor-save").hidden = documentMode;
  $("editor-submit").hidden = documentMode;
  $("environment").closest("label").hidden = documentMode;
  $("editor-path").textContent = e?.path || "选择文件";
  const kind = $("editor-kind");
  if (e) {
    const base = e.path.split("/").pop();
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toUpperCase() : "TEXT";
    kind.textContent = ext;
    kind.dataset.script = String(/\.(py|ps1)$/i.test(e.path));
    kind.hidden = false;
  } else {
    kind.hidden = true;
  }
  $("editor-dirty-dot").hidden = !e?.dirty;
  $("editor-state").textContent = S.editingBusy ? "正在读取 / 保存…" : !e ? "点击项目文件可查看和编辑" : e.dirty ? "未保存修改" : "已保存";
  $("editor-state").dataset.dirty = String(Boolean(e?.dirty));
  if (documentMode) $("editor-state").textContent = e.kind === "pdf" ? "PDF 只读预览" : "项目文档";
  $("editor-save").disabled = !e || S.editingBusy || S.busy || !e.dirty;
  $("editor-reload").disabled = !e || e.version === null || S.editingBusy;
  $("editor-submit").disabled = !e || !/\.(py|ps1)$/i.test(e.path) || S.editingBusy || S.busy || S.submitting;
  $("editor-submit").querySelector("span").textContent = S.submitting ? "正在提交…" : "保存并提交";
  if (e) {
    const lineCount = e.text ? e.text.split("\n").length : 1;
    $("editor-meta").textContent = `${lineCount} 行 · ${e.encoding || "UTF-8"} · ${e.newline || "LF"} · ${size(new TextEncoder().encode(e.text).length)}`;
  } else {
    $("editor-meta").textContent = "UTF-8 · 最大 1 MiB";
  }
  if (documentMode) $("editor-meta").textContent = size(e.size);
  updateTelemetry();
}

function renderEditor() {
  const e = S.editor;
  const documentMode = Boolean(e?.kind && e.kind !== "text");
  const isPdf = e?.kind === "pdf";
  $("reading-mode").disabled = !e;
  if (!e) readingLayout.focus(false);
  if (isPdf && consoleBeforePdf === null) {
    consoleBeforePdf = $("console-body").hidden;
    setConsoleCollapsed(true);
  } else if (!isPdf && consoleBeforePdf !== null) {
    setConsoleCollapsed(consoleBeforePdf);
    consoleBeforePdf = null;
  }
  $("document-tools").hidden = !documentMode;
  $("document-open").hidden = true;
  $("project-content").classList.toggle("viewing-document", documentMode);
  $("editor-path").title = e?.path || "";
  $("pdf-popout").hidden = !isPdf;
  $("code-area").hidden = documentMode;
  $("document-area").hidden = !documentMode;
  const frame = $("pdf-preview");
  if (documentMode) {
    const query = new URLSearchParams({path: e.path});
    $("document-download").href = `/api/projects/${S.project.id}/download?${query}`;
    const pdf = e.kind === "pdf";
    frame.hidden = !pdf;
    $("document-placeholder").hidden = pdf;
    const office = /\.(docx|xlsx)$/i.test(e.path);
    $("document-open").hidden = !office || !S.config.office_enabled || e.size > S.config.max_office_bytes;
    $("document-open").href = `/office?${new URLSearchParams({project: S.project.id, path: e.path})}`;
    $("document-format").textContent = e.path.split(".").pop().toUpperCase();
    $("document-title").textContent = e.path.split("/").pop();
    $("document-description").textContent = office
      ? !S.config.office_enabled ? "尚未配置文档服务。服务器部署后，可在这里打开完整的 Word / Excel 编辑器，修改格式、图片和图表。现在可以下载文件。"
        : e.size > S.config.max_office_bytes ? `文档超过在线编辑上限 ${size(S.config.max_office_bytes)}，请下载后编辑。`
        : "在独立页面中完整编辑。使用编辑器的保存按钮后，请确认顶部显示已写回项目。"
      : /\.(doc|xls)$/i.test(e.path) ? "旧版 Office 格式请先另存为 .docx / .xlsx，再上传进行在线编辑。" : "此文件不支持在线预览，可下载后使用对应程序打开。";
    if (pdf) {
      const source = `/api/projects/${S.project.id}/preview?${query}`;
      const view = source + "#view=FitH";
      $("pdf-popout").href = view;
      if (frame.getAttribute("src") !== view) frame.src = view;
    } else frame.removeAttribute("src");
  } else frame.removeAttribute("src");
  $("editor-text").value = S.editor?.text || "";
  $("editor-text").disabled = !S.editor || S.editingBusy;
  editorLines();
  document.querySelectorAll(".tree-file").forEach(row => {
    const selected = row.dataset.path === S.editor?.path;
    row.classList.toggle("is-selected", selected);
    row.querySelector("button").setAttribute("aria-pressed", String(selected));
  });
  editorControls();
}

async function openEditor(path, reveal = true) {
  if (S.editingBusy) throw new Error("文件正在读取或保存，请稍后重试。");
  if (S.editor?.dirty && !await ask("有未保存的修改，放弃修改并读取文件？")) return;
  if (reveal) setView("workspace");
  S.editingBusy = true;
  renderEditor();
  try {
    const query = new URLSearchParams({path});
    if (/\.(pdf|docx?|xlsx?)$/i.test(path)) {
      const data = await api(`/api/projects/${S.project.id}/file-info?${query}`);
      S.editor = {...data, kind: /\.pdf$/i.test(path) ? "pdf" : "office", text: "", dirty: false};
      $("pdf-preview").removeAttribute("src");
    } else {
      try {
        const data = await api(`/api/projects/${S.project.id}/text?${query}`);
        const text = data.text.replace(/\r\n/g, "\n");
        S.editor = {...data, kind: "text", text, original: text, dirty: false};
      } catch (error) {
        if (error.status !== 415) throw error;
        const data = await api(`/api/projects/${S.project.id}/file-info?${query}`);
        S.editor = {...data, kind: "binary", text: "", dirty: false};
      }
    }
  } finally {
    S.editingBusy = false;
    renderEditor();
  }
}

async function deleteProjectFile(file) {
  if (S.busy || S.editingBusy) throw new Error("请等待当前文件操作完成。");
  const projectId = S.project.id;
  const dirty = S.editor?.path === file.path && S.editor.dirty;
  if (!await ask(`永久删除“${file.path}”？此操作无法撤销。${dirty ? "当前未保存的修改也会丢弃。" : ""}已提交任务的文件副本不受影响。`)) return;
  if (S.project?.id !== projectId) return;
  S.editingBusy = true;
  $("pdf-preview").removeAttribute("src");
  editorControls();
  try {
    await api(`/api/projects/${projectId}/files`, "DELETE", {path: file.path, version: file.version});
    if (S.editor?.path === file.path) S.editor = null;
    await refreshFiles();
    message("文件已删除；已提交任务的副本保留");
  } finally {
    S.editingBusy = false;
    renderEditor();
  }
}
$("editor-delete").onclick = guarded(() => deleteProjectFile(S.editor));

async function saveEditor() {
  const e = S.editor;
  if (!e) throw new Error("请先打开或新建文件。");
  if (S.editingBusy || S.busy) throw new Error("请等待当前文件操作或上传完成。");
  if (!e.dirty) return;
  S.editingBusy = true;
  renderEditor();
  try {
    const saved = await api(`/api/projects/${S.project.id}/text`, "PUT", {path:e.path, text:e.text, version:e.version});
    const text = saved.text.replace(/\r\n/g, "\n");
    S.editor = {...saved, text, original:text, dirty:false};
    await refreshFiles();
    message("文件已保存");
  } finally {
    S.editingBusy = false;
    renderEditor();
  }
}

function showConsole(name) {
  readingLayout.focus(false);
  setConsoleCollapsed(false);
  for (const pane of ["output", "shell"]) {
    $("console-" + pane + "-tab").setAttribute("aria-selected", String(pane === name));
    $("console-" + pane + "-tab").tabIndex = pane === name ? 0 : -1;
    $("console-" + pane).hidden = pane !== name;
  }
}

let consoleSize = 260;
let consoleExpanded = false;
function setConsoleCollapsed(collapsed) {
  $("job-dialog").classList.toggle("is-collapsed", collapsed);
  $("console-body").hidden = collapsed;
  $("console-resizer").hidden = collapsed;
  $("console-toggle").setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? "打开输出区" : "收起输出区";
  $("console-toggle").setAttribute("aria-label", label);
  $("console-toggle").title = label;
}
function setConsoleSize(value) {
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

// Native disclosure buttons retain keyboard support; dismiss contextual actions after use.
document.addEventListener("click", event => {
  document.querySelectorAll(".action-menu[open]").forEach(menu => {
    if (!menu.contains(event.target)) menu.open = false;
    else if (event.target.closest("button, a")) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  document.querySelectorAll(".action-menu[open]").forEach(menu => {
    menu.open = false;
    menu.querySelector("summary").focus();
    event.preventDefault();
  });
});
document.querySelectorAll("button[aria-label]").forEach(button => {
  if (!button.title) button.title = button.getAttribute("aria-label");
});

function renderProjects() {
  $("projects").replaceChildren();
  if (!S.projects.length) {
    const option = node("option", "尚无项目");
    option.value = "";
    $("projects").append(option);
  }
  for (const p of S.projects) {
    const option = node("option", p.name);
    option.value = p.id;
    $("projects").append(option);
  }
  $("projects").value = S.project?.id || S.projects[0]?.id || "";
  for (const id of ["upload-files", "upload-folder", "new-file", "refresh-files", "file-filter"]) {
    $(id).disabled = !S.project || S.busy;
  }
}

function renderFiles() {
  $("files").replaceChildren();
  $("file-count").textContent = String(S.files.length);
  const query = S.fileFilter.trim().toLocaleLowerCase();
  const visible = query ? S.files.filter(f => f.path.toLocaleLowerCase().includes(query)) : S.files;
  if (!visible.length) {
    $("files").append(node("p", S.files.length ? "没有匹配的文件。" : S.project ? "上传文件或新建 run.ps1 开始。" : "先选择或新建项目。", "empty"));
  }
  const tree = {dirs: new Map(), files: []};
  for (const file of visible) {
    const parts = file.path.split("/");
    let branch = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!branch.dirs.has(key)) branch.dirs.set(key, {dirs: new Map(), files: [], path: parts.slice(0, i + 1).join("/")});
      branch = branch.dirs.get(key);
    }
    branch.files.push(file);
  }
  function appendBranch(branch, parent) {
    for (const [name, child] of [...branch.dirs].sort((a,b) => a[0].localeCompare(b[0]))) {
      const details = node("details");
      details.open = Boolean(query) || S.openDirs.has(child.path) || Boolean(S.editor?.path.startsWith(child.path + "/"));
      const summary = node("summary");
      summary.append(svgIcon("#i-folder"), node("span", name));
      summary.title = child.path;
      details.append(summary);
      const children = node("div", undefined, "tree-children");
      appendBranch(child, children);
      details.append(children);
      details.addEventListener("toggle", () => {
        if (query) return;
        if (details.open) S.openDirs.add(child.path);
        else S.openDirs.delete(child.path);
      });
      parent.append(details);
    }
    for (const f of branch.files.sort((a,b) => a.path.localeCompare(b.path))) {
      const row = node("div", undefined, "tree-file");
      const isScript = /\.(py|ps1)$/i.test(f.path);
      const base = f.path.split("/").pop();
      const dot = base.lastIndexOf(".");
      row.dataset.path = f.path;
      row.dataset.script = String(isScript);
      if (dot > 0 && dot < base.length - 1) row.dataset.ext = base.slice(dot + 1).toLowerCase();
      const open = node("button", undefined, "file-open");
      open.type = "button";
      open.title = f.path + " · " + size(f.size);
      open.setAttribute("aria-pressed", String(f.path === S.editor?.path));
      row.classList.toggle("is-selected", f.path === S.editor?.path);
      open.append(svgIcon(isScript ? "#i-terminal" : "#i-file"), node("span", f.path.split("/").pop()));
      open.onclick = guarded(() => openEditor(f.path));
      const download = linkFor(`/api/projects/${S.project.id}/download?${new URLSearchParams({path:f.path})}`, "", "#i-download");
      download.className = "file-download";
      download.setAttribute("aria-label", "下载 " + f.path);
      download.title = "下载 " + f.path;
      const remove = node("button", "×", "file-delete");
      remove.type = "button";
      remove.title = "删除 " + f.path;
      remove.setAttribute("aria-label", remove.title);
      remove.onclick = guarded(() => deleteProjectFile(f));
      row.append(open, download, remove);
      parent.append(row);
    }
  }
  appendBranch(tree, $("files"));
  const total = S.files.reduce((n,f) => n + f.size, 0);
  $("project-stats").textContent = S.project ? `${S.files.length} 个文件 · ${size(total)}` : "项目保存代码、数据与结果";
  updateTelemetry();
}

async function refreshFiles() {
  if (!S.project) return;
  const pid = S.project.id;
  const files = await api(`/api/projects/${pid}/files`);
  if (S.project?.id !== pid) return;
  S.files = files;
  renderFiles();
  const pending = await api(`/api/projects/${pid}/uploads`);
  if (S.project?.id !== pid) return;
  for (const u of pending) {
    if (!S.transfers.some(t => t.uid === u.id)) {
      S.transfers.push({
        uid: u.id,
        pid,
        owner: S.me.id,
        path: u.relative,
        total: u.total,
        received: u.received,
        phase: "等待重新选择文件",
        file: null
      });
    }
  }
  renderTransfers();
}

async function selectProject(p) {
  if (S.busy && S.project?.id !== p.id) throw new Error("请等待本轮上传完成或失败后再切换项目。");
  if (S.editingBusy) throw new Error("文件正在保存或读取，请稍后切换项目。");
  if (S.editor?.dirty && !await ask("当前文件有未保存的修改，放弃修改并切换项目？")) return;
  S.editor = null;
  renderEditor();
  S.project = p;
  S.files = [];
  renderFiles();
  S.pendingSubmit = null;
  S.fileFilter = "";
  $("file-filter").value = "";
  $("project-name").textContent = p.name;
  $("project-content").hidden = false;
  renderProjects();
  S.openDirs.clear();
  setView("workspace");
  $("project-empty").hidden = true;
  await refreshFiles();
  const initial = S.files.find(f => /(^|\/)run\.ps1$/i.test(f.path)) || S.files.find(f => /\.(ps1|py|md|txt|yaml|json)$/i.test(f.path) && f.size <= S.config.max_text_bytes);
  if (initial) await openEditor(initial.path, false);
}

async function enter() {
  S.me = await api("/api/me");
  $("identity").textContent = S.me.name;
  $("identity-role").hidden = !S.me.admin;
  $("logout").hidden = false;
  if ($("login")) $("login").hidden = true;
  $("members-toggle").hidden = !S.me.admin;
  $("workspace").hidden = false;
  $("admin-filter").hidden = !S.me.admin;
  $("main-navigation").hidden = false;
  $("header-project-bar").hidden = false;
  $("queue-toggle").hidden = false;
  S.projects = await api("/api/projects");
  renderProjects();
  if (S.projects.length) await selectProject(S.projects[0]);
  setConsoleSize(consoleSize);
  await refreshJobs(true);
}

function renderJobs() {
  const activeCount = S.jobs.filter(j => !terminal(j.state)).length;
  const succeededCount = S.jobs.filter(j => j.state === "succeeded").length;
  const otherCount = S.jobs.filter(j => terminal(j.state) && j.state !== "succeeded").length;
  $("job-count").textContent = String(S.jobs.length);
  $("history-count").textContent = String(S.jobs.length);
  $("waiting-count").textContent = String(activeCount);
  $("hist-total").textContent = String(S.jobs.length);
  $("hist-active").textContent = String(activeCount);
  $("hist-succeeded").textContent = String(succeededCount);
  $("hist-other").textContent = String(otherCount);
  updateTelemetry();
  $("queue-description").textContent = `${S.me.admin && $("all-jobs").checked ? "所有成员" : "我的所有项目"} · 执行器尚未接入`;
  $("job-filters").hidden = !S.jobs.length;
  $("jobs").replaceChildren();
  $("job-history").replaceChildren();

  const filtered = S.jobs.filter(j => {
    if (S.jobFilter === "active") return !terminal(j.state);
    if (S.jobFilter === "done") return terminal(j.state);
    return true;
  });

  if (!S.jobs.length) $("jobs").append(node("p", "还没有任务。编辑脚本后即可提交。", "side-note"));
  if (!filtered.length) {
    const row = node("tr");
    const cell = node("td", S.jobs.length ? "当前筛选条件下没有任务。" : "还没有任务。编辑脚本后即可提交。");
    cell.colSpan = 5;
    row.append(cell);
    $("job-history").append(row);
  }

  for (const j of S.jobs) {
    const card = node("article", undefined, "job-card");
    const meta = node("div", undefined, "job-meta");
    const b = node("button", j.entry, "job-open");
    const status = node("span", states[j.state] || j.state, "status " + j.state);
    card.dataset.state = j.state;
    card.classList.toggle("is-selected", j.id === S.detail);
    b.onclick = guarded(() => openJob(j.id));
    meta.append(b, status);
    const ownerLabel = j.owner === S.me.id ? "我的任务" : j.owner;
    const when = new Date(j.submitted * 1000).toLocaleString("zh-CN");
    const projectName = S.projects.find(p => p.id === j.project)?.name || "其他项目";
    card.append(meta, node("p", `${projectName} · ${ownerLabel}`), node("p", `${when} · ${j.id.slice(0, 8)}`));
    $("jobs").append(card);
    if (!filtered.includes(j)) continue;
    const row = node("tr");
    const script = node("td");
    script.append(node("code", j.entry), node("span", `${projectName} · ${j.environment} · ${ownerLabel}`, "muted"));
    const state = node("td");
    state.append(node("span", states[j.state] || j.state, "status " + j.state));
    const action = node("td");
    const open = node("button", "查看输出", "quiet");
    open.type = "button";
    open.onclick = guarded(() => openJob(j.id));
    action.append(open);
    row.append(node("td", j.id.slice(0, 8)), script, state, node("td", when), action);
    $("job-history").append(row);
  }
}

async function refreshJobs(force = false) {
  if (!S.me) return;
  const owner = S.me.id;
  const jobs = await api("/api/jobs?all_members=" + Boolean(S.me.admin && $("all-jobs").checked));
  if (S.me?.id !== owner) return;
  const changed = JSON.stringify(S.jobs) !== JSON.stringify(jobs);
  S.jobs = jobs;
  if (changed || force) renderJobs();
  if (S.detail) await refreshDetail();
}

async function openJob(id) {
  S.detail = id;
  S.offset = 0;
  S.log = "";
  $("job-log").textContent = "正在读取日志…";
  setView("workspace");
  showConsole("output");
  $("job-dialog").scrollIntoView({block: "nearest"});
  renderJobs();
  await refreshDetail();
}

async function refreshDetail() {
  const id = S.detail;
  const j = await api(`/api/jobs/${id}`);
  if (S.detail !== id) return;
  $("job-title").textContent = j.entry;
  const badge = $("job-dialog-status");
  badge.textContent = states[j.state] || j.state;
  badge.className = "status " + j.state;
  badge.hidden = false;
  const projectName = S.projects.find(p => p.id === j.project)?.name || "其他项目";
  $("job-detail").textContent = `任务 ${j.id.slice(0, 10)} · ${projectName} · ${j.environment} · ${j.reason || "每次提交独立保存文件"}${j.exit_code !== null ? " · 退出码 " + j.exit_code : ""}`;
  $("cancel-job").hidden = terminal(j.state) || j.state === "cancelling";
  const log = await api(`/api/jobs/${id}/log?offset=${S.offset}`);
  if (S.detail !== id) return;
  S.offset = log.offset;
  S.log += log.text;
  // Bound the browser's retained preview even when logs have many polls.
  if (S.log.length > 1000000) S.log = S.log.slice(-1000000);
  const text = S.log || (j.state === "queued" ? "等待执行，尚无日志。" : "尚无日志。");
  if ($("job-log").textContent !== text) {
    const follow = $("job-log").scrollTop + $("job-log").clientHeight >= $("job-log").scrollHeight - 24;
    $("job-log").textContent = text;
    if (follow) $("job-log").scrollTop = $("job-log").scrollHeight;
  }
  $("log-note").textContent = log.truncated ? "日志已达到保存上限，部分内容被截断。" : "日志会自动刷新。";
  $("job-outputs").replaceChildren();
  $("output-count").textContent = "";
  if (!terminal(j.state)) {
    $("job-outputs").append(node("p", "任务结束后开放结果下载。", "muted"));
    return;
  }
  const files = await api(`/api/jobs/${id}/outputs`);
  if (S.detail !== id) return;
  $("output-count").textContent = files.length ? String(files.length) : "";
  if (!files.length) $("job-outputs").append(node("p", "没有结果文件。", "muted"));
  for (const f of files) {
    $("job-outputs").append(linkFor(`/api/jobs/${id}/download?${new URLSearchParams({ path: f.path })}`, `${f.path} · ${size(f.size)}`, "#i-download"));
  }
}

function renderTransfers() {
  const list = S.transfers.filter(t => t.pid === S.project?.id && t.owner === S.me?.id);
  $("transfers-section").hidden = !list.length;
  $("transfers").replaceChildren();
  $("transfer-summary").textContent = `${list.filter(t => t.phase === "已完成").length} / ${list.length} 已完成`;
  $("clear-transfers").hidden = !list.some(t => ["已完成", "已跳过", "已放弃"].includes(t.phase));

  for (const t of list) {
    const row = node("div", undefined, "transfer");
    const title = node("div", undefined, "transfer-title");
    title.append(node("span", t.path), node("span", t.phase));
    const progress = node("progress");
    progress.max = t.total || 1;
    progress.value = t.phase === "已完成" ? (t.total || 1) : t.display ?? t.received;
    row.dataset.state = { "已完成": "done", "失败": "failed", "上传中": "active" }[t.phase] || "idle";
    row.append(title, progress, node("p", `${size(t.display ?? t.received)} / ${size(t.total)}${t.error ? " · " + t.error : ""}`));
    if (t.phase === "失败" || t.phase === "等待重新选择文件") {
      const retry = node("button", t.file ? "重试 / 继续" : "重新选择同一文件");
      retry.disabled = S.busy;
      retry.onclick = guarded(async () => {
        if (t.file) {
          S.busy = true;
          try {
            await transfer(t);
          } finally {
            S.busy = false;
            await refreshFiles();
            renderTransfers();
          }
        } else {
          S.resumeTarget = t;
          $("file-picker").multiple = false;
          $("file-picker").click();
        }
      });
      row.append(retry);
    }
    if (t.uid && !["已完成", "已放弃", "上传中"].includes(t.phase)) {
      const abandon = node("button", "放弃上传");
      abandon.disabled = S.busy;
      abandon.onclick = guarded(async () => {
        await api(`/api/uploads/${t.uid}`, "DELETE", {});
        t.phase = "已放弃";
        t.error = "";
        renderTransfers();
      });
      row.append(abandon);
    }
    $("transfers").append(row);
  }
}

function chunkRequest(t, offset, content) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/uploads/${t.uid}?offset=${offset}`);
    xhr.withCredentials = true;
    xhr.timeout = 120000;
    xhr.setRequestHeader("X-Requested-With", "GroupCompute");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = e => {
      t.display = offset + e.loaded;
      renderTransfers();
    };
    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error("传输响应无效，请重试"));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || "传输失败，请重试"));
    };
    xhr.onerror = () => reject(new Error("网络中断。文件保留，可点击重试继续"));
    xhr.ontimeout = () => reject(new Error("本次传输超时。点击重试继续"));
    xhr.send(content);
  });
}

async function transfer(t) {
  t.phase = "准备中";
  t.error = "";
  renderTransfers();
  try {
    if (!t.uid) {
      let overwrite = false;
      if (S.files.some(f => f.path.toLocaleLowerCase() === t.path.toLocaleLowerCase())) {
        overwrite = await ask(`项目中已存在“${t.path}”。是否覆盖？传输完成前会保留原文件。`);
        if (!overwrite) {
          t.phase = "已跳过";
          renderTransfers();
          return;
        }
      }
      const u = await api(`/api/projects/${t.pid}/uploads`, "POST", { path: t.path, size: t.total, overwrite });
      t.uid = u.id;
      t.received = u.received;
    }
    let u = await api(`/api/uploads/${t.uid}`);
    if (u.state === "complete") {
      t.phase = "已完成";
      t.received = t.total;
      renderTransfers();
      return;
    }
    if (u.state !== "uploading") throw new Error("该上传已被放弃，请重新选择文件");
    t.received = u.received;
    t.phase = "上传中";
    renderTransfers();
    while (t.received < t.total) {
      const part = t.file.slice(t.received, Math.min(t.total, t.received + S.config.chunk_bytes));
      u = await chunkRequest(t, t.received, part);
      t.received = u.received;
      t.display = u.received;
      renderTransfers();
    }
    await api(`/api/uploads/${t.uid}/finish`, "POST", {});
    t.phase = "已完成";
    t.received = t.total;
    t.display = t.total;
    renderTransfers();
  } catch (e) {
    t.phase = "失败";
    t.error = e.message;
    t.display = t.received;
    renderTransfers();
  }
}

function stageSelection(items) {
  if (!S.project || !items.length) return;
  S.selected = items;
  $("selection-total").textContent = `${S.selected.length} 个文件 · ${size(S.selected.reduce((n, e) => n + e.file.size, 0))} · 目标：${S.project.name}`;
  $("selection-files").replaceChildren();
  for (const e of S.selected) $("selection-files").append(node("li", `${e.path} · ${size(e.file.size)}`));
  $("selection-dialog").showModal();
}

function previewSelection(files) {
  const target = S.resumeTarget;
  S.resumeTarget = null;
  if (!S.project || !files.length) return;
  if (target && (files.length !== 1 || files[0].size !== target.total || files[0].name !== target.path.split("/").pop())) {
    message("文件名称或大小与原上传不一致，请重新选择同一文件。", true);
    return;
  }
  stageSelection([...files].map(file => ({
    file,
    path: target ? target.path : (file.webkitRelativePath || file.name),
    target
  })));
}

async function readDroppedEntry(entry, prefix = "") {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      entry.file(
        file => resolve([{ file, path: prefix + entry.name, target: null }]),
        reject
      );
    });
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const collected = [];
    const readBatch = () => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    while (true) {
      const batch = await readBatch();
      if (!batch.length) break;
      for (const child of batch) {
        collected.push(...await readDroppedEntry(child, `${prefix}${entry.name}/`));
      }
    }
    return collected;
  }
  return [];
}

async function extractDroppedItems(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  if (items.length && items.some(it => typeof it.webkitGetAsEntry === "function")) {
    const entries = items.map(it => it.webkitGetAsEntry()).filter(Boolean);
    if (entries.length) {
      const nested = await Promise.all(entries.map(entry => readDroppedEntry(entry)));
      return nested.flat();
    }
  }
  return [...(dataTransfer.files || [])].map(file => ({
    file,
    path: file.webkitRelativePath || file.name,
    target: null
  }));
}

const dropZone = $("drop-zone");
dropZone.addEventListener("dragover", e => {
  e.preventDefault();
  dropZone.classList.add("is-dragover");
});
dropZone.addEventListener("dragleave", e => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("is-dragover");
});
dropZone.addEventListener("drop", guarded(async e => {
  e.preventDefault();
  dropZone.classList.remove("is-dragover");
  if (S.busy) throw new Error("请等待本轮上传完成或失败后再添加文件。");
  const dropped = await extractDroppedItems(e.dataTransfer);
  if (!dropped.length) return;
  S.resumeTarget = null;
  stageSelection(dropped);
}));

$("file-filter").oninput = e => {
  S.fileFilter = e.target.value;
  renderFiles();
};

$("clear-transfers").onclick = () => {
  S.transfers = S.transfers.filter(
    t => !(t.pid === S.project?.id && t.owner === S.me?.id && ["已完成", "已跳过", "已放弃"].includes(t.phase))
  );
  renderTransfers();
};

document.querySelectorAll("#job-filters .filter-chip").forEach(btn => {
  btn.onclick = () => {
    S.jobFilter = btn.dataset.filter;
    document.querySelectorAll("#job-filters .filter-chip").forEach(c => {
      c.setAttribute("aria-pressed", String(c === btn));
    });
    renderJobs();
  };
});

$("copy-log").onclick = guarded(async () => {
  const text = $("job-log").textContent || "";
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    message("运行日志已复制到剪贴板");
  } else {
    throw new Error("当前浏览器不支持自动复制，请手动选择日志文本。");
  }
});

if ($("login-form")) $("login-form").onsubmit = guarded(async e => {
  e.preventDefault();
  await api("/api/dev/login", "POST", { member_id: $("login-member").value });
  await enter();
});

$("logout").onclick = guarded(async () => {
  if (S.busy) {
    message("请等待本轮上传完成或失败后再退出。", true);
    return;
  }
  if (S.editingBusy) throw new Error("文件正在保存或读取，请稍后退出。");
  if (S.editor?.dirty && !await ask("当前文件有未保存修改，放弃修改并退出？")) return;
  const result = await api("/api/logout", "POST", {});
  if (result.redirect) location.replace(result.redirect);
  else location.reload();
});

async function refreshMembers() {
  const list = $("member-list");
  const members = await api("/api/members");
  const labels = {active: "已激活", pending: "待激活", disabled: "已停用"};
  list.replaceChildren();
  for (const m of members) {
    const item = node("li");
    const info = node("div");
    info.append(node("strong", m.name || m.email), node("small", (m.name ? m.email + " · " : "") +
      (m.admin ? "管理员 · " : "") + labels[m.status], "muted"));
    item.append(info);
    if (!m.admin) {
      const enable = m.status === "disabled";
      const action = node("button", enable ? "恢复" : "停用", "quiet");
      action.type = "button";
      action.setAttribute("aria-label", action.textContent + " " + m.email);
      action.onclick = guarded(async () => {
        if (!enable && !await ask("停用 " + m.email + "？已有文件和任务会保留。")) return;
        try {
          await api("/api/members/" + encodeURIComponent(m.id) + "/enabled", "POST", {enabled: enable});
          await refreshMembers();
          $("members-status").textContent = m.email + (enable ? " 已恢复。" : " 已停用。");
        } catch (e) { $("members-status").textContent = e.message; }
      });
      item.append(action);
    }
    list.append(item);
  }
}
$("members-toggle").onclick = guarded(async () => {
  $("members-dialog").showModal();
  $("members-status").textContent = "正在读取名单…";
  try { await refreshMembers(); $("members-status").textContent = ""; }
  catch (e) { $("members-status").textContent = e.message; }
});
$("invite-form").onsubmit = guarded(async e => {
  e.preventDefault();
  try {
    const m = await api("/api/members", "POST", {email: $("invite-email").value.trim()});
    $("invite-form").reset();
    await refreshMembers();
    $("members-status").textContent = m.email + " 已加入邀请名单。";
  } catch (e) { $("members-status").textContent = e.message; }
});

$("new-project").onclick = () => {
  $("project-dialog").showModal();
  $("new-name").focus();
};

$("project-form").onsubmit = guarded(async e => {
  e.preventDefault();
  const p = await api("/api/projects", "POST", { name: $("new-name").value });
  S.projects.push(p);
  $("project-dialog").close();
  $("new-name").value = "";
  await selectProject(p);
  message("项目已创建");
});

document.querySelectorAll(".close-dialog").forEach(b => b.onclick = () => b.closest("dialog").close());
document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => setView(b.dataset.view));
$("queue-toggle").onclick = () => setQueue(S.view === "history" || !S.queueOpen);
$("queue-close").onclick = () => {setQueue(false); $("queue-toggle").focus();};
$("projects").onchange = guarded(async () => {
  const p = S.projects.find(p => p.id === $("projects").value);
  try { if (p && p.id !== S.project?.id) await selectProject(p); }
  finally { $("projects").value = S.project?.id || ""; }
});
$("console-output-tab").onclick = () => showConsole("output");
$("console-shell-tab").onclick = () => showConsole("shell");
$("editor-save").onclick = guarded(saveEditor);
$("editor-reload").onclick = guarded(() => openEditor(S.editor.path));
$("editor-submit").onclick = guarded(async () => {await saveEditor(); await queueScript(S.editor.path);});
$("editor-text").addEventListener("input", () => {
  if (!S.editor) return;
  S.editor.text = $("editor-text").value;
  S.editor.dirty = S.editor.text !== S.editor.original || S.editor.version === null;
  editorLines();
  editorControls();
});
$("editor-text").addEventListener("scroll", () => {$("editor-lines").scrollTop = $("editor-text").scrollTop;});
document.querySelector(".console-tabs").addEventListener("keydown", e => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const output = $("console-output-tab").getAttribute("aria-selected") === "true";
  const name = e.key === "Home" ? "output" : e.key === "End" ? "shell" : output ? "shell" : "output";
  showConsole(name);
  $("console-" + name + "-tab").focus();
});
$("editor-text").addEventListener("keydown", e => {
  if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  const input = e.target;
  input.setRangeText("    ", input.selectionStart, input.selectionEnd, "end");
  input.dispatchEvent(new Event("input", {bubbles:true}));
});
document.addEventListener("keydown", e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s" || !S.editor) return;
  e.preventDefault();
  guarded(saveEditor)();
});
window.addEventListener("beforeunload", e => {
  if (!S.editor?.dirty) return;
  e.preventDefault();
  e.returnValue = "";
});
$("new-file").onclick = () => {$("file-dialog").showModal(); $("new-file-path").focus();};
$("file-form").onsubmit = guarded(async event => {
  event.preventDefault();
  const path = $("new-file-path").value.trim().replace(/\\/g, "/");
  if (!path) return;
  if (S.editingBusy) throw new Error("文件操作尚未完成，请稍后重试。");
  $("file-dialog").close();
  const existing = S.files.find(f => f.path.toLocaleLowerCase() === path.toLocaleLowerCase());
  if (existing) {await openEditor(existing.path); return;}
  if (S.editor?.dirty && !await ask("当前文件有未保存修改，放弃修改并新建文件？")) return;
  const text = /\.ps1$/i.test(path) ? "# 将脚本名和参数替换成当前项目的实际配置\n$ErrorActionPreference = 'Stop'\npython -u .\\train.py --epochs 100 --batch-size 64\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n" : "";
  S.editor = {path, text, original:"", version:null, dirty:true, encoding:"UTF-8", newline:"LF"};
  renderEditor();
  setView("workspace");
  $("editor-text").focus();
});

$("upload-files").onclick = () => {
  S.resumeTarget = null;
  $("file-picker").multiple = true;
  $("file-picker").click();
};
$("upload-folder").onclick = () => {
  S.resumeTarget = null;
  $("folder-picker").click();
};
for (const id of ["file-picker", "folder-picker"]) {
  $(id).onchange = e => {
    previewSelection(e.target.files);
    e.target.value = "";
  };
}
$("refresh-files").onclick = guarded(refreshFiles);
$("refresh-jobs").onclick = guarded(refreshJobs);
$("all-jobs").onchange = guarded(refreshJobs);

$("start-transfer").onclick = guarded(async () => {
  if (S.busy) return;
  const pid = S.project.id;
  S.busy = true;
  $("selection-dialog").close();
  $("upload-files").disabled = true;
  $("upload-folder").disabled = true;
  editorControls();
  try {
    for (const selected of S.selected) {
      const { file, path } = selected;
      let t = selected.target || S.transfers.find(t => t.pid === pid && t.path === path && t.total === file.size && ["失败", "等待重新选择文件"].includes(t.phase));
      if (t) {
        if (!await ask(`继续“${path}”的未完成上传？请确认选择的是同一份文件。`)) continue;
        t.file = file;
      } else {
        t = { owner: S.me.id, pid, path, total: file.size, received: 0, file, phase: "等待上传", uid: null };
        S.transfers.push(t);
      }
      await transfer(t);
    }
  } finally {
    S.busy = false;
    $("upload-files").disabled = false;
    $("upload-folder").disabled = false;
    await refreshFiles();
    renderTransfers();
    editorControls();
  }
});

async function queueScript(entry) {
  if (S.busy) throw new Error("请先完成上传");
  if (S.submitting) return;
  if (S.editor?.dirty) throw new Error("请先保存文件再提交作业。");
  const data = {
    entry,
    environment: $("environment").value,
    args: []
  };
  const signature = JSON.stringify([S.me.id, S.project.id, data]);
  if (S.pendingSubmit?.signature !== signature) S.pendingSubmit = { signature, id: crypto.randomUUID() };
  S.submitting = true;
  editorControls();
  try {
    const job = await api(`/api/projects/${S.project.id}/jobs`, "POST", { ...data, request_id: S.pendingSubmit.id });
    S.pendingSubmit = null;
    message("已加入队列。当前预览尚未接入执行器。");
    await refreshJobs();
    setQueue(true);
    await openJob(job.id);
  } finally {
    S.submitting = false;
    renderEditor();
  }
}
$("cancel-job").onclick = guarded(async () => {
  if (!await ask("取消这个任务？")) return;
  await api(`/api/jobs/${S.detail}/cancel`, "POST", {});
  await refreshJobs();
  message("已提交取消请求");
});

$("clear-console").onclick = () => {
  S.detail = null;
  S.log = "";
  S.offset = 0;
  $("job-title").textContent = "当前未选择任务";
  $("job-log").textContent = "尚未选择任务。";
  $("job-detail").textContent = "提交脚本或选择任务后，输出会显示在这里。";
  $("job-dialog-status").hidden = true;
  $("cancel-job").hidden = true;
  $("job-outputs").replaceChildren();
  $("log-note").textContent = "";
  $("output-count").textContent = "";
  renderJobs();
};

async function boot() {
  S.config = await api("/api/config");
  $("preview-notice").hidden = !S.config.development;
  $("environment").replaceChildren();
  for (const [key, label] of Object.entries(S.config.environments)) {
    const o = node("option", label);
    o.value = key;
    $("environment").append(o);
  }
  try {
    await enter();
  } catch (e) {
    if (e.status !== 401) throw e;
  }
}

guarded(boot)();
setInterval(() => {
  if (S.me && !document.hidden) guarded(refreshJobs)();
}, 4000);
