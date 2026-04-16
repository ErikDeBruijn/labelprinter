// Labelprinter — client-side canvas designer
// Document model: list of elements rendered to <canvas>. Canvas pixels == print pixels (300 DPI).

const DPI = 300;
const MM_PER_INCH = 25.4;
const mmPx = (mm) => Math.round((mm * DPI) / MM_PER_INCH);
const pxMm = (px) => (px * MM_PER_INCH) / DPI;

// Brother QL-570 printable widths per media width (mm)
const PRINTABLE_PX = { 62: 696, 29: 306, 38: 413 };

// Embed/simple modes (for iframe use from other apps like Dendrobase)
const _embedParams = new URLSearchParams(location.search);
const EMBED_MODE = _embedParams.get("embed") === "1";
const SIMPLE_MODE = _embedParams.get("simple") === "1";
if (EMBED_MODE) document.body.classList.add("embed-mode");
if (SIMPLE_MODE) {
  document.body.classList.add("simple-mode");
  // Move the Print button out of the topbar (hidden in simple mode) to body level
  // so the floating position works. Module scripts run after DOMContentLoaded.
  const _btn = document.getElementById("btnPrint");
  if (_btn) document.body.appendChild(_btn);
}

const state = {
  label: { width_mm: 62, height_mm: 30, border: false, border_mm: 0.3 },
  elements: [],
  selectedId: null,
  zoom: 1, // CSS scale
  tool: "select",
  printer: { has_media: false, width_mm: null, type: "?" },
};

let uidCounter = 1;
const uid = () => `el${uidCounter++}`;

// QR images are server-rendered via /qr?data=... for consistency with print output.
const qrCache = new Map(); // data -> HTMLImageElement (loaded)

function getQrImage(data, sizePx) {
  const key = `${data}|${sizePx}`;
  if (qrCache.has(key)) return qrCache.get(key);
  const img = new Image();
  img.dataset.loading = "1";
  img.onload = () => { img.dataset.loading = ""; draw(); };
  img.src = `/qr?data=${encodeURIComponent(data)}&size=${sizePx}`;
  qrCache.set(key, img);
  return img;
}

// ============ Canvas rendering ============
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const canvasWrap = document.getElementById("canvasWrap");
const handlesLayer = document.getElementById("handles");
const sizeIndicator = document.getElementById("sizeIndicator");

function resizeCanvas() {
  const pxW = PRINTABLE_PX[state.label.width_mm] || mmPx(state.label.width_mm);
  const pxH = mmPx(state.label.height_mm);
  canvas.width = pxW;
  canvas.height = pxH;
  // CSS-scale to fit view (zoom * display scale). Display px per canvas px:
  applyZoom();
  sizeIndicator.textContent = `${state.label.width_mm} × ${state.label.height_mm} mm  ·  ${pxW} × ${pxH} px @ 300 DPI`;
}

function applyZoom() {
  const pxW = canvas.width;
  const pxH = canvas.height;
  // 1 canvas-px = (1mm/DPI_scale) CSS px. We'll display at ~2.5x so 62mm becomes readable.
  // Base "100%" = 3x canvas-mm display size.
  const cssPerPx = (3 * state.zoom);
  const w = Math.round(pxW * cssPerPx / (DPI / 72) * (72/96)); // not quite right
  // Simpler: CSS size in mm at "100%" = label physical size * zoom.
  // At zoom=1, display 1mm as 3.78 CSS px (≈ 96 DPI). We'll go bigger.
  const displayMmToCssPx = 3.78 * 2.5 * state.zoom;
  canvas.style.width = `${state.label.width_mm * displayMmToCssPx}px`;
  canvas.style.height = `${state.label.height_mm * displayMmToCssPx}px`;
  canvasWrap.style.width = canvas.style.width;
  canvasWrap.style.height = canvas.style.height;
  document.getElementById("zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
  drawHandles();
}

function draw() {
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const el of state.elements) drawElement(el);
  if (state.label.border) {
    const w = Math.max(1, mmPx(state.label.border_mm));
    ctx.strokeStyle = "black";
    ctx.lineWidth = w;
    const half = w / 2;
    ctx.strokeRect(half, half, canvas.width - w, canvas.height - w);
  }
}

function drawElement(el) {
  if (el.id === inlineEditingId) return; // hidden while editing inline
  if (el.type === "text") {
    const sizePx = Math.round((el.size_pt * DPI) / 72);
    const style = `${el.italic ? "italic " : ""}${el.bold ? "700 " : "400 "}${sizePx}px ${el.font || "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"}`;
    ctx.font = style;
    ctx.fillStyle = "black";
    ctx.textBaseline = "top";
    // Word-wrap within el.width
    const lines = wrapText(el.text, el.width - 4);
    let y = el.y;
    const lineH = sizePx * 1.2;
    for (const line of lines) {
      ctx.fillText(line, el.x, y);
      y += lineH;
      if (y > el.y + el.height) break;
    }
    el.height = Math.max(lineH * lines.length, lineH);
  } else if (el.type === "rect") {
    const sw = Math.max(1, mmPx(el.stroke_mm || 0.3));
    if (el.fill) {
      ctx.fillStyle = el.fill_color || "black";
      ctx.fillRect(el.x, el.y, el.width, el.height);
    }
    if (el.stroke !== false) {
      ctx.strokeStyle = el.stroke_color || "black";
      ctx.lineWidth = sw;
      ctx.strokeRect(el.x + sw / 2, el.y + sw / 2, el.width - sw, el.height - sw);
    }
  } else if (el.type === "line") {
    const sw = Math.max(1, mmPx(el.stroke_mm || 0.3));
    ctx.strokeStyle = "black";
    ctx.lineWidth = sw;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(el.x1, el.y1);
    ctx.lineTo(el.x2, el.y2);
    ctx.stroke();
  } else if (el.type === "qr") {
    const size = Math.min(el.width, el.height);
    el.width = size; el.height = size;
    ctx.fillStyle = "white";
    ctx.fillRect(el.x, el.y, size, size);
    const img = getQrImage(el.data || " ", Math.max(64, Math.min(512, Math.round(size))));
    if (img.complete && !img.dataset.loading) {
      ctx.drawImage(img, el.x, el.y, size, size);
    } else {
      // Loading placeholder
      ctx.strokeStyle = "#ccc"; ctx.lineWidth = 2;
      ctx.strokeRect(el.x + 1, el.y + 1, size - 2, size - 2);
      ctx.fillStyle = "#999"; ctx.font = "14px system-ui";
      ctx.textBaseline = "middle"; ctx.textAlign = "center";
      ctx.fillText("QR…", el.x + size/2, el.y + size/2);
      ctx.textAlign = "start";
    }
  }
}

