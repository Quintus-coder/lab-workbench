import io
import os
import sqlite3
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier

import pytest

from test_auth_api import client, project, put, submit


def login(c, member):
    assert c.post("/api/dev/login", json={"member_id": member}).status_code == 200


def move_payload(c, p, path, new_path):
    info = c.get(f"/api/projects/{p}/file-info", params={"path": path})
    assert info.status_code == 200, info.text
    return {"path": path, "new_path": new_path, "version": info.json()["version"]}


def start_upload(c, p, path, size=5, **extra):
    response = c.post(f"/api/projects/{p}/uploads", json={"path": path, "size": size, **extra})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def unzip(response):
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"].startswith("attachment;")
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def test_project_rename_and_usage(client, monkeypatch):
    p = project(client)
    url = f"/api/projects/{p}"
    ws = client.app_instance.state.workspace
    monkeypatch.setattr(ws, "disk_free_bytes", lambda: 12345678)
    expected = {"file_count": 0, "used_bytes": 0, "reserved_bytes": 0,
                "max_project_bytes": ws.limits.max_project_bytes, "disk_free_bytes": 12345678}
    result = client.get(url + "/usage")
    assert result.status_code == 200 and result.json() == expected
    assert not (ws.root / "projects" / "alice" / p).exists()
    for body in ({"name": ""}, {"name": " \t "}, {"name": "实" * 121}, {"name": 123}, {"name": "good", "owner": "bob"}):
        assert client.patch(url, json=body).status_code == 422
    old = client.get("/api/projects").json()[0]
    changed = client.patch(url, json={"name": "   新实验  "})
    assert changed.status_code == 200 and changed.json() == {**old, "name": "新实验"}
    assert client.get("/api/projects").json() == [changed.json()]
    put(client, p, "输入/a.txt", b"old")
    uid = start_upload(client, p, "输入/a.txt", size=7, overwrite=True)
    assert client.put(f"/api/uploads/{uid}?offset=0", content=b"new").status_code == 200
    assert client.get(url + "/usage").json() == {**expected, "file_count": 1, "used_bytes": 3, "reserved_bytes": 7}
    assert client.delete(f"/api/uploads/{uid}").status_code == 200
    assert client.get(url + "/usage").json() == {**expected, "file_count": 1, "used_bytes": 3}


def test_project_delete_preserves_terminal_history(client):
    p = project(client)
    url = f"/api/projects/{p}"
    put(client, p)
    upload = start_upload(client, p, "waiting.dat", size=0)
    assert client.delete(url).status_code == 409
    assert client.delete(f"/api/uploads/{upload}").status_code == 200
    job = submit(client, p).json()
    jid, jurl = job["id"], f"/api/jobs/{job['id']}"
    state = client.app_instance.state
    assert client.delete(url).status_code == 409  # queued
    assert state.store.claim_next()["id"] == jid
    assert client.delete(url).status_code == 409  # starting
    state.store.transition(jid, ["starting"], "running")
    assert client.delete(url).status_code == 409
    assert client.post(jurl + "/cancel").json()["state"] == "cancelling"
    assert client.delete(url).status_code == 409
    state.store.transition(jid, ["cancelling"], "cancelled")
    root = state.workspace.root
    outputs = state.workspace.output_root(job)
    outputs.mkdir(parents=True)
    (outputs / "report.txt").write_bytes(b"completed output")
    log = root / "logs" / "alice" / (jid + ".log")
    log.parent.mkdir()
    log.write_text("保留的日志", encoding="utf-8")
    assert client.delete(url).json() == {"ok": True}
    assert not (root / "projects" / "alice" / p).exists()
    assert list((root / "staging").iterdir()) == []
    assert client.get("/api/projects").json() == []
    assert client.delete(url).status_code == 404
    assert client.get(url + "/usage").status_code == 404
    assert client.get(jurl).json()["project"] == p
    assert client.get("/api/jobs").json()[0]["id"] == jid
    assert [entry["path"] for entry in client.get(jurl + "/snapshot/files").json()] == ["main.py"]
    assert client.get(jurl + "/snapshot/text", params={"path": "main.py"}).json()["text"] == "print('hello')"
    assert client.get(jurl + "/snapshot/download", params={"path": "main.py"}).content == b"print('hello')"
    assert client.get(jurl + "/log").json()["text"] == "保留的日志"
    assert unzip(client.get(jurl + "/outputs/archive")) == {"report.txt": b"completed output"}
    assert client.post(jurl + "/rerun", json={"request_id": "after-deletion"}).status_code == 404


