"""Label printer web service + REST API.

Robust to a powered-off / disconnected printer:
- /status reports `online` + `queue_length`.
- /print/* endpoints queue the rendered label when the printer is offline and
  return `{queued: true, queue: {...}}` instead of raising.
- A background task drains the queue once the printer returns.
"""
from __future__ import annotations

from pathlib import Path

import asyncio
import io
import json
import logging
import os
import re
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from PIL import Image

from . import printer, render

log = logging.getLogger("labelprinter")

app = FastAPI(title="Labelprinter", docs_url="/api")
TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"
DATA_DIR = Path(os.environ.get("LABELPRINTER_DATA", "/opt/labelprinter/data"))
LABEL_TEMPLATES_DIR = DATA_DIR / "templates"
LABEL_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
QUEUE_DIR = DATA_DIR / "queue"
QUEUE_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def reject_cross_origin_writes(request: Request, call_next):
    """Stop other websites from printing through a visitor's browser.

    Browsers send Origin on every cross-site POST, even when CORS would hide the
    response. Server-side clients send no Origin and are not affected.
    """
    origin = request.headers.get("origin")
    if (request.method not in ("GET", "HEAD", "OPTIONS") and origin
            and urlsplit(origin).netloc != request.headers.get("host")):
        return JSONResponse({"detail": "Cross-origin request rejected"}, status_code=403)
    return await call_next(request)


_TEMPLATE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,48}$")


def _tpl_path(name: str) -> Path:
    if not _TEMPLATE_NAME_RE.match(name):
        raise HTTPException(400, "Template name must match [a-z0-9_-]")
    return LABEL_TEMPLATES_DIR / f"{name}.json"


class TextLineIn(BaseModel):
    text: str = ""
    size_pt: int = Field(14, ge=6, le=96)
    bold: bool = False
    italic: bool = False
    mono: bool = False
    font: str = ""


class DesignIn(BaseModel):
    width_mm: int = 62
    height_mm: int = 30
    lines: list[TextLineIn] = Field(default_factory=list)
    qr_data: str = ""
    qr_size_mm: int = 0
    padding_mm: float = 2.0


def _spec_from(payload: DesignIn) -> render.LabelSpec:
    return render.LabelSpec(
        width_mm=payload.width_mm,
        height_mm=payload.height_mm,
        lines=[render.TextLine(**l.model_dump()) for l in payload.lines],
        qr_data=payload.qr_data,
        qr_size_mm=payload.qr_size_mm,
        padding_mm=payload.padding_mm,
    )


# =================================================================
# Print queue (used when the printer is offline)
# =================================================================

def _queue_enqueue(img: Image.Image, *, kind: str, title: str, design_width_mm: int,
                   extra: dict | None = None) -> dict:
    qid = uuid.uuid4().hex[:12]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    base = QUEUE_DIR / f"{stamp}_{qid}"
    img.save(base.with_suffix(".png"))
    meta = {
        "id": qid,
        "ts": datetime.now(timezone.utc).isoformat(),
        "title": (title or "")[:120],
        "kind": kind,
        "design_width_mm": int(design_width_mm),
        "pixels": [img.width, img.height],
    }
    if extra:
        meta.update(extra)
    base.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False))
    log.info("queued print id=%s title=%r kind=%s w=%dmm", qid, title, kind, design_width_mm)
    return meta


def _queue_paths_for(qid: str) -> list[Path]:
    return list(QUEUE_DIR.glob(f"*_{qid}.png")) + list(QUEUE_DIR.glob(f"*_{qid}.json"))


def _queue_list() -> list[dict]:
    out: list[dict] = []
    for p in sorted(QUEUE_DIR.glob("*.json")):
        try:
            out.append(json.loads(p.read_text()))
        except Exception:
            continue
    return out


def _queue_length() -> int:
    return sum(1 for _ in QUEUE_DIR.glob("*.png"))


def _queue_remove(qid: str) -> int:
    n = 0
    for p in _queue_paths_for(qid):
        try:
            p.unlink()
            n += 1
        except OSError:
            pass
    return n


