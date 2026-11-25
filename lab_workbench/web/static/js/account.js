// Login and registration page. Shares the workbench theme switcher (auto -> light -> dark).
import { initAccountBackdrop } from "./account-backdrop.js";
import { initTheme } from "./core/theme.js";

initTheme();
initAccountBackdrop(document.getElementById("account-backdrop"), document.querySelector(".password-card"));

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
    // Keep a shared workbench link (#/p/...) across the sign-in redirect.
    const destination = location.hash.startsWith("#/") ? "/" + location.hash : "/";
    location.replace(registering ? data.redirect : destination);
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
