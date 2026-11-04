"""Label rendering from structured parameters. Server is source of truth."""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import qrcode
from PIL import Image, ImageChops, ImageDraw, ImageFont

DPI = 300
MM_PER_INCH = 25.4

# Printable widths in pixels at 300 DPI (Brother QL-570 specs)
PRINTABLE_PX = {
    62: 696,   # DK-22205 continuous 62mm
    29: 306,   # 29mm continuous / die-cut
    38: 413,   # 38mm continuous
}

# ---- Font registry -------------------------------------------------------
# Single source of truth for fonts, shared between PIL rendering (here) and the
# browser canvas preview (the /fonts endpoint serves this as @font-face rules).
# Fonts are bundled in static/fonts so the app is self-contained and preview ==
# print: the canvas draws with the exact same files PIL rasterises with.
#
# Each family maps the four (bold, italic) style combinations to a file. Where a
# family lacks a real variant (e.g. Bebas Neue has only one weight) the request
# falls back to the nearest available file, and the browser is told to do the
# same — so it never synthesises a fake bold/italic that the print wouldn't have.
FONTS_DIR = Path(__file__).parent / "static" / "fonts"

FONT_FAMILIES: dict[str, dict] = {
    "sans": {"label": "Sans", "files": {
        (False, False): "DejaVuSans.ttf",        (True, False): "DejaVuSans-Bold.ttf",
        (False, True): "DejaVuSans-Oblique.ttf", (True, True): "DejaVuSans-BoldOblique.ttf"}},
    "serif": {"label": "Serif", "files": {
        (False, False): "DejaVuSerif.ttf",       (True, False): "DejaVuSerif-Bold.ttf",
        (False, True): "DejaVuSerif-Italic.ttf", (True, True): "DejaVuSerif-BoldItalic.ttf"}},
    "mono": {"label": "Mono", "files": {
        (False, False): "DejaVuSansMono.ttf",        (True, False): "DejaVuSansMono-Bold.ttf",
        (False, True): "DejaVuSansMono-Oblique.ttf", (True, True): "DejaVuSansMono-BoldOblique.ttf"}},
    "condensed": {"label": "Condensed", "files": {
        (False, False): "Oswald-Regular.ttf", (True, False): "Oswald-Bold.ttf"}},
    "hand": {"label": "Handschrift", "files": {
        (False, False): "Caveat-Regular.ttf", (True, False): "Caveat-Bold.ttf"}},
    "display": {"label": "Display", "files": {
        (False, False): "BebasNeue-Regular.ttf"}},
    "emoji": {"label": "Emoji", "files": {
        (False, False): "NotoEmoji-Regular.ttf"}},  # monochrome — prints on the B/W QL-570
}
DEFAULT_FAMILY = "sans"


def resolve_family(font: str | None, mono: bool = False) -> str:
    """Pick a family key, honouring the legacy `mono` flag when `font` is unset."""
    if font and font in FONT_FAMILIES:
        return font
    return "mono" if mono else DEFAULT_FAMILY


def font_file(family: str, bold: bool = False, italic: bool = False) -> str:
    """Resolve a (family, bold, italic) request to a bundled TTF path.

    Missing style variants degrade gracefully: bold+italic → bold → italic →
    regular, matching what the browser is instructed to do for the preview.
    """
    files = (FONT_FAMILIES.get(family) or FONT_FAMILIES[DEFAULT_FAMILY])["files"]
    for key in [(bold, italic), (bold, False), (False, italic), (False, False)]:
        if key in files:
            return str(FONTS_DIR / files[key])
    return str(FONTS_DIR / next(iter(files.values())))


def font_registry_for_api(url_prefix: str = "/static/fonts/") -> list[dict]:
    """Describe the registry for the browser: dropdown labels + @font-face faces.

    Emits all four style combos per family, each pointing at the file PIL would
    actually use (after fallback). The browser declares these as @font-face rules
    so its canvas preview matches the printed raster without synthesising styles.
    """
    combos = [(False, False), (True, False), (False, True), (True, True)]
    out = []
    for key, fam in FONT_FAMILIES.items():
        faces = [{
            "url": url_prefix + Path(font_file(key, bold, italic)).name,
            "weight": 700 if bold else 400,
            "style": "italic" if italic else "normal",
        } for bold, italic in combos]
        out.append({"key": key, "label": fam["label"], "css": f"lpf-{key}", "faces": faces})
    return out


