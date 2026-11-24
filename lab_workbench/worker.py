"""Scheduler state machine. No subprocess fallback; an approved isolated runner is required."""
from dataclasses import dataclass
from .store import Conflict


@dataclass(frozen=True)
class Observation:
    state: str
    exit_code: int | None = None
    reason: str | None = None


class Worker:
    def __init__(self, store, runner, capacity=1):
        self.store, self.runner, self.capacity = store, runner, capacity
        self.handles = {}
        if runner.open_exclusive() is not True:
            raise RuntimeError("Cannot recover until exclusive ownership and process cleanup are proven")
        store.recover_after_runner_cleanup()

    def tick(self):
        for jid, handle in list(self.handles.items()):
            with self.store.connect() as c:
                job = self.store._job(c, jid)
            observation = self.runner.cancel(handle) if job["state"] == "cancelling" else self.runner.poll(handle)
            if observation.state == "running":
                continue
            state = "cancelled" if job["state"] == "cancelling" else observation.state
            if state not in ("succeeded", "failed", "cancelled", "interrupted"):
                raise RuntimeError("Runner returned an invalid observation")
            try:
                self.store.transition(jid, [job["state"]], state, reason=observation.reason, exit_code=observation.exit_code)
            except Conflict:
                # A cancellation raced with completion. Keep the handle and poll again.
                continue
            del self.handles[jid]

        job = self.store.claim_next(self.capacity)
        if job is None:
            return
        try:
            handle = self.runner.start(job)
        except Exception:
            # Runner.start may raise only after proving no child remains alive.
            try:
                self.store.transition(job["id"], ["starting"], "failed", reason="执行器启动失败；请联系管理员")
            except Conflict:
                # Cancellation may arrive between launch failure and its atomic
                # state update. The runner has no live child, so finish cancellation.
                self.store.transition(job["id"], ["cancelling"], "cancelled", reason="启动期间已取消")
            return
        self.handles[job["id"]] = handle
        try:
            self.store.transition(job["id"], ["starting"], "running")
        except Conflict:
            # Starting cancellation still holds capacity; handle remains owned for next tick.
            pass
