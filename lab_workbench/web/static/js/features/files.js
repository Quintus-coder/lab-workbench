// Project file tree: listing, rename, delete.
import { api } from "../core/api.js";
import { $, buildRowMenu, node, svgIcon } from "../core/dom.js";
import { size } from "../core/format.js";
import { S } from "../core/state.js";
import { ask, guarded, message } from "../core/ui.js";
import { editorControls, openEditor, renderEditor } from "./editor.js";
import { renderUsage } from "./projects.js";
import { syncRoute } from "./router.js";
import { updateTelemetry } from "./status.js";
import { renderTransfers } from "./uploads.js";

export function revealFileInTree(path) {
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

export async function deleteProjectFile(file) {
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
    syncRoute("replace");
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
    syncRoute("replace");
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

export function renderFiles() {
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

export async function refreshFiles() {
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

export function initFiles() {
  $("file-filter").oninput = e => {
    S.fileFilter = e.target.value;
    renderFiles();
  };

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
      syncRoute("replace");
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

  $("refresh-files").onclick = guarded(refreshFiles);
}