function wrapText(text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const tryLine = cur ? cur + " " + w : w;
    const width = ctx.measureText(tryLine).width;
    if (width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = tryLine;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// ============ Selection & handles ============
// Handle DOM is kept stable across redraws — only positions are updated.
let _selBox = null;
let _handleBR = null;
let _handleP1 = null;
let _handleP2 = null;

function ensureHandleDom() {
  if (_selBox) return;
  _selBox = document.createElement("div"); _selBox.className = "sel-box";
  handlesLayer.appendChild(_selBox);
  _handleBR = document.createElement("div"); _handleBR.className = "handle"; _handleBR.dataset.handle = "br";
  handlesLayer.appendChild(_handleBR); bindResize(_handleBR);
  _handleP1 = document.createElement("div"); _handleP1.className = "handle"; _handleP1.dataset.handle = "p1";
  _handleP1.style.cursor = "move";
  handlesLayer.appendChild(_handleP1); bindEndpointDrag(_handleP1, "1");
  _handleP2 = document.createElement("div"); _handleP2.className = "handle"; _handleP2.dataset.handle = "p2";
  _handleP2.style.cursor = "move";
  handlesLayer.appendChild(_handleP2); bindEndpointDrag(_handleP2, "2");
}

function drawHandles() {
  ensureHandleDom();
  if (!state.selectedId) {
    _selBox.style.display = _handleBR.style.display = _handleP1.style.display = _handleP2.style.display = "none";
    return;
  }
  const el = state.elements.find(e => e.id === state.selectedId);
  if (!el) return;
  const sx = canvas.clientWidth / canvas.width;
  const sy = canvas.clientHeight / canvas.height;

  if (el.type === "line") {
    _selBox.style.display = _handleBR.style.display = "none";
    _handleP1.style.display = _handleP2.style.display = "block";
    _handleP1.style.left = (el.x1 * sx - 5) + "px"; _handleP1.style.top = (el.y1 * sy - 5) + "px";
    _handleP2.style.left = (el.x2 * sx - 5) + "px"; _handleP2.style.top = (el.y2 * sy - 5) + "px";
    return;
  }

  _selBox.style.display = _handleBR.style.display = "block";
  _handleP1.style.display = _handleP2.style.display = "none";
  _selBox.style.left = (el.x * sx) + "px";
  _selBox.style.top = (el.y * sy) + "px";
  _selBox.style.width = (el.width * sx) + "px";
  _selBox.style.height = (el.height * sy) + "px";
  _handleBR.style.left = ((el.x + el.width) * sx - 5) + "px";
  _handleBR.style.top = ((el.y + el.height) * sy - 5) + "px";
}

function bindEndpointDrag(handle, which) {
  handle.addEventListener("pointerdown", (ev) => {
    const el = state.elements.find(e => e.id === state.selectedId);
    if (!el || el.type !== "line") return;
    ev.preventDefault(); ev.stopPropagation();
    handle.setPointerCapture(ev.pointerId);
    const xKey = "x" + which, yKey = "y" + which;
    const otherKey = which === "1" ? ["x2", "y2"] : ["x1", "y1"];
    const start = { x: ev.clientX, y: ev.clientY, ex: el[xKey], ey: el[yKey] };
    const sx = canvas.clientWidth / canvas.width;
    const sy = canvas.clientHeight / canvas.height;
    const onMove = (e) => {
      let nx = Math.max(0, Math.min(canvas.width, start.ex + (e.clientX - start.x) / sx));
      let ny = Math.max(0, Math.min(canvas.height, start.ey + (e.clientY - start.y) / sy));
      if (e.shiftKey) {
        // Snap to nearest 45° angle relative to the other endpoint, preserving length
        const [oxk, oyk] = otherKey;
        const fx = el[oxk], fy = el[oyk];
        const dx = nx - fx, dy = ny - fy;
        const len = Math.hypot(dx, dy);
        const step = Math.PI / 4;
        const snapAng = Math.round(Math.atan2(dy, dx) / step) * step;
        nx = fx + Math.cos(snapAng) * len;
        ny = fy + Math.sin(snapAng) * len;
      }
      el[xKey] = nx; el[yKey] = ny;
      draw(); drawHandles(); renderSelProps();
    };
    const onUp = () => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}

function bindResize(handle) {
  handle.addEventListener("pointerdown", (ev) => {
    const el = state.elements.find(e => e.id === state.selectedId);
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    handle.setPointerCapture(ev.pointerId);
    const start = { x: ev.clientX, y: ev.clientY, w: el.width, h: el.height };
    const sx = canvas.clientWidth / canvas.width;
    const sy = canvas.clientHeight / canvas.height;
    const onMove = (e) => {
      const dx = (e.clientX - start.x) / sx;
      const dy = (e.clientY - start.y) / sy;
      if (el.type === "qr") {
        const nw = Math.max(20, Math.max(start.w + dx, start.h + dy));
        el.width = el.height = nw;
      } else {
        el.width = Math.max(20, start.w + dx);
        el.height = Math.max(20, start.h + dy);
      }
      draw(); drawHandles(); renderSelProps();
    };
    const onUp = () => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}

// ============ Canvas interaction ============
function canvasCoords(ev) {
  const r = canvas.getBoundingClientRect();
  const x = ((ev.clientX - r.left) / r.width) * canvas.width;
  const y = ((ev.clientY - r.top) / r.height) * canvas.height;
  return { x, y };
}

function hitTest(x, y) {
  for (let i = state.elements.length - 1; i >= 0; i--) {
    const el = state.elements[i];
    if (el.type === "line") {
      // Distance from point to line segment
      const tol = Math.max(8, mmPx(el.stroke_mm || 0.3) + 6);
      const dx = el.x2 - el.x1, dy = el.y2 - el.y1;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - el.x1) * dx + (y - el.y1) * dy) / len2));
      const px = el.x1 + t * dx, py = el.y1 + t * dy;
      if (Math.hypot(x - px, y - py) < tol) return el;
    } else {
      if (x >= el.x && y >= el.y && x <= el.x + el.width && y <= el.y + el.height) return el;
    }
  }
  return null;
}

// ============ Inline text editor ============
let inlineEditor = null;
let inlineEditingId = null;

function startInlineEdit(el, opts = {}) {
  if (el.type !== "text") return;
  endInlineEdit();
  inlineEditingId = el.id;
  const placeholderMode = !!opts.placeholderMode;
  const sx = canvas.clientWidth / canvas.width;
  const sy = canvas.clientHeight / canvas.height;
  const sizeCss = (el.size_pt * DPI / 72) * sx;
  const ed = document.createElement("div");
  ed.className = "inline-editor";
  ed.contentEditable = "plaintext-only";
  ed.spellcheck = false;
  ed.textContent = el.text;
  Object.assign(ed.style, {
    position: "absolute",
    left: (el.x * sx) + "px",
    top: (el.y * sy) + "px",
    minWidth: (el.width * sx) + "px",
    maxWidth: (el.width * sx) + "px",
    font: `${el.italic ? "italic " : ""}${el.bold ? "700 " : "400 "}${sizeCss}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`,
    lineHeight: "1.2",
    color: "black",
    background: "rgba(255,255,255,0.95)",
    outline: "2px solid var(--primary)",
    outlineOffset: "0",
    padding: "0",
    margin: "0",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    zIndex: "50",
    cursor: "text",
  });
  canvasWrap.appendChild(ed);
  ed.focus();
  const range = document.createRange();
  if (opts.selectRange && ed.firstChild) {
    const [s, e2] = opts.selectRange;
    range.setStart(ed.firstChild, Math.min(s, ed.firstChild.length));
    range.setEnd(ed.firstChild, Math.min(e2, ed.firstChild.length));
  } else {
    range.selectNodeContents(ed);
  }
  const sel = getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  inlineEditor = ed;

  if (placeholderMode) {
    // Hint label above the editor
    const hint = document.createElement("div");
    hint.className = "placeholder-hint";
    const ph = findRemainingPlaceholders().find(p => p.elId === el.id);
    hint.textContent = ph ? `Tab voor volgende · ${ph.name}` : "Tab voor volgende";
    const rect = ed.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    hint.style.left = (rect.left - wrapRect.left) + "px";
    hint.style.top = (rect.top - wrapRect.top - 28) + "px";
    canvasWrap.appendChild(hint);
    ed._hintEl = hint;
  }

  ed.addEventListener("input", () => {
    const target = state.elements.find(x => x.id === inlineEditingId);
    if (target) { target.text = ed.textContent; draw(); refreshLayers(); }
  });
  ed.addEventListener("keydown", (kev) => {
    if (kev.key === "Tab") {
      kev.preventDefault();
      endInlineEdit();
      const remaining = findRemainingPlaceholders();
      if (remaining.length) {
        const idx = kev.shiftKey ? remaining.length - 1 : 0;
        const p = remaining[idx];
        const target = state.elements.find(x => x.id === p.elId);
        if (target) {
          state.selectedId = target.id;
          drawHandles(); refreshLayers();
          startInlineEdit(target, { selectRange: [p.start, p.end], placeholderMode: true });
        }
      }
      return;
    }
    if (kev.key === "Enter" && !kev.shiftKey) { kev.preventDefault(); endInlineEdit(); }
    if (kev.key === "Escape") { kev.preventDefault(); endInlineEdit(); }
  });
  ed.addEventListener("blur", () => endInlineEdit());
}

function endInlineEdit() {
  if (!inlineEditor) return;
  if (inlineEditor._hintEl) inlineEditor._hintEl.remove();
  inlineEditor.remove();
  inlineEditor = null;
  inlineEditingId = null;
  draw(); drawHandles(); renderSelProps();
}

canvas.addEventListener("dblclick", (ev) => {
  const { x, y } = canvasCoords(ev);
  const hit = hitTest(x, y);
  if (hit && hit.type === "text") {
    state.selectedId = hit.id;
    renderSelProps(); refreshLayers(); drawHandles();
    startInlineEdit(hit);
  }
});

canvas.addEventListener("pointerdown", (ev) => {
  const { x, y } = canvasCoords(ev);
  document.getElementById("mouseCoord").textContent = `${pxMm(x).toFixed(1)}, ${pxMm(y).toFixed(1)} mm`;
  if (state.tool === "text") {
    addElement({ type: "text", text: "Tekst", x, y, width: 200, height: 40, size_pt: 14, bold: false, italic: false });
    setTool("select");
  } else if (state.tool === "qr") {
    addElement({ type: "qr", data: "https://example.com", x, y, width: 120, height: 120 });
    setTool("select");
  } else if (state.tool === "rect") {
    addElement({ type: "rect", x, y, width: mmPx(15), height: mmPx(10), stroke_mm: 0.3, stroke: true, fill: false });
    setTool("select");
  } else if (state.tool === "line") {
    addElement({ type: "line", x1: x, y1: y, x2: x + mmPx(20), y2: y, stroke_mm: 0.3 });
    setTool("select");
  } else {
    const hit = hitTest(x, y);
    state.selectedId = hit ? hit.id : null;
    renderSelProps();
    refreshLayers();
    drawHandles();
    if (hit) startDrag(ev, hit, x, y);
  }
});

function startDrag(ev, el, startX, startY) {
  canvas.setPointerCapture(ev.pointerId);
  const isLine = el.type === "line";
  const offset = isLine
    ? { dx1: startX - el.x1, dy1: startY - el.y1, dx2: startX - el.x2, dy2: startY - el.y2 }
    : { x: startX - el.x, y: startY - el.y };
  const onMove = (e) => {
    const { x, y } = canvasCoords(e);
    if (isLine) {
      el.x1 = x - offset.dx1; el.y1 = y - offset.dy1;
      el.x2 = x - offset.dx2; el.y2 = y - offset.dy2;
      document.getElementById("mouseCoord").textContent = `${pxMm(el.x1).toFixed(1)}, ${pxMm(el.y1).toFixed(1)} → ${pxMm(el.x2).toFixed(1)}, ${pxMm(el.y2).toFixed(1)}`;
    } else {
      // Allow elements to extend past the canvas edges — render clips naturally.
      // Keep at least ~10 CSS px of the element visible so it isn't lost off-canvas.
      const minVisible = 30; // canvas pixels
      el.x = Math.max(minVisible - el.width, Math.min(canvas.width - minVisible, x - offset.x));
      el.y = Math.max(minVisible - el.height, Math.min(canvas.height - minVisible, y - offset.y));
      document.getElementById("mouseCoord").textContent = `${pxMm(el.x).toFixed(1)}, ${pxMm(el.y).toFixed(1)} mm`;
    }
    draw(); drawHandles(); renderSelProps();
  };
  const onUp = () => {
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
}

canvas.addEventListener("pointermove", (ev) => {
  const { x, y } = canvasCoords(ev);
  document.getElementById("mouseCoord").textContent = `${pxMm(x).toFixed(1)}, ${pxMm(y).toFixed(1)} mm`;
});

// ============ Element management ============
function addElement(attrs) {
  const el = { id: uid(), ...attrs };
  state.elements.push(el);
  state.selectedId = el.id;
  draw(); drawHandles(); refreshLayers(); renderSelProps();
  return el;
}

function deleteSelected() {
  if (!state.selectedId) return;
  state.elements = state.elements.filter(e => e.id !== state.selectedId);
  state.selectedId = null;
  draw(); drawHandles(); refreshLayers(); renderSelProps();
}

function refreshLayers() {
  const ul = document.getElementById("layers");
  ul.innerHTML = "";
  if (!state.elements.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nog geen elementen. Kies een tool links.";
    ul.appendChild(li);
    return;
  }
  for (let i = state.elements.length - 1; i >= 0; i--) {
    const el = state.elements[i];
    const li = document.createElement("li");
    if (el.id === state.selectedId) li.classList.add("selected");
    const icon = ({ text: "T", qr: "▣", rect: "▭", line: "╱" })[el.type] || "?";
    const name = el.type === "text" ? (el.text || "Tekst")
               : el.type === "qr" ? (el.data || "QR-code").slice(0, 30)
               : el.type === "rect" ? "Rechthoek"
               : el.type === "line" ? "Lijn"
               : el.type;
    li.innerHTML = `<span class="icon">${icon}</span><span class="name"></span>`;
    li.querySelector(".name").textContent = name;
    li.addEventListener("click", () => { state.selectedId = el.id; refreshLayers(); renderSelProps(); drawHandles(); });
    ul.appendChild(li);
  }
}

// ============ Properties panel ============
function renderSelProps() {
  const section = document.getElementById("selProps");
  const editor = document.getElementById("selEditor");
  const title = document.getElementById("selTitle");
  const el = state.elements.find(e => e.id === state.selectedId);
  if (!el) { section.style.display = "none"; return; }
  section.style.display = "block";
  title.textContent = ({ text: "Tekst", qr: "QR-code", rect: "Rechthoek", line: "Lijn" })[el.type] || "Element";
  editor.innerHTML = "";

  const add = (label, inputEl) => {
    const row = document.createElement("div");
    row.className = "row";
    const l = document.createElement("label");
    l.textContent = label;
    row.append(l, inputEl);
    editor.appendChild(row);
  };

  if (el.type === "text") {
    const ta = document.createElement("textarea"); ta.rows = 2; ta.value = el.text;
    ta.addEventListener("input", () => { el.text = ta.value; draw(); drawHandles(); refreshLayers(); });
    add("Tekst", ta);

    const sizeIn = document.createElement("input");
    sizeIn.type = "number"; sizeIn.min = 6; sizeIn.max = 72; sizeIn.value = el.size_pt;
    sizeIn.addEventListener("input", () => { el.size_pt = +sizeIn.value; draw(); drawHandles(); });
    add("Grootte (pt)", sizeIn);

    const styleRow = document.createElement("div"); styleRow.className = "btn-group";
    const mkTog = (label, key) => {
      const b = document.createElement("button"); b.className = "toggle"; b.textContent = label;
      if (el[key]) b.classList.add("active");
      b.addEventListener("click", () => { el[key] = !el[key]; b.classList.toggle("active"); draw(); drawHandles(); });
      return b;
    };
    styleRow.append(mkTog("B", "bold"), mkTog("I", "italic"));
    add("Stijl", styleRow);
  } else if (el.type === "qr") {
    const ta = document.createElement("textarea"); ta.rows = 2; ta.value = el.data;
    ta.addEventListener("input", () => { el.data = ta.value; draw(); drawHandles(); });
    add("Data (URL/tekst)", ta);

    const sizeIn = document.createElement("input");
    sizeIn.type = "number"; sizeIn.min = 20; sizeIn.value = Math.round(pxMm(el.width) * 10) / 10;
    sizeIn.step = 0.5;
    sizeIn.addEventListener("input", () => { const px = mmPx(+sizeIn.value); el.width = el.height = px; draw(); drawHandles(); });
    add("Grootte (mm)", sizeIn);
  } else if (el.type === "rect") {
    const swIn = document.createElement("input");
    swIn.type = "number"; swIn.min = 0.1; swIn.step = 0.1; swIn.value = el.stroke_mm || 0.3;
    swIn.addEventListener("input", () => { el.stroke_mm = +swIn.value; draw(); drawHandles(); });
    add("Lijndikte (mm)", swIn);

    const styleRow = document.createElement("div"); styleRow.className = "btn-group";
    const mkTog = (label, key) => {
      const b = document.createElement("button"); b.className = "toggle"; b.textContent = label;
      if (el[key]) b.classList.add("active");
      b.addEventListener("click", () => { el[key] = !el[key]; b.classList.toggle("active"); draw(); drawHandles(); });
      return b;
    };
    styleRow.append(mkTog("Rand", "stroke"), mkTog("Vulling", "fill"));
    add("Stijl", styleRow);
  } else if (el.type === "line") {
    const swIn = document.createElement("input");
    swIn.type = "number"; swIn.min = 0.1; swIn.step = 0.1; swIn.value = el.stroke_mm || 0.3;
    swIn.addEventListener("input", () => { el.stroke_mm = +swIn.value; draw(); drawHandles(); });
    add("Lijndikte (mm)", swIn);

    for (const [label, kx, ky] of [["Van", "x1", "y1"], ["Naar", "x2", "y2"]]) {
      const g = document.createElement("div"); g.className = "input-group";
      const xi = document.createElement("input"); xi.type = "number"; xi.step = 0.5;
      xi.value = Math.round(pxMm(el[kx]) * 10) / 10;
      xi.addEventListener("input", () => { el[kx] = mmPx(+xi.value); draw(); drawHandles(); });
      const yi = document.createElement("input"); yi.type = "number"; yi.step = 0.5;
      yi.value = Math.round(pxMm(el[ky]) * 10) / 10;
      yi.addEventListener("input", () => { el[ky] = mmPx(+yi.value); draw(); drawHandles(); });
      g.append(xi, yi);
      const sfx = document.createElement("span"); sfx.className = "suffix"; sfx.textContent = "mm"; g.append(sfx);
      add(label + " (x,y)", g);
    }
    return; // skip generic X/Y (doesn't apply to line)
  }

  const pos = document.createElement("div"); pos.className = "input-group";
  const xIn = document.createElement("input"); xIn.type = "number"; xIn.step = 0.5;
  xIn.value = Math.round(pxMm(el.x) * 10) / 10;
  xIn.addEventListener("input", () => { el.x = mmPx(+xIn.value); draw(); drawHandles(); });
  pos.append(xIn);
  const xSuf = document.createElement("span"); xSuf.className = "suffix"; xSuf.textContent = "mm"; pos.append(xSuf);
  add("X positie", pos);

  const pos2 = document.createElement("div"); pos2.className = "input-group";
  const yIn = document.createElement("input"); yIn.type = "number"; yIn.step = 0.5;
  yIn.value = Math.round(pxMm(el.y) * 10) / 10;
  yIn.addEventListener("input", () => { el.y = mmPx(+yIn.value); draw(); drawHandles(); });
  pos2.append(yIn);
  const ySuf = document.createElement("span"); ySuf.className = "suffix"; ySuf.textContent = "mm"; pos2.append(ySuf);
  add("Y positie", pos2);
}

// ============ Tools ============
function setTool(name) {
  state.tool = name;
  document.querySelectorAll(".tool").forEach(t => t.classList.toggle("active", t.dataset.tool === name));
  canvasWrap.classList.remove("tool-text", "tool-qr");
  if (name === "text") canvasWrap.classList.add("tool-text");
  if (name === "qr") canvasWrap.classList.add("tool-qr");
}
document.querySelectorAll(".tool").forEach(b => {
  b.addEventListener("click", () => {
    if (b.dataset.tool === "delete") { deleteSelected(); return; }
    setTool(b.dataset.tool);
  });
});

// Keyboard shortcuts
function toggleSelectedStyle(attr) {
  const el = state.elements.find(e => e.id === state.selectedId);
  if (!el || el.type !== "text") return false;
  el[attr] = !el[attr];
  draw(); drawHandles(); renderSelProps();
  return true;
}

document.addEventListener("keydown", (ev) => {
  const tgt = ev.target;
  const inField = tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable;
  const mod = ev.metaKey || ev.ctrlKey;

  // Cmd/Ctrl + B / I — also works while text input is focused (applies to selected element)
  if (mod && !ev.altKey && !ev.shiftKey) {
    if (ev.key === "b" || ev.key === "B") {
      if (toggleSelectedStyle("bold")) { ev.preventDefault(); return; }
    }
    if (ev.key === "i" || ev.key === "I") {
      if (toggleSelectedStyle("italic")) { ev.preventDefault(); return; }
    }
  }

  if (inField) return;
  if (ev.key === "v") setTool("select");
  else if (ev.key === "t") setTool("text");
  else if (ev.key === "q") setTool("qr");
  else if (ev.key === "r") setTool("rect");
  else if (ev.key === "l") setTool("line");
  else if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); deleteSelected(); }
  else if (ev.key === "=" || ev.key === "+") { state.zoom = Math.min(4, state.zoom + 0.1); applyZoom(); }
  else if (ev.key === "-") { state.zoom = Math.max(0.25, state.zoom - 0.1); applyZoom(); }
  else if (ev.key === "0") { state.zoom = 1; applyZoom(); }
});

document.getElementById("btnShare").onclick = copyShareLink;
document.getElementById("btnExport").onclick = () => { closeMenus(); exportAsJson(); };
document.getElementById("btnImport").onclick = () => { closeMenus(); importFromJsonDialog(); };
document.getElementById("btnSaveTemplate").onclick = () => { closeMenus(); saveAsTemplate(); };

// ============ Dropdown menus ============
function closeMenus() {
  document.querySelectorAll(".menu").forEach(m => m.classList.remove("open"));
}
document.addEventListener("click", (ev) => {
  const target = ev.target;
  if (!target.closest(".menu-wrap")) closeMenus();
});

async function openTemplatesMenu() {
  const menu = document.getElementById("templatesMenu");
  menu.innerHTML = "<div class='menu-empty'>Laden…</div>";
  closeMenus(); menu.classList.add("open");
  try {
    const r = await fetch("/templates");
    const list = await r.json();
    if (!list.length) { menu.innerHTML = "<div class='menu-empty'>Nog geen templates</div>"; return; }
    menu.innerHTML = "";
    for (const t of list) {
      const b = document.createElement("button");
      b.innerHTML = `<span>${t.title}</span><span class="dim">${t.width_mm}×${t.height_mm}mm</span>`;
      b.addEventListener("click", async () => {
        closeMenus();
        const r2 = await fetch(`/templates/${encodeURIComponent(t.name)}`);
        const doc = await r2.json();
        loadFromJson(doc, {});
        document.querySelector(".doc-title").textContent = doc.title || t.name;
        if (findRemainingPlaceholders().length) setTimeout(startPlaceholderFill, 100);
      });
      menu.appendChild(b);
    }
  } catch (e) {
    menu.innerHTML = `<div class='menu-empty'>Fout: ${e.message}</div>`;
  }
}
document.getElementById("btnTemplates").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const open = document.getElementById("templatesMenu").classList.contains("open");
  if (open) closeMenus(); else openTemplatesMenu();
});
document.getElementById("btnMore").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const m = document.getElementById("moreMenu");
  const wasOpen = m.classList.contains("open");
  closeMenus();
  if (!wasOpen) m.classList.add("open");
});

