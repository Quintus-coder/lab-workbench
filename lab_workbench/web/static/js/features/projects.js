// Project selection, usage and project management.
import { api } from "../core/api.js";
import { $, node } from "../core/dom.js";
import { size } from "../core/format.js";
import { S } from "../core/state.js";
import { ask, guarded, message } from "../core/ui.js";
import { openEditor, renderEditor } from "./editor.js";
import { refreshFiles, renderFiles } from "./files.js";
import { refreshJobs, renderJobs } from "./jobs.js";
import { setView } from "./layout.js";
import { refreshSystemStatus } from "./status.js";
import { renderTransfers } from "./uploads.js";

export function renderProjects() {
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

export function renderUsage() {
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

export async function selectProject(p) {
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

export function initProjects() {
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


  $("projects").onchange = guarded(async () => {
    const p = S.projects.find(p => p.id === $("projects").value);
    try { if (p && p.id !== S.project?.id) await selectProject(p); }
    finally { $("projects").value = S.project?.id || ""; }
  });
}
