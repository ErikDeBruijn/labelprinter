import os
import tempfile

os.environ.setdefault("LABELPRINTER_DATA", tempfile.mkdtemp())

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, base_url="http://labels.test")
DESIGN = {"width_mm": 62, "height_mm": 30, "lines": [{"text": "x"}]}


def test_write_from_another_origin_is_rejected():
    r = client.post("/render", json=DESIGN, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_opaque_origin_is_rejected():
    r = client.post("/render", json=DESIGN, headers={"Origin": "null"})
    assert r.status_code == 403


def test_same_origin_write_is_allowed():
    r = client.post("/render", json=DESIGN, headers={"Origin": "https://labels.test"})
    assert r.status_code == 200


def test_server_side_client_without_origin_is_allowed():
    assert client.post("/render", json=DESIGN).status_code == 200


def test_read_from_another_origin_is_allowed():
    r = client.get("/fonts", headers={"Origin": "https://evil.example"})
    assert r.status_code == 200
