"use strict";
const statusLine = document.getElementById("office-status");
let changed = false;
let editor;
let polling;
let editorError = false;
function report(text, error = false) {
  statusLine.textContent = text;
  statusLine.dataset.error = String(error);
}
async function request(url, body) {
  const options = {credentials: "same-origin"};
  if (body) Object.assign(options, {method: "POST", headers: {"Content-Type": "application/json", "X-Requested-With": "GroupCompute"}, body: JSON.stringify(body)});
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "文档请求失败");
  return data;
}
async function start() {
  const params = new URLSearchParams(location.search);
  const project = params.get("project"), path = params.get("path");
  if (!project || !path) throw new Error("缺少项目或文件路径，请从工作区重新打开文档。");
  document.getElementById("office-title").textContent = path;
  const session = await request(`/api/projects/${encodeURIComponent(project)}/office`, {path});
  const download = document.getElementById("office-download");
  download.href = `/api/projects/${encodeURIComponent(project)}/download?${new URLSearchParams({path})}`;
  download.hidden = false;
  let revision = (await request(`/api/office/sessions/${session.id}`)).revision;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = session.api_url;
    script.onload = resolve;
    script.onerror = () => reject(new Error("无法连接文档服务，请确认服务器部署与网络配置。"));
    document.head.append(script);
  });
  session.config.events = {
    onDocumentReady: () => report("编辑器已就绪。修改后请点击编辑器内的保存按钮。"),
    onDocumentStateChange: event => {
      if (event.data) {
        changed = true;
        report("有编辑操作；请保存并等待项目回写确认。");
      }
      // false only confirms the document service cache, not project persistence.
    },
    onError: event => {
      editorError = true;
      report(`文档编辑器错误（${event.data?.errorCode ?? "未知"}）。请保留页面，必要时从编辑器下载副本。`, true);
    }
  };
  editor = new DocsAPI.DocEditor("office-editor", session.config);
  let failures = 0;
  async function poll() {
    try {
      const state = await request(`/api/office/sessions/${session.id}`);
      failures = 0;
      if (state.error) report(state.error, true);
      else if (state.revision > revision) {
        revision = state.revision;
        report(`已写回项目 · 第 ${revision} 次保存。若之后继续修改，请再次保存。`);
        // Keep the unload reminder: a callback can belong to an earlier edit.
      } else if (!state.active && !editorError) {
        report("文档会话已结束，请关闭此页并从工作区重新打开。");
      }
    } catch (error) {
      if (++failures >= 2) report("无法确认项目保存状态，请保留页面并检查连接。", true);
    }
    polling = setTimeout(poll, 2500);
  }
  polling = setTimeout(poll, 2500);
}
window.addEventListener("beforeunload", event => {
  if (changed) {event.preventDefault(); event.returnValue = "";}
});
window.addEventListener("pagehide", () => {clearTimeout(polling); editor?.destroyEditor();});
start().catch(error => report(error.message, true));
