"""End-to-end: drive the real designer in a headless browser against a live server."""
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import pytest

sync_api = pytest.importorskip("playwright.sync_api")

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def server():
    data = tempfile.mkdtemp()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port)],
        cwd=ROOT, env={**os.environ, "LABELPRINTER_DATA": data},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "/fonts", timeout=1)
            break
        except OSError:
            time.sleep(0.1)
    yield base
    proc.terminate()
    proc.wait()


@pytest.fixture
def page(server):
    with sync_api.sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="chrome")  # installed Chrome, if any
        except sync_api.Error:
            browser = p.chromium.launch()
        pg = browser.new_page()
        pg.goto(server + "/")
        yield pg
        browser.close()


def test_save_as_template_shows_up_in_template_list(page):
    page.on("dialog", lambda d: d.accept("Betaal-link (bunq)"))
    page.click("#btnMore")
    page.click("#btnSaveTemplate")
    page.wait_for_selector("text=Template 'Betaal-link (bunq)' opgeslagen")
    page.click("#btnTemplates")
    item = page.locator("#templatesMenu .template-item", has_text="Betaal-link (bunq)")
    item.wait_for()
    assert item.locator("img").get_attribute("src") == "/templates/betaal_link_bunq/thumbnail"