async function saveAsTemplate() {
  const suggested = (document.querySelector(".doc-title").textContent || "mijn_template")
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  const name = prompt("Template naam (a-z0-9_-):", suggested);
  if (!name) return;
  if (!/^[a-z0-9][a-z0-9_-]{0,48}$/.test(name)) { toast("✗ Ongeldige naam", "err"); return; }
  const doc = designToJson();
  doc.title = document.querySelector(".doc-title").textContent.trim() || name;
  const r = await fetch(`/templates/${encodeURIComponent(name)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc),
  });
  if (r.ok) toast(`✓ Template '${name}' opgeslagen`, "ok");
  else toast("✗ Kon niet opslaan", "err");
}

// ============ PDF modal ============
const pdfModal = document.getElementById("pdfModal");
const pdfDrop = document.getElementById("pdfDrop");
const pdfInput = document.getElementById("pdfInput");
const pdfPreview = document.getElementById("pdfPreview");
const pdfImg = document.getElementById("pdfImg");
const pdfMeta = document.getElementById("pdfMeta");
const pdfPrintBtn = document.getElementById("pdfPrint");
const pdfCropChk = document.getElementById("pdfCrop");
let _pdfFile = null;

function openPdfModal() { pdfModal.hidden = false; }
function closePdfModal() {
  pdfModal.hidden = true; _pdfFile = null;
  pdfPreview.hidden = true; pdfDrop.hidden = false; pdfPrintBtn.disabled = true;
  pdfInput.value = "";
}
document.getElementById("btnPdf").addEventListener("click", openPdfModal);
document.getElementById("pdfClose").addEventListener("click", closePdfModal);
document.getElementById("pdfCancel").addEventListener("click", closePdfModal);
pdfModal.addEventListener("click", (ev) => { if (ev.target === pdfModal) closePdfModal(); });

document.getElementById("pdfPick").addEventListener("click", () => pdfInput.click());
pdfDrop.addEventListener("click", (ev) => { if (ev.target === pdfDrop || ev.target.classList.contains("dz-title") || ev.target.classList.contains("dz-icon")) pdfInput.click(); });
pdfInput.addEventListener("change", () => { if (pdfInput.files[0]) loadPdf(pdfInput.files[0]); });
["dragenter", "dragover"].forEach(e => pdfDrop.addEventListener(e, (ev) => { ev.preventDefault(); pdfDrop.classList.add("drag"); }));
["dragleave", "drop"].forEach(e => pdfDrop.addEventListener(e, (ev) => { ev.preventDefault(); pdfDrop.classList.remove("drag"); }));
pdfDrop.addEventListener("drop", (ev) => {
  const f = ev.dataTransfer.files[0];
  if (f) loadPdf(f);
});
pdfCropChk.addEventListener("change", () => { if (_pdfFile) loadPdf(_pdfFile); });

async function loadPdf(file) {
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    toast("✗ Geen PDF-bestand", "err"); return;
  }
  _pdfFile = file;
  const fd = new FormData(); fd.append("file", file);
  const url = `/pdf/preview?crop=${pdfCropChk.checked}`;
  pdfPrintBtn.disabled = true;
  try {
    const r = await fetch(url, { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    const blob = await r.blob();
    pdfImg.src = URL.createObjectURL(blob);
    await pdfImg.decode();
    pdfDrop.hidden = true; pdfPreview.hidden = false;
    pdfMeta.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB · preview ${pdfImg.naturalWidth}×${pdfImg.naturalHeight}px`;
    pdfPrintBtn.disabled = false;
  } catch (e) {
    toast("✗ PDF verwerken mislukt: " + e.message, "err");
  }
}

