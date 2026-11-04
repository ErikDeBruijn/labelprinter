import os
import tempfile

os.environ.setdefault("LABELPRINTER_DATA", tempfile.mkdtemp())

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, base_url="http://labels.test")
DOC = {"title": "Betaal-link", "label": {"width_mm": 62, "height_mm": 35}, "elements": []}


def test_saved_template_is_listed_and_readable():
    assert client.put("/templates/betaal_link", json=DOC,
                      headers={"Origin": "http://labels.test"}).status_code == 200
    listed = {t["name"]: t for t in client.get("/templates").json()}
    assert listed["betaal_link"]["title"] == "Betaal-link"
    assert client.get("/templates/betaal_link").json() == DOC


def test_invalid_template_name_is_refused():
    assert client.put("/templates/Betaal link", json=DOC).status_code == 400
