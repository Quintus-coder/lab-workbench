// Notifications, confirmations, error guards and shared menu/dialog behavior.
import { $ } from "./dom.js";

export async function copyText(text, okMessage) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    message(okMessage);
  } else {
    throw new Error("当前浏览器不支持自动复制，请手动复制。");
  }
}

let messageTimer;
export function message(text, error = false) {
  clearTimeout(messageTimer);
  const box = $("message");
  box.dataset.tone = error ? "error" : "info";
  $("message-icon").setAttribute("href", error ? "#i-alert" : "#i-check");
  $("message-text").textContent = text;
  box.hidden = false;
  if (!error) messageTimer = setTimeout(() => { box.hidden = true; }, 5000);
}

export function guarded(fn) {
  return async (...args) => {
    const event = args[0] instanceof Event ? args[0] : null;
    const button = event?.submitter || (event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null);
    if (button?.getAttribute("aria-busy") === "true") { event.preventDefault(); return; }
    button?.setAttribute("aria-busy", "true");
    try {
      await fn(...args);
    } catch (e) {
      message(e.message, true);
    } finally {
      button?.removeAttribute("aria-busy");
    }
  };
}

export function ask(text, options = {}) {
  return new Promise(resolve => {
    const d = $("confirm-dialog");
    const wrap = $("confirm-match-wrap");
    const input = $("confirm-match-input");
    const yes = $("confirm-yes");
    const expect = options.expect || "";
    $("confirm-message").textContent = text;
    if (expect) {
      $("confirm-match-label").textContent = `请输入“${expect}”以确认`;
      input.value = "";
      input.placeholder = expect;
      wrap.hidden = false;
      yes.disabled = true;
      input.oninput = () => { yes.disabled = input.value.trim() !== expect; };
    } else {
      wrap.hidden = true;
      input.value = "";
      input.oninput = null;
      yes.disabled = false;
    }
    d.returnValue = "";
    d.addEventListener("close", () => {
      const confirmed = d.returnValue === "yes" && (!expect || input.value.trim() === expect);
      wrap.hidden = true;
      input.value = "";
      input.oninput = null;
      yes.disabled = false;
      resolve(confirmed);
    }, { once: true });
    d.showModal();
    if (expect) input.focus();
  });
}

export function initUi() {
  $("message-close").onclick = () => {
    clearTimeout(messageTimer);
    $("message").hidden = true;
  };

  $("dismiss-notice").onclick = () => {
    $("preview-notice").hidden = true;
  };

  // Native disclosure buttons retain keyboard support; dismiss contextual actions after use.
  document.addEventListener("click", event => {
    document.querySelectorAll(".action-menu[open]").forEach(menu => {
      if (!menu.contains(event.target)) menu.open = false;
      else if (event.target.closest("button, a")) {
        menu.open = false;
        if (!document.querySelector("dialog[open]")) menu.querySelector("summary").focus();
      }
    });
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    document.querySelectorAll(".action-menu[open]").forEach(menu => {
      menu.open = false;
      menu.querySelector("summary").focus();
      event.preventDefault();
    });
  });
  document.querySelectorAll("button[aria-label]").forEach(button => {
    if (!button.title) button.title = button.getAttribute("aria-label");
  });

  document.querySelectorAll(".close-dialog").forEach(b => b.onclick = () => b.closest("dialog").close());
}
