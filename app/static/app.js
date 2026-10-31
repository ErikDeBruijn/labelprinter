// Labelprinter — client-side canvas designer
// Document model: list of elements rendered to <canvas>. Canvas pixels == print pixels (300 DPI).

const DPI = 300;
const MM_PER_INCH = 25.4;
// Brother QL-570 printable widths per media width (mm)
const PRINTABLE_PX = { 62: 696, 29: 306, 38: 413 };

// The tape has a fixed printable width (calibrated px/mm) and an arbitrary
// length (pure 300 DPI). In portrait the across-tape axis is horizontal (x); in
// landscape the whole label is rotated 90° at print time, so the across-tape
// axis becomes vertical (y). The mm↔px helpers swap accordingly so the design
// always maps 1:1 onto the print raster.
const DPI_PX_PER_MM = DPI / MM_PER_INCH;
function isLandscape() { return state.label.orientation === "landscape"; }
function acrossPxPerMm() {
  const w = state.label.width_mm;
  return (PRINTABLE_PX[w] || (w * DPI / MM_PER_INCH)) / w;
}
const mmPxX = (mm) => Math.round(mm * (isLandscape() ? DPI_PX_PER_MM : acrossPxPerMm()));
const mmPxY = (mm) => Math.round(mm * (isLandscape() ? acrossPxPerMm() : DPI_PX_PER_MM));
// Axis-independent (stroke widths, sizes): always pure DPI.
const mmPx = (mm) => Math.round(mm * DPI_PX_PER_MM);
const pxMmX = (px) => px / (isLandscape() ? DPI_PX_PER_MM : acrossPxPerMm());  // X reporting
const pxMm = (px) => px / (isLandscape() ? acrossPxPerMm() : DPI_PX_PER_MM);    // Y reporting

// Embed/simple modes (for iframe use from other apps)
const _embedParams = new URLSearchParams(location.search);
const EMBED_MODE = _embedParams.get("embed") === "1";
const SIMPLE_MODE = _embedParams.get("simple") === "1";
if (EMBED_MODE) document.body.classList.add("embed-mode");
if (SIMPLE_MODE) {
  document.body.classList.add("simple-mode");
  // Move the Print button out of the topbar (hidden in simple mode) to body level.
  const _btn = document.getElementById("btnPrint");
  if (_btn) document.body.appendChild(_btn);
}

// In simple or embed mode: add an "Open in full designer" link that opens
// the same URL without embed/simple flags in a new window/tab.
if (SIMPLE_MODE || EMBED_MODE) {
  const _up = document.createElement("a");
  _up.className = "upgrade-link";
  _up.textContent = "↗ Volledige designer";
  _up.target = "_blank";
  _up.rel = "noopener";
  const _params = new URLSearchParams(location.search);
  _params.delete("embed"); _params.delete("simple"); _params.delete("print");
  _up.href = location.pathname + (_params.toString() ? "?" + _params.toString() : "");
  document.body.appendChild(_up);
}

const state = {
  label: { width_mm: 62, height_mm: 30, border: false, border_mm: 0.3, orientation: "portrait" },
  elements: [],
  selectedIds: [],
  zoom: 1, // CSS scale
  tool: "select",
  printer: { has_media: false, width_mm: null, type: "?" },
  fold: (() => { try { return localStorage.getItem("labelprinter.fold") === "1"; } catch { return false; } })(),
};

// `selectedIds` is the truth; `selectedId` stays as the single-selection view on
// it (null when 0 or >1 selected) so everything that only makes sense for one
// element — inspector fields, resize/rotate handles — keeps working unchanged.
Object.defineProperty(state, "selectedId", {
  get() { return state.selectedIds.length === 1 ? state.selectedIds[0] : null; },
  set(v) { state.selectedIds = v == null ? [] : [v]; },
});
const isSelected = (id) => state.selectedIds.includes(id);
const selectedElements = () => state.elements.filter(e => isSelected(e.id));
function setSelection(ids) { state.selectedIds = [...new Set(ids)]; }
function toggleSelection(id) {
  const i = state.selectedIds.indexOf(id);
  if (i >= 0) state.selectedIds.splice(i, 1); else state.selectedIds.push(id);
}

// ============ Undo / redo ============
// Snapshot-based: the whole document is small (a handful of elements), so a JSON
// snapshot per step is simpler and safer than per-action inverse operations.
// A drag/resize pushes once (on the first move), inspector typing coalesces per
// field so "12" is one step rather than two.
const UNDO_LIMIT = 100;
const undoStack = [];
const redoStack = [];
let _coalesceKey = null;
let _coalesceAt = 0;

function docTitleEl() { return document.querySelector(".doc-title"); }

function snapshotDoc() {
  return JSON.stringify({
    label: state.label,
    elements: state.elements,
    selectedIds: state.selectedIds,
    title: docTitleEl() ? docTitleEl().textContent : null,
  });
}

// Call BEFORE mutating. `key` (e.g. "size:el3") merges rapid repeats into one step.
function pushUndo(key = null) {
  const now = Date.now();
  if (key && key === _coalesceKey && now - _coalesceAt < 700) { _coalesceAt = now; return; }
  _coalesceKey = key; _coalesceAt = now;
  undoStack.push(snapshotDoc());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  updateUndoUi();
}

function applySnapshot(json) {
  const s = JSON.parse(json);
  if (inlineEditor) endInlineEdit();
  state.label = s.label;
  state.elements = s.elements;
  state.selectedIds = s.selectedIds || [];
  document.getElementById("widthSel").value = String(state.label.width_mm);
  document.getElementById("heightIn").value = state.label.height_mm;
  document.getElementById("borderToggle").checked = !!state.label.border;
  const orientSel = document.getElementById("orientSel");
  if (orientSel) orientSel.value = state.label.orientation || "portrait";
  if (docTitleEl() && s.title != null) docTitleEl().textContent = s.title;
  resizeCanvas(); draw(); drawHandles(); refreshLayers(); renderSelProps();
}

function undo() {
  if (!undoStack.length) { toast("Niets om ongedaan te maken"); return; }
  redoStack.push(snapshotDoc());
  applySnapshot(undoStack.pop());
  _coalesceKey = null;
  updateUndoUi();
}

function redo() {
  if (!redoStack.length) { toast("Niets om opnieuw te doen"); return; }
  undoStack.push(snapshotDoc());
  applySnapshot(redoStack.pop());
  _coalesceKey = null;
  updateUndoUi();
}

