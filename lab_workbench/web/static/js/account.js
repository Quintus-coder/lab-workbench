"use strict";

const THEME_MODES = [
  { key: "dark", label: "深色", icon: "#i-moon" },
  { key: "light", label: "浅色", icon: "#i-sun" }
];

function readAccountTheme() {
  try {
    const v = localStorage.getItem("gc_theme");
    if (v === "light" || v === "dark") return v;
  } catch { /* Storage is optional for login. */ }
  // Default login/register portal to dark-tech showcase without overwriting storage until toggled
  return "dark";
}

function renderAccountTheme(mode, persist = false) {
  const item = THEME_MODES.find(m => m.key === mode) || THEME_MODES[0];
  document.documentElement.dataset.theme = item.key;

  const icon = document.getElementById("account-theme-icon");
  const label = document.getElementById("account-theme-label");
  const btn = document.getElementById("account-theme-toggle");
  if (icon) icon.setAttribute("href", item.icon);
  if (label) label.textContent = item.label;
  if (btn) btn.title = `显示主题：${item.label}（点击切换）`;

  if (persist) {
    try {
      localStorage.setItem("gc_theme", item.key);
    } catch { /* Storage is optional for login. */ }
  }
}

renderAccountTheme(readAccountTheme(), false);
const themeToggle = document.getElementById("account-theme-toggle");
if (themeToggle) {
  themeToggle.onclick = () => {
    const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    renderAccountTheme(current === "dark" ? "light" : "dark", true);
  };
}

const accountForm = document.getElementById("account-form");
const registering = accountForm.dataset.mode === "register";
const accountError = document.getElementById("account-error");
const accountSubmit = document.getElementById("account-submit");
const accountSubmitLabel = document.getElementById("account-submit-label");

if (!registering && new URLSearchParams(location.search).get("registered") === "1") {
  document.getElementById("registration-notice").hidden = false;
  history.replaceState(null, "", "/login");
}

for (const toggle of accountForm.querySelectorAll(".password-control button")) {
  const input = document.getElementById(toggle.getAttribute("aria-controls"));
  const fieldName = input.labels[0].textContent;
  const textSpan = toggle.querySelector("span");
  const useIcon = toggle.querySelector("use");
  toggle.onclick = () => {
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    const actionText = visible ? "隐藏" : "显示";
    if (textSpan) textSpan.textContent = actionText;
    else toggle.textContent = actionText;
    if (useIcon) useIcon.setAttribute("href", visible ? "#i-eye-off" : "#i-eye");
    toggle.setAttribute("aria-label", actionText + fieldName);
    toggle.setAttribute("aria-pressed", String(visible));
  };
}

accountForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (accountSubmit.disabled) return;
  accountError.textContent = "";
  const fields = accountForm.elements;
  const body = { email: fields.email.value.trim(), password: fields.password.value };
  if (registering) {
    if (fields.confirm.value !== body.password) {
      accountError.textContent = "两次输入的密码不一致。";
      fields.confirm.focus();
      return;
    }
  } else {
    body.remember = fields.remember.checked;
  }
  const originalLabel = accountSubmitLabel ? accountSubmitLabel.textContent : accountSubmit.textContent;
  accountSubmit.disabled = true;
  accountSubmit.setAttribute("aria-busy", "true");
  if (accountSubmitLabel) accountSubmitLabel.textContent = registering ? "正在注册…" : "正在登录…";
  else accountSubmit.textContent = registering ? "正在注册…" : "正在登录…";
  try {
    const response = await fetch(registering ? "/register" : "/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      headers: { "Content-Type": "application/json", "X-Requested-With": "GroupCompute" },
      body: JSON.stringify(body)
    });
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("邮箱验证可能已过期，请刷新页面重新验证后再提交。");
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "操作未完成，请稍后再试。");
    fields.password.value = "";
    if (registering) fields.confirm.value = "";
    location.replace(registering ? data.redirect : "/");
  } catch (error) {
    accountError.textContent = error instanceof TypeError
      ? (registering ? "无法提交。请检查网络；若邮箱验证已过期，请刷新页面重新验证。" : "连接失败，请检查网络或稍后重试。")
      : error.message;
  } finally {
    accountSubmit.disabled = false;
    accountSubmit.removeAttribute("aria-busy");
    if (accountSubmitLabel) accountSubmitLabel.textContent = originalLabel;
    else accountSubmit.textContent = originalLabel;
  }
});
