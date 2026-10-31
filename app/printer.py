"""Thin wrapper around brother_ql for the QL-570 on /dev/usb/lp2.

Resilient to a powered-off / disconnected printer: query_status() never raises
and reports `online=False` when the device is missing or unreadable. print_image()
raises PrinterOffline so callers can fall back to queueing.
"""
from __future__ import annotations

import os
import stat
import time
from dataclasses import dataclass
from pathlib import Path

from PIL import Image
from brother_ql.backends.helpers import send
from brother_ql.backends.linux_kernel import BrotherQLBackendLinuxKernel
from brother_ql.conversion import convert
from brother_ql.raster import BrotherQLRaster

DEVICE = os.environ.get("LABELPRINTER_DEVICE", "/dev/usb/lp2")
MODEL = "QL-570"


class PrinterOffline(RuntimeError):
    """Raised when the printer is powered off, disconnected, or unwritable."""


@dataclass
class PrinterStatus:
    online: bool
    media_width_mm: int
    media_length_mm: int  # 0 = continuous
    media_type: str  # 'continuous' | 'die-cut' | 'unknown' | 'no-media' | 'offline'
    errors: tuple[int, int]
    raw_hex: str

    @property
    def has_media(self) -> bool:
        return self.online and self.media_width_mm > 0

    @property
    def label_spec(self) -> str:
        """brother_ql label identifier (e.g. '62', '29x90')."""
        if self.media_type == "continuous":
            return str(self.media_width_mm)
        if self.media_type == "die-cut":
            return f"{self.media_width_mm}x{self.media_length_mm}"
        return ""


_OFFLINE = PrinterStatus(False, 0, 0, "offline", (0, 0), "")


def _device_is_real_char() -> bool:
    """True only if DEVICE points to a real character device (i.e. usblp node).

    The host may keep a regular-file stub at the path so the container can start
    when the printer is powered off; that stub is not a real device.
    """
    try:
        st = os.stat(DEVICE)
    except OSError:
        return False
    return stat.S_ISCHR(st.st_mode)


def is_online() -> bool:
    return _device_is_real_char()


def query_status() -> PrinterStatus:
    if not _device_is_real_char():
        return _OFFLINE
    try:
        be = BrotherQLBackendLinuxKernel(DEVICE)
    except Exception:
        return _OFFLINE
    resp = b""
    try:
        try:
            be.write(b"\x00" * 200 + b"\x1b\x40" + b"\x1b\x69\x53")
        except Exception:
            return _OFFLINE
        time.sleep(0.3)
        for _ in range(10):
            try:
                chunk = be.read(32)
            except Exception:
                break
            if not chunk:
                break
            resp += chunk
            if len(resp) >= 32:
                break
            time.sleep(0.05)
    finally:
        try:
            be.dispose()
        except Exception:
            pass

    if len(resp) < 32:
        # Device exists but isn't responding (printer asleep / cable issue).
        return PrinterStatus(False, 0, 0, "offline", (0, 0), resp.hex())

    width = resp[10]
    length = resp[17]
    mt_byte = resp[11]
    mt = {0x0A: "continuous", 0x0B: "die-cut"}.get(mt_byte, "unknown")
    if width == 0:
        mt = "no-media"
    return PrinterStatus(True, width, length, mt, (resp[8], resp[9]), resp.hex())


def print_image(img: Image.Image, label_spec: str, cut: bool = True) -> None:
    if not _device_is_real_char():
        raise PrinterOffline("Printer is offline (device node is not a character device)")
    qlr = BrotherQLRaster(MODEL)
    qlr.exception_on_warning = True
    convert(
        qlr=qlr, images=[img], label=label_spec, rotate="0", threshold=70.0,
        dither=False, compress=False, red=False, dpi_600=False, hq=True, cut=cut,
    )
    try:
        send(
            instructions=qlr.data,
            printer_identifier=DEVICE,
            backend_identifier="linux_kernel",
            blocking=True,
        )
    except OSError as e:
        raise PrinterOffline(f"Printer write failed: {e}") from e


def print_file(path: Path, label_spec: str) -> None:
    print_image(Image.open(path), label_spec)
