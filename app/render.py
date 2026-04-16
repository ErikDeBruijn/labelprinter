"""Label rendering from structured parameters. Server is source of truth."""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Literal

import qrcode
from PIL import Image, ImageDraw, ImageFont

DPI = 300
MM_PER_INCH = 25.4

# Printable widths in pixels at 300 DPI (Brother QL-570 specs)
PRINTABLE_PX = {
    62: 696,   # DK-22205 continuous 62mm
    29: 306,   # 29mm continuous / die-cut
    38: 413,   # 38mm continuous
}

FONT_SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_ITALIC = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf"
FONT_BOLD_ITALIC = "/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf"
FONT_MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"


def mm_to_px(mm: float) -> int:
    return round(mm * DPI / MM_PER_INCH)


@dataclass
class TextLine:
    text: str
    size_pt: int = 14
    bold: bool = False
    italic: bool = False
    mono: bool = False


@dataclass
class LabelSpec:
    """Design input for a label."""
    width_mm: int
    height_mm: int  # for continuous, this is requested; for die-cut, physical
    lines: list[TextLine] = field(default_factory=list)
    qr_data: str = ""
    qr_size_mm: int = 0  # 0 = auto (fit vertical - padding)
    padding_mm: float = 2.0


def _font(line: TextLine) -> ImageFont.FreeTypeFont:
    size_px = round(line.size_pt * DPI / 72)
    if line.mono:
        path = FONT_MONO
    elif line.bold:
        path = FONT_BOLD
    elif line.italic:
        path = FONT_ITALIC
    else:
        path = FONT_SANS
    return ImageFont.truetype(path, size_px)


def render(spec: LabelSpec) -> Image.Image:
    w = PRINTABLE_PX.get(spec.width_mm) or mm_to_px(spec.width_mm)
    h = mm_to_px(spec.height_mm)
    img = Image.new("L", (w, h), 255)
    draw = ImageDraw.Draw(img)

    pad = mm_to_px(spec.padding_mm)

    # QR code on the left if present
    qr_w = 0
    if spec.qr_data:
        qr_size_px = mm_to_px(spec.qr_size_mm) if spec.qr_size_mm > 0 else (h - 2 * pad)
        qr_size_px = max(mm_to_px(8), min(qr_size_px, h - 2 * pad))
        qr = qrcode.QRCode(border=0, box_size=4, error_correction=qrcode.constants.ERROR_CORRECT_M)
        qr.add_data(spec.qr_data)
        qr.make(fit=True)
        qr_img = qr.make_image(fill_color="black", back_color="white").convert("L")
        qr_img = qr_img.resize((qr_size_px, qr_size_px), Image.NEAREST)
        img.paste(qr_img, (pad, pad))
        qr_w = qr_size_px + pad

    # Text lines, stacked vertically in the remaining area
    text_x = pad + qr_w
    max_text_w = w - text_x - pad
    total_h = 0
    rendered = []
    for line in spec.lines:
        if not line.text:
            continue
        font = _font(line)
        bbox = draw.textbbox((0, 0), line.text, font=font)
        lh = bbox[3] - bbox[1]
        rendered.append((line.text, font, lh))
        total_h += lh + mm_to_px(0.8)

    if rendered:
        y = max(pad, (h - total_h) // 2)
        for text, font, lh in rendered:
            truncated = _truncate(draw, text, font, max_text_w)
            draw.text((text_x, y), truncated, font=font, fill=0)
            y += lh + mm_to_px(0.8)

    return img


def _truncate(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_w: int) -> str:
    if draw.textbbox((0, 0), text, font=font)[2] <= max_w:
        return text
    for i in range(len(text), 0, -1):
        t = text[:i] + "…"
        if draw.textbbox((0, 0), t, font=font)[2] <= max_w:
            return t
    return "…"


def to_png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


# ---- Design-JSON rendering (same format as browser designer) ----

import re

_PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}")


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_w: int) -> list[str]:
    if not text:
        return [""]
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = (cur + " " + w) if cur else w
        width = draw.textbbox((0, 0), trial, font=font)[2]
        if width > max_w and cur:
            lines.append(cur)
            cur = w
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines or [""]


