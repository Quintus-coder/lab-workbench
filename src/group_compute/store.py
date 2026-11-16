import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

ACTIVE = ("starting", "running", "cancelling")
TERMINAL = ("succeeded", "failed", "cancelled", "interrupted")
TRANSITIONS = {
    "queued": {"starting", "cancelled"},
    "starting": {"running", "failed", "cancelling", "interrupted"},
    "running": {"succeeded", "failed", "cancelling", "interrupted"},
    "cancelling": {"cancelled", "interrupted"},
}


class Conflict(ValueError):
    pass


class Forbidden(PermissionError):
    pass


class NotFound(FileNotFoundError):
    pass


def new_id():
    return uuid.uuid4().hex


def decode_job(row):
    if row is None:
        return None
    result = dict(row)
    result["args"] = json.loads(result["args"])
    return result


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect(transaction=False) as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript("""
                CREATE TABLE IF NOT EXISTS members(
                  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
                  admin INTEGER NOT NULL DEFAULT 0, last_served INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS projects(
                  id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES members(id), name TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS snapshots(
                  id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs(
                  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                  owner TEXT NOT NULL REFERENCES members(id), project TEXT NOT NULL,
                  snapshot TEXT NOT NULL, environment TEXT NOT NULL, entry TEXT NOT NULL,
                  args TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL,
                  submitted REAL NOT NULL, started REAL, finished REAL, reason TEXT,
                  exit_code INTEGER, UNIQUE(owner, request_id));
                CREATE INDEX IF NOT EXISTS job_state ON jobs(state, owner, seq);
                CREATE TABLE IF NOT EXISTS uploads(
                  id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL,
                  relative TEXT NOT NULL, total INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0,
                  original TEXT, staged_id TEXT, state TEXT NOT NULL DEFAULT 'uploading', created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions(
                  token TEXT PRIMARY KEY, member TEXT NOT NULL, expires REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS office_sessions(
                  id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, relative TEXT NOT NULL,
                  version TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0,
                  last_url TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created REAL NOT NULL);
            """)
            if "staged_id" not in {r[1] for r in c.execute("PRAGMA table_info(uploads)")}:
                c.execute("ALTER TABLE uploads ADD COLUMN staged_id TEXT")

    @contextmanager
    def connect(self, write=False, transaction=True):
        c = sqlite3.connect(self.path, timeout=60, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        try:
            if transaction:
                c.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield c
            c.commit()
        except BaseException:
            c.rollback()
            raise
        finally:
            c.close()

    def add_member(self, member_id, email, name, admin=False):
        if not member_id or len(member_id) > 64 or not all(ch.isascii() and (ch.isalnum() or ch in "_-") for ch in member_id):
            raise ValueError("Invalid member ID")
        with self.connect(True) as c:
            c.execute("INSERT OR IGNORE INTO members(id,email,name,admin) VALUES(?,?,?,?)", (member_id, email.lower(), name, int(admin)))

    def member(self, member_id):
        with self.connect() as c:
            r = c.execute("SELECT * FROM members WHERE id=?", (member_id,)).fetchone()
            if r is None:
                raise Forbidden("成员未经批准")
            return dict(r)

    def member_by_email(self, email):
        with self.connect() as c:
            r = c.execute("SELECT * FROM members WHERE email=?", (email.lower(),)).fetchone()
            if r is None:
                raise Forbidden("邮箱未列入成员名单")
            return dict(r)

    def create_project(self, owner, name):
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError("项目名称应为 1–120 个字符")
        self.member(owner)
        row = dict(id=new_id(), owner=owner, name=name.strip(), created=time.time())
        with self.connect(True) as c:
            if c.execute("SELECT count(*) FROM projects WHERE owner=?", (owner,)).fetchone()[0] >= 100:
                raise Conflict("项目数量已达到上限")
            c.execute("INSERT INTO projects VALUES(:id,:owner,:name,:created)", row)
        return row

    def require_project(self, c, project_id, actor):
        row = c.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if row is None:
            raise NotFound("项目不存在")
        if row["owner"] != actor:
            raise Forbidden("不能访问其他成员的项目")
        return dict(row)

    def list_projects(self, actor):
        with self.connect() as c:
            return [dict(r) for r in c.execute("SELECT * FROM projects WHERE owner=? ORDER BY created", (actor,))]

    def submit(self, member_id, project_id, snapshot_id, environment_id, script_relative, args, request_id, connection=None):
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
            raise ValueError("Invalid request ID")
        def insert(c):
            self.require_project(c, project_id, member_id)
            old = c.execute("SELECT * FROM jobs WHERE owner=? AND request_id=?", (member_id, request_id)).fetchone()
            if old:
                return decode_job(old)
            if c.execute("SELECT count(*) FROM jobs WHERE owner=? AND state='queued'", (member_id,)).fetchone()[0] >= 20:
                raise Conflict("最多保留 20 个等待任务，请取消部分任务后重试")
            j = new_id()
            c.execute("""INSERT INTO jobs(id,owner,project,snapshot,environment,entry,args,request_id,state,submitted)
                         VALUES(?,?,?,?,?,?,?,?,'queued',?)""", (j, member_id, project_id, snapshot_id, environment_id, script_relative, json.dumps(args, ensure_ascii=False), request_id, time.time()))
            return decode_job(c.execute("SELECT * FROM jobs WHERE id=?", (j,)).fetchone())
        if connection is not None:
            return insert(connection)
        with self.connect(True) as c:
            return insert(c)

    def find_request(self, c, owner, request_id):
        return decode_job(c.execute("SELECT * FROM jobs WHERE owner=? AND request_id=?", (owner, request_id)).fetchone())

    def claim_next(self, capacity=1):
        if not 1 <= capacity <= 4:
            raise ValueError("Invalid capacity")
        with self.connect(True) as c:
            if c.execute("SELECT count(*) FROM jobs WHERE state IN ('starting','running','cancelling')").fetchone()[0] >= capacity:
                return None
            r = c.execute("""SELECT j.* FROM jobs j JOIN members m ON j.owner=m.id
                             WHERE j.state='queued' ORDER BY m.last_served,j.seq LIMIT 1""").fetchone()
            if r is None:
                return None
            counter = c.execute("SELECT coalesce(max(last_served),0)+1 FROM members").fetchone()[0]
            c.execute("UPDATE members SET last_served=? WHERE id=?", (counter, r["owner"]))
            c.execute("UPDATE jobs SET state='starting',started=? WHERE id=?", (time.time(), r["id"]))
            return decode_job(c.execute("SELECT * FROM jobs WHERE id=?", (r["id"],)).fetchone())

    def _job(self, c, job_id, actor=None):
        r = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if r is None:
            raise NotFound("任务不存在")
        if actor is not None and actor != r["owner"]:
            member = c.execute("SELECT admin FROM members WHERE id=?", (actor,)).fetchone()
            if not member or not member[0]:
                raise Forbidden("不能访问其他成员的任务")
        return decode_job(r)

    def get_job(self, job_id, actor):
        with self.connect() as c:
            return self._job(c, job_id, actor)

    def list_jobs(self, actor, all_members=False):
        if all_members and not self.member(actor)["admin"]:
            raise Forbidden("需要管理员权限")
        with self.connect() as c:
            query = "SELECT * FROM jobs" + ("" if all_members else " WHERE owner=?") + " ORDER BY seq DESC LIMIT 500"
            return [decode_job(r) for r in c.execute(query, () if all_members else (actor,))]

    def transition(self, job_id, expected, next_state, reason=None, exit_code=None):
        with self.connect(True) as c:
            r = self._job(c, job_id)
            if r["state"] not in expected or next_state not in TRANSITIONS.get(r["state"], set()):
                raise Conflict("任务状态已经改变")
            c.execute("UPDATE jobs SET state=?,reason=?,exit_code=?,finished=? WHERE id=?", (next_state, reason, exit_code, time.time() if next_state in TERMINAL else None, job_id))
            return self._job(c, job_id)

    def request_cancel(self, job_id, actor):
        with self.connect(True) as c:
            j = self._job(c, job_id, actor)
            state = "cancelled" if j["state"] == "queued" else "cancelling" if j["state"] in ACTIVE else j["state"]
            c.execute("UPDATE jobs SET state=?,finished=? WHERE id=?", (state, time.time() if state in TERMINAL else None, job_id))
            return self._job(c, job_id)

    def recover_after_runner_cleanup(self):
        """Caller must hold exclusive worker ownership and prove its Job Objects closed."""
        with self.connect(True) as c:
            c.execute("UPDATE jobs SET state='interrupted',finished=?,reason=? WHERE state IN ('starting','running','cancelling')", (time.time(), "执行服务中断；结果未知，未自动重新执行"))