EMOJI_FALLBACK = "NotoEmoji-Regular.ttf"  # monochrome emoji glyphs missing from text fonts
# Zero-width selectors that have no glyph of their own; drop them so they don't
# render as tofu when split into a fallback run.
_INVISIBLE = {0xFE0E, 0xFE0F, 0x200D}


from functools import lru_cache


@lru_cache(maxsize=64)
def _font_cmap(path: str) -> frozenset:
    """Set of Unicode code points a font file can render (empty if undeterminable)."""
    try:
        from fontTools.ttLib import TTFont
        with TTFont(path, lazy=True, fontNumber=0) as tt:
            return frozenset(tt.getBestCmap().keys())
    except Exception:
        return frozenset()


def _runs(text: str, primary_path: str) -> list[tuple[str, str]]:
    """Split text into (substring, font_path) runs, routing glyphs the primary
    font lacks to the bundled emoji font. Falls back to a single primary run when
    coverage can't be determined (so behaviour is unchanged without fontTools)."""
    primary = _font_cmap(primary_path)
    emoji_path = str(FONTS_DIR / EMOJI_FALLBACK)
    emoji = _font_cmap(emoji_path)
    if not primary or not emoji:
        return [(text, primary_path)]
    runs: list[list] = []
    for ch in text:
        cp = ord(ch)
        if cp in _INVISIBLE:
            continue
        if cp in primary or ch.isspace() or cp not in emoji:
            path = primary_path  # primary, or tofu on primary if neither has it
        else:
            path = emoji_path
        if runs and runs[-1][1] == path:
            runs[-1][0] += ch
        else:
            runs.append([ch, path])
    return [(s, p) for s, p in runs] or [("", primary_path)]


def _runs_width(draw: ImageDraw.ImageDraw, text: str, primary_path: str, size_px: int) -> float:
    total = 0.0
    for sub, path in _runs(text, primary_path):
        total += draw.textlength(sub, font=ImageFont.truetype(path, size_px))
    return total


def _draw_runs(draw: ImageDraw.ImageDraw, xy: tuple, text: str, primary_path: str,
               size_px: int, fill: int) -> None:
    x, y = xy
    for sub, path in _runs(text, primary_path):
        font = ImageFont.truetype(path, size_px)
        draw.text((x, y), sub, font=font, fill=fill)
        x += draw.textlength(sub, font=font)


def mm_to_px(mm: float) -> int:
    """Default (vertical / DPI-based) conversion, used for continuous-label heights."""
    return round(mm * DPI / MM_PER_INCH)


def px_per_mm_x(label_width_mm: int) -> float:
    """Horizontal pixels-per-mm, calibrated so the canvas maps 1:1 onto the
    printer's printable-pixel-width for this label. E.g. 62mm → 696 px → 11.23 px/mm."""
    if label_width_mm in PRINTABLE_PX:
        return PRINTABLE_PX[label_width_mm] / label_width_mm
    return DPI / MM_PER_INCH


def mm_to_px_x(mm: float, label_width_mm: int) -> int:
    return round(mm * px_per_mm_x(label_width_mm))


@dataclass
class TextLine:
    text: str
    size_pt: int = 14
    bold: bool = False
    italic: bool = False
    mono: bool = False
    font: str = ""  # font family key (see FONT_FAMILIES); "" = sans / legacy mono


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
    family = resolve_family(line.font, line.mono)
    return ImageFont.truetype(font_file(family, line.bold, line.italic), size_px)


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
        qr = qrcode.QRCode(border=0, box_size=4, error_correction=qrcode.constants.ERROR_CORRECT_H)
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


def apply_fold(img: Image.Image) -> Image.Image:
    """Stack the label twice vertically; bottom half rotated 180 degrees.

    For continuous-paper labels meant to be folded in half so sticky sides
    face each other and both readable sides face outward (e.g. a laminate
    pouch insert that becomes a double-sided card).
    """
    rotated = img.rotate(180)
    folded = Image.new(img.mode, (img.width, img.height * 2), "white")
    folded.paste(img, (0, 0))
    folded.paste(rotated, (0, img.height))
    return folded