def _sub(text: str, vars: dict) -> str:
    if not text:
        return text
    return _PLACEHOLDER_RE.sub(lambda m: str(vars.get(m.group(1), m.group(0))), text)


def _font_for(size_pt: int, bold: bool, italic: bool, mono: bool) -> ImageFont.FreeTypeFont:
    size_px = round(size_pt * DPI / 72)
    if mono:
        path = FONT_MONO
    elif bold and italic:
        path = FONT_BOLD_ITALIC
    elif bold:
        path = FONT_BOLD
    elif italic:
        path = FONT_ITALIC
    else:
        path = FONT_SANS
    return ImageFont.truetype(path, size_px)


def render_design(design: dict, vars: dict | None = None) -> Image.Image:
    """Render a design in the same JSON format produced by the browser app."""
    vars = vars or {}
    label = design.get("label", {})
    w_mm = int(label.get("width_mm", 62))
    h_mm = int(label.get("height_mm", 30))
    w = PRINTABLE_PX.get(w_mm) or mm_to_px(w_mm)
    h = mm_to_px(h_mm)
    img = Image.new("L", (w, h), 255)
    draw = ImageDraw.Draw(img)

    for el in design.get("elements", []):
        t = el.get("type")
        if t == "line":
            x1 = mm_to_px(el.get("x1_mm", 0))
            y1 = mm_to_px(el.get("y1_mm", 0))
            x2 = mm_to_px(el.get("x2_mm", 0))
            y2 = mm_to_px(el.get("y2_mm", 0))
            sw = max(1, mm_to_px(float(el.get("stroke_mm", 0.3))))
            draw.line([(x1, y1), (x2, y2)], fill=0, width=sw)
            continue

        x = mm_to_px(el.get("x_mm", 0))
        y = mm_to_px(el.get("y_mm", 0))
        ew = mm_to_px(el.get("w_mm", 0))
        eh = mm_to_px(el.get("h_mm", 0))

        if t == "rect":
            sw = max(1, mm_to_px(float(el.get("stroke_mm", 0.3))))
            if el.get("fill"):
                draw.rectangle([(x, y), (x + ew - 1, y + eh - 1)], fill=0)
            if el.get("stroke", True):
                half = sw // 2
                draw.rectangle(
                    [(x + half, y + half), (x + ew - half - 1, y + eh - half - 1)],
                    outline=0, width=sw,
                )
            continue

        if t == "text":
            text = _sub(el.get("text", ""), vars)
            size_pt = int(el.get("size_pt", 12))
            font = _font_for(size_pt, bool(el.get("bold")),
                             bool(el.get("italic")), bool(el.get("mono")))
            lines = _wrap_text(draw, text, font, ew) if ew > 0 else [text]
            size_px = round(size_pt * DPI / 72)
            line_h = round(size_px * 1.2)
            for i, line in enumerate(lines):
                draw.text((x, y + i * line_h), line, font=font, fill=0)
        elif t == "qr":
            data = _sub(el.get("data", ""), vars)
            import qrcode
            qr = qrcode.QRCode(border=0, box_size=4,
                               error_correction=qrcode.constants.ERROR_CORRECT_M)
            qr.add_data(data or " ")
            qr.make(fit=True)
            qr_img = qr.make_image(fill_color="black", back_color="white").convert("L")
            size = max(20, min(ew, eh))
            qr_img = qr_img.resize((size, size), Image.NEAREST)
            img.paste(qr_img, (x, y))

    if label.get("border"):
        stroke = max(1, mm_to_px(float(label.get("border_mm", 0.3))))
        half = stroke // 2
        draw.rectangle(
            [(half, half), (w - half - 1, h - half - 1)],
            outline=0, width=stroke,
        )
    return img
