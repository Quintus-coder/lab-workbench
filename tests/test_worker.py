from dataclasses import dataclass
import pytest
from group_compute.store import Store
from group_compute.worker import Worker, Observation


class ControlledRunner:
    """No user code executes: tests control OS observations at the runner boundary."""
    def __init__(self):
        self.live = {}
        self.opened = False

    def open_exclusive(self):
        if self.opened:
            raise RuntimeError("worker already owns runner")
        self.opened = True
        return True  # A real runner may return true only after process cleanup is proven.

    def start(self, job):
        if job["entry"] == "fail.py":
            raise OSError("synthetic launch error")
        self.live[job["id"]] = Observation("running")
        return job["id"]

    def poll(self, handle):
        return self.live[handle]

    def cancel(self, handle):
        self.live[handle] = Observation("cancelled", reason="用户取消")
        return self.live[handle]

    def close(self):
        self.live.clear()
        self.opened = False


@pytest.fixture
def setup(tmp_path):
    s = Store(tmp_path / "state.sqlite")
    s.add_member("alice", "a@example.org", "A")
    p = s.create_project("alice", "p")["id"]
    r = ControlledRunner()
    w = Worker(s, r)
    return s, p, r, w


def add(s, p, key, entry="main.py"):
    return s.submit("alice", p, "a"*32, "py312", entry, [], key)


def test_failure_releases_slot_and_next_job_starts(setup):
    s, p, r, w = setup
    a, b = add(s, p, "a", "fail.py"), add(s, p, "b")
    w.tick()
    assert s.get_job(a["id"], "alice")["state"] == "failed"
    w.tick()
    assert s.get_job(b["id"], "alice")["state"] == "running"


def test_cancellation_waits_for_runner_confirmation(setup):
    s, p, r, w = setup
    a, b = add(s, p, "a"), add(s, p, "b")
    w.tick()
    s.request_cancel(a["id"], "alice")
    w.tick()
    assert s.get_job(a["id"], "alice")["state"] == "cancelled"
    assert s.get_job(b["id"], "alice")["state"] == "running"


def test_web_store_reopen_does_not_interrupt_job(setup):
    s, p, r, w = setup
    a = add(s, p, "a")
    w.tick()
    reopened = Store(s.path)
    assert reopened.get_job(a["id"], "alice")["state"] == "running"
    r.live[a["id"]] = Observation("succeeded", exit_code=0)
    w.tick()
    assert reopened.get_job(a["id"], "alice")["exit_code"] == 0


def test_recovery_requires_exclusive_runner_cleanup(setup):
    s, p, r, w = setup
    add(s, p, "a")
    w.tick()
    with pytest.raises(RuntimeError):
        Worker(s, r)
    assert s.list_jobs("alice")[0]["state"] == "running"


def test_cancel_during_start_does_not_leave_untracked_task(setup):
    s, p, r, w = setup
    a = add(s, p, "a")
    original = r.start
    def start(job):
        h = original(job)
        s.request_cancel(job["id"], "alice")
        return h
    r.start = start
    w.tick()
    w.tick()
    assert s.get_job(a["id"], "alice")["state"] == "cancelled"


def test_cancel_racing_failed_launch_releases_capacity(setup, monkeypatch):
    s, p, r, w = setup
    a, b = add(s, p, "a", "fail.py"), add(s, p, "b")
    transition = s.transition
    raced = False
    def transition_after_cancel(jid, expected, next_state, **kwargs):
        nonlocal raced
        if jid == a["id"] and next_state == "failed" and not raced:
            raced = True
            s.request_cancel(jid, "alice")
        return transition(jid, expected, next_state, **kwargs)
    monkeypatch.setattr(s, "transition", transition_after_cancel)
    w.tick()
    assert s.get_job(a["id"], "alice")["state"] == "cancelled"
    w.tick()
    assert s.get_job(b["id"], "alice")["state"] == "running"
