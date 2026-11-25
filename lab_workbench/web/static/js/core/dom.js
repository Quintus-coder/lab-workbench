// DOM lookup and element builders.

export const $ = id => document.getElementById(id);

export function node(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

export function svgIcon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", id);
  svg.append(use);
  return svg;
}

export function linkFor(path, text, iconId) {
  const a = node("a");
  a.href = path;
  if (iconId) a.append(svgIcon(iconId));
  a.append(node("span", text));
  return a;
}

export function buildRowMenu(label, items) {
  const menu = node("details", undefined, "action-menu row-menu");
  const summary = node("summary", undefined, "icon-control");
  summary.setAttribute("aria-label", label);
  summary.title = label;
  summary.append(svgIcon("#i-more"));
  const popover = node("div", undefined, "action-popover align-right");
  for (const item of items) {
    if (item.href) {
      const a = linkFor(item.href, item.text, item.icon);
      a.className = "menu-link";
      popover.append(a);
    } else {
      const b = node("button", undefined, item.danger ? "quiet danger" : "quiet");
      b.type = "button";
      if (item.icon) b.append(svgIcon(item.icon));
      b.append(node("span", item.text));
      b.onclick = item.onclick;
      popover.append(b);
    }
  }
  menu.append(summary, popover);
  return menu;
}
