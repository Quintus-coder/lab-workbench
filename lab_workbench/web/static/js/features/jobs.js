// Job queue, history, job detail, snapshots and submission.
import { api } from "../core/api.js";
import { $, linkFor, node } from "../core/dom.js";
import { relativeTime, size, states, terminal } from "../core/format.js";
import { S } from "../core/state.js";
import { ask, copyText, guarded, message } from "../core/ui.js";
import { editorControls, renderEditor } from "./editor.js";
import { setQueue, setView, showConsole } from "./layout.js";
import { syncRoute } from "./router.js";
import { refreshSystemStatus, updateTelemetry } from "./status.js";

export function renderJobs() {
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

export async function refreshJobs(force = false) {
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

export async function openJob(id) {
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
  syncRoute();
  await refreshDetail();
}

export function closeJob() {
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

export async function queueScript(entry) {
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

export function refreshRelativeTimes() {
  document.querySelectorAll("#jobs .job-rel-time[data-submitted]").forEach(el => {
    const next = relativeTime(Number(el.dataset.submitted));
    if (el.textContent !== next) el.textContent = next;
  });
}

export function initJobs() {
  syncConsoleEmptyState();
  $("console-open-queue").onclick = () => setQueue(true);

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

  $("refresh-jobs").onclick = guarded(refreshJobs);
  $("all-jobs").onchange = guarded(refreshJobs);

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
    closeJob();
    syncRoute("replace");
  };
}
