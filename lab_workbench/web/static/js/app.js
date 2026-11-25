"use strict";
const $ = id => document.getElementById(id);
const S = {
  me: null,
  config: null,
  projects: [],
  project: null,
  usage: null,
  systemStatus: null,
  files: [],
  jobs: [],
  transfers: [],
  selected: [],
  resumeTarget: null,
  busy: false,
  detail: null,
  detailJob: null,
  offset: 0,
  log: "",
  pendingSubmit: null,
  pendingReruns: {},
  renamingFile: null,
  editor: null,
  editingBusy: false,
  submitting: false,
  fileFilter: "",
  jobFilter: "all",
  jobSearch: "",
  view: "workspace",
  queueOpen: false,
  openDirs: new Set()
};
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
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

function relativeTime(epochSeconds) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

async function copyText(text, okMessage) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    message(okMessage);
  } else {
    throw new Error("当前浏览器不支持自动复制，请手动复制。");
  }
}

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

function ask(text, options = {}) {
  return new Promise(resolve => {
    const d = $("confirm-dialog");
    const wrap = $("confirm-match-wrap");
    const input = $("confirm-match-input");
    const yes = $("confirm-yes");
    const expect = options.expect || "";
    $("confirm-message").textContent = text;
    if (expect) {
      $("confirm-match-label").textContent = `请输入“${expect}”以确认`;
      input.value = "";
      input.placeholder = expect;
      wrap.hidden = false;
      yes.disabled = true;
      input.oninput = () => { yes.disabled = input.value.trim() !== expect; };
    } else {
      wrap.hidden = true;
      input.value = "";
      input.oninput = null;
      yes.disabled = false;
    }
    d.returnValue = "";
    d.addEventListener("close", () => {
      const confirmed = d.returnValue === "yes" && (!expect || input.value.trim() === expect);
      wrap.hidden = true;
      input.value = "";
      input.oninput = null;
      yes.disabled = false;
      resolve(confirmed);
    }, { once: true });
    d.showModal();
    if (expect) input.focus();
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

function buildRowMenu(label, items) {
  const menu = node("details", undefined, "action-menu row-menu");
  const summary = node("summary", undefined, "icon-control");
  summary.setAttribute("aria-label", label);
  summary.title = label;
  summary.append(svgIcon("#i-more"));
  const popover = node("div", undefined, "action-popover align-right");
  for (const item of items) {
    if (item.href) {
      const a = linkFor(item.href, item.text, item.icon);
      a.className = "menu-link";
      popover.append(a);
    } else {
      const b = node("button", undefined, item.danger ? "quiet danger" : "quiet");
      b.type = "button";
      if (item.icon) b.append(svgIcon(item.icon));
      b.append(node("span", item.text));
      b.onclick = item.onclick;
      popover.append(b);
    }
  }
  menu.append(summary, popover);
  return menu;
}

function syncRoleCards(value) {
  document.querySelectorAll(".role-card").forEach(btn => {
    const selected = btn.dataset.member === value;
    btn.setAttribute("aria-checked", String(selected));
    btn.tabIndex = selected ? 0 : -1;
  });
}

const roleCards = [...document.querySelectorAll(".role-card")];
roleCards.forEach((btn, idx) => {
  btn.onclick = () => {
    $("login-member").value = btn.dataset.member;
    syncRoleCards(btn.dataset.member);
  };
  btn.ondblclick = () => {
    $("login-member").value = btn.dataset.member;
    syncRoleCards(btn.dataset.member);
    $("login-form")?.requestSubmit();
  };
  btn.onkeydown = e => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("login-member").value = btn.dataset.member;
      syncRoleCards(btn.dataset.member);
      $("login-form")?.requestSubmit();
      return;
    }
    let nextIdx = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") nextIdx = (idx + 1) % roleCards.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") nextIdx = (idx - 1 + roleCards.length) % roleCards.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = roleCards.length - 1;
    if (nextIdx >= 0) {
      e.preventDefault();
      const target = roleCards[nextIdx];
      $("login-member").value = target.dataset.member;
      syncRoleCards(target.dataset.member);
      target.focus();
    }
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
  const isScript = Boolean(e && /\.(py|ps1)$/i.test(e.path));
  $("editor-delete").disabled = !e || e.version === null || S.editingBusy || S.busy;
  $("editor-save").hidden = documentMode;
  $("editor-submit").hidden = documentMode || !isScript;
  $("environment").closest("label").hidden = documentMode || !isScript;
  $("editor-path").textContent = e?.path || "选择文件";
  const kind = $("editor-kind");
  if (e) {
    const base = e.path.split("/").pop();
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toUpperCase() : "TEXT";
    kind.textContent = ext;
    kind.dataset.script = String(isScript);
    kind.hidden = false;
  } else {
    kind.hidden = true;
  }
  $("editor-dirty-dot").hidden = !e?.dirty;
  $("editor-state").textContent = S.editingBusy ? "正在读取 / 保存…" : !e ? "点击项目文件可查看和编辑" : e.dirty ? "未保存修改" : "已保存";
  $("editor-state").dataset.dirty = String(Boolean(e?.dirty));
  if (documentMode) $("editor-state").textContent = e.kind === "pdf" ? "PDF 只读预览" : e.kind === "image" ? "图片只读预览" : "项目文档";
  $("editor-save").disabled = !e || S.editingBusy || S.busy || !e.dirty;
  $("editor-save").title = !e ? "请先打开或新建文件"
    : S.busy ? "请等待当前上传完成后保存"
    : S.editingBusy ? "正在读取或保存文件"
    : !e.dirty ? "当前没有未保存的修改"
    : "保存文件 (Ctrl+S)";
  $("editor-reload").disabled = !e || e.version === null || S.editingBusy;
  $("editor-submit").disabled = !isScript || S.editingBusy || S.busy || S.submitting;
  $("editor-submit").title = !e ? "请先打开 .ps1 / .py 脚本"
    : !isScript ? "仅 .ps1 / .py 脚本可提交"
    : S.submitting ? "正在提交作业…"
    : S.busy ? "请等待当前上传完成后再提交"
    : S.editingBusy ? "正在读取或保存文件，请稍后提交"
    : "保存并提交 (Ctrl+Enter)";
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
  const isImage = e?.kind === "image";
  const isPreview = isPdf || isImage;
  $("reading-mode").disabled = !e;
  if (!e) readingLayout.focus(false);
  if (isPreview && consoleBeforePdf === null) {
    consoleBeforePdf = $("console-body").hidden;
    setConsoleCollapsed(true);
  } else if (!isPreview && consoleBeforePdf !== null) {
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
  const imgWrap = $("image-preview-wrap");
  const img = $("image-preview");
  if (documentMode) {
    const query = new URLSearchParams({path: e.path});
    $("document-download").href = `/api/projects/${S.project.id}/download?${query}`;
    const pdf = e.kind === "pdf";
    const image = e.kind === "image";
    frame.hidden = !pdf;
    imgWrap.hidden = !image;
    $("document-placeholder").hidden = pdf || image;
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
    if (image) {
      const view = `/api/projects/${S.project.id}/preview?${query}`;
      img.alt = e.path;
      img.onerror = () => {
        if (S.editor?.kind !== "image" || img.getAttribute("src") !== view) return;
        imgWrap.hidden = true;
        $("document-placeholder").hidden = false;
        $("document-description").textContent = "无法在线预览此图片（可能超过大小上限或文件头与扩展名不符），请下载后查看。";
      };
      if (img.getAttribute("src") !== view) img.src = view;
    } else {
      img.onerror = null;
      img.removeAttribute("src");
    }
  } else {
    frame.removeAttribute("src");
    imgWrap.hidden = true;
    img.onerror = null;
    img.removeAttribute("src");
  }
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

function revealFileInTree(path) {
  if (!path) return;
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    S.openDirs.add(parts.slice(0, i).join("/"));
  }
  document.querySelectorAll("#files details").forEach(details => {
    if (details.dataset.dirPath && S.openDirs.has(details.dataset.dirPath)) {
      details.open = true;
    }
  });
  const row = [...document.querySelectorAll("#files .tree-file")].find(r => r.dataset.path === path);
  if (row) {
    row.classList.add("is-selected");
    row.querySelector("button")?.setAttribute("aria-pressed", "true");
    row.scrollIntoView({block: "nearest"});
  }
}

async function openEditor(path, reveal = true) {
  if (S.editingBusy) throw new Error("文件正在读取或保存，请稍后重试。");
  if (S.editor?.dirty && !await ask("有未保存的修改，放弃修改并读取文件？")) return;
  if (reveal) setView("workspace");
  S.editingBusy = true;
  renderEditor();
  let loaded = false;
  try {
    const query = new URLSearchParams({path});
    if (/\.(pdf|docx?|xlsx?)$/i.test(path) || IMAGE_EXT_RE.test(path)) {
      const data = await api(`/api/projects/${S.project.id}/file-info?${query}`);
      const kind = /\.pdf$/i.test(path) ? "pdf" : IMAGE_EXT_RE.test(path) ? "image" : "office";
      S.editor = {...data, kind, text: "", dirty: false};
      $("pdf-preview").removeAttribute("src");
      $("image-preview").removeAttribute("src");
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
    loaded = true;
  } finally {
    S.editingBusy = false;
    renderEditor();
    if (loaded && S.editor?.path === path) revealFileInTree(path);
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
  $("image-preview").removeAttribute("src");
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

async function deleteProjectDir(dirPath) {
  if (S.busy || S.editingBusy) throw new Error("请等待当前文件操作完成。");
  const projectId = S.project.id;
  const dirtyInside = Boolean(S.editor?.dirty && S.editor.path.startsWith(dirPath + "/"));
  if (!await ask(`永久删除文件夹“${dirPath}”及其中的全部文件？此操作无法撤销。${dirtyInside ? "该文件夹内未保存的修改也会丢弃。" : ""}已提交任务的文件副本不受影响。`)) return;
  if (S.project?.id !== projectId) return;
  S.editingBusy = true;
  if (S.editor?.path.startsWith(dirPath + "/")) {
    $("pdf-preview").removeAttribute("src");
    $("image-preview").removeAttribute("src");
  }
  editorControls();
  try {
    await api(`/api/projects/${projectId}/directories`, "DELETE", {path: dirPath});
    if (S.editor?.path.startsWith(dirPath + "/")) S.editor = null;
    for (const openPath of [...S.openDirs]) {
      if (openPath === dirPath || openPath.startsWith(dirPath + "/")) S.openDirs.delete(openPath);
    }
    await refreshFiles();
    message("文件夹已删除；已提交任务的副本保留");
  } finally {
    S.editingBusy = false;
    renderEditor();
  }
}

function openRenameFileDialog(file) {
  if (!S.project) return;
  if (S.busy || S.editingBusy) {
    message("请等待当前文件操作完成。", true);
    return;
  }
  S.renamingFile = file;
  $("rename-file-current").textContent = `当前路径：${file.path}`;
  const input = $("rename-file-path");
  input.value = file.path;
  $("rename-file-error").hidden = true;
  $("rename-file-error").textContent = "";
  $("rename-file-dialog").showModal();
  input.focus();
  const slash = file.path.lastIndexOf("/");
  input.setSelectionRange(slash + 1, file.path.length);
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
    revealFileInTree(S.editor.path);
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
      if (!document.querySelector("dialog[open]")) menu.querySelector("summary").focus();
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
  $("project-menu").hidden = !S.project;
  if (S.project) {
    $("archive-project").href = `/api/projects/${S.project.id}/archive`;
  } else {
    $("archive-project").removeAttribute("href");
  }
  $("rename-project").disabled = !S.project || S.busy || S.editingBusy;
  $("delete-project").disabled = !S.project || S.busy || S.editingBusy;
  for (const id of ["upload-files", "upload-folder", "new-file", "refresh-files", "file-filter"]) {
    $(id).disabled = !S.project || S.busy;
  }
}

function renderUsage() {
  const bar = $("project-usage-bar");
  const stats = $("project-stats");
  if (!S.project) {
    stats.textContent = "项目保存代码、数据与结果";
    bar.hidden = true;
    bar.value = 0;
    delete bar.dataset.level;
    return;
  }
  if (!S.usage) {
    const total = S.files.reduce((n, f) => n + f.size, 0);
    stats.textContent = `${S.files.length} 个文件 · ${size(total)}`;
    bar.hidden = true;
    return;
  }
  const used = S.usage.used_bytes;
  const max = Math.max(1, S.usage.max_project_bytes || 1);
  const ratio = Math.min(1, used / max);
  const reserved = S.usage.reserved_bytes ? `（上传预留 ${size(S.usage.reserved_bytes)}）` : "";
  stats.textContent = `${S.usage.file_count} 个文件 · 已用 ${size(used)} / ${size(S.usage.max_project_bytes)}${reserved}`;
  bar.max = max;
  bar.value = Math.min(max, used);
  bar.dataset.level = ratio >= 0.95 ? "danger" : ratio >= 0.8 ? "warn" : "normal";
  bar.hidden = false;
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
      const dirWrap = node("div", undefined, "tree-dir");
      const details = node("details");
      details.dataset.dirPath = child.path;
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
      const dirMenu = buildRowMenu("操作文件夹 " + child.path, [
        { text: "打包下载", href: `/api/projects/${S.project.id}/archive?${new URLSearchParams({ dir: child.path })}`, icon: "#i-download" },
        { text: "删除文件夹…", danger: true, onclick: guarded(() => deleteProjectDir(child.path)) }
      ]);
      dirWrap.append(details, dirMenu);
      parent.append(dirWrap);
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
      open.append(svgIcon(isScript ? "#i-terminal" : "#i-file"), node("span", base));
      open.onclick = guarded(() => openEditor(f.path));
      const menu = buildRowMenu("操作文件 " + f.path, [
        { text: "重命名 / 移动…", onclick: () => openRenameFileDialog(f) },
        { text: "下载", href: `/api/projects/${S.project.id}/download?${new URLSearchParams({ path: f.path })}`, icon: "#i-download" },
        { text: "删除…", danger: true, onclick: guarded(() => deleteProjectFile(f)) }
      ]);
      row.append(open, menu);
      parent.append(row);
    }
  }
  appendBranch(tree, $("files"));
  renderUsage();
  updateTelemetry();
}

async function refreshFiles() {
  if (!S.project) return;
  const pid = S.project.id;
  const [files, pending, usage] = await Promise.all([
    api(`/api/projects/${pid}/files`),
    api(`/api/projects/${pid}/uploads`),
    api(`/api/projects/${pid}/usage`)
  ]);
  if (S.project?.id !== pid) return;
  S.files = files;
  S.usage = usage;
  renderFiles();
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
  S.usage = null;
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

async function refreshSystemStatus() {
  if (!S.me) return;
  const st = await api("/api/system/status");
  if (!S.me) return;
  S.systemStatus = st;
  const el = $("system-status");
  const sep = $("system-status-sep");
  const lowDisk = st.disk_free_bytes < st.disk_min_free_bytes * 2;
  el.textContent = `磁盘剩余 ${size(st.disk_free_bytes)} · 排队 ${st.queued_jobs}`;
  el.dataset.lowDisk = String(lowDisk);
  el.title = `磁盘保留下限：${size(st.disk_min_free_bytes)} · 全组运行中：${st.active_jobs} · 全组排队：${st.queued_jobs}`;
  el.hidden = false;
  sep.hidden = false;
}

async function enter() {
  S.me = await api("/api/me");
  $("identity").textContent = S.me.name;
  $("identity-role").hidden = !S.me.admin;
  $("user-menu").hidden = false;
  $("logout").hidden = false;
  $("preview-notice").hidden = !S.config?.development;
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
  await Promise.all([refreshJobs(true), refreshSystemStatus().catch(() => {})]);
}

function renderJobs() {
  const activeCount = S.jobs.filter(j => !terminal(j.state)).length;
  const succeededCount = S.jobs.filter(j => j.state === "succeeded").length;
  const otherCount = S.jobs.filter(j => terminal(j.state) && j.state !== "succeeded").length;
  $("job-count").textContent = String(S.jobs.length);
  $("history-count").textContent = String(S.jobs.length);
  $("waiting-count").textContent = String(activeCount);
  $("waiting-count").dataset.active = String(activeCount > 0);
  $("hist-total").textContent = String(S.jobs.length);
  $("hist-active").textContent = String(activeCount);
  $("hist-succeeded").textContent = String(succeededCount);
  $("hist-other").textContent = String(otherCount);
  updateTelemetry();
  $("queue-description").textContent = `${S.me.admin && $("all-jobs").checked ? "所有成员" : "我的所有项目"} · 执行器尚未接入`;
  $("job-filters").hidden = !S.jobs.length;
  $("job-search").closest("label").hidden = !S.jobs.length;
  $("jobs").replaceChildren();
  $("job-history").replaceChildren();

  const searchQuery = S.jobSearch.trim().toLocaleLowerCase();
  const projectNameFor = j => S.projects.find(p => p.id === j.project)?.name || "其他项目";

  const filtered = S.jobs.filter(j => {
    if (S.jobFilter === "active" && terminal(j.state)) return false;
    if (S.jobFilter === "done" && !terminal(j.state)) return false;
    if (searchQuery) {
      const proj = projectNameFor(j).toLocaleLowerCase();
      if (!j.entry.toLocaleLowerCase().includes(searchQuery) && !proj.includes(searchQuery)) return false;
    }
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

  function buildJobCard(j) {
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
    const projectName = projectNameFor(j);
    const timeLine = node("p");
    const rel = node("span", relativeTime(j.submitted), "job-rel-time");
    rel.dataset.submitted = String(j.submitted);
    rel.title = when;
    timeLine.title = when;
    timeLine.append(rel, document.createTextNode(` · ${j.id.slice(0, 8)}`));
    card.append(meta, node("p", `${projectName} · ${ownerLabel}`), timeLine);
    return card;
  }

  const activeJobs = S.jobs.filter(j => !terminal(j.state));
  const finishedJobs = S.jobs.filter(j => terminal(j.state));
  if (activeJobs.length) {
    $("jobs").append(node("h3", "进行中", "job-group-title"));
    for (const j of activeJobs) $("jobs").append(buildJobCard(j));
  }
  if (finishedJobs.length) {
    $("jobs").append(node("h3", "最近结束", "job-group-title"));
    for (const j of finishedJobs.slice(0, 8)) $("jobs").append(buildJobCard(j));
  }
  const historyBtnSpan = document.querySelector(".history-link span");
  if (historyBtnSpan) {
    historyBtnSpan.textContent = finishedJobs.length > 8 ? `查看全部 ${S.jobs.length} 条任务` : "查看全部任务";
  }

  for (const j of filtered) {
    const ownerLabel = j.owner === S.me.id ? "我的任务" : j.owner;
    const when = new Date(j.submitted * 1000).toLocaleString("zh-CN");
    const projectName = projectNameFor(j);
    const row = node("tr");
    const script = node("td");
    const scriptMeta = node("div", undefined, "history-script-meta");
    const copyId = node("button", j.id.slice(0, 8), "quiet job-id-copy");
    copyId.type = "button";
    copyId.title = `点击复制任务 ID：${j.id}`;
    copyId.setAttribute("aria-label", `复制任务 ID ${j.id}`);
    copyId.onclick = guarded(() => copyText(j.id, `已复制任务 ID：${j.id.slice(0, 8)}`));
    scriptMeta.append(copyId, node("span", j.environment, "muted"));
    script.append(node("code", j.entry), scriptMeta);
    const projectCell = node("td");
    projectCell.append(node("span", projectName), node("span", ownerLabel, "muted"));
    const state = node("td");
    state.append(node("span", states[j.state] || j.state, "status " + j.state));
    const timeCell = node("td", when);
    timeCell.title = when;
    const action = node("td");
    const actionWrap = node("div", undefined, "table-actions");
    const open = node("button", "查看输出", "quiet");
    open.type = "button";
    open.onclick = guarded(() => openJob(j.id));
    actionWrap.append(open);
    if (j.owner === S.me.id) {
      const rerun = node("button", "重新运行", "quiet");
      rerun.type = "button";
      rerun.onclick = guarded(() => rerunJob(j));
      actionWrap.append(rerun);
    }
    action.append(actionWrap);
    row.append(script, projectCell, state, timeCell, action);
    $("job-history").append(row);
  }
}

async function rerunJob(job) {
  if (!S.me || job.owner !== S.me.id) throw new Error("只能重新运行自己的任务。");
  if (S.submitting) return;
  let pending = S.pendingReruns[job.id];
  if (!pending) {
    pending = { request_id: crypto.randomUUID() };
    S.pendingReruns[job.id] = pending;
  }
  S.submitting = true;
  editorControls();
  try {
    const submitted = await api(`/api/jobs/${job.id}/rerun`, "POST", { request_id: pending.request_id });
    delete S.pendingReruns[job.id];
    message("已重新提交任务");
    await refreshJobs();
    await refreshSystemStatus().catch(() => {});
    setQueue(true);
    await openJob(submitted.id);
  } finally {
    S.submitting = false;
    editorControls();
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

function syncConsoleEmptyState() {
  const hasJob = Boolean(S.detail);
  $("console-empty").hidden = hasJob;
  document.querySelector("#console-output .console-heading").hidden = !hasJob;
  $("job-detail").hidden = !hasJob;
  $("job-log").hidden = !hasJob;
  $("log-note").hidden = !hasJob;
  $("job-results").hidden = !hasJob;
  $("copy-log").hidden = !hasJob;
  $("clear-console").hidden = !hasJob;
  if (!hasJob) {
    $("job-queue-pos").hidden = true;
    $("rerun-job").hidden = true;
    $("view-snapshot").hidden = true;
    $("outputs-archive").hidden = true;
  }
}

syncConsoleEmptyState();
$("console-open-queue").onclick = () => setQueue(true);

async function openJob(id) {
  S.detail = id;
  S.detailJob = null;
  S.offset = 0;
  S.log = "";
  syncConsoleEmptyState();
  $("job-log").textContent = "正在读取日志…";
  setView("workspace");
  showConsole("output");
  $("job-dialog").scrollIntoView({block: "nearest"});
  renderJobs();
  await refreshDetail();
}

async function openSnapshotDialog(jid) {
  const list = $("snapshot-files");
  list.replaceChildren();
  $("snapshot-meta").textContent = "正在读取…";
  $("snapshot-preview-head").hidden = true;
  $("snapshot-text").hidden = true;
  $("snapshot-binary").hidden = true;
  $("snapshot-preview-empty").hidden = false;
  $("snapshot-preview-empty").textContent = "正在读取快照文件列表…";
  $("snapshot-dialog").showModal();
  const files = await api(`/api/jobs/${jid}/snapshot/files`);
  $("snapshot-meta").textContent = `${files.length} 个文件`;
  if (!files.length) {
    $("snapshot-preview-empty").textContent = "该次提交没有文件。";
    return;
  }
  $("snapshot-preview-empty").textContent = "从左侧选择文件查看只读内容或下载。";
  for (const f of files) {
    const li = node("li", undefined, "snapshot-file-row");
    const btn = node("button", undefined, "snapshot-file-btn");
    btn.type = "button";
    btn.title = f.path;
    btn.append(node("span", f.path), node("span", size(f.size), "snapshot-file-size"));
    btn.onclick = guarded(async () => {
      list.querySelectorAll(".snapshot-file-row").forEach(el => el.classList.toggle("is-selected", el === li));
      const dlUrl = `/api/jobs/${jid}/snapshot/download?${new URLSearchParams({ path: f.path })}`;
      $("snapshot-file-path").textContent = f.path;
      $("snapshot-file-download").href = dlUrl;
      $("snapshot-preview-head").hidden = false;
      $("snapshot-preview-empty").hidden = true;
      $("snapshot-text").hidden = true;
      $("snapshot-binary").hidden = true;
      try {
        const textData = await api(`/api/jobs/${jid}/snapshot/text?${new URLSearchParams({ path: f.path })}`);
        $("snapshot-text").textContent = textData.text.replace(/\r\n/g, "\n");
        $("snapshot-text").hidden = false;
      } catch (err) {
        if (err.status !== 415) throw err;
        $("snapshot-binary-note").textContent = err.message || "此文件不支持文本预览，请下载后查看。";
        $("snapshot-binary-download").href = dlUrl;
        $("snapshot-binary").hidden = false;
      }
    });
    li.append(btn);
    list.append(li);
  }
}

async function refreshDetail() {
  const id = S.detail;
  const j = await api(`/api/jobs/${id}`);
  if (S.detail !== id) return;
  S.detailJob = j;
  $("job-title").textContent = j.entry;
  const badge = $("job-dialog-status");
  badge.textContent = states[j.state] || j.state;
  badge.className = "status " + j.state;
  badge.hidden = false;
  const qpos = $("job-queue-pos");
  if (j.state === "queued" && Number.isInteger(j.queue_position)) {
    qpos.textContent = `前面还有 ${Math.max(0, j.queue_position - 1)} 个任务`;
    qpos.hidden = false;
  } else {
    qpos.hidden = true;
  }
  $("rerun-job").hidden = j.owner !== S.me.id;
  $("view-snapshot").hidden = false;
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
  const archiveBtn = $("outputs-archive");
  if (!terminal(j.state)) {
    archiveBtn.hidden = true;
    archiveBtn.removeAttribute("href");
    $("job-outputs").append(node("p", "任务结束后开放结果下载。", "muted"));
    return;
  }
  const files = await api(`/api/jobs/${id}/outputs`);
  if (S.detail !== id) return;
  $("output-count").textContent = files.length ? String(files.length) : "";
  if (files.length) {
    archiveBtn.href = `/api/jobs/${id}/outputs/archive`;
    archiveBtn.hidden = false;
  } else {
    archiveBtn.hidden = true;
    archiveBtn.removeAttribute("href");
    $("job-outputs").append(node("p", "没有结果文件。", "muted"));
  }
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

$("job-search").oninput = e => {
  S.jobSearch = e.target.value;
  renderJobs();
};

$("copy-log").onclick = guarded(() => copyText($("job-log").textContent || "", "运行日志已复制到剪贴板"));

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
  const labels = {active: "已激活", pending: S.config.password_auth ? "已批准 · 待注册" : "待激活", disabled: "已停用"};
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
    $("members-status").textContent = m.email + (S.config.password_auth ? " 已获准注册。" : " 已加入邀请名单。");
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

$("rename-project").onclick = () => {
  if (!S.project) return;
  const input = $("rename-project-name");
  input.value = S.project.name;
  $("rename-project-error").hidden = true;
  $("rename-project-error").textContent = "";
  $("rename-project-dialog").showModal();
  input.focus();
  input.select();
};

$("rename-project-form").onsubmit = guarded(async e => {
  e.preventDefault();
  if (!S.project) return;
  const pid = S.project.id;
  $("rename-project-error").hidden = true;
  try {
    const updated = await api(`/api/projects/${pid}`, "PATCH", { name: $("rename-project-name").value });
    const target = S.projects.find(p => p.id === pid);
    if (target) target.name = updated.name;
    if (S.project?.id === pid) {
      S.project.name = updated.name;
      $("project-name").textContent = updated.name;
    }
    $("rename-project-dialog").close();
    renderProjects();
    renderJobs();
    message("项目已重命名");
  } catch (err) {
    $("rename-project-error").textContent = err.message;
    $("rename-project-error").hidden = false;
    throw err;
  }
});

$("delete-project").onclick = guarded(async () => {
  if (!S.project) return;
  if (S.busy || S.editingBusy) throw new Error("请等待当前文件操作完成。");
  const target = S.project;
  if (!await ask(`永久删除项目“${target.name}”及其全部文件？此操作无法撤销；已提交任务的历史记录与日志仍会保留。`, { expect: target.name })) return;
  await api(`/api/projects/${target.id}`, "DELETE");
  S.projects = S.projects.filter(p => p.id !== target.id);
  S.transfers = S.transfers.filter(t => t.pid !== target.id);
  S.editor = null;
  S.project = null;
  S.usage = null;
  S.files = [];
  if (S.projects.length) {
    await selectProject(S.projects[0]);
  } else {
    renderEditor();
    renderProjects();
    renderFiles();
    renderTransfers();
    $("project-name").textContent = "尚未选择项目";
    $("project-content").hidden = true;
    $("project-empty").hidden = false;
  }
  await Promise.all([refreshJobs(true), refreshSystemStatus().catch(() => {})]);
  message("项目已删除");
});

$("rename-file-form").onsubmit = guarded(async e => {
  e.preventDefault();
  const file = S.renamingFile;
  if (!S.project || !file) return;
  const pid = S.project.id;
  const newPath = $("rename-file-path").value.trim().replace(/\\/g, "/");
  if (!newPath) return;
  if (newPath === file.path) {
    $("rename-file-dialog").close();
    return;
  }
  $("rename-file-error").hidden = true;
  try {
    const res = await api(`/api/projects/${pid}/files/rename`, "POST", { path: file.path, new_path: newPath, version: file.version });
    $("rename-file-dialog").close();
    S.renamingFile = null;
    if (S.editor?.path === file.path) {
      if (S.editor.dirty) {
        S.editor.path = res.path;
        S.editor.version = res.version;
        renderEditor();
      } else {
        await openEditor(res.path, false);
      }
    }
    await refreshFiles();
    revealFileInTree(res.path);
    message("文件已重命名 / 移动");
  } catch (err) {
    $("rename-file-error").textContent = err.message;
    $("rename-file-error").hidden = false;
    if (err.status === 409) {
      await refreshFiles().catch(() => {});
      const latest = S.files.find(x => x.path === file.path);
      if (latest) S.renamingFile = latest;
    }
    throw err;
  }
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
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    const submitBtn = $("editor-submit");
    if (!submitBtn.hidden && !submitBtn.disabled) {
      e.preventDefault();
      submitBtn.click();
    }
    return;
  }
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
    await refreshSystemStatus().catch(() => {});
    setQueue(true);
    await openJob(job.id);
  } finally {
    S.submitting = false;
    renderEditor();
  }
}
$("rerun-job").onclick = guarded(() => {
  const job = S.detailJob || S.jobs.find(j => j.id === S.detail);
  if (job) return rerunJob(job);
});
$("view-snapshot").onclick = guarded(() => {
  if (S.detail) return openSnapshotDialog(S.detail);
});
$("outputs-archive").onclick = e => e.stopPropagation();
$("cancel-job").onclick = guarded(async () => {
  if (!await ask("取消这个任务？")) return;
  await api(`/api/jobs/${S.detail}/cancel`, "POST", {});
  await refreshJobs();
  await refreshSystemStatus().catch(() => {});
  message("已提交取消请求");
});

$("clear-console").onclick = () => {
  S.detail = null;
  S.detailJob = null;
  S.log = "";
  S.offset = 0;
  syncConsoleEmptyState();
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

function setProdAuthState(state, detail) {
  const panel = $("prod-auth-panel");
  if (!panel) return;
  panel.dataset.state = state;
  panel.querySelectorAll("[data-auth-view]").forEach(el => {
    el.hidden = el.dataset.authView !== state;
  });
  if (detail && $("prod-auth-detail")) {
    $("prod-auth-detail").textContent = detail;
  }
}

if ($("relogin-btn")) $("relogin-btn").onclick = () => location.reload();

function refreshRelativeTimes() {
  document.querySelectorAll("#jobs .job-rel-time[data-submitted]").forEach(el => {
    const next = relativeTime(Number(el.dataset.submitted));
    if (el.textContent !== next) el.textContent = next;
  });
}

async function boot() {
  S.config = await api("/api/config");
  $("preview-notice").hidden = true;
  $("user-menu").hidden = true;
  $("environment").replaceChildren();
  for (const [key, label] of Object.entries(S.config.environments)) {
    const o = node("option", label);
    o.value = key;
    $("environment").append(o);
  }
  const devSelect = Boolean(S.config.development && !S.config.password_auth);
  if ($("dev-login-panel")) $("dev-login-panel").hidden = !devSelect;
  if ($("prod-auth-panel")) $("prod-auth-panel").hidden = devSelect || Boolean(S.config.password_auth);
  if (!devSelect && !S.config.password_auth) {
    setProdAuthState("loading");
  }
  try {
    await enter();
  } catch (e) {
    if (S.config.password_auth) {
      if (e.status === 401) {
        location.replace("/login");
        return;
      }
      throw e;
    }
    if (!S.config.development) {
      if ($("login")) $("login").hidden = false;
      if (e.status === 403) {
        setProdAuthState("forbidden");
        return;
      }
      if (e.status === 401) {
        setProdAuthState("expired");
        return;
      }
      setProdAuthState("expired", e.message);
      return;
    }
    if (e.status !== 401) throw e;
  }
}

guarded(boot)();
setInterval(() => {
  if (S.me && !document.hidden) guarded(refreshJobs)();
}, 4000);
setInterval(() => {
  if (S.me && !document.hidden) {
    refreshRelativeTimes();
    refreshSystemStatus().catch(() => {});
  }
}, 30000);
