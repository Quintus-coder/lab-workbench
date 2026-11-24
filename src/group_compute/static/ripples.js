"use strict";

(function initAccountBackdrop() {
  const canvas = document.getElementById("ripple-canvas");
  if (!canvas) return;

  const REVEAL_RADIUS = 150;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const glOpts = {
    alpha: true,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true
  };
  const gl2 = canvas.getContext("webgl2", glOpts);
  const gl = gl2 || canvas.getContext("webgl", glOpts) || canvas.getContext("experimental-webgl", glOpts);
  if (!gl) return;

  const CHARSET = ["○", ">", "_", "·"];
  const FONT_FAMILY = '"SF Mono", "Cascadia Mono", "JetBrains Mono", Consolas, "Liberation Mono", ui-monospace, monospace';

  const atlasCanvas = document.createElement("canvas");
  const atlasCtx = atlasCanvas.getContext("2d");
  if (!atlasCtx) return;
  const atlasTex = gl.createTexture();

  let dpr = 0;
  let tileW = 8;
  let tileH = 13;

  function measureGlyphBox(metrics, fallbackSize) {
    const hasLeft = Number.isFinite(metrics.actualBoundingBoxLeft);
    const hasRight = Number.isFinite(metrics.actualBoundingBoxRight);
    const left = hasLeft ? metrics.actualBoundingBoxLeft : 0;
    const right = hasRight ? metrics.actualBoundingBoxRight : metrics.width;
    let width = hasLeft && hasRight ? left + right : metrics.width || right;
    if (width === 0 && metrics.width) width = metrics.width;
    return {
      width,
      left,
      ascent: Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : fallbackSize * 0.78,
      descent: Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : fallbackSize * 0.22
    };
  }

  function rebuildGlyphAtlas() {
    const padX = Math.max(1, Math.round(1.0 * dpr));
    const padY = Math.max(1, Math.round(2.0 * dpr));
    const drawW = Math.max(5, Math.round(5.8 * dpr));
    const drawH = Math.max(9, Math.round(9.4 * dpr));
    tileW = drawW + padX * 2;
    tileH = drawH + padY * 2;

    atlasCanvas.width = tileW * CHARSET.length;
    atlasCanvas.height = tileH;
    atlasCtx.clearRect(0, 0, atlasCanvas.width, atlasCanvas.height);
    atlasCtx.fillStyle = "#000000";
    atlasCtx.fillRect(0, 0, atlasCanvas.width, atlasCanvas.height);
    atlasCtx.imageSmoothingEnabled = false;

    const basePx = drawH;
    atlasCtx.font = `500 ${basePx}px ${FONT_FAMILY}`;

    let maxW = 0;
    let maxAsc = 0;
    let maxDesc = 0;
    for (let i = 0; i < CHARSET.length; i++) {
      const m = measureGlyphBox(atlasCtx.measureText(CHARSET[i]), basePx);
      if (m.width > maxW) maxW = m.width;
      if (m.ascent > maxAsc) maxAsc = m.ascent;
      if (m.descent > maxDesc) maxDesc = m.descent;
    }

    const totalH = maxAsc + maxDesc;
    const scaleX = maxW > 0 ? (drawW * 0.94) / maxW : 1;
    const scaleY = totalH > 0 ? drawH / totalH : 1;
    const scale = Math.min(1.12, Math.max(0.72, Math.min(scaleX, scaleY)));
    const finalPx = basePx * scale;

    atlasCtx.font = `500 ${finalPx}px ${FONT_FAMILY}`;
    atlasCtx.fillStyle = "#ffffff";
    atlasCtx.textAlign = "left";
    atlasCtx.textBaseline = "alphabetic";

    const boxes = [];
    let asc = 0;
    let desc = 0;
    for (let i = 0; i < CHARSET.length; i++) {
      const m = measureGlyphBox(atlasCtx.measureText(CHARSET[i]), finalPx);
      boxes.push(m);
      if (m.ascent > asc) asc = m.ascent;
      if (m.descent > desc) desc = m.descent;
    }

    const baselineY = Math.round(padY + (drawH + asc - desc) * 0.5);
    for (let i = 0; i < CHARSET.length; i++) {
      const box = boxes[i];
      const gx = Math.round(i * tileW + padX + (drawW - box.width) * 0.5 + box.left);
      atlasCtx.fillText(CHARSET[i], gx, baselineY);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
  }

  const vsSource = `
    attribute vec2 aPos;
    void main() {
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  const fsSource = `
    precision highp float;
    uniform sampler2D uAtlas;
    uniform vec2 uTilePx;
    uniform vec2 uPointer;
    uniform float uPhysHeight;
    uniform float uDpr;
    uniform float uDark;
    uniform vec4 uCardRect;
    uniform vec4 uPillRect;

    float hash21(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float rectDistance(vec2 p, vec4 rect) {
      if (rect.z <= rect.x || rect.w <= rect.y) return 1e5;
      vec2 outside = max(max(rect.xy - p, p - rect.zw), 0.0);
      return length(outside);
    }

    void main() {
      vec2 px = vec2(gl_FragCoord.x, uPhysHeight - gl_FragCoord.y);
      vec2 cssPos = px / uDpr;
      float reveal = 1.0 - smoothstep(24.0, ${REVEAL_RADIUS.toFixed(1)}, distance(cssPos, uPointer));
      float safeMask = smoothstep(0.0, 68.0, rectDistance(cssPos, uCardRect))
        * smoothstep(0.0, 34.0, rectDistance(cssPos, uPillRect));

      vec2 cell = floor(px / uTilePx);
      vec2 subPx = px - cell * uTilePx;
      float glyph = 3.0 - floor(hash21(cell) * 3.99);
      vec2 atlasUv = vec2((glyph * uTilePx.x + subPx.x) / (uTilePx.x * ${CHARSET.length.toFixed(1)}), subPx.y / uTilePx.y);
      float ink = texture2D(uAtlas, atlasUv).r;
      vec3 color = mix(vec3(0.20, 0.33, 0.50), vec3(0.52, 0.67, 0.85), uDark);
      float baseOpacity = mix(0.16, 0.20, uDark) - 0.02 * glyph;
      float opacity = mix(baseOpacity, 0.55 - 0.08 * glyph, reveal);
      gl_FragColor = vec4(color, ink * opacity * safeMask);
    }
  `;

  function compileShader(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vs = compileShader(gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return;

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uTilePx = gl.getUniformLocation(prog, "uTilePx");
  const uPointer = gl.getUniformLocation(prog, "uPointer");
  const uPhysHeight = gl.getUniformLocation(prog, "uPhysHeight");
  const uDpr = gl.getUniformLocation(prog, "uDpr");
  const uDark = gl.getUniformLocation(prog, "uDark");
  const uCardRect = gl.getUniformLocation(prog, "uCardRect");
  const uPillRect = gl.getUniformLocation(prog, "uPillRect");
  gl.uniform1i(gl.getUniformLocation(prog, "uAtlas"), 0);

  const card = document.querySelector(".account-card");
  const pill = document.querySelector(".account-theme-pill");
  let pointerX = -1;
  let pointerY = -1;
  let idleTimer = 0;
  let frameId = 0;
  let hasEmphasis = false;

  function setIdlePointer() {
    gl.uniform2f(uPointer, -REVEAL_RADIUS, -REVEAL_RADIUS);
  }

  function restoreTexture() {
    if (!hasEmphasis) return;
    // The scissor box still covers the previous pointer position.
    setIdlePointer();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    hasEmphasis = false;
  }

  function hideReveal() {
    clearTimeout(idleTimer);
    cancelAnimationFrame(frameId);
    idleTimer = 0;
    frameId = 0;
    restoreTexture();
  }

  function resize() {
    hideReveal();
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
    if (nextDpr !== dpr || !atlasCanvas.width) {
      dpr = nextDpr;
      rebuildGlyphAtlas();
    }
    canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(uTilePx, tileW, tileH);
    gl.uniform1f(uPhysHeight, gl.drawingBufferHeight);
    gl.uniform1f(uDpr, dpr);
    drawBackground();
  }

  function setRectUniform(location, element) {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    gl.uniform4f(location, rect.left, rect.top, rect.right, rect.bottom);
  }

  function draw() {
    frameId = 0;
    restoreTexture();
    gl.uniform2f(uPointer, pointerX, pointerY);

    const radius = Math.ceil(REVEAL_RADIUS * dpr) + 1;
    const x = Math.floor(pointerX * dpr);
    const y = gl.drawingBufferHeight - Math.floor(pointerY * dpr);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x - radius, y - radius, radius * 2, radius * 2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    hasEmphasis = true;
  }

  function drawBackground() {
    hasEmphasis = false;
    gl.disable(gl.SCISSOR_TEST);
    setIdlePointer();
    gl.uniform1f(uDark, document.documentElement.dataset.theme === "light" ? 0 : 1);
    setRectUniform(uCardRect, card);
    setRectUniform(uPillRect, pill);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestDraw();
  }

  function requestDraw() {
    if (idleTimer && !frameId) frameId = requestAnimationFrame(draw);
  }

  window.addEventListener("pointermove", event => {
    if (event.pointerType !== "mouse" || reducedMotion.matches) return;
    if (event.clientX === pointerX && event.clientY === pointerY) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(hideReveal, 100);
    requestDraw();
  }, { passive: true });

  document.documentElement.addEventListener("pointerleave", hideReveal);
  window.addEventListener("blur", hideReveal);
  window.addEventListener("resize", resize);
  window.addEventListener("scroll", drawBackground, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hideReveal();
  });
  reducedMotion.addEventListener("change", hideReveal);
  new MutationObserver(drawBackground).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"]
  });

  if (card && typeof ResizeObserver === "function") {
    new ResizeObserver(drawBackground).observe(card);
  }

  resize();
})();
