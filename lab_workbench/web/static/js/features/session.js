// Login, logout and startup.
import { api } from "../core/api.js";
import { $, node } from "../core/dom.js";
import { S } from "../core/state.js";
import { ask, guarded, message } from "../core/ui.js";
import { refreshJobs } from "./jobs.js";
import { consoleSize, setConsoleSize } from "./layout.js";
import { renderProjects, selectProject } from "./projects.js";
import { refreshSystemStatus } from "./status.js";

function syncRoleCards(value) {
  document.querySelectorAll(".role-card").forEach(btn => {
    const selected = btn.dataset.member === value;
    btn.setAttribute("aria-checked", String(selected));
    btn.tabIndex = selected ? 0 : -1;
  });
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

export async function boot() {
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

export function initSession() {
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

  if ($("relogin-btn")) $("relogin-btn").onclick = () => location.reload();
}
