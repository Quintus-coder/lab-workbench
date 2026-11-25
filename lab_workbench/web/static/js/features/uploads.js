// Chunked, resumable uploads and drag-and-drop.
import { api } from "../core/api.js";
import { $, node } from "../core/dom.js";
import { size } from "../core/format.js";
import { S } from "../core/state.js";
import { ask, guarded, message } from "../core/ui.js";
import { editorControls } from "./editor.js";
import { refreshFiles } from "./files.js";

export function renderTransfers() {
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

export function initUploads() {
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

  $("clear-transfers").onclick = () => {
    S.transfers = S.transfers.filter(
      t => !(t.pid === S.project?.id && t.owner === S.me?.id && ["已完成", "已跳过", "已放弃"].includes(t.phase))
    );
    renderTransfers();
  };

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
}
