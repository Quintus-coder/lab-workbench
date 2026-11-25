// Keeps the address bar in step with the open project, file, job and view:
//   #/p/<project>/f/<file path>?job=<job>&view=history
// Navigation pushes a history entry; corrections and restores replace the current one.
import { S } from "../core/state.js";
import { ask, guarded, message } from "../core/ui.js";
import { openEditor, renderEditor } from "./editor.js";
import { closeJob, openJob } from "./jobs.js";
import { setView } from "./layout.js";
import { selectProject } from "./projects.js";

let restoring = 0;
let queue = Promise.resolve();

function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseRoute(hash) {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const match = /^\/p\/([^/]+)(?:\/f\/(.+))?$/.exec(path);
  const segments = match?.[2] ? match[2].split("/").map(decode) : [];
  return {
    project: match ? decode(match[1]) : null,
    file: segments.length && !segments.includes(null) ? segments.join("/") : null,
    job: params.get("job"),
    view: params.get("view") === "history" ? "history" : "workspace"
  };
}

export function routeFromState() {
  let path = "/";
  if (S.project) {
    path = "/p/" + encodeURIComponent(S.project.id);
    // A new file has no address until it is saved.
    if (S.editor && S.editor.version !== null) path += "/f/" + S.editor.path.split("/").map(encodeURIComponent).join("/");
  }
  const params = new URLSearchParams();
  if (S.detail) params.set("job", S.detail);
  if (S.view === "history") params.set("view", "history");
  const query = params.toString();
  return "#" + path + (query ? "?" + query : "");
}

export function syncRoute(mode = "push") {
  if (!S.me) return;
  const hash = routeFromState();
  if (hash === location.hash) return;
  const url = location.pathname + location.search + hash;
  if (restoring || mode === "replace" || !location.hash) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}

async function closeEditorForRoute() {
  if (!S.editor || S.editor.version === null) return;
  if (S.editor.dirty && !await ask("当前文件有未保存的修改，放弃修改并返回？")) return;
  S.editor = null;
  renderEditor();
}

async function restore() {
  const route = parseRoute(location.hash);
  restoring++;
  try {
    const linked = route.project && S.projects.find(p => p.id === route.project);
    const project = linked || S.project || S.projects[0];
    if (route.project && !linked) message(`链接中的项目不存在或无权访问${project ? "，已打开其他项目" : ""}。`, true);
    // The file part only means something inside the project it was linked from.
    const file = linked ? route.file : null;
    if (project && project.id !== S.project?.id) {
      await selectProject(project, { file });
    } else if (linked && file && file !== S.editor?.path) {
      if (S.files.some(f => f.path === file)) await openEditor(file, false);
      else message("链接中的文件不存在，可能已被移动或删除。", true);
    } else if (linked && !file) {
      await closeEditorForRoute();
    }
    if (route.job && route.job !== S.detail) {
      try {
        await openJob(route.job);
      } catch (error) {
        closeJob();
        message(`无法打开链接中的任务：${error.message}`, true);
      }
    } else if (!route.job && S.detail) {
      closeJob();
    }
    // openJob shows the workspace; the history view can still sit on top of an open job.
    setView(route.view);
  } finally {
    restoring--;
    syncRoute("replace");
  }
}

// Restores run one at a time so quick back/forward presses settle on the last entry.
export function applyRoute() {
  queue = queue.catch(() => {}).then(restore);
  return queue;
}

export function initRouter() {
  window.addEventListener("popstate", guarded(() => S.me ? applyRoute() : undefined));
}
