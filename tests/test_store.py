"""Persistent real SQLite tests: capacity, fairness and ownership are server rules."""
from concurrent.futures import ThreadPoolExecutor
import pytest
from group_compute.store import Store, Conflict, Forbidden


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "state.sqlite")
    s.add_member("alice", "alice@example.org", "Alice")
    s.add_member("bob", "bob@example.org", "Bob")
    return s


def submit(s, who, key):
    p = s.create_project(who, "实验")
    return s.submit(who, p["id"], "a" * 32, "py312", "main.py", ["two words"], key)


def test_simultaneous_claims_respect_one_slot(store):
    submit(store, "alice", "a")
    submit(store, "bob", "b")
    with ThreadPoolExecutor(2) as pool:
        jobs = list(pool.map(lambda _: store.claim_next(1), range(2)))
    assert sum(j is not None for j in jobs) == 1


def test_round_robin_with_member_fifo(store):
    a1, a2 = submit(store, "alice", "a1"), submit(store, "alice", "a2")
    b1 = submit(store, "bob", "b1")
    found = []
    for _ in range(3):
        j = store.claim_next(1)
        found.append(j["id"])
        store.transition(j["id"], ["starting"], "failed", reason="test")
    assert found == [a1["id"], b1["id"], a2["id"]]


def test_same_request_id_is_idempotent(store):
    a = submit(store, "alice", "same")
    assert submit(store, "alice", "same")["id"] == a["id"]
    assert len(store.list_jobs("alice")) == 1


def test_starting_and_cancelling_hold_slot(store):
    a = submit(store, "alice", "a")
    submit(store, "bob", "b")
    store.claim_next(1)
    store.request_cancel(a["id"], "alice")
    assert store.claim_next(1) is None
    assert store.get_job(a["id"], "alice")["state"] == "cancelling"


def test_waiting_cancel_and_owner_boundary(store):
    a = submit(store, "alice", "a")
    with pytest.raises(Forbidden):
        store.request_cancel(a["id"], "bob")
    store.request_cancel(a["id"], "alice")
    assert store.claim_next(1) is None
    with pytest.raises(Conflict):
        store.transition(a["id"], ["running"], "succeeded")


def test_restart_marks_unknown_run_interrupted_without_relaunch(store):
    a = submit(store, "alice", "a")
    b = submit(store, "bob", "b")
    store.claim_next(1)
    store.recover_after_runner_cleanup()
    reopened = Store(store.path)
    assert reopened.get_job(a["id"], "alice")["state"] == "interrupted"
    assert reopened.claim_next(1)["id"] == b["id"]
