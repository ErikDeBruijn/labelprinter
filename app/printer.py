"""Thin wrapper around brother_ql for the QL-570 on /dev/usb/lp2."""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

from PIL import Image
from brother_ql.backends.helpers import send
from brother_ql.backends.linux_kernel import BrotherQLBackendLinuxKernel
from brother_ql.conversion import convert
from brother_ql.raster import BrotherQLRaster

DEVICE = "/dev/usb/lp2"
MODEL = "QL-570"


@dataclass
class PrinterStatus:
    media_width_mm: int
    media_length_mm: int  # 0 = continuous
    media_type: str  # 'continuous' | 'die-cut' | 'unknown' | 'no-media'
    errors: tuple[int, int]
    raw_hex: str

    @property
    def has_media(self) -> bool:
        return self.media_width_mm > 0

    @property
    def label_spec(self) -> str:
        """brother_ql label identifier (e.g. '62', '29x90')."""
        if self.media_type == "continuous":
            return str(self.media_width_mm)
        if self.media_type == "die-cut":
            return f"{self.media_width_mm}x{self.media_length_mm}"
        return ""


def query_status() -> PrinterStatus:
    be = BrotherQLBackendLinuxKernel(DEVICE)
    try:
        be.write(b"\x00" * 200 + b"\x1b\x40" + b"\x1b\x69\x53")
        time.sleep(0.3)
        resp = b""
        for _ in range(10):
            chunk = be.read(32)
            if not chunk:
                break
            resp += chunk
            if len(resp) >= 32:
                break
            time.sleep(0.05)
    finally:
        be.dispose()

    if len(resp) < 32:
        return PrinterStatus(0, 0, "no-media", (0, 0), resp.hex())

    width = resp[10]
    length = resp[17]
    mt_byte = resp[11]
    mt = {0x0A: "continuous", 0x0B: "die-cut"}.get(mt_byte, "unknown")
    if width == 0:
        mt = "no-media"
    return PrinterStatus(width, length, mt, (resp[8], resp[9]), resp.hex())


def print_image(img: Image.Image, label_spec: str, cut: bool = True) -> None:
    qlr = BrotherQLRaster(MODEL)
    qlr.exception_on_warning = True
    convert(
        qlr=qlr, images=[img], label=label_spec, rotate="0", threshold=70.0,
        dither=False, compress=False, red=False, dpi_600=False, hq=True, cut=cut,
    )
    send(
        instructions=qlr.data,
        printer_identifier=DEVICE,
        backend_identifier="linux_kernel",
        blocking=True,
    )


def print_file(path: Path, label_spec: str) -> None:
    print_image(Image.open(path), label_spec)
