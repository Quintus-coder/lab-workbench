// Status bar telemetry and system status.
import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import { size, terminal } from "../core/format.js";
import { S } from "../core/state.js";

export function updateTelemetry() {
  const waiting = S.jobs.filter(j => !terminal(j.state)).length;
  const parts = [];
  if (S.project) parts.push(`${S.files.length} 个文件`);
  if (S.editor) parts.push(`${S.editor.path.split("/").pop()}${S.editor.dirty ? " · 未保存" : ""}`);
  parts.push(`等待队列 ${waiting}`);
  $("workspace-telemetry").textContent = parts.join(" · ");
}

export async function refreshSystemStatus() {
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
