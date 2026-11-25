// Text editor and document/image/PDF preview.
import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import { size } from "../core/format.js";
import { S } from "../core/state.js";
import { ask, guarded, message } from "../core/ui.js";
import { deleteProjectFile, refreshFiles, revealFileInTree } from "./files.js";
import { queueScript } from "./jobs.js";
import { readingLayout, setConsoleCollapsed, setView } from "./layout.js";
import { updateTelemetry } from "./status.js";

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;

let consoleBeforePdf = null;

function editorLines() {
  $("editor-lines").textContent = $("editor-text").value.split("\n").map((_, i) => i + 1).join("\n");
  $("editor-lines").scrollTop = $("editor-text").scrollTop;
}

export function editorControls() {
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

export function renderEditor() {
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

export async function openEditor(path, reveal = true) {
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

export function initEditor() {
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

  $("editor-delete").onclick = guarded(() => deleteProjectFile(S.editor));

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
}
