"use strict";
try {
  const theme = localStorage.getItem("gc_theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch { /* Storage is optional for activation. */ }
const form = document.getElementById("activate-form");
if (form) form.addEventListener("submit", async event => {
  event.preventDefault();
  const name = form.elements.name.value.trim();
  const error = document.getElementById("activate-error");
  if (!name) { error.textContent = "请填写姓名。"; return; }
  const button = form.querySelector("button");
  button.disabled = true;
  error.textContent = "";
  try {
    const response = await fetch("/api/activate", {method: "POST", credentials: "same-origin",
      headers: {"Content-Type": "application/json", "X-Requested-With": "GroupCompute"},
      body: JSON.stringify({name})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "注册失败，请重试。");
    location.replace("/");
  } catch (e) {
    error.textContent = e.message;
    button.disabled = false;
  }
});