def _queue_oldest() -> tuple[dict, Path] | None:
    pngs = sorted(QUEUE_DIR.glob("*.png"))
    for png in pngs:
        meta_path = png.with_suffix(".json")
        if meta_path.exists():
            try:
                return json.loads(meta_path.read_text()), png
            except Exception:
                continue
    return None


def _print_or_queue(img: Image.Image, *, kind: str, title: str,
                    design_width_mm: int, extra: dict | None = None) -> dict:
    """Print the image now, or queue it for later if the printer is offline.

    Raises HTTPException(400) if the printer is online but media is missing,
    and HTTPException(409) on width mismatch.
    """
    s = printer.query_status()
    if s.online and not s.has_media:
        raise HTTPException(400, "Geen labelrol gedetecteerd. Plaats of vervang de DK-rol.")
    if s.online and s.has_media:
        if s.media_width_mm != design_width_mm:
            raise HTTPException(
                409,
                f"De geladen rol is {s.media_width_mm}mm, het ontwerp is {design_width_mm}mm. "
                "Wissel van rol of pas het ontwerp aan.",
            )
        try:
            printer.print_image(img, s.label_spec)
            log.info("printed kind=%s title=%r w=%dmm pixels=%dx%d",
                     kind, title, design_width_mm, img.width, img.height)
            return {"ok": True, "queued": False, "label_spec": s.label_spec,
                    "pixels": [img.width, img.height]}
        except printer.PrinterOffline as e:
            log.warning("printer went offline mid-print: %s — queueing", e)
    meta = _queue_enqueue(img, kind=kind, title=title,
                          design_width_mm=design_width_mm, extra=extra)
    return {"ok": True, "queued": True, "queue": meta, "queue_length": _queue_length()}


# =================================================================
# Endpoints
# =================================================================

@app.get("/status")
def status() -> dict:
    s = printer.query_status()
    return {
        "online": s.online,
        "media_width_mm": s.media_width_mm,
        "media_length_mm": s.media_length_mm,
        "media_type": s.media_type,
        "has_media": s.has_media,
        "label_spec": s.label_spec,
        "errors": list(s.errors),
        "raw_hex": s.raw_hex,
        "queue_length": _queue_length(),
    }


@app.get("/queue")
def queue_list() -> dict:
    items = _queue_list()
    return {"length": len(items), "items": items}


@app.delete("/queue")
def queue_clear() -> dict:
    n = 0
    for p in list(QUEUE_DIR.glob("*.png")) + list(QUEUE_DIR.glob("*.json")):
        try:
            p.unlink()
            n += 1
        except OSError:
            pass
    return {"ok": True, "removed": n}


@app.delete("/queue/{qid}")
def queue_delete(qid: str) -> dict:
    if not re.match(r"^[a-f0-9]{6,32}$", qid):
        raise HTTPException(400, "invalid id")
    return {"ok": True, "removed": _queue_remove(qid)}


@app.post("/queue/flush")
async def queue_flush() -> dict:
    """Manually try to drain the queue once. Useful right after powering on the printer."""
    drained, errors = await asyncio.get_event_loop().run_in_executor(None, _drain_once)
    return {"ok": True, "drained": drained, "errors": errors,
            "remaining": _queue_length()}


@app.get("/fonts")
def fonts() -> list[dict]:
    """Font registry for the browser designer (dropdown + @font-face)."""
    return render.font_registry_for_api()