def test_project_delete_restores_directory_if_database_write_fails(client):
    p = project(client)
    put(client, p, "nested/data.txt", b"preserve")
    state = client.app_instance.state
    with state.store.connect(True) as c:
        c.execute("CREATE TRIGGER reject_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'test'); END")
    with pytest.raises(sqlite3.IntegrityError):
        state.workspace.delete_project("alice", p)
    assert client.get(f"/api/projects/{p}/download", params={"path": "nested/data.txt"}).content == b"preserve"
    assert list((state.workspace.root / "staging").iterdir()) == []


def test_new_endpoints_require_correct_members_and_csrf(client):
    p = project(client)
    url = f"/api/projects/{p}"
    put(client, p, "main.py")
    job = submit(client, p).json()
    jurl = f"/api/jobs/{job['id']}"
    assert client.post(jurl + "/cancel").status_code == 200
    mutations = [
        ("PATCH", url, {"name": "new name"}),
        ("DELETE", url, None),
        ("POST", url + "/files/rename", move_payload(client, p, "main.py", "new.py")),
        ("DELETE", url + "/directories", {"path": "nested"}),
        ("POST", jurl + "/rerun", {"request_id": "denied"}),
    ]
    for method, endpoint, body in mutations:
        assert client.request(method, endpoint, json=body, headers={"X-Requested-With": ""}).status_code == 403
    login(client, "bob")
    for method, endpoint, body in mutations:
        assert client.request(method, endpoint, json=body).status_code == 403, endpoint
    private_gets = [url + "/usage", url + "/archive", jurl + "/snapshot/files", jurl + "/outputs/archive",
                    jurl + "/snapshot/text?path=main.py", jurl + "/snapshot/download?path=main.py"]
    for endpoint in private_gets:
        assert client.get(endpoint).status_code == 403, endpoint
    login(client, "admin")
    assert client.get(url + "/usage").status_code == 403
    assert [row["path"] for row in client.get(jurl + "/snapshot/files").json()] == ["main.py"]
    assert client.get(jurl + "/snapshot/text?path=main.py").json()["text"] == "print('hello')"
    assert client.get(jurl + "/snapshot/download?path=main.py").content == b"print('hello')"
    assert unzip(client.get(jurl + "/outputs/archive")) == {}
    assert client.post(jurl + "/rerun", json={"request_id": "denied-admin"}).status_code == 403


def test_rename_file_and_block_stale_colliding_and_pending_updates(client):
    p = project(client)
    put(client, p, "src/main.py", b"original")
    put(client, p, "Archive/Existing.Py", b"keep")
    url = f"/api/projects/{p}/files/rename"
    data = move_payload(client, p, "src/main.py", "archive\\输入\\新名字.py")
    assert client.post(url, json={**data, "version": "stale"}).status_code == 409
    assert client.post(url, json={**data, "version": 3}).status_code == 422
    assert client.post(url, json={**data, "new_path": "ARCHIVE/existing.py"}).status_code == 409
    assert client.post(url, json={**data, "new_path": "src/MAIN.PY"}).status_code == 409
    for path, overwrite in [("src/main.py", True), ("Archive/输入/新名字.py", False), ("Archive/输入", False)]:
        uid = start_upload(client, p, path, overwrite=overwrite)
        assert client.post(url, json=data).status_code == 409
        assert client.delete(f"/api/uploads/{uid}").status_code == 200
    moved = client.post(url, json=data)
    assert moved.status_code == 200, moved.text
    assert moved.json() == {"path": "Archive/输入/新名字.py", "size": 8, "version": data["version"]}
    download = f"/api/projects/{p}/download"
    assert client.get(download, params={"path": data["path"]}).status_code == 404
    assert client.get(download, params={"path": moved.json()["path"]}).content == b"original"
    assert client.get(download, params={"path": "Archive/Existing.Py"}).content == b"keep"