function updateUndoUi() {
  const u = document.getElementById("btnUndo");
  const r = document.getElementById("btnRedo");
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

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

// ============ Fonts ============
// The server (/fonts) is the single source of truth for the font registry.
// We declare each face as @font-face pointing at the same TTF files PIL prints
// with, so the canvas preview matches the printed raster exactly.
let FONT_FAMILIES = [];           // [{key,label,css,faces:[{url,weight,style}]}]
const FONT_BY_KEY = new Map();
let _fontsReadyResolve;
const fontsReady = new Promise((r) => { _fontsReadyResolve = r; });

function fontCssFamily(el) {
  const key = (el && el.font) || (el && el.mono ? "mono" : "sans");
  const fam = FONT_BY_KEY.get(key);
  const base = fam ? `'${fam.css}'` : "-apple-system, BlinkMacSystemFont, system-ui, sans-serif";
  // Append the emoji font as a per-glyph fallback (the browser uses it only for
  // glyphs the primary font lacks) so the canvas matches the server's fallback.
  const emoji = FONT_BY_KEY.get("emoji");
  return emoji && key !== "emoji" ? `${base}, '${emoji.css}'` : base;
}

async function loadFonts() {
  try {
    const r = await fetch("/fonts");
    FONT_FAMILIES = await r.json();
  } catch (e) {
    console.error("Kon lettertypes niet laden", e);
    FONT_FAMILIES = [];
  }
  FONT_BY_KEY.clear();
  for (const f of FONT_FAMILIES) FONT_BY_KEY.set(f.key, f);
  // Inject @font-face rules. font-display:block avoids a flash of fallback text
  // (which would have wrong metrics) before the real font is ready.
  const css = FONT_FAMILIES.flatMap(f => f.faces.map(face =>
    `@font-face{font-family:'${f.css}';src:url('${face.url}') format('truetype');` +
    `font-weight:${face.weight};font-style:${face.style};font-display:block;}`
  )).join("\n");
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  // Preload every face so the canvas can measure/draw with real glyphs.
  try {
    await Promise.all(FONT_FAMILIES.flatMap(f => f.faces.map(face =>
      document.fonts.load(`${face.style} ${face.weight} 40px '${f.css}'`).catch(() => {})
    )));
  } catch {}
  _fontsReadyResolve();
  draw();
  // Refresh the properties panel so a font dropdown appears if a text element
  // happened to be selected before the registry arrived.
  if (state.selectedId) renderSelProps();
}

// ============ Canvas rendering ============
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const canvasWrap = document.getElementById("canvasWrap");
const handlesLayer = document.getElementById("handles");
const sizeIndicator = document.getElementById("sizeIndicator");

function resizeCanvas() {
  const acrossPx = PRINTABLE_PX[state.label.width_mm] || mmPx(state.label.width_mm);
  const alongPx = mmPx(state.label.height_mm);
  // Landscape swaps the axes: the tape length runs horizontally on the design.
  const pxW = isLandscape() ? alongPx : acrossPx;
  const pxH = isLandscape() ? acrossPx : alongPx;
  canvas.width = pxW;
  canvas.height = pxH;
  // CSS-scale to fit view (zoom * display scale). Display px per canvas px:
  applyZoom();
  const orient = isLandscape() ? "liggend" : "staand";
  sizeIndicator.textContent = `${state.label.width_mm} × ${state.label.height_mm} mm  ·  ${orient}  ·  ${pxW} × ${pxH} px @ 300 DPI`;
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
  // Landscape: the horizontal extent is the tape length (height_mm), vertical is
  // the tape width (width_mm).
  const horizMm = isLandscape() ? state.label.height_mm : state.label.width_mm;
  const vertMm = isLandscape() ? state.label.width_mm : state.label.height_mm;
  canvas.style.width = `${horizMm * displayMmToCssPx}px`;
  canvas.style.height = `${vertMm * displayMmToCssPx}px`;
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
  // Per-element rotation: rotate the canvas around the element's centre. Lines
  // already have free endpoints, so rotation doesn't apply to them.
  const rot = el.rot || 0;
  const needRot = Math.abs(rot) > 0.01 && el.type !== "line";
  if (needRot) {
    const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
  if (el.type === "text") {
    const fontFamily = fontCssFamily(el);
    const baseStyle = (pt) => `${el.italic ? "italic " : ""}${el.bold ? "700 " : "400 "}${Math.round((pt * DPI) / 72)}px ${fontFamily}`;
    ctx.fillStyle = el.color === "white" ? "white" : "black";  // diapositief
    ctx.textBaseline = "top";

    if (el.wrap) {
      // Multi-line: fixed size, wrap within width, clip to height
      const pt = el.size_pt;
      ctx.font = baseStyle(pt);
      const sizePx = Math.round((pt * DPI) / 72);
      const lineH = sizePx * 1.2;
      const lines = wrapText(el.text, el.width - 4);
      const maxLines = Math.max(1, Math.floor(el.height / lineH));
      for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
        ctx.fillText(lines[i], el.x, el.y + i * lineH);
      }
    } else {
      // Single-line auto-shrink to fit width (down to 6pt)
      let pt = el.size_pt;
      const MIN_PT = 6;
      while (pt >= MIN_PT) {
        ctx.font = baseStyle(pt);
        if (ctx.measureText(el.text).width <= el.width - 4) break;
        pt -= 0.5;
      }
      ctx.fillText(el.text, el.x, el.y);
    }
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
    if (el.data && el.data.trim()) {
      ctx.fillStyle = "white";
      ctx.fillRect(el.x, el.y, size, size);
      const img = getQrImage(el.data, Math.max(64, Math.min(512, Math.round(size))));
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
  if (needRot) ctx.restore();
}

// In landscape the design canvas runs along the tape; the print raster must be
// the tape width. Rotate the canvas 90° clockwise to match the server, which
// applies the same transform (ImageChops/transpose ROTATE_270).
function rasterForPrint() {
  if (!isLandscape()) return canvas;
  const off = document.createElement("canvas");
  off.width = canvas.height;
  off.height = canvas.width;
  const octx = off.getContext("2d");
  octx.translate(off.width, 0);
  octx.rotate(Math.PI / 2);
  octx.drawImage(canvas, 0, 0);
  return off;
}

// Single-line text auto-shrinks to its box width at draw time. So that the
// "Grootte (pt)" field (and font/style changes) actually take effect, grow the
// box to fit the text at the requested size. Grow-only: never shrinks, so a
// manually-widened box or an authored template box is preserved, and the
// server's print-time shrink-to-fit for variable data still applies.
function fitTextBox(el) {
  if (!el || el.type !== "text" || el.wrap) return;
  const sizePx = Math.round((el.size_pt * DPI) / 72);
  ctx.font = `${el.italic ? "italic " : ""}${el.bold ? "700 " : "400 "}${sizePx}px ${fontCssFamily(el)}`;
  const need = Math.ceil(ctx.measureText(el.text || " ").width + 8);  // clear of the draw-time fit margin
  if (el.width < need) el.width = need;
  const lineH = Math.ceil(sizePx * 1.2);
  if (el.height < lineH) el.height = lineH;
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
// One selection box per selected element, grown on demand and reused.
const _selBoxes = [];
let _handleBR = null;
let _handleP1 = null;
let _handleP2 = null;
let _handleRot = null;

// Rotate (px,py) by `deg` clockwise around (cx,cy).
function rotPt(px, py, cx, cy, deg) {
  const a = (deg * Math.PI) / 180;
  const dx = px - cx, dy = py - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

// Axis-aligned bounding box in canvas px, rotation and line endpoints included.
function elementBBox(el) {
  if (el.type === "line") {
    const pad = Math.max(4, mmPx(el.stroke_mm || 0.3) / 2);
    return {
      x: Math.min(el.x1, el.x2) - pad, y: Math.min(el.y1, el.y2) - pad,
      w: Math.abs(el.x2 - el.x1) + 2 * pad, h: Math.abs(el.y2 - el.y1) + 2 * pad,
    };
  }
  const rot = el.rot || 0;
  if (Math.abs(rot) < 0.01) return { x: el.x, y: el.y, w: el.width, h: el.height };
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
  const pts = [[el.x, el.y], [el.x + el.width, el.y], [el.x + el.width, el.y + el.height], [el.x, el.y + el.height]]
    .map(([px, py]) => rotPt(px, py, cx, cy, rot));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function unionBBox(els) {
  const boxes = els.map(elementBBox);
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return {
    x, y,
    w: Math.max(...boxes.map(b => b.x + b.w)) - x,
    h: Math.max(...boxes.map(b => b.y + b.h)) - y,
  };
}

const bboxIntersects = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function selBoxDom(i) {
  while (_selBoxes.length <= i) {
    const d = document.createElement("div");
    d.className = "sel-box";
    handlesLayer.appendChild(d);
    _selBoxes.push(d);
  }
  return _selBoxes[i];
}

function ensureHandleDom() {
  if (_handleBR) return;
  _handleBR = document.createElement("div"); _handleBR.className = "handle"; _handleBR.dataset.handle = "br";
  handlesLayer.appendChild(_handleBR); bindResize(_handleBR);
  _handleRot = document.createElement("div"); _handleRot.className = "handle handle-rot"; _handleRot.dataset.handle = "rot";
  _handleRot.title = "Draaien (Shift = stap 15°)";
  handlesLayer.appendChild(_handleRot); bindRotate(_handleRot);
  _handleP1 = document.createElement("div"); _handleP1.className = "handle"; _handleP1.dataset.handle = "p1";
  _handleP1.style.cursor = "move";
  handlesLayer.appendChild(_handleP1); bindEndpointDrag(_handleP1, "1");
  _handleP2 = document.createElement("div"); _handleP2.className = "handle"; _handleP2.dataset.handle = "p2";
  _handleP2.style.cursor = "move";
  handlesLayer.appendChild(_handleP2); bindEndpointDrag(_handleP2, "2");
}

function drawHandles() {
  ensureHandleDom();
  for (const b of _selBoxes) b.style.display = "none";
  const sel = selectedElements();
  const sx = canvas.clientWidth / canvas.width;
  const sy = canvas.clientHeight / canvas.height;
  const dupBtn = document.getElementById("btnDuplicate");
  if (dupBtn) dupBtn.disabled = !sel.length;

  if (!sel.length) {
    _handleBR.style.display = _handleP1.style.display = _handleP2.style.display = _handleRot.style.display = "none";
    return;
  }

  if (sel.length > 1) {
    // Multi-selection: outline every element, no resize/rotate (one at a time).
    _handleBR.style.display = _handleP1.style.display = _handleP2.style.display = _handleRot.style.display = "none";
    sel.forEach((el, i) => {
      const bb = elementBBox(el);
      const box = selBoxDom(i);
      box.style.left = (bb.x * sx) + "px";
      box.style.top = (bb.y * sy) + "px";
      box.style.width = (bb.w * sx) + "px";
      box.style.height = (bb.h * sy) + "px";
      box.style.transform = "";
      box.style.display = "block";
    });
    return;
  }

  const el = sel[0];
  const _selBox = selBoxDom(0);

  if (el.type === "line") {
    _handleBR.style.display = _handleRot.style.display = "none";
    _handleP1.style.display = _handleP2.style.display = "block";
    _handleP1.style.left = (el.x1 * sx - 5) + "px"; _handleP1.style.top = (el.y1 * sy - 5) + "px";
    _handleP2.style.left = (el.x2 * sx - 5) + "px"; _handleP2.style.top = (el.y2 * sy - 5) + "px";
    return;
  }

  _selBox.style.display = _handleBR.style.display = _handleRot.style.display = "block";
  _handleP1.style.display = _handleP2.style.display = "none";
  const rot = el.rot || 0;
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
  // Box is positioned axis-aligned then CSS-rotated about its centre (= element centre).
  _selBox.style.left = (el.x * sx) + "px";
  _selBox.style.top = (el.y * sy) + "px";
  _selBox.style.width = (el.width * sx) + "px";
  _selBox.style.height = (el.height * sy) + "px";
  _selBox.style.transformOrigin = "center";
  _selBox.style.transform = rot ? `rotate(${rot}deg)` : "";
  // Resize handle follows the rotated bottom-right corner.
  const [brx, bry] = rotPt(el.x + el.width, el.y + el.height, cx, cy, rot);
  _handleBR.style.left = (brx * sx - 5) + "px";
  _handleBR.style.top = (bry * sy - 5) + "px";
  // Rotate handle sits a little above the rotated top-centre edge.
  const offCanvas = 22 / sy; // ~22 CSS px above, expressed in canvas px
  const [rxx, ryy] = rotPt(cx, el.y - offCanvas, cx, cy, rot);
  _handleRot.style.left = (rxx * sx - 6) + "px";
  _handleRot.style.top = (ryy * sy - 6) + "px";
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
    let pushed = false;
    const onMove = (e) => {
      if (!pushed) { pushUndo(); pushed = true; }
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
    let pushed = false;
    const onMove = (e) => {
      if (!pushed) { pushUndo(); pushed = true; }
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

function bindRotate(handle) {
  handle.addEventListener("pointerdown", (ev) => {
    const el = state.elements.find(e => e.id === state.selectedId);
    if (!el || el.type === "line") return;
    ev.preventDefault(); ev.stopPropagation();
    handle.setPointerCapture(ev.pointerId);
    const sx = canvas.clientWidth / canvas.width;
    const sy = canvas.clientHeight / canvas.height;
    const r = canvas.getBoundingClientRect();
    const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
    let pushed = false;
    const onMove = (e) => {
      if (!pushed) { pushUndo(); pushed = true; }
      // Pointer in canvas coords, angle from element centre. Handle starts at the
      // top (12 o'clock), so add 90° to make "straight up" read as 0°.
      const px = ((e.clientX - r.left) / r.width) * canvas.width;
      const py = ((e.clientY - r.top) / r.height) * canvas.height;
      let deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      deg = Math.round(deg);
      if (deg <= -180) deg += 360;
      if (deg > 180) deg -= 360;
      el.rot = deg;
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
      let px = x, py = y;
      const rot = el.rot || 0;
      if (Math.abs(rot) > 0.01) {
        // Un-rotate the hit point into the element's local (axis-aligned) frame.
        const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
        const a = (-rot * Math.PI) / 180;
        const dx = x - cx, dy = y - cy;
        px = cx + dx * Math.cos(a) - dy * Math.sin(a);
        py = cy + dx * Math.sin(a) + dy * Math.cos(a);
      }
      if (px >= el.x && py >= el.y && px <= el.x + el.width && py <= el.y + el.height) return el;
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
    font: `${el.italic ? "italic " : ""}${el.bold ? "700 " : "400 "}${sizeCss}px ${fontCssFamily(el)}`,
    lineHeight: "1.2",
    color: el.color === "white" ? "white" : "black",
    background: el.color === "white" ? "rgba(20,20,20,0.95)" : "rgba(255,255,255,0.95)",
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

  let pushedEdit = false;  // one undo step per inline-edit session, not per keystroke
  ed.addEventListener("input", () => {
    const target = state.elements.find(x => x.id === inlineEditingId);
    if (target) {
      if (!pushedEdit) { pushUndo(); pushedEdit = true; }
      target.text = ed.textContent; fitTextBox(target); draw(); refreshLayers();
      if (!target.wrap) {  // keep the editor as wide as the (grown) box
        const sxNow = canvas.clientWidth / canvas.width;
        ed.style.minWidth = ed.style.maxWidth = (target.width * sxNow) + "px";
      }
    }
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
  // Removing a focused element fires blur synchronously, which re-enters here.
  // Clear the refs first so the nested call returns instead of removing twice.
  const ed = inlineEditor;
  inlineEditor = null;
  inlineEditingId = null;
  if (ed._hintEl) ed._hintEl.remove();
  ed.remove();
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
  document.getElementById("mouseCoord").textContent = `${pxMmX(x).toFixed(1)}, ${pxMm(y).toFixed(1)} mm`;
  if (state.tool === "text") {
    addElement({ type: "text", text: "Tekst", x, y, width: 200, height: 40, size_pt: 14, font: "sans", bold: false, italic: false });
    setTool("select");
  } else if (state.tool === "qr") {
    addElement({ type: "qr", data: "https://example.com", x, y, width: 120, height: 120 });
    setTool("select");
  } else if (state.tool === "rect") {
    addElement({ type: "rect", x, y, width: mmPxX(15), height: mmPxY(10), stroke_mm: 0.3, stroke: true, fill: false });
    setTool("select");
  } else if (state.tool === "line") {
    addElement({ type: "line", x1: x, y1: y, x2: x + mmPxX(20), y2: y, stroke_mm: 0.3 });
    setTool("select");
  } else {
    const hit = hitTest(x, y);
    if (hit) {
      if (ev.shiftKey) toggleSelection(hit.id);
      else if (!isSelected(hit.id)) state.selectedId = hit.id;
      // Clicking an already-selected element keeps the group, so it can be dragged as one.
      renderSelProps();
      refreshLayers();
      drawHandles();
      if (isSelected(hit.id)) startDrag(ev, hit, x, y);
    } else {
      startRubberBand(ev, x, y);
    }
  }
});

// Drags the selection the element belongs to; a lone element drags by itself.
function startDrag(ev, el, startX, startY) {
  canvas.setPointerCapture(ev.pointerId);
  const group = selectedElements();
  const movers = group.includes(el) ? group : [el];
  const origins = movers.map(m => m.type === "line"
    ? { el: m, x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2 }
    : { el: m, x: m.x, y: m.y });
  // Allow elements to extend past the canvas edges — render clips naturally.
  // Keep at least ~30 canvas px of the selection visible so it isn't lost off-canvas.
  const minVisible = 30;
  const bb = unionBBox(movers);
  const minDx = minVisible - (bb.x + bb.w), maxDx = canvas.width - minVisible - bb.x;
  const minDy = minVisible - (bb.y + bb.h), maxDy = canvas.height - minVisible - bb.y;
  const wasShift = ev.shiftKey;
  let moved = false;
  const onMove = (e) => {
    const { x, y } = canvasCoords(e);
    if (!moved) {
      // Ignore jitter: below ~3 CSS px this is still a click, not a drag.
      const sx = canvas.clientWidth / canvas.width, sy = canvas.clientHeight / canvas.height;
      if (Math.abs((x - startX) * sx) < 3 && Math.abs((y - startY) * sy) < 3) return;
      moved = true;
      pushUndo();
    }
    const dx = Math.max(minDx, Math.min(maxDx, x - startX));
    const dy = Math.max(minDy, Math.min(maxDy, y - startY));
    for (const o of origins) {
      if (o.el.type === "line") {
        o.el.x1 = o.x1 + dx; o.el.y1 = o.y1 + dy;
        o.el.x2 = o.x2 + dx; o.el.y2 = o.y2 + dy;
      } else {
        o.el.x = o.x + dx; o.el.y = o.y + dy;
      }
    }
    const coord = document.getElementById("mouseCoord");
    if (movers.length > 1) coord.textContent = `${movers.length} elementen · Δ ${pxMmX(dx).toFixed(1)}, ${pxMm(dy).toFixed(1)} mm`;
    else if (el.type === "line") coord.textContent = `${pxMmX(el.x1).toFixed(1)}, ${pxMm(el.y1).toFixed(1)} → ${pxMmX(el.x2).toFixed(1)}, ${pxMm(el.y2).toFixed(1)}`;
    else coord.textContent = `${pxMmX(el.x).toFixed(1)}, ${pxMm(el.y).toFixed(1)} mm`;
    draw(); drawHandles(); renderSelProps();
  };
  const onUp = () => {
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    // Clicking (not dragging) inside a multi-selection narrows it to that element.
    if (!moved && !wasShift && movers.length > 1) {
      state.selectedId = el.id;
      renderSelProps(); refreshLayers(); drawHandles();
    }
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
}

// ============ Rubber-band selection ============
// Dragging on empty canvas with the select tool draws a dashed rectangle; every
// element whose bounding box *touches* it is selected (touching rather than
// fully enclosing is friendlier on a label this small).
let _bandDom = null;
function bandDom() {
  if (!_bandDom) {
    _bandDom = document.createElement("div");
    _bandDom.className = "rubber-band";
    _bandDom.style.display = "none";
    handlesLayer.appendChild(_bandDom);
  }
  return _bandDom;
}

function startRubberBand(ev, startX, startY) {
  canvas.setPointerCapture(ev.pointerId);
  const base = ev.shiftKey ? [...state.selectedIds] : [];
  const band = bandDom();
  let dragging = false;
  const rectOf = (x, y) => ({
    x: Math.min(startX, x), y: Math.min(startY, y),
    w: Math.abs(x - startX), h: Math.abs(y - startY),
  });
  const onMove = (e) => {
    const { x, y } = canvasCoords(e);
    const r = rectOf(x, y);
    const sx = canvas.clientWidth / canvas.width;
    const sy = canvas.clientHeight / canvas.height;
    if (!dragging && (r.w * sx > 3 || r.h * sy > 3)) dragging = true;
    if (!dragging) return;
    band.style.display = "block";
    band.style.left = (r.x * sx) + "px";
    band.style.top = (r.y * sy) + "px";
    band.style.width = (r.w * sx) + "px";
    band.style.height = (r.h * sy) + "px";
    setSelection([...base, ...state.elements.filter(el => bboxIntersects(elementBBox(el), r)).map(el => el.id)]);
    drawHandles(); refreshLayers();
  };
  const onUp = (e) => {
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    band.style.display = "none";
    if (!dragging) setSelection(base);  // plain click on empty canvas deselects
    renderSelProps(); refreshLayers(); drawHandles();
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  if (!ev.shiftKey) { setSelection([]); renderSelProps(); refreshLayers(); drawHandles(); }
}

canvas.addEventListener("pointermove", (ev) => {
  const { x, y } = canvasCoords(ev);
  document.getElementById("mouseCoord").textContent = `${pxMmX(x).toFixed(1)}, ${pxMm(y).toFixed(1)} mm`;
});

// ============ Element management ============
function addElement(attrs) {
  pushUndo();
  const el = { id: uid(), ...attrs };
  fitTextBox(el);
  state.elements.push(el);
  state.selectedId = el.id;
  draw(); drawHandles(); refreshLayers(); renderSelProps();
  return el;
}

function deleteSelected() {
  if (!state.selectedIds.length) return;
  pushUndo();
  const ids = new Set(state.selectedIds);
  state.elements = state.elements.filter(e => !ids.has(e.id));
  setSelection([]);
  draw(); drawHandles(); refreshLayers(); renderSelProps();
}

// ============ Duplicate / copy / paste ============
// Copies ride the system clipboard as JSON (via the native copy/cut/paste
// events, so no clipboard permission prompt and it works over plain http too)
// and are kept internally as well, so a paste still works if the clipboard was
// overwritten by something else in the meantime.
const PASTE_OFFSET = 10;               // canvas px per duplicate/paste step
const CLIP_KIND = "labelprinter/elements";
let _clipboard = [];
let _pasteStep = 0;                    // grows per paste so repeats keep marching

// px per mm for a given label geometry (landscape swaps the axes).
function labelPxPerMm(label) {
  const w = label.width_mm;
  const across = (PRINTABLE_PX[w] || (w * DPI / MM_PER_INCH)) / w;
  const land = label.orientation === "landscape";
  return { x: land ? DPI_PX_PER_MM : across, y: land ? across : DPI_PX_PER_MM };
}

function cloneForPaste(els, offset, fromLabel) {
  // Elements carry canvas px. Pasting into a different label geometry rescales
  // them so they keep the same size and position in mm.
  const to = labelPxPerMm(state.label);
  const from = fromLabel ? labelPxPerMm(fromLabel) : to;
  const rx = to.x / from.x, ry = to.y / from.y;
  return els.map(src => {
    const el = JSON.parse(JSON.stringify(src));
    el.id = uid();
    if (el.type === "line") {
      el.x1 = el.x1 * rx + offset; el.y1 = el.y1 * ry + offset;
      el.x2 = el.x2 * rx + offset; el.y2 = el.y2 * ry + offset;
    } else {
      el.x = el.x * rx + offset; el.y = el.y * ry + offset;
      el.width *= rx; el.height *= ry;
    }
    return el;
  });
}

// Adds copies on top of the z-order and moves the selection to them, so a
// repeated ⌘D keeps stepping away from the last copy.
function addCopies(els, offset, fromLabel) {
  if (!els || !els.length) return;
  pushUndo();
  const copies = cloneForPaste(els, offset, fromLabel);
  state.elements.push(...copies);
  setSelection(copies.map(e => e.id));
  draw(); drawHandles(); refreshLayers(); renderSelProps();
}

function duplicateSelection() {
  addCopies(selectedElements(), PASTE_OFFSET);
}

function parseClipPayload(text) {
  if (!text || text.length > 2e6) return null;
  try {
    const j = JSON.parse(text);
    if (j && j.kind === CLIP_KIND && Array.isArray(j.elements) && j.elements.length) return j;
  } catch {}
  return null;
}

// True when the keystroke belongs to a text field or a real text selection —
// then the browser's own copy/paste must win (inline edit, inputs, doc title).
function clipboardBelongsToText(ev) {
  const t = ev.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return true;
  const sel = getSelection();
  return !!(sel && !sel.isCollapsed && String(sel).trim());
}

function grabSelection(ev) {
  const els = selectedElements();
  if (!els.length) return 0;
  _clipboard = JSON.parse(JSON.stringify(els));
  _pasteStep = 0;
  ev.clipboardData.setData("text/plain", JSON.stringify({
    kind: CLIP_KIND,
    label: { width_mm: state.label.width_mm, orientation: state.label.orientation },
    elements: _clipboard,
  }));
  ev.preventDefault();
  return els.length;
}

document.addEventListener("copy", (ev) => {
  if (clipboardBelongsToText(ev)) return;
  const n = grabSelection(ev);
  if (n) toast(`📋 ${n} element${n === 1 ? "" : "en"} gekopieerd`, "ok");
});

document.addEventListener("cut", (ev) => {
  if (clipboardBelongsToText(ev)) return;
  if (grabSelection(ev)) deleteSelected();
});

document.addEventListener("paste", (ev) => {
  if (clipboardBelongsToText(ev)) return;   // plain-text paste keeps working there
  const payload = parseClipPayload(ev.clipboardData.getData("text/plain"));
  if (payload) {
    // Clipboard content from elsewhere (other tab/template) restarts the offset.
    if (JSON.stringify(payload.elements) !== JSON.stringify(_clipboard)) {
      _clipboard = payload.elements;
      _pasteStep = 0;
    }
    ev.preventDefault();
    _pasteStep += 1;
    addCopies(payload.elements, PASTE_OFFSET * _pasteStep, payload.label);
    return;
  }
  if (!_clipboard.length) return;           // plain text on the canvas: nothing to paste
  ev.preventDefault();
  _pasteStep += 1;
  addCopies(_clipboard, PASTE_OFFSET * _pasteStep);
});

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
    if (isSelected(el.id)) li.classList.add("selected");
    const icon = ({ text: "T", qr: "▣", rect: "▭", line: "╱" })[el.type] || "?";
    const name = el.type === "text" ? (el.text || "Tekst")
               : el.type === "qr" ? (el.data || "QR-code").slice(0, 30)
               : el.type === "rect" ? "Rechthoek"
               : el.type === "line" ? "Lijn"
               : el.type;
    li.innerHTML = `<span class="icon">${icon}</span><span class="name"></span>`;
    li.querySelector(".name").textContent = name;
    li.addEventListener("click", (ev) => {
      if (ev.shiftKey) toggleSelection(el.id); else state.selectedId = el.id;
      refreshLayers(); renderSelProps(); drawHandles();
    });
    ul.appendChild(li);
  }
}

// ============ Properties panel ============
function renderSelProps() {
  const section = document.getElementById("selProps");
  const editor = document.getElementById("selEditor");
  const title = document.getElementById("selTitle");
  if (state.selectedIds.length > 1) {
    section.style.display = "block";
    title.textContent = "Selectie";
    editor.innerHTML = "";
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = `${state.selectedIds.length} elementen geselecteerd — sleep om te verplaatsen, pijltjes voor precisie, ⌘D dupliceert, Delete wist.`;
    editor.appendChild(p);
    return;
  }
  const el = state.elements.find(e => e.id === state.selectedId);
  if (!el) { section.style.display = "none"; return; }
  section.style.display = "block";
  title.textContent = ({ text: "Tekst", qr: "QR-code", rect: "Rechthoek", line: "Lijn" })[el.type] || "Element";
  editor.innerHTML = "";
  // Every inspector field mutates an element, so each one snapshots first. The
  // key coalesces a burst of `input` events (typing "12") into one undo step.
  const mark = (field) => pushUndo(`${field}:${el.id}`);

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
    ta.addEventListener("input", () => { mark("text"); el.text = ta.value; fitTextBox(el); draw(); drawHandles(); refreshLayers(); });
    add("Tekst", ta);

    if (FONT_FAMILIES.length) {
      const fontSel = document.createElement("select");
      for (const f of FONT_FAMILIES) {
        const o = document.createElement("option");
        o.value = f.key; o.textContent = f.label;
        // Preview each option in its own font; fall back to UI font for any
        // missing glyphs (e.g. the emoji font has no Latin letters for its label).
        o.style.fontFamily = `'${f.css}', system-ui`;
        fontSel.appendChild(o);
      }
      fontSel.value = el.font || (el.mono ? "mono" : "sans");
      fontSel.addEventListener("change", () => {
        mark("font");
        el.font = fontSel.value;
        el.mono = fontSel.value === "mono";  // keep legacy flag coherent
        fitTextBox(el); draw(); drawHandles();
      });
      add("Lettertype", fontSel);
    }

    const sizeIn = document.createElement("input");
    sizeIn.type = "number"; sizeIn.min = 4; sizeIn.max = 200; sizeIn.step = 0.5; sizeIn.value = el.size_pt;
    sizeIn.addEventListener("input", () => { mark("size"); el.size_pt = +sizeIn.value; fitTextBox(el); draw(); drawHandles(); });
    add("Grootte (pt)", sizeIn);

    const styleRow = document.createElement("div"); styleRow.className = "btn-group";
    const mkTog = (label, key) => {
      const b = document.createElement("button"); b.className = "toggle"; b.textContent = label;
      if (el[key]) b.classList.add("active");
      b.addEventListener("click", () => { mark("style-" + key); el[key] = !el[key]; b.classList.toggle("active"); fitTextBox(el); draw(); drawHandles(); });
      return b;
    };
    // "Wit" = diapositief: white ink, meant to sit on a black fill behind it.
    const whiteTog = document.createElement("button");
    whiteTog.className = "toggle"; whiteTog.textContent = "Wit";
    whiteTog.title = "Diapositief: witte tekst (zet er een zwart vlak achter)";
    if (el.color === "white") whiteTog.classList.add("active");
    whiteTog.addEventListener("click", () => {
      mark("color");
      el.color = el.color === "white" ? "black" : "white";
      whiteTog.classList.toggle("active");
      draw(); drawHandles();
    });
    styleRow.append(mkTog("B", "bold"), mkTog("I", "italic"), whiteTog);
    add("Stijl", styleRow);

    const wrapLabel = document.createElement("label"); wrapLabel.className = "switch";
    const wrapIn = document.createElement("input"); wrapIn.type = "checkbox"; wrapIn.checked = !!el.wrap;
    const wrapSlider = document.createElement("span"); wrapSlider.className = "slider";
    wrapLabel.append(wrapIn, wrapSlider);
    wrapIn.addEventListener("change", () => { mark("wrap"); el.wrap = wrapIn.checked; fitTextBox(el); draw(); drawHandles(); });
    add("Wrap (multi-line)", wrapLabel);
  } else if (el.type === "qr") {
    const ta = document.createElement("textarea"); ta.rows = 2; ta.value = el.data;
    ta.addEventListener("input", () => { mark("data"); el.data = ta.value; draw(); drawHandles(); });
    add("Data (URL/tekst)", ta);

    const sizeIn = document.createElement("input");
    sizeIn.type = "number"; sizeIn.min = 20; sizeIn.value = Math.round(pxMmX(el.width) * 10) / 10;
    sizeIn.step = 0.5;
    sizeIn.addEventListener("input", () => { mark("qrsize"); const px = mmPxX(+sizeIn.value); el.width = el.height = px; draw(); drawHandles(); });
    add("Grootte (mm)", sizeIn);
  } else if (el.type === "rect") {
    const swIn = document.createElement("input");
    swIn.type = "number"; swIn.min = 0.1; swIn.step = 0.1; swIn.value = el.stroke_mm || 0.3;
    swIn.addEventListener("input", () => { mark("stroke"); el.stroke_mm = +swIn.value; draw(); drawHandles(); });
    add("Lijndikte (mm)", swIn);

    const styleRow = document.createElement("div"); styleRow.className = "btn-group";
    const mkTog = (label, key) => {
      const b = document.createElement("button"); b.className = "toggle"; b.textContent = label;
      if (el[key]) b.classList.add("active");
      b.addEventListener("click", () => { mark("style-" + key); el[key] = !el[key]; b.classList.toggle("active"); fitTextBox(el); draw(); drawHandles(); });
      return b;
    };
    styleRow.append(mkTog("Rand", "stroke"), mkTog("Vulling", "fill"));
    add("Stijl", styleRow);
  } else if (el.type === "line") {
    const swIn = document.createElement("input");
    swIn.type = "number"; swIn.min = 0.1; swIn.step = 0.1; swIn.value = el.stroke_mm || 0.3;
    swIn.addEventListener("input", () => { mark("stroke"); el.stroke_mm = +swIn.value; draw(); drawHandles(); });
    add("Lijndikte (mm)", swIn);

    for (const [label, kx, ky] of [["Van", "x1", "y1"], ["Naar", "x2", "y2"]]) {
      const g = document.createElement("div"); g.className = "input-group";
      const xi = document.createElement("input"); xi.type = "number"; xi.step = 0.5;
      xi.value = Math.round(pxMmX(el[kx]) * 10) / 10;
      xi.addEventListener("input", () => { mark("line-" + kx); el[kx] = mmPxX(+xi.value); draw(); drawHandles(); });
      const yi = document.createElement("input"); yi.type = "number"; yi.step = 0.5;
      yi.value = Math.round(pxMm(el[ky]) * 10) / 10;
      yi.addEventListener("input", () => { mark("line-" + ky); el[ky] = mmPxY(+yi.value); draw(); drawHandles(); });
      g.append(xi, yi);
      const sfx = document.createElement("span"); sfx.className = "suffix"; sfx.textContent = "mm"; g.append(sfx);
      add(label + " (x,y)", g);
    }
    return; // skip generic X/Y (doesn't apply to line)
  }

  // Rotation — applies to text / qr / rect (line uses free endpoints, returned above).
  const rotWrap = document.createElement("div"); rotWrap.className = "input-group";
  const rotIn = document.createElement("input"); rotIn.type = "number"; rotIn.step = 1;
  rotIn.value = Math.round(el.rot || 0);
  rotIn.addEventListener("input", () => { mark("rot"); el.rot = Math.round(+rotIn.value || 0); draw(); drawHandles(); });
  rotWrap.append(rotIn);
  const rotSuf = document.createElement("span"); rotSuf.className = "suffix"; rotSuf.textContent = "°"; rotWrap.append(rotSuf);
  const rot90 = document.createElement("button"); rot90.className = "btn ghost small"; rot90.textContent = "⟳ 90°";
  rot90.title = "Draai 90° met de klok mee";
  rot90.addEventListener("click", () => {
    pushUndo();
    let d = Math.round((el.rot || 0) + 90); if (d > 180) d -= 360;
    el.rot = d; rotIn.value = d; draw(); drawHandles();
  });
  rotWrap.append(rot90);
  add("Rotatie", rotWrap);

  const pos = document.createElement("div"); pos.className = "input-group";
  const xIn = document.createElement("input"); xIn.type = "number"; xIn.step = 0.5;
  xIn.value = Math.round(pxMmX(el.x) * 10) / 10;
  xIn.addEventListener("input", () => { mark("x"); el.x = mmPxX(+xIn.value); draw(); drawHandles(); });
  pos.append(xIn);
  const xSuf = document.createElement("span"); xSuf.className = "suffix"; xSuf.textContent = "mm"; pos.append(xSuf);
  add("X positie", pos);

  const pos2 = document.createElement("div"); pos2.className = "input-group";
  const yIn = document.createElement("input"); yIn.type = "number"; yIn.step = 0.5;
  yIn.value = Math.round(pxMm(el.y) * 10) / 10;
  yIn.addEventListener("input", () => { mark("y"); el.y = mmPxY(+yIn.value); draw(); drawHandles(); });
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
    if (b.dataset.tool === "undo") { undo(); return; }
    if (b.dataset.tool === "redo") { redo(); return; }
    if (b.dataset.tool === "duplicate") { duplicateSelection(); return; }
    setTool(b.dataset.tool);
  });
});

// Keyboard shortcuts
function toggleSelectedStyle(attr) {
  const texts = selectedElements().filter(e => e.type === "text");
  if (!texts.length) return false;
  pushUndo();
  const on = !texts[0][attr];
  for (const el of texts) { el[attr] = on; fitTextBox(el); }
  draw(); drawHandles(); renderSelProps();
  return true;
}

// Nudge the whole selection. 0.5mm per press, 2mm with Shift.
function nudgeSelection(dxMm, dyMm) {
  const sel = selectedElements();
  if (!sel.length) return;
  pushUndo("nudge");
  const dx = mmPxX(dxMm), dy = mmPxY(dyMm);
  for (const el of sel) {
    if (el.type === "line") { el.x1 += dx; el.y1 += dy; el.x2 += dx; el.y2 += dy; }
    else { el.x += dx; el.y += dy; }
  }
  draw(); drawHandles(); renderSelProps();
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

  // Undo/redo — never while a text field has focus, the browser owns that there.
  if (mod && !inField && (ev.key === "z" || ev.key === "Z")) {
    ev.preventDefault();
    if (ev.shiftKey) redo(); else undo();
    return;
  }
  if (mod && !inField && (ev.key === "y" || ev.key === "Y")) { ev.preventDefault(); redo(); return; }

  // ⌘D duplicates; preventDefault keeps the browser from bookmarking the page.
  if (mod && !inField && (ev.key === "d" || ev.key === "D")) {
    ev.preventDefault();
    duplicateSelection();
    return;
  }

  if (inField) return;
  if (ev.key.startsWith("Arrow")) {
    const step = ev.shiftKey ? 2 : 0.5;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
    if (d && state.selectedIds.length) { ev.preventDefault(); nudgeSelection(d[0], d[1]); }
    return;
  }
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
      b.className = "template-item";
      b.innerHTML = `<span class="template-thumb"><img src="/templates/${encodeURIComponent(t.name)}/thumbnail" alt=""></span>`
        + `<span class="template-text"><span>${t.title}</span><span class="dim">${t.width_mm}×${t.height_mm}mm</span></span>`;
      b.addEventListener("click", async () => {
        closeMenus();
        const r2 = await fetch(`/templates/${encodeURIComponent(t.name)}`);
        const doc = await r2.json();
        pushUndo();
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

// ============ Image upload modal ============
const imgModal = document.getElementById("imgModal");
const imgDrop = document.getElementById("imgDrop");
const imgInput = document.getElementById("imgInput");
const imgPreview = document.getElementById("imgPreview");
const imgImg = document.getElementById("imgImg");
const imgMeta = document.getElementById("imgMeta");
const imgPrintBtn = document.getElementById("imgPrint");
const imgDither = document.getElementById("imgDither");
let _imgFile = null;

function openImgModal() { imgModal.hidden = false; }
function closeImgModal() {
  imgModal.hidden = true; _imgFile = null;
  imgPreview.hidden = true; imgDrop.hidden = false; imgPrintBtn.disabled = true;
  imgInput.value = "";
}
document.getElementById("btnImage").addEventListener("click", openImgModal);
document.getElementById("imgClose").addEventListener("click", closeImgModal);
document.getElementById("imgCancel").addEventListener("click", closeImgModal);
imgModal.addEventListener("click", (ev) => { if (ev.target === imgModal) closeImgModal(); });
document.getElementById("imgPick").addEventListener("click", () => imgInput.click());
imgDrop.addEventListener("click", (ev) => {
  if (ev.target === imgDrop || ev.target.classList.contains("dz-title") || ev.target.classList.contains("dz-icon")) imgInput.click();
});
imgInput.addEventListener("change", () => { if (imgInput.files[0]) loadImg(imgInput.files[0]); });
["dragenter", "dragover"].forEach(e => imgDrop.addEventListener(e, (ev) => { ev.preventDefault(); imgDrop.classList.add("drag"); }));
["dragleave", "drop"].forEach(e => imgDrop.addEventListener(e, (ev) => { ev.preventDefault(); imgDrop.classList.remove("drag"); }));
imgDrop.addEventListener("drop", (ev) => { const f = ev.dataTransfer.files[0]; if (f) loadImg(f); });
imgDither.addEventListener("change", () => { if (_imgFile) loadImg(_imgFile); });

async function loadImg(file) {
  if (!file.type.startsWith("image/")) { toast("✗ Geen afbeelding", "err"); return; }
  _imgFile = file;
  const fd = new FormData(); fd.append("file", file);
  imgPrintBtn.disabled = true;
  try {
    const r = await fetch(`/image/preview?dither=${imgDither.checked}${state.fold ? "&fold=true" : ""}`, { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    const blob = await r.blob();
    imgImg.src = URL.createObjectURL(blob);
    await imgImg.decode();
    imgDrop.hidden = true; imgPreview.hidden = false;
    imgMeta.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB · print ${imgImg.naturalWidth}×${imgImg.naturalHeight}px${imgDither.checked ? " · dithered" : " · threshold"}`;
    imgPrintBtn.disabled = false;
  } catch (e) { toast("✗ " + e.message, "err"); }
}

imgPrintBtn.addEventListener("click", async () => {
  if (!_imgFile) return;
  imgPrintBtn.disabled = true;
  const fd = new FormData(); fd.append("file", _imgFile);
  try {
    const r = await fetch(`/print/image?dither=${imgDither.checked}${state.fold ? "&fold=true" : ""}`, { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    const [msg, cls] = formatPrintResult(j, "Afbeelding geprint");
    toast(msg, cls);
    pollStatus();
    closeImgModal();
  } catch (e) { toast("✗ " + e.message, "err"); imgPrintBtn.disabled = false; }
});

// ============ Print history ============
const historyModal = document.getElementById("historyModal");
const historyBody = document.getElementById("historyBody");
document.getElementById("btnHistory").addEventListener("click", () => { closeMenus(); openHistory(); });
document.getElementById("historyClose").addEventListener("click", () => { historyModal.hidden = true; });
historyModal.addEventListener("click", (ev) => { if (ev.target === historyModal) historyModal.hidden = true; });

const GENERIC_TITLES = new Set(["", "nieuw label", "label", "label.", "untitled"]);

// Text values we treat as non-meaningful (tool defaults / blank placeholders).
const PLACEHOLDER_TEXTS = new Set(["tekst", "text", ""]);

function historyDisplayTitle(entry) {
  const raw = (entry.title || "").trim();
  const isGeneric = GENERIC_TITLES.has(raw.toLowerCase());
  const design = entry.design;
  if (!isGeneric && raw) return raw;
  if (!design) return raw || "(zonder titel)";
  const vars = entry.vars || {};
  const sub = (t) => (t || "").replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_, k) => vars[k] ?? "").trim();
  const elements = design.elements || [];
  const meaningful = elements
    .filter(e => e.type === "text")
    .map(e => sub(e.text))
    .filter(s => s && !PLACEHOLDER_TEXTS.has(s.toLowerCase()));
  if (meaningful.length) {
    const clipped = meaningful.slice(0, 2).map(s => s.length > 42 ? s.slice(0, 40) + "…" : s);
    return clipped.join(" · ");
  }
  const qr = elements.find(e => e.type === "qr" && e.data);
  if (qr) {
    const data = sub(qr.data);
    if (data) return "QR: " + (data.length > 50 ? data.slice(0, 48) + "…" : data);
  }
  // Shape-only label — summarize element counts
  const counts = { text: 0, qr: 0, rect: 0, line: 0 };
  for (const e of elements) if (counts[e.type] !== undefined) counts[e.type]++;
  const parts = [];
  if (counts.text) parts.push(`${counts.text}× tekst`);
  if (counts.rect) parts.push(`${counts.rect}× rechthoek`);
  if (counts.line) parts.push(`${counts.line}× lijn`);
  if (counts.qr) parts.push(`${counts.qr}× QR`);
  if (parts.length) return "Vormen: " + parts.join(", ");
  return raw || "(leeg label)";
}

async function openHistory() {
  historyModal.hidden = false;
  historyBody.innerHTML = "<div class='menu-empty'>Laden…</div>";
  try {
    const r = await fetch("/history?limit=50");
    const entries = await r.json();
    if (!entries.length) { historyBody.innerHTML = "<div class='history-empty'>Nog geen recente prints.</div>"; return; }
    const ul = document.createElement("ul");
    ul.className = "history-list";
    for (const e of entries) {
      const li = document.createElement("li");
      const title = document.createElement("div"); title.className = "h-title";
      title.textContent = historyDisplayTitle(e);
      const meta = document.createElement("div"); meta.className = "h-meta";
      const d = new Date(e.ts);
      meta.textContent = isNaN(d) ? e.ts : d.toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });
      const del = document.createElement("button"); del.className = "btn ghost h-del";
      del.textContent = "×"; del.title = "Verwijderen";
      del.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await fetch(`/history/${encodeURIComponent(e.id)}`, { method: "DELETE" });
        li.remove();
      });
      li.append(title, meta, del);
      li.addEventListener("click", () => {
        if (!e.design) { toast("Geen ontwerp opgeslagen", "err"); return; }
        try {
          pushUndo();
          loadFromJson(e.design, e.vars || {});
          if (e.title) document.querySelector(".doc-title").textContent = e.title;
          historyModal.hidden = true;
          toast("✓ Geladen — je kunt aanpassen en opnieuw printen", "ok");
        } catch (err) { toast("✗ Kon niet laden: " + err.message, "err"); }
      });
      ul.appendChild(li);
    }
    historyBody.innerHTML = "";
    historyBody.appendChild(ul);
  } catch (e) {
    historyBody.innerHTML = `<div class='history-empty'>Fout: ${e.message}</div>`;
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
    const [msg, cls] = formatPrintResult(j, "PDF geprint");
    toast(msg, cls);
    pollStatus();
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
  pushUndo();
  state.label.border = ev.target.checked;
  draw();
});

document.getElementById("widthSel").addEventListener("change", (ev) => {
  pushUndo();
  state.label.width_mm = +ev.target.value;
  resizeCanvas(); draw();
});
document.getElementById("orientSel").addEventListener("change", (ev) => {
  pushUndo();
  state.label.orientation = ev.target.value === "landscape" ? "landscape" : "portrait";
  resizeCanvas(); draw(); drawHandles();
});
document.getElementById("heightIn").addEventListener("input", (ev) => {
  pushUndo("labelheight");
  state.label.height_mm = Math.max(10, Math.min(200, +ev.target.value || 30));
  resizeCanvas(); draw();
});

// ============ Print ============
const STRIP_PLACEHOLDER_RE = /\{\{\s*[a-zA-Z0-9_-]+\s*\}\}/g;

const MAX_COPIES = 99;

async function printLabel(copies = 1) {
  const btn = document.getElementById("btnPrint");
  if (btn.disabled) return;
  let printed = 0;
  btn.disabled = true;
  setStatus("Printen…");
  // Ensure web fonts are loaded before rasterising the canvas, otherwise the
  // print could capture fallback glyphs with the wrong metrics.
  await fontsReady;
  // Snapshot texts/data, strip unfilled {{placeholders}} for the print raster,
  // restore after — so the canvas UI keeps its placeholder hints.
  const saved = [];
  let stripped = false;
  for (const el of state.elements) {
    if (el.type === "text" && el.text && STRIP_PLACEHOLDER_RE.test(el.text)) {
      saved.push({ id: el.id, key: "text", val: el.text });
      el.text = el.text.replace(STRIP_PLACEHOLDER_RE, "").replace(/\s+/g, " ").trim();
      stripped = true;
    }
    STRIP_PLACEHOLDER_RE.lastIndex = 0;
    if (el.type === "qr" && el.data && STRIP_PLACEHOLDER_RE.test(el.data)) {
      saved.push({ id: el.id, key: "data", val: el.data });
      el.data = el.data.replace(STRIP_PLACEHOLDER_RE, "").trim();
      stripped = true;
    }
    STRIP_PLACEHOLDER_RE.lastIndex = 0;
  }
  if (stripped) draw();
  try {
    const blob = await new Promise(res => rasterForPrint().toBlob(res, "image/png"));
    const fd = new FormData();
    fd.append("file", blob, "label.png");
    const printUrl = state.fold ? "/print/image?fold=true" : "/print/image";
    let j;
    for (let i = 1; i <= copies; i++) {
      if (copies > 1) setStatus(`Printen ${i}/${copies}…`);
      const r = await fetch(printUrl, { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      j = await r.json();
      printed = i;
    }
    const [msg, cls] = formatPrintResult(j, copies > 1 ? `${copies}× verzonden naar QL-570` : "Verzonden naar QL-570");
    toast(msg, cls);
    setStatus(j.queued ? "In wachtrij" : "Klaar");
    pollStatus();
    if (EMBED_MODE && window.parent && window.parent !== window) {
      try { window.parent.postMessage({ type: "label.printed", label_spec: j.label_spec }, "*"); } catch {}
    }
    // Log to history — silent fail, never blocks or errors the print
    try {
      fetch("/history/add", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          type: "design",
          title: (document.querySelector(".doc-title").textContent || "").trim() || "Label",
          design: designToJson(),
        }),
      }).catch(() => {});
    } catch {}
  } catch (e) {
    toast(`✗ ${printed ? `${printed} van ${copies} gelukt: ` : ""}${e.message}`, "err");
    setStatus("Fout");
  }
  // Restore texts/data so the designer keeps showing {{placeholders}}
  if (stripped) {
    for (const s of saved) {
      const el = state.elements.find(e => e.id === s.id);
      if (el) el[s.key] = s.val;
    }
    draw();
  }
  btn.disabled = false;
}
document.getElementById("btnPrint").addEventListener("click", () => printLabel());
document.getElementById("btnPrintMore").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const m = document.getElementById("printMenu");
  const wasOpen = m.classList.contains("open");
  closeMenus();
  if (!wasOpen) m.classList.add("open");
});
document.getElementById("btnPrintCopies").addEventListener("click", () => {
  closeMenus();
  const answer = prompt(`Hoeveel exemplaren? (max ${MAX_COPIES})`, "2");
  if (answer === null) return;
  const copies = Number(answer);
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
    toast(`✗ Vul een aantal in van 1 t/m ${MAX_COPIES}`, "err");
    return;
  }
  printLabel(copies);
});

// ============ Fold toggle (laminate double-side mode) ============
const _foldChk = document.getElementById("foldToggle");
const _foldWrap = document.getElementById("foldToggleWrap");

function _applyFoldUi() {
  if (!_foldChk || !_foldWrap) return;
  _foldChk.checked = !!state.fold;
  _foldWrap.classList.toggle("on", !!state.fold);
}

function _updateFoldVisibility() {
  // Only meaningful for continuous-paper labels (no die-cut media). When the
  // printer reports die-cut media, hide the toggle and force-off (a die-cut
  // label has fixed height so doubling it makes no sense).
  if (!_foldWrap) return;
  const isDieCut = state.printer && state.printer.media_type === "die-cut";
  _foldWrap.hidden = !!isDieCut;
  if (isDieCut && state.fold) {
    state.fold = false;
    try { localStorage.setItem("labelprinter.fold", "0"); } catch {}
    _applyFoldUi();
  }
}

if (_foldChk) {
  _applyFoldUi();
  _foldChk.addEventListener("change", () => {
    state.fold = !!_foldChk.checked;
    try { localStorage.setItem("labelprinter.fold", state.fold ? "1" : "0"); } catch {}
    _applyFoldUi();
    // Trigger a re-render so the user sees the preview adjust (canvas
    // doubling is purely a print-time op, so just nudge the existing draw).
    try { draw(); } catch {}
  });
}

// (preset-button removed — templates dropdown replaces it)

// ============ Printer status poll ============
async function pollStatus() {
  try {
    const r = await fetch("/status");
    const s = await r.json();
    state.printer = s;
    const chip = document.getElementById("printerChip");
    const txt = document.getElementById("printerText");
    const alert = document.getElementById("printerAlert");
    const alertQueueLine = document.getElementById("alertQueueLine");
    const queueChip = document.getElementById("queueChip");
    const queueText = document.getElementById("queueText");

    chip.classList.remove("ok", "err", "warn");
    if (!s.online) {
      chip.classList.add("err");
      txt.textContent = "Printer uit";
      alert.hidden = false;
    } else if (!s.has_media) {
      chip.classList.add("warn");
      txt.textContent = "Geen media";
      alert.hidden = true;
    } else {
      chip.classList.add("ok");
      txt.textContent = `QL-570 · ${s.media_width_mm}mm ${s.media_type}`;
      alert.hidden = true;
      // Auto-set label width to detected
      if ([62, 29, 38].includes(s.media_width_mm)) {
        const sel = document.getElementById("widthSel");
        if (+sel.value !== s.media_width_mm) {
          sel.value = String(s.media_width_mm);
          state.label.width_mm = s.media_width_mm;
          resizeCanvas(); draw();
        }
      }
    }
    _updateFoldVisibility();

    const qLen = s.queue_length || 0;
    if (qLen > 0) {
      queueChip.hidden = false;
      queueText.textContent = `${qLen} in wachtrij`;
      alertQueueLine.hidden = false;
      alertQueueLine.textContent = `${qLen} print${qLen === 1 ? "" : "s"} in wachtrij — worden automatisch verstuurd zodra de printer aan staat.`;
    } else {
      queueChip.hidden = true;
      alertQueueLine.hidden = true;
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

// Returns [message, cssClass] for a /print/* JSON response.
// Handles the queued-while-offline case: server returns {queued: true, queue_length: N}.
function formatPrintResult(j, kindLabel) {
  if (j && j.queued) {
    const n = j.queue_length || 1;
    return [`📋 Printer offline — in wachtrij (${n})`, "warn"];
  }
  const spec = (j && j.label_spec) || "?";
  return [`✓ ${kindLabel} (${spec})`, "ok"];
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
      orientation: state.label.orientation || "portrait",
    },
    title: document.querySelector(".doc-title").textContent.trim() || null,
    elements: state.elements.map(el => {
      if (el.type === "line") {
        return {
          type: "line",
          x1_mm: +pxMmX(el.x1).toFixed(2), y1_mm: +pxMm(el.y1).toFixed(2),
          x2_mm: +pxMmX(el.x2).toFixed(2), y2_mm: +pxMm(el.y2).toFixed(2),
          stroke_mm: el.stroke_mm || 0.3,
        };
      }
      const base = {
        type: el.type,
        x_mm: +pxMmX(el.x).toFixed(2),
        y_mm: +pxMm(el.y).toFixed(2),
        w_mm: +pxMmX(el.width).toFixed(2),
        h_mm: +pxMm(el.height).toFixed(2),
      };
      if (el.rot) base.rot = Math.round(el.rot);
      if (el.type === "text") Object.assign(base, {
        text: el.text, size_pt: el.size_pt,
        font: el.font || (el.mono ? "mono" : "sans"),
        bold: !!el.bold, italic: !!el.italic, mono: !!el.mono, wrap: !!el.wrap,
        color: el.color === "white" ? "white" : "black",
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
  state.label.orientation = doc.label?.orientation === "landscape" ? "landscape" : "portrait";
  document.getElementById("widthSel").value = String(state.label.width_mm);
  document.getElementById("heightIn").value = state.label.height_mm;
  document.getElementById("borderToggle").checked = state.label.border;
  const orientSel = document.getElementById("orientSel");
  if (orientSel) orientSel.value = state.label.orientation;
  if (doc.title) document.querySelector(".doc-title").textContent = substitute(doc.title, vars);
  resizeCanvas();
  for (const e of (doc.elements || [])) {
    let el;
    if (e.type === "line") {
      el = {
        id: uid(), type: "line",
        x1: mmPxX(e.x1_mm || 0), y1: mmPxY(e.y1_mm || 0),
        x2: mmPxX(e.x2_mm || 10), y2: mmPxY(e.y2_mm || 0),
        stroke_mm: e.stroke_mm ?? 0.3,
      };
    } else {
      el = {
        id: uid(), type: e.type,
        x: mmPxX(e.x_mm || 0), y: mmPxY(e.y_mm || 0),
        width: mmPxX(e.w_mm || 20), height: mmPxY(e.h_mm || 20),
        rot: e.rot || 0,
      };
      if (e.type === "text") Object.assign(el, {
        text: substitute(e.text || "", vars),
        size_pt: e.size_pt ?? 12, font: e.font || (e.mono ? "mono" : "sans"),
        bold: !!e.bold, italic: !!e.italic, mono: !!e.mono, wrap: !!e.wrap,
        color: e.color === "white" ? "white" : "black",
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
    fr.onload = () => { try { const doc = JSON.parse(fr.result); pushUndo(); loadFromJson(doc); toast("✓ Ontwerp geladen", "ok"); } catch { toast("✗ Geen geldige JSON", "err"); } };
    fr.readAsText(f);
  });
  input.click();
}

window.lp = { designToJson, exportAsJson, importFromJsonDialog, copyShareLink };

// ============ Doc title ============
const docTitle = document.querySelector(".doc-title");
// beforeinput (not input) so the snapshot still holds the pre-edit title.
docTitle.addEventListener("beforeinput", () => pushUndo("doctitle"));
docTitle.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); docTitle.blur(); }
  if (ev.key === "Escape") { ev.preventDefault(); docTitle.blur(); }
});
docTitle.addEventListener("paste", (ev) => {
  ev.preventDefault();
  const text = (ev.clipboardData || window.clipboardData).getData("text").replace(/[\r\n]+/g, " ");
  document.execCommand("insertText", false, text);
});

// ============ Queue (offline-print) ============
const queueModal = document.getElementById("queueModal");
const queueBody = document.getElementById("queueBody");

function openQueue() {
  queueModal.hidden = false;
  loadQueue();
}
function closeQueue() { queueModal.hidden = true; }

async function loadQueue() {
  queueBody.innerHTML = '<div class="menu-empty">Laden…</div>';
  try {
    const r = await fetch("/queue");
    const j = await r.json();
    if (!j.items.length) {
      queueBody.innerHTML = '<div class="menu-empty">Geen items in wachtrij.</div>';
      return;
    }
    queueBody.innerHTML = '<ul class="layer-list">' + j.items.map(it => `
      <li>
        <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          <strong>${escapeHtml(it.title || "(zonder titel)")}</strong>
          <span class="muted small"> · ${escapeHtml(it.kind || "")} · ${it.design_width_mm || "?"}mm</span>
        </span>
        <button class="btn icon" data-qid="${it.id}" title="Verwijderen uit wachtrij">×</button>
      </li>`).join("") + "</ul>";
    queueBody.querySelectorAll("button[data-qid]").forEach(btn => {
      btn.addEventListener("click", async () => {
        await fetch("/queue/" + btn.dataset.qid, { method: "DELETE" });
        loadQueue(); pollStatus();
      });
    });
  } catch (e) {
    queueBody.innerHTML = `<div class="menu-empty">Fout: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

document.getElementById("queueChip").addEventListener("click", openQueue);
document.getElementById("queueClose").addEventListener("click", closeQueue);
queueModal.addEventListener("click", (ev) => { if (ev.target === queueModal) closeQueue(); });

document.getElementById("queueClear").addEventListener("click", async () => {
  if (!confirm("Wachtrij volledig leegmaken? Dit verwijdert alle queued prints.")) return;
  await fetch("/queue", { method: "DELETE" });
  loadQueue(); pollStatus();
});

document.getElementById("queueFlush").addEventListener("click", async () => {
  const r = await fetch("/queue/flush", { method: "POST" });
  const j = await r.json();
  if (j.drained > 0) {
    toast(`✓ ${j.drained} uit wachtrij geprint`, "ok");
  } else if (j.remaining > 0) {
    toast(`Kon nu niet printen — ${j.remaining} blijft in wachtrij`, "warn");
  } else {
    toast("Wachtrij is leeg", "");
  }
  loadQueue(); pollStatus();
});

// "Opnieuw proberen" button in offline-alert tries to flush + re-poll status.
document.getElementById("alertRetry").addEventListener("click", async () => {
  const btn = document.getElementById("alertRetry");
  btn.disabled = true;
  try {
    await fetch("/queue/flush", { method: "POST" }).catch(() => {});
  } finally {
    await pollStatus();
    btn.disabled = false;
  }
});

// ============ Init ============
resizeCanvas();
draw();
refreshLayers();
updateUndoUi();
loadFonts();
pollStatus();
// Poll faster while alert is showing so the offline → online transition is snappy.
setInterval(() => {
  const fast = !document.getElementById("printerAlert").hidden
            || (state.printer && state.printer.queue_length > 0);
  if (fast) pollStatus();
}, 3000);
setInterval(pollStatus, 10000);
loadFromUrl();

window.addEventListener("resize", () => { applyZoom(); drawHandles(); });