pdfPrintBtn.addEventListener("click", async () => {
  if (!_pdfFile) return;
  pdfPrintBtn.disabled = true;
  const fd = new FormData(); fd.append("file", _pdfFile);
  try {
    const r = await fetch(`/print/pdf?crop=${pdfCropChk.checked}`, { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    toast(`✓ PDF geprint (${j.label_spec})`, "ok");
    closePdfModal();
  } catch (e) {
    toast("✗ " + e.message, "err");
    pdfPrintBtn.disabled = false;
  }
});

document.getElementById("zoomIn").onclick = () => { state.zoom = Math.min(4, state.zoom + 0.1); applyZoom(); };
document.getElementById("zoomOut").onclick = () => { state.zoom = Math.max(0.25, state.zoom - 0.1); applyZoom(); };
document.getElementById("zoomFit").onclick = () => { state.zoom = 1; applyZoom(); };

// ============ Label config ============
document.getElementById("borderToggle").addEventListener("change", (ev) => {
  state.label.border = ev.target.checked;
  draw();
});

document.getElementById("widthSel").addEventListener("change", (ev) => {
  state.label.width_mm = +ev.target.value;
  resizeCanvas(); draw();
});
document.getElementById("heightIn").addEventListener("input", (ev) => {
  state.label.height_mm = Math.max(10, Math.min(200, +ev.target.value || 30));
  resizeCanvas(); draw();
});

// ============ Print ============
document.getElementById("btnPrint").addEventListener("click", async () => {
  const btn = document.getElementById("btnPrint");
  btn.disabled = true;
  setStatus("Printen…");
  try {
    const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
    const fd = new FormData();
    fd.append("file", blob, "label.png");
    const r = await fetch("/print/image", { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    toast(`✓ Verzonden naar QL-570 (${j.label_spec})`, "ok");
    setStatus("Klaar");
    if (EMBED_MODE && window.parent && window.parent !== window) {
      try { window.parent.postMessage({ type: "label.printed", label_spec: j.label_spec }, "*"); } catch {}
    }
  } catch (e) {
    toast("✗ " + e.message, "err");
    setStatus("Fout");
  }
  btn.disabled = false;
});

// (preset-button removed — templates dropdown replaces it)

// ============ Printer status poll ============
async function pollStatus() {
  try {
    const r = await fetch("/status");
    const s = await r.json();
    state.printer = s;
    const chip = document.getElementById("printerChip");
    const txt = document.getElementById("printerText");
    if (s.has_media) {
      chip.classList.add("ok"); chip.classList.remove("err");
      txt.textContent = `QL-570 · ${s.media_width_mm}mm ${s.media_type}`;
      // Auto-set label width to detected
      if ([62, 29, 38].includes(s.media_width_mm)) {
        const sel = document.getElementById("widthSel");
        if (+sel.value !== s.media_width_mm) {
          sel.value = String(s.media_width_mm);
          state.label.width_mm = s.media_width_mm;
          resizeCanvas(); draw();
        }
      }
    } else {
      chip.classList.add("err"); chip.classList.remove("ok");
      txt.textContent = `Geen media`;
    }
  } catch (e) {
    document.getElementById("printerText").textContent = "verbindingsfout";
  }
}

// ============ Toast + status ============
function setStatus(t) { document.getElementById("statusText").textContent = t; }
function toast(msg, cls = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast visible " + cls;
  setTimeout(() => t.classList.remove("visible"), 2600);
}

// ============ Serialize / deserialize ============
// JSON format uses mm (DPI-independent). Placeholders {{var}} in text/qr substituted from URL params.
function designToJson() {
  return {
    label: {
      width_mm: state.label.width_mm,
      height_mm: state.label.height_mm,
      border: state.label.border,
      border_mm: state.label.border_mm,
    },
    title: document.querySelector(".doc-title").textContent.trim() || null,
    elements: state.elements.map(el => {
      if (el.type === "line") {
        return {
          type: "line",
          x1_mm: +pxMm(el.x1).toFixed(2), y1_mm: +pxMm(el.y1).toFixed(2),
          x2_mm: +pxMm(el.x2).toFixed(2), y2_mm: +pxMm(el.y2).toFixed(2),
          stroke_mm: el.stroke_mm || 0.3,
        };
      }
      const base = {
        type: el.type,
        x_mm: +pxMm(el.x).toFixed(2),
        y_mm: +pxMm(el.y).toFixed(2),
        w_mm: +pxMm(el.width).toFixed(2),
        h_mm: +pxMm(el.height).toFixed(2),
      };
      if (el.type === "text") Object.assign(base, {
        text: el.text, size_pt: el.size_pt,
        bold: !!el.bold, italic: !!el.italic, mono: !!el.mono,
      });
      if (el.type === "qr") base.data = el.data;
      if (el.type === "rect") Object.assign(base, {
        stroke_mm: el.stroke_mm || 0.3,
        stroke: el.stroke !== false,
        fill: !!el.fill,
      });
      return base;
    }),
  };
}

function substitute(str, vars) {
  if (!str) return str;
  return str.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

function loadFromJson(doc, vars = {}) {
  state.elements = [];
  state.label.width_mm = doc.label?.width_mm ?? 62;
  state.label.height_mm = doc.label?.height_mm ?? 30;
  state.label.border = !!doc.label?.border;
  state.label.border_mm = doc.label?.border_mm ?? 0.3;
  document.getElementById("widthSel").value = String(state.label.width_mm);
  document.getElementById("heightIn").value = state.label.height_mm;
  document.getElementById("borderToggle").checked = state.label.border;
  if (doc.title) document.querySelector(".doc-title").textContent = substitute(doc.title, vars);
  resizeCanvas();
  for (const e of (doc.elements || [])) {
    let el;
    if (e.type === "line") {
      el = {
        id: uid(), type: "line",
        x1: mmPx(e.x1_mm || 0), y1: mmPx(e.y1_mm || 0),
        x2: mmPx(e.x2_mm || 10), y2: mmPx(e.y2_mm || 0),
        stroke_mm: e.stroke_mm ?? 0.3,
      };
    } else {
      el = {
        id: uid(), type: e.type,
        x: mmPx(e.x_mm || 0), y: mmPx(e.y_mm || 0),
        width: mmPx(e.w_mm || 20), height: mmPx(e.h_mm || 20),
      };
      if (e.type === "text") Object.assign(el, {
        text: substitute(e.text || "", vars),
        size_pt: e.size_pt ?? 12, bold: !!e.bold, italic: !!e.italic, mono: !!e.mono,
      });
      if (e.type === "qr") el.data = substitute(e.data || "", vars);
      if (e.type === "rect") Object.assign(el, {
        stroke_mm: e.stroke_mm ?? 0.3,
        stroke: e.stroke !== false,
        fill: !!e.fill,
      });
    }
    state.elements.push(el);
  }
  state.selectedId = null;
  draw(); drawHandles(); refreshLayers(); renderSelProps();
}

async function copyShareLink() {
  const doc = designToJson();
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(doc))));
  const safe = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const url = `${location.origin}/?d=${safe}`;
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(url); ok = true; } catch {}
  }
  if (!ok) {
    // Fallback for http:// (non-secure context): hidden textarea + execCommand
    const ta = document.createElement("textarea");
    ta.value = url; ta.style.position = "fixed"; ta.style.left = "-9999px";
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
  }
  if (ok) toast(`📎 Link gekopieerd (${url.length} chars)`, "ok");
  else prompt("Kopieer deze link:", url);
}