def test_delete_directory_checks_pending_prefix_without_blocking_siblings(client):
    p = project(client)
    put(client, p, "data/下/one.txt", b"one")
    put(client, p, "data-two/two.txt", b"two")
    endpoint = f"/api/projects/{p}/directories"
    assert client.request("DELETE", endpoint, json={"path": ""}).status_code == 422
    for path in (".", "/", "\\"):
        assert client.request("DELETE", endpoint, json={"path": path}).status_code == 400
    pending = start_upload(client, p, "DATA/another/deep.txt")
    assert client.request("DELETE", endpoint, json={"path": "data"}).status_code == 409
    assert client.delete(f"/api/uploads/{pending}").status_code == 200
    sibling = start_upload(client, p, "data-two/future.txt")
    assert client.request("DELETE", endpoint, json={"path": "data"}).json() == {"ok": True}
    assert client.request("DELETE", endpoint, json={"path": "data"}).status_code == 404
    assert [row["path"] for row in client.get(f"/api/projects/{p}/files").json()] == ["data-two/two.txt"]
    assert client.get(f"/api/uploads/{sibling}").json()["state"] == "uploading"


@pytest.mark.skipif(os.name != "nt", reason="Windows denies renaming files and ancestor directories held open")
def test_busy_file_preserved_across_move_and_recursive_deletes(client):
    p = project(client)
    put(client, p, "data/nested/z.txt", b"in use")
    put(client, p, "data/a.txt", b"also preserve")
    url = f"/api/projects/{p}"
    ws = client.app_instance.state.workspace
    move = move_payload(client, p, "data/nested/z.txt", "moved.txt")
    files = [entry["path"] for entry in client.get(url + "/files").json()]
    with ws.open_project("alice", p, "data/nested/z.txt") as in_use:
        assert client.post(url + "/files/rename", json=move).status_code == 409
        assert client.request("DELETE", url + "/directories", json={"path": "data"}).status_code == 409
        assert client.delete(url).status_code == 409
        assert in_use.read() == b"in use"
        assert [entry["path"] for entry in client.get(url + "/files").json()] == files
    assert client.post(url + "/files/rename", json=move).status_code == 200
    assert client.request("DELETE", url + "/directories", json={"path": "data"}).status_code == 200


def test_upload_and_project_delete_are_serialized(client):
    p = project(client)
    url = f"/api/projects/{p}"
    put(client, p)
    together = Barrier(2)
    def upload():
        together.wait(timeout=5)
        return client.post(url + "/uploads", json={"path": "pending.txt", "size": 7})
    def delete():
        together.wait(timeout=5)
        return client.delete(url)
    with ThreadPoolExecutor(2) as pool:
        pending, removal = pool.submit(upload), pool.submit(delete)
        u, d = pending.result(timeout=10), removal.result(timeout=10)
    assert (u.status_code, d.status_code) in {(404, 200), (200, 409)}
    if u.status_code == 200:
        assert client.get(url + "/usage").json()["reserved_bytes"] == 7
        assert client.get(url + "/download?path=main.py").content == b"print('hello')"


def test_file_move_and_text_save_use_the_same_version_lock(client):
    p = project(client)
    put(client, p, "main.py", b"original")
    url = f"/api/projects/{p}"
    payload = move_payload(client, p, "main.py", "moved.py")
    with ThreadPoolExecutor(2) as pool:
        moving = pool.submit(client.post, url + "/files/rename", json=payload)
        editing = pool.submit(client.put, url + "/text", json={
            "path": "main.py", "version": payload["version"], "text": "edited"})
        moved, edited = moving.result(timeout=10), editing.result(timeout=10)
    assert (moved.status_code, edited.status_code) in {(200, 409), (409, 200)}
    name, data = ("moved.py", b"original") if moved.status_code == 200 else ("main.py", b"edited")
    assert [row["path"] for row in client.get(url + "/files").json()] == [name]
    assert client.get(url + "/download", params={"path": name}).content == data


