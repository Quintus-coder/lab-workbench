"""Protocol tests with a controlled document-service response, not live Office UI."""
import io
import zipfile
from dataclasses import replace

import jwt
import pytest
from fastapi.testclient import TestClient

from lab_workbench.api import create_app
from lab_workbench.config import AppConfig, Limits
from lab_workbench.office import NoRedirect
from lab_workbench.store import Conflict


SECRET = "test-only-office-shared-secret-32-characters"
BASE = "http://127.0.0.1:8765"
DOCS = "http://docs.example:8080"


def document(ext, text=b"original"):
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w") as z:
        z.writestr(zipfile.ZipInfo("[Content_Types].xml"), b"<Types/>")
        z.writestr(zipfile.ZipInfo("word/document.xml" if ext == "docx" else "xl/workbook.xml"), text)
        z.writestr(zipfile.ZipInfo("media/picture.png"), b"preserve embedded image bytes")
        z.writestr(zipfile.ZipInfo("charts/chart1.xml"), b"preserve chart and formatting")
    return result.getvalue()


@pytest.fixture
def office(tmp_path):
    app = create_app(AppConfig(tmp_path, limits=Limits(min_free_bytes=0), office_url=DOCS, office_secret=SECRET))
    with TestClient(app, base_url=BASE, client=("127.0.0.1", 10000)) as c:
        c.headers.update({"Origin": BASE, "X-Requested-With": "GroupCompute"})
        c.post("/api/dev/login", json={"member_id": "alice"})
        p = c.post("/api/projects", json={"name": "Office"}).json()["id"]
        yield c, app, p


def upload(app, p, path, data, overwrite=False):
    ws = app.state.workspace
    u = ws.begin_upload("alice", p, path, len(data), overwrite)
    ws.write_chunk("alice", u["id"], 0, data)
    ws.finalize("alice", u["id"])


def open_document(office, ext="docx"):
    c, app, p = office
    upload(app, p, "report." + ext, document(ext))
    r = c.post(f"/api/projects/{p}/office", json={"path": "report." + ext})
    assert r.status_code == 200, r.text
    return r.json()


def callback(c, sid, status=6, url=DOCS + "/cache/new.docx", **extra):
    payload = {"key": sid, "status": status, "url": url, **extra}
    token = jwt.encode({"operation": "callback", "payload": payload}, SECRET, algorithm="HS256")
    return c.post("/api/office/callback/" + sid, json={"url": "https://evil.example/unsigned"},
                  headers={"Authorization": "Bearer " + token, "Origin": "", "X-Requested-With": ""})


@pytest.mark.parametrize("ext", ["docx", "xlsx"])
def test_signed_config_source_save_close_and_restart(office, monkeypatch, ext):
    c, app, p = office
    opened = open_document(office, ext)
    sid = opened["id"]
    config = opened["config"]
    signed = jwt.decode(config["token"], SECRET, algorithms=["HS256"])
    assert signed["document"]["key"] == sid
    assert SECRET not in str(opened)
    assert config["documentType"] == ("word" if ext == "docx" else "cell")
    assert c.post(f"/api/projects/{p}/office", json={"path": "report." + ext}).json()["id"] == sid
    source_token = jwt.encode({"payload": {"url": config["document"]["url"]}, "operation": "download"}, SECRET, algorithm="HS256")
    source = c.get("/api/office/source/" + sid, headers={"Authorization": "Bearer " + source_token})
    assert source.content == document(ext)
    updated = document(ext, b"formatted edited document")
    monkeypatch.setattr(app.state.office, "fetch_document", lambda url: updated)
    assert callback(c, sid, filetype=ext).json() == {"error": 0}
    with app.state.workspace.open_project("alice", p, "report." + ext) as f:
        assert f.read() == updated  # Includes all embedded parts, no lossy round-trip.
    assert callback(c, sid, filetype=ext).json() == {"error": 0}
    assert c.get("/api/office/sessions/" + sid).json()["revision"] == 2
    assert callback(c, sid, status=2, filetype=ext).json() == {"error": 0}
    assert c.get("/api/office/sessions/" + sid).json()["active"] == 0
    restarted = create_app(app.state.config)
    assert restarted.state.office.session(sid)["revision"] == 3
    assert c.post(f"/api/projects/{p}/office", json={"path": "report." + ext}).json()["id"] != sid