@app.get("/qr")
def qr_png(data: str, size: int = 200) -> Response:
    """Render a QR code to PNG. Used by the canvas designer for live preview."""
    import qrcode
    from io import BytesIO
    qr = qrcode.QRCode(border=0, box_size=4, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("L")
    size = max(32, min(size, 1000))
    img = img.resize((size, size), Image.NEAREST)
    buf = BytesIO()
    img.save(buf, "PNG")
    return Response(content=buf.getvalue(), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.post("/render")
def render_png(payload: DesignIn, fold: bool = False) -> Response:
    img = render.render(_spec_from(payload))
    if fold:
        img = render.apply_fold(img)
    return Response(content=render.to_png_bytes(img), media_type="image/png")


@app.post("/print/design")
def print_design(payload: DesignIn, fold: bool = False) -> dict:
    img = render.render(_spec_from(payload))
    if fold:
        img = render.apply_fold(img)
    return _print_or_queue(img, kind="design+fold" if fold else "design",
                           title="design",
                           design_width_mm=payload.width_mm)


class PrintDesignIn(BaseModel):
    design: dict
    vars: dict = Field(default_factory=dict)
    preview: bool = False
    fold: bool = False


@app.post("/print/from-design")
async def print_from_design(payload: PrintDesignIn):
    """Print from a design JSON (same format as the browser designer)."""
    img = render.render_design(payload.design, payload.vars)
    if payload.fold:
        img = render.apply_fold(img)
    if payload.preview:
        return Response(content=render.to_png_bytes(img), media_type="image/png")
    width_mm = int(payload.design.get("label", {}).get("width_mm", 62))
    title = (payload.design.get("title")
             or payload.vars.get("title")
             or _first_text(payload.design)
             or "label")
    kind = "from-design+fold" if payload.fold else "from-design"
    return _print_or_queue(img, kind=kind, title=title,
                           design_width_mm=width_mm)


def _first_text(design: dict) -> str:
    for el in design.get("elements", []):
        if el.get("type") == "text" and el.get("text"):
            return str(el["text"])[:60]
    return ""


def _prepare_image(data: bytes, label_width_mm: int, dither: bool = False) -> Image.Image:
    from .render import PRINTABLE_PX
    img = Image.open(io.BytesIO(data)).convert("L")
    target_w = PRINTABLE_PX.get(label_width_mm, img.width)
    if img.width != target_w:
        ratio = target_w / img.width
        img = img.resize((target_w, round(img.height * ratio)), Image.LANCZOS)
    if dither:
        img = img.convert("1").convert("L")
    return img


@app.post("/print/image")
async def print_image_endpoint(file: UploadFile = File(...), dither: bool = False,
                               fold: bool = False) -> dict:
    s = printer.query_status()
    target_w = s.media_width_mm if s.has_media else 62
    data = await file.read()
    img = _prepare_image(data, target_w, dither=dither)
    if fold:
        img = render.apply_fold(img)
    return _print_or_queue(img, kind="image+fold" if fold else "image",
                           title=file.filename or "image",
                           design_width_mm=target_w)


@app.post("/image/preview")
async def image_preview(file: UploadFile = File(...), dither: bool = False,
                        fold: bool = False) -> Response:
    data = await file.read()
    s = printer.query_status()
    label_w = s.media_width_mm if s.has_media else 62
    img = _prepare_image(data, label_w, dither=dither)
    if fold:
        img = render.apply_fold(img)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


# ---- Print history ----
HISTORY_FILE = DATA_DIR / "history.jsonl"
MAX_HISTORY = 100


def _history_append(entry: dict) -> None:
    try:
        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        with HISTORY_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        _history_trim()
    except Exception:
        pass


def _history_trim() -> None:
    try:
        text = HISTORY_FILE.read_text(encoding="utf-8")
        lines = [l for l in text.splitlines() if l.strip()]
        if len(lines) > MAX_HISTORY:
            HISTORY_FILE.write_text("\n".join(lines[-MAX_HISTORY:]) + "\n", encoding="utf-8")
    except Exception:
        pass


def _history_read() -> list[dict]:
    try:
        text = HISTORY_FILE.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    out: list[dict] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


@app.post("/history/add")
def history_add(entry: dict) -> dict:
    safe = {
        "id": str(uuid.uuid4()),
        "ts": datetime.now(timezone.utc).isoformat(),
        "title": str(entry.get("title", ""))[:120],
        "type": str(entry.get("type", "design"))[:20],
        "design": entry.get("design") if isinstance(entry.get("design"), dict) else None,
        "template_name": str(entry.get("template_name", ""))[:48] or None,
        "vars": entry.get("vars") if isinstance(entry.get("vars"), dict) else None,
    }
    _history_append(safe)
    return {"ok": True, "id": safe["id"]}


@app.get("/history")
def history_list(limit: int = 50) -> list[dict]:
    entries = _history_read()
    entries.reverse()
    return entries[: max(1, min(limit, MAX_HISTORY))]


@app.delete("/history/{entry_id}")
def history_delete(entry_id: str) -> dict:
    entries = _history_read()
    before = len(entries)
    kept = [e for e in entries if e.get("id") != entry_id]
    if len(kept) != before:
        try:
            HISTORY_FILE.write_text(
                "\n".join(json.dumps(e, ensure_ascii=False) for e in kept) + ("\n" if kept else ""),
                encoding="utf-8",
            )
        except Exception as e:
            raise HTTPException(500, str(e))
    return {"ok": True, "deleted": before - len(kept)}


@app.post("/print/test")
def print_test() -> dict:
    s = printer.query_status()
    width_mm = s.media_width_mm if s.has_media else 62
    spec = render.LabelSpec(
        width_mm=width_mm,
        height_mm=25,
        lines=[
            render.TextLine("Testprint ✓", 22, bold=True),
            render.TextLine(f"{width_mm}mm", 12),
        ],
        qr_data="https://example.com",
    )
    img = render.render(spec)
    return _print_or_queue(img, kind="test", title="Testprint", design_width_mm=width_mm)


# ---- Template CRUD ----

@app.get("/templates")
def list_templates() -> list[dict]:
    out = []
    for p in sorted(LABEL_TEMPLATES_DIR.glob("*.json")):
        try:
            doc = json.loads(p.read_text())
            out.append({
                "name": p.stem,
                "title": doc.get("title") or p.stem,
                "width_mm": doc.get("label", {}).get("width_mm"),
                "height_mm": doc.get("label", {}).get("height_mm"),
            })
        except Exception:
            continue
    return out


@app.get("/templates/{name}")
def get_template(name: str) -> dict:
    p = _tpl_path(name)
    if not p.exists():
        raise HTTPException(404, f"Template '{name}' not found")
    return json.loads(p.read_text())


@app.get("/templates/{name}/thumbnail")
def template_thumbnail(name: str) -> Response:
    """Small PNG of a template, with each {{placeholder}} showing its own name."""
    doc = get_template(name)
    names = render._PLACEHOLDER_RE.findall(json.dumps(doc, ensure_ascii=False))
    img = render.render_design(doc, {n: n for n in names})
    if doc.get("label", {}).get("orientation") == "landscape":
        img = img.transpose(Image.ROTATE_90)  # read it as designed, not as it runs on the tape
    img.thumbnail((144, 96))
    return Response(content=render.to_png_bytes(img), media_type="image/png")


@app.put("/templates/{name}")
def put_template(name: str, doc: dict) -> dict:
    _tpl_path(name).write_text(json.dumps(doc, ensure_ascii=False, indent=2))
    return {"ok": True, "name": name}


@app.delete("/templates/{name}")
def delete_template(name: str) -> dict:
    p = _tpl_path(name)
    if p.exists():
        p.unlink()
    return {"ok": True, "name": name}


@app.post("/print/template/{name}")
def print_template(name: str, vars: dict = None, fold: bool = False):
    doc = get_template(name)
    img = render.render_design(doc, vars or {})
    if fold:
        img = render.apply_fold(img)
    width_mm = int(doc.get("label", {}).get("width_mm", 62))
    kind = "template+fold" if fold else "template"
    return _print_or_queue(img, kind=kind, title=name,
                           design_width_mm=width_mm,
                           extra={"template_name": name, "vars": vars or {},
                                  "fold": bool(fold)})


# ---- PDF ----

def _pdf_to_png(pdf_bytes: bytes, dpi: int = 300) -> Image.Image:
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        pdf_path = td_path / "in.pdf"
        pdf_path.write_bytes(pdf_bytes)
        subprocess.run(
            ["pdftoppm", "-r", str(dpi), "-gray", "-png", "-f", "1", "-l", "1",
             str(pdf_path), str(td_path / "page")],
            check=True, capture_output=True,
        )
        outs = sorted(td_path.glob("page*.png"))
        if not outs:
            raise HTTPException(500, "pdftoppm produced no output")
        return Image.open(outs[0]).convert("L")


def _crop_to_content(img: Image.Image, pad_mm: float = 1.0) -> Image.Image:
    inv = Image.eval(img, lambda p: 255 - p)
    bbox = inv.getbbox()
    if not bbox:
        return img
    pad_px = round(pad_mm * img.info.get("dpi", (300, 300))[0] / 25.4) if img.info.get("dpi") else round(pad_mm * 300 / 25.4)
    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - pad_px); y0 = max(0, y0 - pad_px)
    x1 = min(img.width, x1 + pad_px); y1 = min(img.height, y1 + pad_px)
    return img.crop((x0, y0, x1, y1))


@app.post("/pdf/preview")
async def pdf_preview(file: UploadFile = File(...), crop: bool = True) -> Response:
    data = await file.read()
    img = _pdf_to_png(data)
    if crop:
        img = _crop_to_content(img)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@app.post("/print/pdf")
async def print_pdf(file: UploadFile = File(...), crop: bool = True) -> dict:
    s = printer.query_status()
    width_mm = s.media_width_mm if s.has_media else 62
    data = await file.read()
    img = _pdf_to_png(data)
    if crop:
        img = _crop_to_content(img)
    from .render import PRINTABLE_PX
    target_w = PRINTABLE_PX.get(width_mm, img.width)
    if img.width != target_w:
        ratio = target_w / img.width
        img = img.resize((target_w, round(img.height * ratio)), Image.LANCZOS)
    return _print_or_queue(img, kind="pdf", title=file.filename or "pdf",
                           design_width_mm=width_mm)


# =================================================================
# Background drain task
# =================================================================

def _drain_once() -> tuple[int, int]:
    """Try to drain the queue. Returns (drained_count, error_count)."""
    drained = 0
    errors = 0
    while True:
        s = printer.query_status()
        if not (s.online and s.has_media):
            break
        item = _queue_oldest()
        if not item:
            break
        meta, png_path = item
        if meta.get("design_width_mm") and meta["design_width_mm"] != s.media_width_mm:
            log.info("queue item id=%s width mismatch (design %dmm vs loaded %dmm), skipping drain",
                     meta.get("id"), meta["design_width_mm"], s.media_width_mm)
            break  # leave queue alone — wrong label loaded
        try:
            img = Image.open(png_path).convert("L")
            printer.print_image(img, s.label_spec)
            _history_append({
                "id": meta.get("id"),
                "ts": datetime.now(timezone.utc).isoformat(),
                "title": meta.get("title", ""),
                "type": "queued-" + meta.get("kind", "design"),
                "template_name": meta.get("template_name"),
                "vars": meta.get("vars"),
                "design": None,
            })
            _queue_remove(meta["id"])
            drained += 1
            log.info("drained queue item id=%s title=%r", meta.get("id"), meta.get("title"))
        except printer.PrinterOffline:
            log.warning("drain interrupted: printer offline mid-write")
            break
        except Exception as e:
            log.exception("drain error for id=%s: %s", meta.get("id"), e)
            errors += 1
            break
    return drained, errors


_drain_task: asyncio.Task | None = None


async def _drain_loop():
    await asyncio.sleep(2)  # let app finish startup
    while True:
        try:
            if _queue_length() > 0:
                await asyncio.get_event_loop().run_in_executor(None, _drain_once)
        except Exception as e:
            log.exception("drain loop error: %s", e)
        await asyncio.sleep(5)


@app.on_event("startup")
async def _on_startup():
    global _drain_task
    _drain_task = asyncio.create_task(_drain_loop())
    log.info("labelprinter started (queue dir=%s, items=%d)", QUEUE_DIR, _queue_length())


@app.on_event("shutdown")
async def _on_shutdown():
    global _drain_task
    if _drain_task:
        _drain_task.cancel()


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    html = (TEMPLATES_DIR / "index.html").read_text(encoding="utf-8")
    css_v = int((STATIC_DIR / "app.css").stat().st_mtime)
    js_v = int((STATIC_DIR / "app.js").stat().st_mtime)
    return (html
            .replace("/static/app.css", f"/static/app.css?v={css_v}")
            .replace("/static/app.js", f"/static/app.js?v={js_v}"))