# ---- Design-JSON rendering (same format as browser designer) ----

import re

_PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}")


def _font_path_for(bold: bool, italic: bool, mono: bool, font: str = "") -> str:
    return font_file(resolve_family(font, mono), bold, italic)


def _fit_size_px(draw: ImageDraw.ImageDraw, text: str, font_path: str,
                 size_pt: float, max_w: int, min_pt: float = 6.0) -> int:
    """Largest size (px) at which the text — with emoji fallback — fits max_w."""
    pt = size_pt
    while pt >= min_pt:
        size_px = max(1, round(pt * DPI / 72))
        if _runs_width(draw, text, font_path, size_px) <= max_w:
            return size_px
        pt -= 0.5
    return max(1, round(min_pt * DPI / 72))


def _wrap_runs(draw: ImageDraw.ImageDraw, text: str, font_path: str,
               size_px: int, max_w: int) -> list[str]:
    """Word-wrap using emoji-fallback-aware width measurement."""
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = (cur + " " + w) if cur else w
        if _runs_width(draw, trial, font_path, size_px) > max_w and cur:
            lines.append(cur)
            cur = w
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines or [""]


def _sub(text: str, vars: dict) -> str:
    """Substitute {{placeholder}} tokens. Unfilled placeholders collapse to empty."""
    if not text:
        return text
    out = _PLACEHOLDER_RE.sub(lambda m: str(vars.get(m.group(1), "")), text)
    # Collapse whitespace left behind by removed placeholders, per line, so an
    # explicit newline survives.
    return "\n".join(" ".join(line.split()) for line in out.split("\n")).strip("\n") if out.strip() else ""


def _font_for(size_pt: int, bold: bool, italic: bool, mono: bool, font: str = "") -> ImageFont.FreeTypeFont:
    size_px = round(size_pt * DPI / 72)
    return ImageFont.truetype(_font_path_for(bold, italic, mono, font), size_px)


