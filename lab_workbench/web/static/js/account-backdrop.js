// Pointer-reactive backdrop for the login and register pages: a dot field in the light theme and a
// drifting compute-node network in the dark theme. Decorative only; the form never depends on it.

const LINK = 150;   // node-to-node link distance (px)
const REACH = 200;  // pointer influence radius for the node network (px)
const CARD_GAP = 70; // effects fade out within this distance of the card (px)

// Resolve a CSS color (hex, rgb, rgba) to channels by painting one pixel.
const probe = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
function channels(value) {
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = value.trim();
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return { r, g, b };
}
const rgba = (c, a) => `rgba(${c.r},${c.g},${c.b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

export function initAccountBackdrop(canvas, card) {
  const ctx = canvas?.getContext("2d");
  if (!ctx || !card) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, strength: 0, active: false, seen: false };
  const clicks = [];
  let W = 0, H = 0, dpr = 1, colors, effect, state, cardRect, frameId = 0, last = 0;

  function readColors() {
    const s = getComputedStyle(document.documentElement);
    const bg = channels(s.getPropertyValue("--chassis"));
    colors = {
      ink: channels(s.getPropertyValue("--ink-muted")),
      signal: channels(s.getPropertyValue("--signal")),
      dark: bg.r * 0.299 + bg.g * 0.587 + bg.b * 0.114 < 128
    };
  }

  // 0 inside the card, rising to 1 at CARD_GAP outside it.
  function cardFade(x, y) {
    const dx = Math.max(cardRect.left - x, 0, x - cardRect.right);
    const dy = Math.max(cardRect.top - y, 0, y - cardRect.bottom);
    return Math.min(1, Math.hypot(dx, dy) / CARD_GAP);
  }

  const dots = {
    init() {
      const gap = 24, list = [];
      for (let y = gap / 2; y < H; y += gap) for (let x = gap / 2; x < W; x += gap) list.push({ x, y, fade: cardFade(x, y) });
      return { list };
    },
    draw(t) {
      const { x: px, y: py, strength } = pointer;
      const hot = [];
      ctx.fillStyle = rgba(colors.ink, 0.26);
      ctx.beginPath();
      for (const d of state.list) {
        if (!d.fade) continue;
        const dx = d.x - px, dy = d.y - py, dist = Math.hypot(dx, dy) || 1;
        let f = strength * Math.exp(-(dist * dist) / (2 * 115 * 115));
        for (const c of clicks) {
          const age = (t - c.t) / 1000;
          const cd = Math.hypot(d.x - c.x, d.y - c.y);
          f = Math.max(f, Math.exp(-((cd - age * 460) ** 2) / (2 * 20 * 20)) * Math.max(0, 1 - age / 1.5));
        }
        const push = f * 11;
        const x = d.x + (dx / dist) * push, y = d.y + (dy / dist) * push;
        if (f < 0.04) {
          const wave = reduced.matches ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.0011 + d.x * 0.011 + d.y * 0.008);
          const r = 0.9 + wave * 0.35;
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        } else hot.push([x, y, f * d.fade]);
      }
      ctx.fill();
      for (const [x, y, f] of hot) {
        ctx.fillStyle = rgba(colors.signal, 0.25 + 0.75 * f);
        ctx.beginPath();
        ctx.arc(x, y, 1 + f * 2.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  const graph = {
    init() {
      const count = Math.max(28, Math.min(90, Math.round((W * H) / 21000)));
      const nodes = Array.from({ length: count }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.03, vy: (Math.random() - 0.5) * 0.03,
        r: 1.4 + Math.random() * 1.4, hot: Math.random() < 0.12, fade: 1, near: 0
      }));
      return { nodes, packets: [], nextPacket: 0 };
    },
    draw(t, dt) {
      const { nodes, packets } = state;
      const { x: px, y: py, strength } = pointer;
      const moving = !reduced.matches;
      for (const n of nodes) {
        if (moving) { n.x += n.vx * dt; n.y += n.vy * dt; }
        const dx = px - n.x, dy = py - n.y, d = Math.hypot(dx, dy);
        if (d < REACH && d > 1) {
          const pull = strength * 0.012 * dt * (1 - d / REACH);
          n.x += (dx / d) * pull; n.y += (dy / d) * pull;
        }
        if (n.x < -20) n.x = W + 20; else if (n.x > W + 20) n.x = -20;
        if (n.y < -20) n.y = H + 20; else if (n.y > H + 20) n.y = -20;
        n.fade = cardFade(n.x, n.y);
        n.near = d < REACH ? strength * (1 - d / REACH) : 0;
      }
      const edges = [];
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j], d = Math.hypot(a.x - b.x, a.y - b.y);
        const fade = Math.min(a.fade, b.fade);
        if (d > LINK || !fade) continue;
        edges.push([a, b]);
        const near = Math.max(a.near, b.near);
        ctx.strokeStyle = near > 0.05
          ? rgba(colors.signal, (1 - d / LINK) * (0.25 + 0.6 * near) * fade)
          : rgba(colors.ink, (1 - d / LINK) * 0.32 * fade);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      if (strength > 0.01) {
        for (const n of nodes) {
          const d = Math.hypot(px - n.x, py - n.y);
          if (d > REACH || !n.fade) continue;
          ctx.strokeStyle = rgba(colors.signal, (1 - d / REACH) * 0.7 * strength * n.fade);
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(n.x, n.y); ctx.stroke();
        }
      }
      if (moving && t > state.nextPacket && edges.length) {
        const [a, b] = edges[Math.floor(Math.random() * edges.length)];
        packets.push({ a, b, p: 0 });
        state.nextPacket = t + 260;
      }
      for (const n of nodes) {
        if (!n.fade) continue;
        const lit = n.hot || n.near > 0.2;
        if (lit) {
          ctx.fillStyle = rgba(colors.signal, 0.16 * n.fade);
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = lit ? rgba(colors.signal, 0.9 * n.fade) : rgba(colors.ink, 0.6 * n.fade);
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
      }
      for (let i = packets.length - 1; i >= 0; i--) {
        const k = packets[i];
        k.p += dt / 700;
        if (k.p >= 1) { packets.splice(i, 1); continue; }
        const x = k.a.x + (k.b.x - k.a.x) * k.p, y = k.a.y + (k.b.y - k.a.y) * k.p;
        ctx.fillStyle = rgba(colors.signal, 0.95 * cardFade(x, y));
        ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
      }
    }
  };

  function rebuild() {
    readColors();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cardRect = card.getBoundingClientRect();
    effect = colors.dark ? graph : dots;
    state = effect.init();
  }

  // Notices and errors resize the card, and small screens scroll it; keep the quiet zone around it.
  function trackCard() {
    cardRect = card.getBoundingClientRect();
    if (effect === dots) for (const d of state.list) d.fade = cardFade(d.x, d.y);
  }

  function frame(now) {
    const dt = Math.min(64, now - (last || now));
    last = now;
    const follow = 1 - Math.exp(-dt / 70);
    pointer.x += (pointer.tx - pointer.x) * follow;
    pointer.y += (pointer.ty - pointer.y) * follow;
    pointer.strength += ((pointer.active ? 1 : 0) - pointer.strength) * (1 - Math.exp(-dt / 260));
    while (clicks.length && now - clicks[0].t > 1600) clicks.shift();
    ctx.clearRect(0, 0, W, H);
    effect.draw(now, dt);
    card.style.setProperty("--cx", `${pointer.x - cardRect.left}px`);
    card.style.setProperty("--cy", `${pointer.y - cardRect.top}px`);
    card.style.setProperty("--spot", pointer.strength.toFixed(3));
    frameId = requestAnimationFrame(frame);
  }

  function start() {
    if (!frameId && !document.hidden) { last = 0; frameId = requestAnimationFrame(frame); }
  }
  function stop() {
    cancelAnimationFrame(frameId);
    frameId = 0;
  }

  addEventListener("pointermove", e => {
    pointer.tx = e.clientX; pointer.ty = e.clientY; pointer.active = true;
    if (!pointer.seen) { pointer.x = pointer.tx; pointer.y = pointer.ty; pointer.seen = true; }
  });
  document.documentElement.addEventListener("pointerleave", () => { pointer.active = false; });
  addEventListener("blur", () => { pointer.active = false; });
  addEventListener("pointerdown", e => {
    const target = e.target instanceof Element ? e.target : document.body;
    if (!card.contains(target) && !target.closest(".masthead")) clicks.push({ x: e.clientX, y: e.clientY, t: performance.now() });
  });
  addEventListener("resize", rebuild);
  addEventListener("scroll", trackCard, { passive: true });
  new ResizeObserver(trackCard).observe(card);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  // Theme switches (button or system) change both the palette and the effect.
  new MutationObserver(rebuild).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rebuild);

  card.classList.add("is-lit");
  rebuild();
  start();
}
