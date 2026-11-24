"""Real files, restarts and links test transfer contracts without file hashes."""
import os
import pytest
from lab_workbench.store import Store, Conflict, Forbidden
from lab_workbench.config import Limits
from lab_workbench.paths import Workspace, InvalidPath, StorageFull


@pytest.fixture
def workspace(tmp_path):
    s = Store(tmp_path / "state.sqlite")
    s.add_member("alice", "a@example.org", "A")
    s.add_member("bob", "b@example.org", "B")
    p = s.create_project("alice", "项目")
    return Workspace(tmp_path / "files", s, Limits(min_free_bytes=0)), s, p["id"]


def upload(w, p, name, content, overwrite=False):
    u = w.begin_upload("alice", p, name, len(content), overwrite)
    w.write_chunk("alice", u["id"], 0, content)
    w.finalize("alice", u["id"])
    return u


def read(w, p, name):
    with w.open_project("alice", p, name) as f:
        return f.read()


def test_unicode_and_space_paths(workspace):
    w, _, p = workspace
    upload(w, p, "数据 集/输入.txt", "你好".encode())
    assert read(w, p, "数据 集/输入.txt").decode() == "你好"
    assert w.list_project("alice", p)[0]["path"] == "数据 集/输入.txt"


def test_text_editor_creates_and_saves_unicode_file(workspace):
    w, _, p = workspace
    created = w.save_text("alice", p, "脚本/run.ps1", "python -u train.py --epochs 10\n", None)
    assert created["text"] == "python -u train.py --epochs 10\n"
    assert read(w, p, "脚本/run.ps1") == b"python -u train.py --epochs 10\n"
    saved = w.save_text("alice", p, "脚本/run.ps1", "# 中文\n", created["version"])
    assert w.read_text("alice", p, "脚本/run.ps1")["version"] == saved["version"]
    assert read(w, p, "脚本/run.ps1").decode() == "# 中文\n"


def test_text_editor_rejects_stale_save_without_overwriting(workspace):
    w, _, p = workspace
    upload(w, p, "main.py", b"old")
    old = w.read_text("alice", p, "main.py")
    upload(w, p, "main.py", b"new", True)
    with pytest.raises(Conflict):
        w.save_text("alice", p, "main.py", "stale", old["version"])
    assert read(w, p, "main.py") == b"new"
    with pytest.raises(Conflict):
        w.save_text("alice", p, "main.py", "overwrite unseen", None)


def test_text_editor_preserves_bom_and_crlf(workspace):
    w, _, p = workspace
    upload(w, p, "run.ps1", b"\xef\xbb\xbf# old\r\n")
    old = w.read_text("alice", p, "run.ps1")
    w.save_text("alice", p, "run.ps1", "# new\npython main.py\n", old["version"])
    assert read(w, p, "run.ps1") == b"\xef\xbb\xbf# new\r\npython main.py\r\n"


def test_text_editor_rejects_binary_large_and_other_members(workspace):
    from lab_workbench.paths import UnsupportedText
    w, _, p = workspace
    upload(w, p, "binary.dat", b"\x00data")
    with pytest.raises(UnsupportedText):
        w.read_text("alice", p, "binary.dat")
    upload(w, p, "legacy.txt", b"\xff\xfeold")
    with pytest.raises(UnsupportedText):
        w.read_text("alice", p, "legacy.txt")
    with pytest.raises(Forbidden):
        w.save_text("bob", p, "secret.py", "x", None)
    w.limits = Limits(min_free_bytes=0, max_text_bytes=4)
    with pytest.raises(UnsupportedText):
        w.save_text("alice", p, "large.txt", "中文", None)
    with pytest.raises(InvalidPath):
        w.save_text("alice", p, "../escape.txt", "x", None)


def test_text_editor_blocks_pending_upload_and_keeps_snapshot(workspace):
    w, _, p = workspace
    upload(w, p, "main.py", b"old")
    old = w.read_text("alice", p, "main.py")
    snap = w.snapshot("alice", p)
    u = w.begin_upload("alice", p, "main.py", 3, True)
    with pytest.raises(Conflict):
        w.save_text("alice", p, "main.py", "new", old["version"])
    w.abandon("alice", u["id"])
    w.save_text("alice", p, "main.py", "new", old["version"])
    with w.open_snapshot("alice", snap, "main.py") as f:
        assert f.read() == b"old"


@pytest.mark.parametrize("name", ["../x", "a/../../x", "C:/x", "\\\\server\\x", "/x", "a:stream", "NUL.txt", "COM1", "a/aux.py", "x.", "x ", "a//x", "a/./x", "LPT¹.txt"])
def test_rejects_parent_drive_ads_and_reserved_names(workspace, name):
    w, _, p = workspace
    with pytest.raises(InvalidPath):
        w.begin_upload("alice", p, name, 1)


def test_chunk_retry_and_offset_conflict(workspace):
    w, _, p = workspace
    u = w.begin_upload("alice", p, "main.py", 6)
    assert w.write_chunk("alice", u["id"], 0, b"abc")["received"] == 3
    assert w.write_chunk("alice", u["id"], 0, b"abc")["received"] == 3
    with pytest.raises(Conflict):
        w.write_chunk("alice", u["id"], 0, b"xyz")
    with pytest.raises(Conflict):
        w.write_chunk("alice", u["id"], 5, b"f")
    resumed = Workspace(w.root, w.store, w.limits)
    assert resumed.upload_status("alice", u["id"])["received"] == 3
    resumed.write_chunk("alice", u["id"], 3, b"def")
    resumed.finalize("alice", u["id"])
    resumed.finalize("alice", u["id"])
    assert read(w, p, "main.py") == b"abcdef"


