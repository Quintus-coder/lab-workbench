// Admin member management dialog.
import { api } from "../core/api.js";
import { $, node } from "../core/dom.js";
import { S } from "../core/state.js";
import { ask, guarded } from "../core/ui.js";

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

export function initMembers() {
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
}
