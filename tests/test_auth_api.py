import time
from pathlib import Path
import pytest
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from lab_workbench.auth import AccessAuthenticator, AuthenticationError
from lab_workbench.config import AppConfig, Limits
from lab_workbench.api import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(AppConfig(tmp_path, limits=Limits(min_free_bytes=0)))
    with TestClient(app, base_url="http://127.0.0.1:8765", client=("127.0.0.1", 12345)) as c:
        c.app_instance = app
        c.headers.update({"Origin": "http://127.0.0.1:8765", "X-Requested-With": "GroupCompute"})
        assert c.post("/api/dev/login", json={"member_id": "alice"}).status_code == 200
        yield c


def project(c):
    r = c.post("/api/projects", json={"name": "测试 项目"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def put(c, p, name="main.py", data=b"print('hello')"):
    r = c.post(f"/api/projects/{p}/uploads", json={"path": name, "size": len(data)})
    assert r.status_code == 200, r.text
    u = r.json()["id"]
    assert c.put(f"/api/uploads/{u}?offset=0", content=data, headers={"Content-Type": "application/octet-stream"}).status_code == 200
    assert c.post(f"/api/uploads/{u}/finish", json={}).status_code == 200
    return u


def submit(c, p, **fields):
    return c.post(f"/api/projects/{p}/jobs", json={"entry": "main.py", "environment": "py312", "args": ["two words"], "request_id": "test-request", **fields})


def test_web_retry_does_not_duplicate_job(client):
    p = project(client)
    put(client, p)
    a, b = submit(client, p), submit(client, p)
    assert a.status_code == b.status_code == 200
    assert a.json()["id"] == b.json()["id"]
    assert len(client.get("/api/jobs").json()) == 1
    assert a.json()["args"] == ["two words"]
    assert len(list((client.app_instance.state.workspace.root / "snapshots").glob("alice/*"))) == 1


def test_homepage_is_available_in_local_preview(client):
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert client.get("/api/config").json()["execution_enabled"] is False


def test_delete_file_version_owner_and_snapshot(client):
    p = project(client)
    put(client, p)
    job = submit(client, p).json()
    version = client.get(f"/api/projects/{p}/files").json()[0]["version"]
    endpoint = f"/api/projects/{p}/files"
    payload = {"path": "main.py", "version": version}
    assert client.request("DELETE", endpoint, json={**payload, "version": "stale"}).status_code == 409
    assert client.request("DELETE", endpoint, json=payload, headers={"Origin": "https://evil.example"}).status_code == 403
    client.post("/api/dev/login", json={"member_id": "bob"})
    assert client.request("DELETE", endpoint, json=payload).status_code == 403
    client.post("/api/dev/login", json={"member_id": "alice"})
    assert client.request("DELETE", endpoint, json=payload).status_code == 200
    assert client.get(f"/api/projects/{p}/files").json() == []
    with client.app_instance.state.workspace.open_snapshot("alice", job["snapshot"], "main.py") as f:
        assert f.read() == b"print('hello')"
    assert client.request("DELETE", endpoint, json=payload).status_code == 404


def test_delete_pending_upload_and_traversal(client):
    p = project(client)
    put(client, p)
    version = client.get(f"/api/projects/{p}/files").json()[0]["version"]
    upload = client.post(f"/api/projects/{p}/uploads", json={"path": "main.py", "size": 4, "overwrite": True}).json()
    endpoint = f"/api/projects/{p}/files"
    assert client.request("DELETE", endpoint, json={"path": "main.py", "version": version}).status_code == 409
    assert client.request("DELETE", endpoint, json={"path": "../state.sqlite", "version": version}).status_code == 400
    client.delete(f"/api/uploads/{upload['id']}")
    assert client.request("DELETE", endpoint, json={"path": "main.py", "version": version}).status_code == 200


def test_pdf_preview_ranges_and_owner(client):
    p = project(client)
    data = b"%PDF-1.7\n" + b"data" * 50
    put(client, p, "报告.pdf", data)
    endpoint = f"/api/projects/{p}/preview"
    response = client.get(endpoint, params={"path": "报告.pdf"})
    assert response.content == data
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"].startswith("inline;")
    assert "frame-ancestors 'self'" in response.headers["content-security-policy"]
    assert "frame-ancestors 'none'" in client.get("/").headers["content-security-policy"]
    for value, expected in [("bytes=0-4", data[:5]), ("bytes=-8", data[-8:]), ("bytes=8-", data[8:])]:
        r = client.get(endpoint, params={"path": "报告.pdf"}, headers={"Range": value})
        assert r.status_code == 206 and r.content == expected
        assert int(r.headers["content-length"]) == len(expected)
    for value in ["bytes=-0", "bytes=999-", "bytes=0-3,7-9", "bytes=" + "1" * 100 + "-"]:
        assert client.get(endpoint, params={"path": "报告.pdf"}, headers={"Range": value}).status_code == 416
    put(client, p, "假的.pdf", b"html content")
    assert client.get(endpoint, params={"path": "假的.pdf"}).status_code == 415
    client.post("/api/dev/login", json={"member_id": "bob"})
    assert client.get(endpoint, params={"path": "报告.pdf"}).status_code == 403


def test_office_unconfigured_is_explicit(client):
    p = project(client)
    put(client, p, "test.docx", b"placeholder")
    assert client.get("/api/config").json()["office_enabled"] is False
    result = client.post(f"/api/projects/{p}/office", json={"path": "test.docx"})
    assert result.status_code == 409 and "尚未配置" in result.json()["error"]


def test_text_editor_api_and_powershell_script_submission(client):
    p = project(client)
    path = "实验/run.ps1"
    content = "python -u train.py --epochs 100 --name 'two words'\n"
    r = client.put(f"/api/projects/{p}/text", json={"path": path, "text": content, "version": None})
    assert r.status_code == 200, r.text
    assert client.get(f"/api/projects/{p}/text", params={"path": path}).json()["text"] == content
    j = submit(client, p, entry=path, args=[])
    assert j.status_code == 200, j.text
    assert j.json()["args"] == []
    assert j.json()["entry"] == path
    stale = client.put(f"/api/projects/{p}/text", json={"path": path, "text": "oops", "version": None})
    assert stale.status_code == 409
    client.post("/api/dev/login", json={"member_id": "bob"})
    assert client.get(f"/api/projects/{p}/text", params={"path": path}).status_code == 403
    assert client.put(f"/api/projects/{p}/text", json={"path": path, "text": "oops", "version": r.json()["version"]}).status_code == 403


def test_text_api_rejects_binary_and_unspecified_save_version(client):
    p = project(client)
    put(client, p, "data.bin", b"\x00data")
    assert client.get(f"/api/projects/{p}/text", params={"path": "data.bin"}).status_code == 415
    assert client.put(f"/api/projects/{p}/text", json={"path": "data.bin", "text": "oops"}).status_code == 422


def test_cross_member_job_and_download_are_denied(client):
    p = project(client)
    u = put(client, p)
    j = submit(client, p).json()["id"]
    assert client.post("/api/dev/login", json={"member_id": "bob"}).status_code == 200
    for url in [f"/api/jobs/{j}", f"/api/projects/{p}/files", f"/api/projects/{p}/download?path=main.py", f"/api/uploads/{u}", f"/api/jobs/{j}/log", f"/api/jobs/{j}/outputs"]:
        assert client.get(url).status_code == 403, url
    assert client.post(f"/api/jobs/{j}/cancel", json={}).status_code == 403


def test_running_outputs_are_not_downloadable(client):
    p = project(client)
    put(client, p)
    j = submit(client, p).json()["id"]
    assert client.get(f"/api/jobs/{j}/outputs").status_code == 409
    assert client.get(f"/api/jobs/{j}/download?path=main.py").status_code == 409
    assert client.get(f"/api/jobs/{j}/log").status_code == 200


@pytest.mark.parametrize("fields", [{"entry": "../x.py"}, {"entry": "x.exe"}, {"environment": "C:/Python/python.exe"}, {"args": "--foo"}, {"args": ["a\u0000b"]}])
def test_entry_environment_and_args_are_validated(client, fields):
    p = project(client)
    put(client, p)
    assert submit(client, p, **fields).status_code in (400, 422)
    assert client.get("/api/jobs").json() == []


def test_request_body_is_bounded(client):
    client.app_instance.state.config.limits = Limits(min_free_bytes=0, max_chunk_bytes=32)
    p = project(client)
    r = client.post(f"/api/projects/{p}/uploads", json={"path": "big", "size": 100})
    u = r.json()["id"]
    assert client.put(f"/api/uploads/{u}?offset=0", content=b"x"*33).status_code == 413
    assert client.get(f"/api/uploads/{u}").json()["received"] == 0


def test_csrf_and_host_checks(client):
    assert client.post("/api/projects", json={"name": "bad"}, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.get("/api/projects", headers={"Host": "evil.example"}).status_code == 400
    client.headers.pop("X-Requested-With")
    assert client.post("/api/projects", json={"name": "bad"}).status_code == 403


def test_pending_transfers_can_be_found_after_browser_restart(client):
    p = project(client)
    u = client.post(f"/api/projects/{p}/uploads", json={"path": "data.txt", "size": 6}).json()["id"]
    client.put(f"/api/uploads/{u}?offset=0", content=b"abc")
    pending = client.get(f"/api/projects/{p}/uploads")
    assert pending.status_code == 200
    assert [(v["id"], v["received"]) for v in pending.json()] == [(u, 3)]
    client.post("/api/dev/login", json={"member_id": "bob"})
    assert client.get(f"/api/projects/{p}/uploads").status_code == 403


def test_forged_email_header_is_rejected(client):
    client.cookies.clear()
    assert client.get("/api/projects", headers={"Cf-Access-Authenticated-User-Email": "alice@example.org"}).status_code == 401


def test_development_login_rejects_remote_clients(tmp_path):
    app = create_app(AppConfig(tmp_path))
    with TestClient(app, base_url="http://127.0.0.1:8765", client=("10.0.0.2", 1)) as c:
        r = c.post("/api/dev/login", json={"member_id": "alice"}, headers={"Origin": "http://127.0.0.1:8765", "X-Requested-With": "GroupCompute"})
        assert r.status_code == 403


def test_production_configuration_fails_closed(tmp_path):
    with pytest.raises(ValueError):
        create_app(AppConfig(tmp_path, mode="production", base_url="https://compute.example.org"))


def test_malformed_development_login_is_a_client_error(client):
    assert client.post("/api/dev/login", content=b"{", headers={"Content-Type": "application/json"}).status_code == 422


def test_log_polling_preserves_multibyte_characters(client):
    p = project(client)
    put(client, p)
    j = submit(client, p).json()
    root = client.app_instance.state.workspace.root / "logs" / "alice"
    root.mkdir(parents=True)
    content = "a"*65535 + "你好\n"
    (root / (j["id"] + ".log")).write_text(content, encoding="utf-8", newline="")
    first = client.get(f"/api/jobs/{j['id']}/log").json()
    second = client.get(f"/api/jobs/{j['id']}/log?offset={first['offset']}").json()
    assert first["text"] + second["text"] == content


@pytest.mark.parametrize("path,payload", [("/api/projects", {"name": "while snapshot is locked"}), ("/api/dev/login", {"member_id": "bob"})])
def test_sqlite_write_wait_does_not_freeze_other_web_requests(client, monkeypatch, path, payload):
    from contextlib import contextmanager
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    store = client.app_instance.state.store
    real_connect = store.connect
    waiting = Event()
    @contextmanager
    def observed_connect(write=False, transaction=True):
        if write:
            waiting.set()
        with real_connect(write, transaction) as c:
            yield c
    monkeypatch.setattr(store, "connect", observed_connect)
    with ThreadPoolExecutor(2) as pool:
        with real_connect(True):
            writer = pool.submit(client.post, path, json=payload)
            assert waiting.wait(2), "write request did not reach the lock"
            reader = pool.submit(client.get, "/api/config")
            assert reader.result(timeout=1).status_code == 200
        assert writer.result(timeout=2).status_code == 200


def test_wrong_issuer_audience_or_expired_token_is_rejected():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    verifier = AccessAuthenticator("https://team.cloudflareaccess.com", "application-id", lambda token: key.public_key())
    valid = {"iss": "https://team.cloudflareaccess.com", "aud": ["application-id"], "exp": int(time.time()) + 100, "iat": int(time.time()) - 10, "email": "alice@example.org", "sub": "member-sub"}
    assert verifier.authenticate(jwt.encode(valid, key, algorithm="RS256"))["email"] == "alice@example.org"
    for change in [{"iss": "https://evil"}, {"aud": ["other"]}, {"exp": 1}, {"email": None}]:
        with pytest.raises(AuthenticationError):
            verifier.authenticate(jwt.encode({**valid, **change}, key, algorithm="RS256"))
    with pytest.raises(AuthenticationError):
        verifier.authenticate(jwt.encode(valid, "forged-signing-key-that-is-at-least-32-bytes", algorithm="HS256"))


def test_invited_school_member_lifecycle(tmp_path):
    issuer, base = "https://team.cloudflareaccess.com", "https://work.example.org"
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    verifier = AccessAuthenticator(issuer, "app", lambda _: key.public_key())
    admin, student = "lead@school.example", "student@school.example"
    config = AppConfig(tmp_path, mode="production", base_url=base, access_issuer=issuer,
                       access_audience="app", bootstrap_admin_email=admin)
    app = create_app(config, authenticator=verifier)
    with TestClient(app, base_url=base) as c:
        c.headers.update({"Origin": base, "X-Requested-With": "GroupCompute"})
        def login(email):
            c.headers["cf-access-jwt-assertion"] = jwt.encode(
                dict(iss=issuer, aud="app", iat=int(time.time()), exp=int(time.time())+300,
                     sub="id-"+email, email=email), key, algorithm="RS256")
        assert c.get("/api/me", headers={"Cf-Access-Authenticated-User-Email": admin}).status_code == 401
        login(student)
        assert c.get("/").status_code == 403
        assert c.post("/api/activate", json={"name":"未邀请"}).status_code == 403
        login(admin)
        assert c.get("/api/me").json()["admin"]
        assert c.post("/api/members", json={"email":"@school.example"}).status_code == 422
        invite = c.post("/api/members", json={"email":student.upper()}).json()
        mid = invite["id"]
        assert invite["status"] == "pending"
        assert c.post("/api/members", json={"email":student}).status_code == 409
        url = f"/api/members/{mid}/enabled"
        assert c.post(url, json={"enabled":False}).status_code == 200
        assert c.post(url, json={"enabled":True}).json()["status"] == "pending"
        login(student)
        assert "填写姓名" in c.get("/").text
        assert c.get("/api/projects").status_code == c.get("/api/jobs").status_code == 403
        assert c.post("/api/activate", json={"name":"   "}).status_code == 422
        assert c.post("/api/activate", json={"name":"学生","admin":True}).status_code == 422
        assert c.post("/api/activate", json={"name":"学生"}).json()["id"] == mid
        assert c.post("/api/activate", json={"name":"不同姓名"}).json()["name"] == "学生"
        assert "选择试用身份" not in c.get("/").text
        assert c.get("/api/members").status_code == 403
        assert c.post("/api/members", json={"email":"other@school.example"}).status_code == 403
        assert c.post(url, json={"enabled":True}).status_code == 403
        pid = project(c)
        put(c, pid)
        job = c.post("/api/projects/"+pid+"/jobs",json=dict(entry="main.py", environment="py312",args=[],request_id="once"))
        assert job.status_code == 200, job.text
        assert c.post("/api/logout").json()["redirect"] == "/cdn-cgi/access/logout"
        login(admin)
        assert c.post(url, json={"enabled":False}).json()["status"] == "disabled"
        login(student)
        assert c.get("/api/projects/"+pid+"/files").status_code == c.get("/api/jobs").status_code == 403
        assert c.post("/api/activate", json={"name":"学生"}).status_code == 403
        login(admin)
        assert c.post(url, json={"enabled":True}).status_code == 200
        login(student)
        assert c.get("/api/me").json()["id"] == mid
        assert c.get("/api/projects/"+pid+"/files").json()[0]["path"] == "main.py"
        assert c.get("/api/jobs").json()[0]["id"] == job.json()["id"]
    with pytest.raises(ValueError, match="数据目录"):
        create_app(AppConfig(tmp_path))


def test_production_refuses_preview_database(tmp_path):
    create_app(AppConfig(tmp_path))
    with pytest.raises(ValueError, match="数据目录"):
        create_app(AppConfig(tmp_path, mode="production", base_url="https://work.example.org",
                             access_issuer="https://team.cloudflareaccess.com", access_audience="app",
                             bootstrap_admin_email="lead@school.example"))


def test_existing_member_survives_upgrade_and_concurrent_activation(tmp_path):
    import sqlite3
    from concurrent.futures import ThreadPoolExecutor
    from lab_workbench.store import Store, Forbidden
    with sqlite3.connect(tmp_path / "state.sqlite") as db:
        db.execute("CREATE TABLE members(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, last_served INTEGER NOT NULL DEFAULT 0)")
        db.execute("INSERT INTO members VALUES('original','lead@school.example','原管理员',1,23)")
    store = Store(tmp_path / "state.sqlite")
    store.configure_members("production")
    assert store.member("original")["last_served"] == 23
    with pytest.raises(Forbidden):
        store.manage_members("original", target="original", enabled=False)
    email = "new@school.example"
    mid = store.manage_members("original", email=email)["id"]
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(lambda name: store.activate(email, name), ["第一次", "第二次"]))
    assert responses[0] == responses[1]
    assert responses[0]["id"] == mid
    store.configure_members("production", "another@school.example")
    with pytest.raises(Forbidden):
        store.member_by_email("another@school.example")


def password_client(tmp_path, production=False):
    from lab_workbench.store import Store
    store = Store(tmp_path / "state.sqlite")
    mode = "production" if production else "development"
    base = "https://work.example.org" if production else "http://127.0.0.1:8765"
    store.configure_members(mode, password_auth=True)
    store.approve_registration("lead@school.example")
    config = AppConfig(tmp_path, mode=mode, base_url=base, password_auth=True,
                       access_issuer="https://team.cloudflareaccess.com", access_audience="app")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048) if production else None
    verifier = AccessAuthenticator(config.access_issuer, "app", lambda _: key.public_key()) if production else None
    app = create_app(config, authenticator=verifier)
    c = TestClient(app, base_url=base, client=("127.0.0.1", 12345))
    c.headers.update({"Origin": base, "X-Requested-With": "GroupCompute"})
    credentials = dict(email="lead@school.example", password="long test password for admin")
    if production:
        c.headers["cf-access-jwt-assertion"] = jwt.encode(dict(iss=config.access_issuer, aud="app",
            iat=int(time.time()), exp=int(time.time())+300, sub="lead", email=credentials["email"]), key, algorithm="RS256")
    response = c.post("/api/auth/register", json=credentials)
    assert response.status_code == 200, response.text
    assert response.json()["redirect"] == "/login?registered=1"
    c.headers.pop("cf-access-jwt-assertion", None)
    assert c.get("/api/me").status_code == 401
    assert c.post("/api/auth/login", json=credentials).status_code == 200
    return c, store, credentials


def test_approved_email_registration_login_and_member_isolation(tmp_path):
    from lab_workbench.auth import token_digest
    c, store, admin_credentials = password_client(tmp_path)
    payload = dict(email="student@school.example", password="a long student password")
    with c:
        assert c.post("/api/dev/login", json={"member_id": "admin"}).status_code == 404
        assert "注册账号" in c.get("/login").text
        assert "邀请码" not in c.get("/register").text
        assert c.get("/api/me").json()["admin"]
        admin_project = project(c)
        assert c.post("/api/auth/register", json=payload).status_code == 403
        approved = c.post("/api/members", json={"email":payload["email"]}).json()
        mid = approved["id"]
        assert approved["status"] == "pending"
        assert "invite_url" not in approved
        assert c.post("/api/members", json={"email":payload["email"]}).json()["id"] == mid
        c.post(f"/api/members/{mid}/enabled", json={"enabled":False})
        assert c.post("/api/auth/register", json=payload).status_code == 403
        c.post(f"/api/members/{mid}/enabled", json={"enabled":True})
        c.post("/api/logout")
        assert c.post("/api/auth/register", json={**payload,"password":"short"}).status_code == 422
        assert c.post("/api/auth/register", json={**payload,"admin":True}).status_code == 422
        assert c.post("/api/auth/register", json=payload, headers={"Origin":"https://evil.example"}).status_code == 403
        response = c.post("/api/auth/register", json=payload)
        assert response.status_code == 200
        assert response.json()["redirect"] == "/login?registered=1"
        assert c.get("/api/me").status_code == 401
        assert not c.cookies.get("gc_session")
        assert c.post("/api/auth/register", json={**payload,"password":"another long password"}).status_code == 409
        assert c.post("/api/auth/login", json={**payload,"password":"incorrect password"}).status_code == 401
        assert c.post("/api/auth/login", json={**payload,"email":"nobody@school.example"}).status_code == 401
        response = c.post("/api/auth/login", json={**payload,"remember":True})
        assert response.status_code == 200
        assert "Max-Age=2592000" in response.headers["set-cookie"]
        assert "HttpOnly" in response.headers["set-cookie"] and "SameSite=strict" in response.headers["set-cookie"]
        assert c.get("/api/me").json()["admin"] == 0
        assert c.get("/api/projects/"+admin_project+"/files").status_code == 403
        assert c.post("/api/members", json={"email":"other@school.example"}).status_code == 403
        sid = c.cookies.get("gc_session")
        with store.connect() as db:
            assert db.execute("SELECT 1 FROM sessions WHERE token=?", (sid,)).fetchone() is None
            assert db.execute("SELECT 1 FROM sessions WHERE token=?", ("password:"+token_digest(sid),)).fetchone()
            encoded = db.execute("SELECT password_hash FROM members WHERE id=?", (mid,)).fetchone()[0]
            assert encoded.startswith("scrypt$") and payload["password"] not in encoded
        student_project = project(c)
        c.post("/api/logout")
        assert c.get("/api/me", headers={"Cookie":"gc_session="+sid}).status_code == 401
        assert c.post("/api/auth/login", json=payload).status_code == 200
        assert c.get("/api/projects").json()[0]["id"] == student_project
        sid = c.cookies.get("gc_session")
        # A separate admin session must invalidate the student's still-active session.
        with TestClient(c.app, base_url="http://127.0.0.1:8765", client=("127.0.0.1",12345)) as admin:
            admin.headers.update(c.headers)
            assert admin.post("/api/auth/login", json=admin_credentials).status_code == 200
            assert admin.post(f"/api/members/{mid}/enabled", json={"enabled":False}).status_code == 200
            assert c.get("/api/me").status_code == 401
            assert c.post("/api/auth/login", json=payload).status_code == 401
            admin.post(f"/api/members/{mid}/enabled", json={"enabled":True})
            assert c.get("/api/me", headers={"Cookie":"gc_session="+sid}).status_code == 401


def test_password_session_expiry_rate_limit_and_production_cookie(tmp_path):
    from lab_workbench.auth import token_digest
    c, store, payload = password_client(tmp_path, production=True)
    with c:
        response = c.post("/api/auth/login", json=payload)
        assert "Secure" in response.headers["set-cookie"]
        token = c.cookies.get("gc_session")
        with store.connect(True) as db:
            db.execute("UPDATE sessions SET expires=0")
        assert c.get("/api/me").status_code == 401
        assert c.post("/api/auth/login", json=payload).status_code == 200
        current = c.cookies.get("gc_session")
        assert current != token
        assert c.post("/api/logout").json()["redirect"] == "/login"
        assert c.get("/api/me", headers={"Cookie":"gc_session="+current}).status_code == 401
        with store.connect(True) as db:
            db.execute("INSERT INTO auth_attempts VALUES(?,10,?)", (token_digest(payload["email"]), time.time()+300))
        create_app(c.app.state.config)
        assert c.post("/api/auth/login", json=payload).status_code == 429
        with store.connect(True) as db:
            db.execute("UPDATE auth_attempts SET expires=0")
        assert c.post("/api/auth/login", json=payload).status_code == 200


def test_cloudflare_registration_then_password_login(tmp_path):
    from lab_workbench.store import Store
    base, issuer = "https://work.example.org", "https://team.cloudflareaccess.com"
    with pytest.raises(ValueError, match="Access"):
        create_app(AppConfig(tmp_path, mode="production", base_url=base, password_auth=True))
    store = Store(tmp_path / "state.sqlite")
    store.configure_members("production", "lead@school.example")
    admin = store.member_by_email("lead@school.example")
    student = "student@school.example"
    mid = store.approve_registration(student, actor=admin["id"])["id"]
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    verifier = AccessAuthenticator(issuer, "app", lambda _: key.public_key())
    config = AppConfig(tmp_path, mode="production", base_url=base, password_auth=True,
                       access_issuer=issuer, access_audience="app")
    def proof(email, **changes):
        claims = dict(iss=issuer, aud="app", iat=int(time.time()), exp=int(time.time())+300, sub=email, email=email)
        return {"cf-access-jwt-assertion": jwt.encode({**claims, **changes}, key, algorithm="RS256")}
    payload = dict(email=student, password="long student test password")
    with TestClient(create_app(config, authenticator=verifier), base_url=base) as c:
        c.headers.update({"Origin":base, "X-Requested-With":"GroupCompute"})
        assert c.get("/login").status_code == 200
        assert c.get("/register").status_code == 401
        for headers in [{}, {"Cf-Access-Authenticated-User-Email":student},
                        {"cf-access-jwt-assertion":"forged"}, proof(student, exp=1), proof(student, aud="other")]:
            for path in ["/register", "/api/auth/register"]:
                assert c.post(path, json=payload, headers=headers).status_code == 401
        assert c.post("/register", json=payload, headers=proof(admin["email"])).status_code == 403
        assert c.get("/register", headers=proof("outsider@school.example")).status_code == 403
        assert c.post("/register", json={**payload,"email":"outsider@school.example"},
                      headers=proof("outsider@school.example")).status_code == 403
        page = c.get("/register", headers=proof(student))
        assert page.status_code == 200 and 'readonly' in page.text and student in page.text
        store.manage_members(admin["id"], target=mid, enabled=False)
        assert c.get("/register", headers=proof(student)).status_code == 403
        assert c.post("/register", json=payload, headers=proof(student)).status_code == 403
        store.manage_members(admin["id"], target=mid, enabled=True)
        response = c.post("/register", json=payload, headers=proof(student.upper()))
        assert response.status_code == 200 and response.json()["redirect"] == "/login?registered=1"
        assert c.get("/api/me").status_code == 401
        assert c.get("/register", headers=proof(student)).status_code == 409
        assert c.post("/register", json=payload, headers=proof(student)).status_code == 409
        assert c.post("/api/auth/login", json=payload).status_code == 200
        assert c.get("/api/me").json()["id"] == mid
        assert c.post("/api/logout").json()["redirect"] == "/login"
        assert c.get("/api/me").status_code == 401


def test_password_upgrade_preserves_accounts_and_prevents_concurrent_overwrite(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from lab_workbench.store import Store, Conflict
    store = Store(tmp_path / "state.sqlite")
    store.configure_members("production", "lead@school.example")
    admin = store.member_by_email("lead@school.example")
    pid = store.create_project(admin["id"], "原项目")["id"]
    store.configure_members("production", password_auth=True)
    store.approve_registration(admin["email"])
    def register(_):
        try:
            return store.register_password(admin["email"], "long enough upgrade password")
        except Conflict:
            return "registered"
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(register, range(2)))
    assert sorted(results) == sorted([admin["id"], "registered"])
    assert store.member(admin["id"])["name"] == admin["name"]
    assert store.list_projects(admin["id"])[0]["id"] == pid
    with pytest.raises(Conflict):
        store.approve_registration("other-admin@school.example")
    demo = Store(tmp_path / "demo" / "state.sqlite")
    demo.configure_members("development")
    with pytest.raises(ValueError, match="独立"):
        demo.configure_members("development", password_auth=True)