def test_incomplete_upload_keeps_previous_version(workspace):
    w, _, p = workspace
    upload(w, p, "main.py", b"old")
    u = w.begin_upload("alice", p, "main.py", 6, overwrite=True)
    w.write_chunk("alice", u["id"], 0, b"abc")
    with pytest.raises(Conflict):
        w.finalize("alice", u["id"])
    assert read(w, p, "main.py") == b"old"
    w.write_chunk("alice", u["id"], 3, b"def")
    w.finalize("alice", u["id"])
    assert read(w, p, "main.py") == b"abcdef"


def test_overwrite_requires_confirmation(workspace):
    w, _, p = workspace
    upload(w, p, "main.py", b"old")
    with pytest.raises(Conflict):
        upload(w, p, "main.py", b"new")
    first = w.begin_upload("alice", p, "main.py", 1, True)
    upload(w, p, "main.py", b"second", True)
    w.write_chunk("alice", first["id"], 0, b"x")
    with pytest.raises(Conflict):
        w.finalize("alice", first["id"])
    assert read(w, p, "main.py") == b"second"


def test_snapshot_is_unchanged_by_project_edits(workspace):
    w, _, p = workspace
    upload(w, p, "main.py", b"old")
    snap = w.snapshot("alice", p)
    upload(w, p, "main.py", b"new", True)
    with w.open_snapshot("alice", snap, "main.py") as f:
        assert f.read() == b"old"


def test_finalize_and_snapshot_are_serialized(workspace):
    from concurrent.futures import ThreadPoolExecutor
    w, _, p = workspace
    upload(w, p, "main.py", b"old")
    u = w.begin_upload("alice", p, "main.py", 3, True)
    w.write_chunk("alice", u["id"], 0, b"new")
    with ThreadPoolExecutor(2) as pool:
        f1 = pool.submit(w.snapshot, "alice", p)
        f2 = pool.submit(w.finalize, "alice", u["id"])
        snap = f1.result()
        f2.result()
    with w.open_snapshot("alice", snap, "main.py") as f:
        assert f.read() in (b"old", b"new")


def test_low_disk_space_rejects_new_write(workspace):
    w, _, p = workspace
    strict = Workspace(w.root, w.store, Limits(min_free_bytes=2**63))
    with pytest.raises(StorageFull):
        strict.begin_upload("alice", p, "main.py", 1)


def test_cross_member_upload_and_download_denied(workspace):
    w, _, p = workspace
    u = upload(w, p, "main.py", b"test")
    for action in [lambda: w.begin_upload("bob", p, "x", 0), lambda: w.upload_status("bob", u["id"]), lambda: w.open_project("bob", p, "main.py")]:
        with pytest.raises(Forbidden):
            action()


def test_reparse_swap_cannot_read_other_member(workspace, tmp_path):
    w, _, p = workspace
    upload(w, p, "main.py", b"test")
    other = tmp_path / "outside"
    other.mkdir()
    (other / "secret").write_bytes(b"sentinel")
    link = w.project_root("alice", p) / "linked"
    if os.name == "nt":
        import subprocess
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(other)], check=True, capture_output=True)
    else:
        link.symlink_to(other, target_is_directory=True)
    with pytest.raises(InvalidPath):
        w.open_project("alice", p, "linked/secret")
    with pytest.raises(InvalidPath):
        upload(w, p, "linked/new", b"x")


def test_project_quota_and_abandon_release_staging(workspace):
    w, _, p = workspace
    w.limits = Limits(min_free_bytes=0, max_file_bytes=4, max_project_bytes=6)
    u = w.begin_upload("alice", p, "a", 4)
    with pytest.raises(StorageFull):
        w.begin_upload("alice", p, "b", 4)
    w.abandon("alice", u["id"])
    upload(w, p, "b", b"1234")


def test_finalize_recovers_after_replace_before_database_commit(workspace, monkeypatch):
    w, _, p = workspace
    upload(w, p, "main.py", b"old")
    u = w.begin_upload("alice", p, "main.py", 3, True)
    w.write_chunk("alice", u["id"], 0, b"new")
    original = os.replace
    def interrupted(src, dst):
        original(src, dst)
        raise OSError("simulated crash after filesystem commit")
    with monkeypatch.context() as m:
        m.setattr(os, "replace", interrupted)
        with pytest.raises(OSError):
            w.finalize("alice", u["id"])
    assert read(w, p, "main.py") == b"new"
    assert w.finalize("alice", u["id"])["state"] == "complete"


def test_failed_submission_does_not_leave_snapshot(workspace):
    w, s, p = workspace
    upload(w, p, "main.py", b"test")
    for n in range(20):
        w.submit("alice", p, "py312", "main.py", [], str(n))
    with pytest.raises(Conflict):
        w.submit("alice", p, "py312", "main.py", [], "one-too-many")
    assert len(list((w.root / "snapshots" / "alice").iterdir())) == 20


def test_overwrite_during_download_can_retry_without_losing_old_file(workspace):
    w, _, p = workspace
    upload(w, p, "main.py", b"old")
    with w.open_project("alice", p, "main.py") as old_reader:
        u = w.begin_upload("alice", p, "main.py", 3, True)
        w.write_chunk("alice", u["id"], 0, b"new")
        with pytest.raises(Conflict):
            w.finalize("alice", u["id"])
        assert old_reader.read() == b"old"
        assert read(w, p, "main.py") == b"old"
    w.finalize("alice", u["id"])
    assert read(w, p, "main.py") == b"new"