async function loadFromUrl() {
  const params = new URLSearchParams(location.search);
  const tpl = params.get("template");
  const d = params.get("d");
  if (!tpl && !d) return false;
  const vars = {};
  for (const [k, v] of params) if (!["d", "template", "print"].includes(k)) vars[k] = v;
  try {
    let doc;
    if (tpl) {
      const r = await fetch(`/templates/${encodeURIComponent(tpl)}`);
      if (!r.ok) throw new Error(`Template '${tpl}' niet gevonden`);
      doc = await r.json();
    } else {
      const b64 = d.replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
      const json = decodeURIComponent(escape(atob(b64 + pad)));
      doc = JSON.parse(json);
    }
    loadFromJson(doc, vars);
    const remaining = findRemainingPlaceholders();
    if (params.get("print") === "1") {
      setTimeout(() => document.getElementById("btnPrint").click(), 500);
    } else if (remaining.length) {
      setTimeout(() => startPlaceholderFill(), 200);
    }
    return true;
  } catch (e) {
    console.error("Failed to load design from URL", e);
    toast("✗ " + (e.message || "Ontwerp in URL is ongeldig"), "err");
    return false;
  }
}

// ============ Tab-through placeholders ============
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/;

function findRemainingPlaceholders() {
  const out = [];
  for (const el of state.elements) {
    if (el.type === "text" && el.text) {
      const re = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;
      let m;
      while ((m = re.exec(el.text)) !== null) {
        out.push({ elId: el.id, start: m.index, end: m.index + m[0].length, name: m[1], raw: m[0] });
      }
    }
  }
  return out;
}