def test_machine_signature_and_member_boundaries(office):
    c, app, p = office
    opened = open_document(office)
    sid = opened["id"]
    source = "/api/office/source/" + sid
    assert c.get(source).status_code == 401
    assert c.get(source, headers={"Authorization": "Bearer " + opened["config"]["token"]}).status_code == 401
    assert c.post("/api/office/callback/" + sid, json={"key": sid, "status": 4}).status_code == 401
    assert c.post("/api/office/callback/" + sid, json={"token": opened["config"]["token"]}).status_code == 401
    wrong = jwt.encode({"payload": {"url": BASE + source}, "operation": "callback"}, SECRET, algorithm="HS256")
    assert c.get(source, headers={"Authorization": "Bearer " + wrong}).status_code == 401
    forged = jwt.encode({"key": sid, "status": 4}, "a different signing key that is also long", algorithm="HS256")
    assert c.post("/api/office/callback/" + sid, json={"token": forged}).status_code == 401
    c.post("/api/dev/login", json={"member_id": "bob"})
    assert c.get("/api/office/sessions/" + sid).status_code == 403
    assert c.post(f"/api/projects/{p}/office", json={"path": "report.docx"}).status_code == 403


@pytest.mark.parametrize("mutation", ["delete", "overwrite"])
def test_late_save_does_not_resurrect_or_overwrite(office, monkeypatch, mutation):
    c, app, p = office
    sid = open_document(office)["id"]
    ws = app.state.workspace
    if mutation == "delete":
        info = ws.file_info("alice", p, "report.docx")
        ws.delete_file("alice", p, "report.docx", info["version"])
    else:
        upload(app, p, "report.docx", document("docx", b"external update"), True)
    monkeypatch.setattr(app.state.office, "fetch_document", lambda url: document("docx", b"stale save"))
    assert callback(c, sid).json() == {"error": 1}
    assert c.get("/api/office/sessions/" + sid).json()["error"]
    if mutation == "delete":
        assert ws.list_project("alice", p) == []
    else:
        with ws.open_project("alice", p, "report.docx") as f:
            assert f.read() == document("docx", b"external update")


@pytest.mark.parametrize("url", ["http://evil.example/file", "http://127.0.0.1/private", "http://docs.example:8080@evil.example/file", "file:///C:/secret", DOCS + "/file\n", "http://[malformed"])
def test_callback_rejects_untrusted_download(office, monkeypatch, url):
    c, app, _ = office
    sid = open_document(office)["id"]
    monkeypatch.setattr(app.state.office, "fetch_document", lambda url: pytest.fail("must not fetch"))
    assert callback(c, sid, url=url).json() == {"error": 1}


def test_document_limits_invalid_zip_and_redirects(office, monkeypatch):
    c, app, _ = office
    sid = open_document(office)["id"]
    monkeypatch.setattr(app.state.office, "fetch_document", lambda url: b"not office")
    assert callback(c, sid).json() == {"error": 1}
    app.state.config.limits = replace(app.state.config.limits, max_office_bytes=10)
    monkeypatch.setattr(app.state.office, "fetch_document", lambda url: document("docx"))
    assert callback(c, sid).json() == {"error": 1}
    with pytest.raises(Conflict):
        NoRedirect().redirect_request(None, None, 302, "redirect", {}, "http://evil.example")


def test_reused_download_url_can_contain_a_newer_save(office, monkeypatch):
    c, app, p = office
    sid = open_document(office)["id"]
    for text in (b"first save", b"second save at same URL"):
        updated = document("docx", text)
        monkeypatch.setattr(app.state.office, "fetch_document", lambda url: updated)
        assert callback(c, sid).json() == {"error": 0}
        with app.state.workspace.open_project("alice", p, "report.docx") as f:
            assert f.read() == updated


def test_document_save_preserves_snapshot_and_respects_pending_upload(office, monkeypatch):
    c, app, p = office
    sid = open_document(office)["id"]
    ws = app.state.workspace
    snapshot = ws.snapshot("alice", p)
    u = ws.begin_upload("alice", p, "report.docx", 10, True)
    edited = document("docx", b"new revision")
    monkeypatch.setattr(app.state.office, "fetch_document", lambda url: edited)
    assert callback(c, sid).json() == {"error": 1}
    ws.abandon("alice", u["id"])
    assert callback(c, sid).json() == {"error": 0}
    assert not app.state.office.session(sid)["error"]
    with ws.open_snapshot("alice", snapshot, "report.docx") as f:
        assert f.read() == document("docx")


def test_only_machine_routes_can_use_callback_host_without_browser_origin(office):
    c, app, _ = office
    sid = open_document(office)["id"]
    app.state.office.callback_base = "http://callback.example"
    with TestClient(app, base_url="http://callback.example", client=("10.0.0.5", 100)) as machine:
        assert machine.get("/api/projects").status_code == 400
        assert machine.get("/api/office/source/" + sid).status_code == 401
        token = jwt.encode({"operation": "callback", "payload": {"key": sid, "status": 4}}, SECRET, algorithm="HS256")
        assert machine.post("/api/office/callback/" + sid, json={"token": token}).json() == {"error": 0}


@pytest.mark.parametrize("url", ["http://host/path", "http://user:password@host", "http://host:99999", "http://host;evil", "http://host\n"])
def test_config_rejects_invalid_document_origin(tmp_path, url):
    with pytest.raises(ValueError):
        AppConfig(tmp_path, office_url=url, office_secret=SECRET).validate()
