import importlib

from app import printer


def test_device_defaults_to_usblp(monkeypatch):
    monkeypatch.delenv("LABELPRINTER_DEVICE", raising=False)
    assert importlib.reload(printer).DEVICE == "/dev/usb/lp2"


def test_device_comes_from_environment(monkeypatch):
    monkeypatch.setenv("LABELPRINTER_DEVICE", "/dev/usb/lp0")
    assert importlib.reload(printer).DEVICE == "/dev/usb/lp0"
    monkeypatch.undo()
    importlib.reload(printer)