def render_design(design: dict, vars: dict | None = None) -> Image.Image:
    """Render a design in the same JSON format produced by the browser app.

    Supports an optional label `orientation` ("portrait" | "landscape") and a
    per-element `rot` (clockwise degrees). In landscape the design is drawn on a
    canvas whose long axis runs along the tape and the finished raster is rotated
    90° so it still prints at the tape's fixed width — mirroring the browser.
    """
    vars = vars or {}
    label = design.get("label", {})
    w_mm = int(label.get("width_mm", 62))
    h_mm = int(label.get("height_mm", 30))
    landscape = label.get("orientation") == "landscape"

    across_px = PRINTABLE_PX.get(w_mm) or mm_to_px(w_mm)  # tape width (fixed raster width)
    along_px = mm_to_px(h_mm)                             # length along the tape

    if landscape:
        # Design surface: length horizontal (DPI), tape-width vertical (calibrated).
        w, h = along_px, across_px
        mx = lambda mm: mm_to_px(mm)
        my = lambda mm: round(mm * across_px / w_mm)
    else:
        w, h = across_px, along_px
        mx = lambda mm: mm_to_px_x(mm, w_mm)  # horizontal (across tape, calibrated)
        my = lambda mm: mm_to_px(mm)          # vertical (along tape, DPI)

    img = Image.new("L", (w, h), 255)
    draw = ImageDraw.Draw(img)

    for el in design.get("elements", []):
        t = el.get("type")
        rot = float(el.get("rot", 0) or 0)
        rotated = abs(rot) > 0.01
        # Ink: black (0) by default; white (255) for "diapositief" text meant to
        # sit on a black fill. White ink composites with `lighter` (keep brightest)
        # instead of `darker`, so the rotation layer is built on the opposite bg.
        ink = 255 if (t == "text" and el.get("color") == "white") else 0
        # Rotated elements draw onto a fresh layer rotated about the element's
        # centre then merged back, which keeps antialiased edges.
        if rotated:
            lay = Image.new("L", (w, h), 0 if ink >= 128 else 255)
            dr = ImageDraw.Draw(lay)
            im = lay
        else:
            dr, im = draw, img

        if t == "line":
            x1, y1 = mx(el.get("x1_mm", 0)), my(el.get("y1_mm", 0))
            x2, y2 = mx(el.get("x2_mm", 0)), my(el.get("y2_mm", 0))
            sw = max(1, my(float(el.get("stroke_mm", 0.3))))
            dr.line([(x1, y1), (x2, y2)], fill=0, width=sw)
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        else:
            x, y = mx(el.get("x_mm", 0)), my(el.get("y_mm", 0))
            ew, eh = mx(el.get("w_mm", 0)), my(el.get("h_mm", 0))
            cx, cy = x + ew / 2, y + eh / 2

            if t == "rect":
                sw = max(1, mm_to_px(float(el.get("stroke_mm", 0.3))))
                if el.get("fill"):
                    dr.rectangle([(x, y), (x + ew - 1, y + eh - 1)], fill=0)
                if el.get("stroke", True):
                    half = sw // 2
                    dr.rectangle(
                        [(x + half, y + half), (x + ew - half - 1, y + eh - half - 1)],
                        outline=0, width=sw,
                    )
            elif t == "text":
                text = _sub(el.get("text", ""), vars)
                if not text:
                    continue
                size_pt = float(el.get("size_pt", 12))
                bold, italic, mono = bool(el.get("bold")), bool(el.get("italic")), bool(el.get("mono"))
                wrap = bool(el.get("wrap", False))
                font_path = _font_path_for(bold, italic, mono, el.get("font", ""))

                if wrap and ew > 0:
                    size_px = max(1, round(size_pt * DPI / 72))
                    lines = [line for para in text.split("\n")
                             for line in _wrap_runs(dr, para, font_path, size_px, ew)]
                    line_h = round(size_px * 1.2)
                    max_lines = max(1, int(eh / line_h)) if eh > 0 else len(lines)
                    for i, line in enumerate(lines[:max_lines]):
                        _draw_runs(dr, (x, y + i * line_h), line, font_path, size_px, ink)
                else:
                    # No wrapping: each \n starts a line; all lines shrink together to fit width
                    lines = text.split("\n")
                    size_px = min(_fit_size_px(dr, line, font_path, size_pt, ew if ew > 0 else 10**6)
                                  for line in lines)
                    line_h = round(size_px * 1.2)
                    for i, line in enumerate(lines):
                        _draw_runs(dr, (x, y + i * line_h), line, font_path, size_px, ink)
            elif t == "qr":
                data = _sub(el.get("data", ""), vars)
                if not data:
                    continue  # skip QR if data is empty (unfilled placeholder)
                qr = qrcode.QRCode(border=0, box_size=4,
                                   error_correction=qrcode.constants.ERROR_CORRECT_H)
                qr.add_data(data)
                qr.make(fit=True)
                qr_img = qr.make_image(fill_color="black", back_color="white").convert("L")
                size = max(20, min(ew, eh))
                qr_img = qr_img.resize((size, size), Image.NEAREST)
                im.paste(qr_img, (x, y))

        if rotated:
            # PIL rotates counter-clockwise for positive angles; negate so `rot`
            # reads as clockwise, matching the browser canvas.
            if ink >= 128:  # white ink: keep the brightest pixels
                rl = lay.rotate(-rot, center=(cx, cy), resample=Image.BICUBIC, fillcolor=0)
                img = ImageChops.lighter(img, rl)
            else:
                rl = lay.rotate(-rot, center=(cx, cy), resample=Image.BICUBIC, fillcolor=255)
                img = ImageChops.darker(img, rl)
            draw = ImageDraw.Draw(img)

    if label.get("border"):
        stroke = max(1, my(float(label.get("border_mm", 0.3))))
        half = stroke // 2
        draw.rectangle(
            [(half, half), (w - half - 1, h - half - 1)],
            outline=0, width=stroke,
        )

    if landscape:
        # Rotate the finished design so the tape-width axis becomes the raster
        # width again. ROTATE_270 (90° clockwise) matches the browser's transform.
        img = img.transpose(Image.ROTATE_270)
    return img