def test_project_zip_subdirectory_contents_and_limits(client):
    p = project(client)
    top = b"outside selected directory" * 50000
    put(client, p, "top.txt", top)
    put(client, p, "数据/一级/result.txt", "测试结果".encode())
    put(client, p, "数据/empty.txt", b"")
    url = f"/api/projects/{p}/archive"
    expected = {"一级/result.txt": "测试结果".encode(), "empty.txt": b""}
    assert unzip(client.get(url, params={"dir": "数据"})) == expected
    assert unzip(client.get(url)) == {"top.txt": top,
                                      **{"数据/" + name: content for name, content in expected.items()}}
    assert client.get(url, params={"dir": "missing"}).status_code == 404
    assert client.get(url, params={"dir": "top.txt"}).status_code == 404
    assert client.get(url, params={"dir": ""}).status_code == 400
    uid = start_upload(client, p, "数据/pending.txt")
    assert client.get(url).status_code == 409
    assert client.get(url, params={"dir": "数据"}).status_code == 409
    assert client.delete(f"/api/uploads/{uid}").status_code == 200
    unrelated = start_upload(client, p, "other/later.txt")
    assert unzip(client.get(url, params={"dir": "数据"})) == expected
    assert client.delete(f"/api/uploads/{unrelated}").status_code == 200
    ws = client.app_instance.state.workspace
    limits = ws.limits
    ws.limits = replace(limits, max_archive_bytes=1)
    assert client.get(url).status_code == 507
    ws.limits = replace(limits, max_files=1)
    assert client.get(url).status_code == 507
    assert list((ws.root / "staging").iterdir()) == []
    assert unzip(client.get(f"/api/projects/{project(client)}/archive")) == {}


@pytest.mark.parametrize(("suffix", "header", "media"), [
    ("PNG", b"\x89PNG\r\n\x1a\n", "image/png"),
    ("jpg", b"\xff\xd8\xff", "image/jpeg"),
    ("jpeg", b"\xff\xd8\xff", "image/jpeg"),
    ("webp", b"RIFF\x07\x00\x00\x00WEBP", "image/webp"),
])
def test_image_preview_signature_ranges_limits_and_owner(client, suffix, header, media):
    p = project(client)
    path = "图片." + suffix
    data = header + b"image payload"
    put(client, p, path, data)
    put(client, p, "wrong." + suffix, b"RIFFxxxxWAVE <svg/>")
    put(client, p, "vector.svg", b"<svg/>")
    url = f"/api/projects/{p}/preview"
    result = client.get(url, params={"path": path})
    assert result.status_code == 200 and result.content == data
    assert result.headers["content-type"] == media
    assert result.headers["x-content-type-options"] == "nosniff"
    assert result.headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
    r = client.get(url, params={"path": path}, headers={"Range": "bytes=1-2"})
    assert r.status_code == 206 and r.content == data[1:3]
    for invalid in ("wrong." + suffix, "vector.svg"):
        assert client.get(url, params={"path": invalid}).status_code == 415
    config = client.app_instance.state.config
    config.limits = replace(config.limits, max_image_preview_bytes=len(data) - 1)
    assert client.get(url, params={"path": path}).status_code == 413
    login(client, "bob")
    assert client.get(url, params={"path": path}).status_code == 403


@pytest.mark.parametrize("bad", ["../data.txt", r"C:\other\data.txt", r"\\server\share\data.txt", "file:stream", "NUL.txt"])
def test_path_input_guards_for_new_file_routes(client, bad):
    p = project(client)
    put(client, p)
    project_url = f"/api/projects/{p}"
    move = move_payload(client, p, "main.py", "new.py")
    assert client.post(project_url + "/files/rename", json={**move, "path": bad}).status_code == 400
    assert client.post(project_url + "/files/rename", json={**move, "new_path": bad}).status_code == 400
    assert client.request("DELETE", project_url + "/directories", json={"path": bad}).status_code == 400
    assert client.get(project_url + "/archive", params={"dir": bad}).status_code == 400
    jurl = f"/api/jobs/{submit(client, p).json()['id']}/snapshot"
    assert client.get(jurl + "/text", params={"path": bad}).status_code == 400
    assert client.get(jurl + "/download", params={"path": bad}).status_code == 400


