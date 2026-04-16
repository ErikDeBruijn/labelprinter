"""Label printer web service + REST API."""
from __future__ import annotations

from pathlib import Path

import io
import json
import re
import subprocess
import tempfile

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from PIL import Image

from . import printer, render

app = FastAPI(title="Labelprinter", docs_url="/api")
TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"
DATA_DIR = Path("/opt/labelprinter/data")
LABEL_TEMPLATES_DIR = DATA_DIR / "templates"
LABEL_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

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


@app.get("/status")
def status() -> dict:
    s = printer.query_status()
    return {
        "media_width_mm": s.media_width_mm,
        "media_length_mm": s.media_length_mm,
        "media_type": s.media_type,
        "has_media": s.has_media,
        "label_spec": s.label_spec,
        "errors": list(s.errors),
        "raw_hex": s.raw_hex,
    }


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
def render_png(payload: DesignIn) -> Response:
    """Render a label to PNG without printing. Used for live preview."""
    img = render.render(_spec_from(payload))
    return Response(content=render.to_png_bytes(img), media_type="image/png")


@app.post("/print/design")
def print_design(payload: DesignIn) -> dict:
    s = printer.query_status()
    if not s.has_media:
        raise HTTPException(400, f"No media detected ({s.media_type})")
    img = render.render(_spec_from(payload))
    printer.print_image(img, s.label_spec)
    return {"ok": True, "label_spec": s.label_spec}


class PrintDesignIn(BaseModel):
    design: dict
    vars: dict = Field(default_factory=dict)
    preview: bool = False  # if true, return PNG instead of printing


@app.post("/print/from-design")
async def print_from_design(payload: PrintDesignIn):
    """Print from a design JSON (same format as the browser designer).

    JSON body:
    {
      "design": { "label": {...}, "elements": [...] },
      "vars":   { "foo": "bar", ... },
      "preview": false
    }
    """
    img = render.render_design(payload.design, payload.vars)
    if payload.preview:
        return Response(content=render.to_png_bytes(img), media_type="image/png")
    s = printer.query_status()
    if not s.has_media:
        raise HTTPException(400, f"No media detected ({s.media_type})")
    printer.print_image(img, s.label_spec)
    return {"ok": True, "label_spec": s.label_spec, "pixels": [img.width, img.height]}


@app.post("/print/image")
async def print_image_endpoint(file: UploadFile = File(...)) -> dict:
    """Print a PNG/JPG uploaded directly. Used by the canvas-based designer."""
    s = printer.query_status()
    if not s.has_media:
        raise HTTPException(400, f"No media detected ({s.media_type})")
    data = await file.read()
    img = Image.open(io.BytesIO(data)).convert("L")
    # Ensure image width matches printable width for this label
    from .render import PRINTABLE_PX
    target_w = PRINTABLE_PX.get(s.media_width_mm, img.width)
    if img.width != target_w:
        ratio = target_w / img.width
        img = img.resize((target_w, round(img.height * ratio)), Image.LANCZOS)
    printer.print_image(img, s.label_spec)
    return {"ok": True, "label_spec": s.label_spec, "printed_size": [img.width, img.height]}


@app.post("/print/test")
def print_test() -> dict:
    s = printer.query_status()
    if not s.has_media:
        raise HTTPException(400, f"No media detected ({s.media_type})")
    spec = render.LabelSpec(
        width_mm=s.media_width_mm,
        height_mm=25,
        lines=[
            render.TextLine("Testprint ✓", 22, bold=True),
            render.TextLine(f"{s.media_width_mm}mm {s.media_type}", 12),
        ],
        qr_data="https://example.com",
    )
    img = render.render(spec)
    printer.print_image(img, s.label_spec)
    return {"ok": True, "label_spec": s.label_spec}


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
def print_template(name: str, vars: dict = None):
    doc = get_template(name)
    img = render.render_design(doc, vars or {})
    s = printer.query_status()
    if not s.has_media:
        raise HTTPException(400, f"No media detected ({s.media_type})")
    printer.print_image(img, s.label_spec)
    return {"ok": True, "label_spec": s.label_spec, "template": name}


# ---- PDF ----

def _pdf_to_png(pdf_bytes: bytes, dpi: int = 300) -> Image.Image:
    """Rasterize first page of a PDF to a grayscale PIL Image using pdftoppm."""
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
    """Crop an image to its non-white content bounding box with a small margin."""
    inv = Image.eval(img, lambda p: 255 - p)  # invert so content is non-zero
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
    """Rasterize uploaded PDF to PNG. Used for preview before printing."""
    data = await file.read()
    img = _pdf_to_png(data)
    if crop:
        img = _crop_to_content(img)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@app.post("/print/pdf")
async def print_pdf(file: UploadFile = File(...), crop: bool = True) -> dict:
    """Rasterize + scale + print a PDF."""
    s = printer.query_status()
    if not s.has_media:
        raise HTTPException(400, f"No media detected ({s.media_type})")

    data = await file.read()
    img = _pdf_to_png(data)
    if crop:
        img = _crop_to_content(img)

    from .render import PRINTABLE_PX
    target_w = PRINTABLE_PX.get(s.media_width_mm, img.width)
    if img.width != target_w:
        ratio = target_w / img.width
        img = img.resize((target_w, round(img.height * ratio)), Image.LANCZOS)
    printer.print_image(img, s.label_spec)
    return {"ok": True, "label_spec": s.label_spec, "pixels": [img.width, img.height]}


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    html = (TEMPLATES_DIR / "index.html").read_text(encoding="utf-8")
    # Cache-bust static assets using file mtimes so dev iterations show up.
    css_v = int((STATIC_DIR / "app.css").stat().st_mtime)
    js_v = int((STATIC_DIR / "app.js").stat().st_mtime)
    return (html
            .replace("/static/app.css", f"/static/app.css?v={css_v}")
            .replace("/static/app.js", f"/static/app.js?v={js_v}"))