function startPlaceholderFill() {
  const remaining = findRemainingPlaceholders();
  if (!remaining.length) { endInlineEdit(); return; }
  const p = remaining[0];
  const el = state.elements.find(e => e.id === p.elId);
  if (!el) return;
  state.selectedId = el.id;
  drawHandles(); refreshLayers();
  startInlineEdit(el, { selectRange: [p.start, p.end], placeholderMode: true });
}

canvas.addEventListener("pointerdown", () => { /* no-op, handler already exists below */ }, { capture: false });

function exportAsJson() {
  const doc = designToJson();
  const text = JSON.stringify(doc, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (doc.title || "label") + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function importFromJsonDialog() {
  const input = document.createElement("input");
  input.type = "file"; input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    const f = input.files[0]; if (!f) return;
    const fr = new FileReader();
    fr.onload = () => { try { loadFromJson(JSON.parse(fr.result)); toast("✓ Ontwerp geladen", "ok"); } catch { toast("✗ Geen geldige JSON", "err"); } };
    fr.readAsText(f);
  });
  input.click();
}

window.lp = { designToJson, exportAsJson, importFromJsonDialog, copyShareLink };

// ============ Doc title ============
const docTitle = document.querySelector(".doc-title");
docTitle.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); docTitle.blur(); }
  if (ev.key === "Escape") { ev.preventDefault(); docTitle.blur(); }
});
docTitle.addEventListener("paste", (ev) => {
  ev.preventDefault();
  const text = (ev.clipboardData || window.clipboardData).getData("text").replace(/[\r\n]+/g, " ");
  document.execCommand("insertText", false, text);
});

// ============ Init ============
resizeCanvas();
draw();
refreshLayers();
pollStatus();
setInterval(pollStatus, 10000);
loadFromUrl();

window.addEventListener("resize", () => { applyZoom(); drawHandles(); });