def test_new_routes_reject_directory_junctions(client, tmp_path):
    if os.name == "nt":
        from subprocess import run
        def link_directory(link, target):
            run(["cmd", "/c", "mklink", "/J", str(link), str(target)], check=True, capture_output=True)
    else:
        def link_directory(link, target):
            link.symlink_to(target, target_is_directory=True)

    p = project(client)
    put(client, p)
    put(client, p, "data/keep.txt", b"keep")
    state = client.app_instance.state
    root = state.workspace.project_root("alice", p)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_bytes(b"sentinel")
    job = submit(client, p).json()
    jurl = f"/api/jobs/{job['id']}"
    client.post(jurl + "/cancel")
    link_directory(root / "data" / "linked", outside)
    link_directory(state.workspace.root / "snapshots" / "alice" / job["snapshot"] / "linked", outside)
    output = state.workspace.output_root(job)
    output.parent.mkdir()
    link_directory(output, outside)
    url = f"/api/projects/{p}"
    assert client.request("DELETE", url + "/directories", json={"path": "data"}).status_code == 400
    assert client.delete(url).status_code == 400
    assert client.get(url + "/archive").status_code == 400
    assert client.get(url + "/archive?dir=data/linked").status_code == 400
    assert client.get(url + "/usage").status_code == 400
    assert client.post(url + "/files/rename",
                       json=move_payload(client, p, "main.py", "data/linked/new.py")).status_code == 400
    assert client.get(jurl + "/snapshot/files").status_code == 400
    assert client.get(jurl + "/snapshot/download?path=linked/secret.txt").status_code == 400
    assert client.get(jurl + "/snapshot/text?path=linked/secret.txt").status_code == 400
    assert client.get(jurl + "/outputs/archive").status_code == 400
    assert (outside / "secret.txt").read_bytes() == b"sentinel"
    assert list(outside.iterdir()) == [outside / "secret.txt"]
    assert (root / "data" / "keep.txt").read_bytes() == b"keep"


def test_snapshot_and_rerun_current_input_with_atomic_idempotency(client):
    p = project(client)
    put(client, p)
    put(client, p, "binary.bin", b"\x00raw")
    original = submit(client, p).json()
    jurl = f"/api/jobs/{original['id']}"
    assert client.get(jurl + "/outputs/archive").status_code == 409
    assert client.get(jurl + "/snapshot/text?path=binary.bin").status_code == 415
    assert client.get(jurl + "/snapshot/download?path=missing.txt").status_code == 404
    assert client.post(jurl + "/cancel").status_code == 200
    version = move_payload(client, p, "main.py", "unused.py")["version"]
    r = client.put(f"/api/projects/{p}/text", json={"path": "main.py", "text": "# updated", "version": version})
    assert r.status_code == 200
    for body in ({"request_id": ""}, {"request_id": "a" * 129}, {"request_id": 3}, {"request_id": "x", "args": []}):
        assert client.post(jurl + "/rerun", json=body).status_code == 422
    assert client.post(jurl + "/rerun", json={"request_id": original["request_id"]}).status_code == 409
    pending = start_upload(client, p, "another/result.txt")
    assert client.post(jurl + "/rerun", json={"request_id": "again"}).status_code == 409
    assert client.delete(f"/api/uploads/{pending}").status_code == 200
    with ThreadPoolExecutor(2) as pool:
        retries = list(pool.map(lambda _: client.post(jurl + "/rerun", json={"request_id": "again"}), range(2)))
    assert [response.status_code for response in retries] == [200, 200]
    a, b = [response.json() for response in retries]
    assert a["id"] == b["id"] != original["id"]
    assert a["snapshot"] != original["snapshot"]
    for key in ("project", "environment", "entry", "args", "owner"):
        assert a[key] == original[key]
    assert client.get(f"/api/jobs/{a['id']}/snapshot/text?path=main.py").json()["text"] == "# updated"
    assert client.get(jurl + "/snapshot/download?path=main.py").content == b"print('hello')"
    assert len(client.get("/api/jobs").json()) == 2
    assert client.post(f"/api/jobs/{a['id']}/rerun", json={"request_id": "again"}).status_code == 409
    assert submit(client, p, request_id="again").status_code == 409
    move = move_payload(client, p, "main.py", "moved.py")
    assert client.post(f"/api/projects/{p}/files/rename", json=move).status_code == 200
    assert client.post(jurl + "/rerun", json={"request_id": "missing-entry"}).status_code == 404


def test_rerun_respects_queue_limit_without_leaving_a_snapshot(client):
    p = project(client)
    put(client, p)
    original = submit(client, p).json()
    state = client.app_instance.state
    for n in range(19):
        state.store.submit("alice", p, original["snapshot"], "py312", "main.py", [], f"filling-{n}")
    url = f"/api/jobs/{original['id']}/rerun"
    assert client.post(url, json={"request_id": "one-too-many"}).status_code == 409
    assert len(client.get("/api/jobs").json()) == 20
    assert [path.name for path in (state.workspace.root / "snapshots" / "alice").iterdir()] == [original["snapshot"]]


def test_queue_metrics_use_real_claim_order_and_status_hides_host_configuration(client):
    state = client.app_instance.state
    sequence = {}
    for actor, keys in (("alice", ("a1", "a2", "a3")), ("bob", ("b1", "b2")), ("admin", ("c1",))):
        login(client, actor)
        p = project(client)
        put(client, p)
        for key in keys:
            r = submit(client, p, request_id=key)
            assert r.status_code == 200, r.text
            sequence[key] = r.json()
    chronological = [sequence[key]["id"] for key in ("a1", "b1", "c1", "a2", "b2", "a3")]
    first, *rest = chronological
    login(client, "alice")
    mine = client.get("/api/jobs").json()
    assert [(j["id"], j["queue_position"]) for j in mine] == [(sequence[key]["id"], position)
                                                              for key, position in (("a3", 6), ("a2", 4), ("a1", 1))]
    assert set(mine[0]) == set(sequence["a3"]) | {"duration_seconds", "queue_position"}
    assert all(j["duration_seconds"] is None for j in mine)
    assert client.get("/api/jobs?all_members=true").status_code == 403
    state.config.environments["gpu"] = r"C:\Users\private-service-account\python.exe"
    state.config.environments[r"D:\private\python.exe"] = "Not a public ID"
    status = client.get("/api/system/status").json()
    assert status == {"execution_enabled": False, "terminal_enabled": False, "active_jobs": 0, "queued_jobs": 6,
                      "disk_free_bytes": status["disk_free_bytes"], "disk_min_free_bytes": 0,
                      "environments": ["gpu", "py312"]}
    assert isinstance(status["disk_free_bytes"], int) and status["disk_free_bytes"] >= 0
    claim = state.store.claim_next()
    assert claim["id"] == first
    state.store.transition(first, ["starting"], "running")
    running = client.get(f"/api/jobs/{first}").json()
    assert running["queue_position"] is None
    assert 0 <= running["duration_seconds"] <= time.time() - claim["started"]
    assert client.get("/api/system/status").json()["active_jobs"] == 1
    assert client.get("/api/system/status").json()["queued_jobs"] == 5
    finished = state.store.transition(first, ["running"], "succeeded")
    done = client.get(f"/api/jobs/{first}").json()
    assert done["duration_seconds"] == finished["finished"] - claim["started"]
    assert client.post(f"/api/jobs/{first}/cancel").json()["finished"] == finished["finished"]
    login(client, "admin")
    for upcoming in rest:
        queue = [job for job in client.get("/api/jobs?all_members=true").json() if job["state"] == "queued"]
        head = min(queue, key=lambda job: job["queue_position"])
        assert head["id"] == upcoming and head["queue_position"] == 1
        assert state.store.claim_next()["id"] == upcoming
        state.store.transition(upcoming, ["starting"], "failed")
    assert client.get("/api/system/status").json()["queued_jobs"] == 0
    client.cookies.clear()
    assert client.get("/api/system/status").status_code == 401
