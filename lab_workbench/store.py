import json
import re
import sqlite3
import time
import uuid
from collections import deque
from contextlib import contextmanager
from pathlib import Path
from .auth import AuthenticationError, RateLimited, password_hash, password_matches, token_digest

ACTIVE = ("starting", "running", "cancelling")
TERMINAL = ("succeeded", "failed", "cancelled", "interrupted")
_QUEUED_ORDER = (" FROM jobs j JOIN members m ON j.owner=m.id"
                 " WHERE j.state='queued' ORDER BY m.last_served,j.seq")
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


def normalized_email(value):
    email = value.strip().lower()
    local, sep, domain = email.partition("@")
    if (not sep or not 0 < len(local) <= 64 or len(email) > 254 or local.startswith(".")
            or local.endswith(".") or ".." in local or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+", local)
            or "." not in domain or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", s)
                                        for s in domain.split("."))):
        raise ValueError("请输入完整的邮箱地址")
    return email


def member_summary(row):
    return {**{k: row[k] for k in ("id", "email", "name", "admin")},
            "status": "disabled" if not row["enabled"] else "active" if row["activated"] else "pending"}


def decode_job(row):
    if row is None:
        return None
    result = dict(row)
    result["args"] = json.loads(result["args"])
    result.pop("rerun_of", None)
    return result


def project_name(name):
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise ValueError("项目名称应为 1–120 个字符")
    return name.strip()


def _job_metrics(job, positions, now):
    started, finished = job["started"], job["finished"]
    job["duration_seconds"] = None if started is None else (now if finished is None else finished) - started
    job["queue_position"] = positions.get(job["id"])
    return job


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
                  exit_code INTEGER, rerun_of TEXT, UNIQUE(owner, request_id));
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
        with self.connect(True) as c:
            if "rerun_of" not in {r[1] for r in c.execute("PRAGMA table_info(jobs)")}:
                c.execute("ALTER TABLE jobs ADD COLUMN rerun_of TEXT")
            columns = {r[1] for r in c.execute("PRAGMA table_info(members)")}
            for field in ("enabled", "activated"):
                if field not in columns:
                    c.execute(f"ALTER TABLE members ADD COLUMN {field} INTEGER NOT NULL DEFAULT 1")
            if "password_hash" not in columns:
                c.execute("ALTER TABLE members ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''")
            c.execute("CREATE TABLE IF NOT EXISTS auth_attempts(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires REAL NOT NULL)")

    def configure_members(self, mode, bootstrap_email="", password_auth=False):
        with self.connect(True) as c:
            c.execute("CREATE TABLE IF NOT EXISTS deployment(mode TEXT PRIMARY KEY)")
            if "authentication" not in {r[1] for r in c.execute("PRAGMA table_info(deployment)")}:
                c.execute("ALTER TABLE deployment ADD COLUMN authentication TEXT NOT NULL DEFAULT ''")
            prior = c.execute("SELECT mode FROM deployment").fetchone()
            demo = c.execute("SELECT 1 FROM members WHERE (id || '@example.org')=email AND id IN ('admin','alice','bob')").fetchone()
            if (prior and prior[0] != mode) or (mode == "production" and demo):
                raise ValueError("开发与正式模式必须使用独立的数据目录")
            if not prior:
                if mode == "development" and c.execute("SELECT 1 FROM members LIMIT 1").fetchone() and not demo:
                    raise ValueError("已有成员的数据目录不能直接切到开发模式")
                c.execute("INSERT INTO deployment(mode) VALUES(?)", (mode,))
            current_auth = "password" if password_auth else "access" if mode == "production" else "demo"
            old_auth = c.execute("SELECT authentication FROM deployment").fetchone()[0]
            old_auth = old_auth or ("access" if mode == "production" else "demo")
            if prior and old_auth != current_auth:
                if "demo" in (old_auth, current_auth):
                    raise ValueError("试用身份与密码登录必须使用独立的数据目录")
                c.execute("DELETE FROM sessions")
            c.execute("UPDATE deployment SET authentication=?", (current_auth,))
            if mode == "production" and not password_auth and not c.execute("SELECT 1 FROM members WHERE admin=1 AND enabled=1 AND activated=1").fetchone():
                if not bootstrap_email:
                    raise ValueError("请在首次启动时配置 GC_BOOTSTRAP_ADMIN_EMAIL")
                email = normalized_email(bootstrap_email)
                if c.execute("SELECT 1 FROM members WHERE email=?", (email,)).fetchone():
                    raise ValueError("首次管理员邮箱已被使用，请核对数据目录")
                c.execute("INSERT INTO members(id,email,name,admin) VALUES(?,?,?,1)", (new_id(), email, "管理员"))

    def manage_members(self, actor, *, email=None, target=None, enabled=None):
        with self.connect(write=email is not None or target is not None) as c:
            if not c.execute("SELECT 1 FROM members WHERE id=? AND admin=1 AND enabled=1 AND activated=1", (actor,)).fetchone():
                raise Forbidden("仅管理员可以管理成员")
            if email is not None:
                email = normalized_email(email)
                if c.execute("SELECT 1 FROM members WHERE email=?", (email,)).fetchone():
                    raise Conflict("此邮箱已在名单中")
                target = new_id()
                c.execute("INSERT INTO members(id,email,name,activated) VALUES(?,?,'',0)", (target, email))
            elif target is not None:
                row = c.execute("SELECT admin FROM members WHERE id=?", (target,)).fetchone()
                if row is None:
                    raise NotFound("成员不存在")
                if row["admin"]:
                    raise Forbidden("不能通过此入口更改管理员状态")
                c.execute("UPDATE members SET enabled=? WHERE id=?", (int(enabled), target))
                if not enabled:
                    c.execute("UPDATE office_sessions SET active=0 WHERE owner=?", (target,))
                    c.execute("DELETE FROM sessions WHERE member=?", (target,))
            else:
                return [member_summary(r) for r in c.execute("SELECT * FROM members ORDER BY admin DESC,email")]
            return member_summary(c.execute("SELECT * FROM members WHERE id=?", (target,)).fetchone())

    def approve_registration(self, email, actor=None):
        """actor=None is only used by the local administrator initialization command."""
        email = normalized_email(email)
        with self.connect(True) as c:
            row = c.execute("SELECT * FROM members WHERE email=?", (email,)).fetchone()
            if actor is None:
                admins = c.execute("SELECT * FROM members WHERE admin=1").fetchall()
                if admins and (len(admins) != 1 or admins[0]["email"] != email or admins[0]["password_hash"]):
                    raise Conflict("已有管理员；不能用初始化命令覆盖账号或密码")
                if row and not row["admin"]:
                    raise Conflict("该邮箱已属于普通成员")
            elif not c.execute("SELECT 1 FROM members WHERE id=? AND admin=1 AND enabled=1 AND activated=1", (actor,)).fetchone():
                raise Forbidden("仅管理员可以批准注册邮箱")
            if row and (row["password_hash"] or not row["enabled"]):
                raise Conflict("该成员已设置密码或已停用")
            mid = row["id"] if row else new_id()
            if not row:
                c.execute("INSERT INTO members(id,email,name,admin,activated) VALUES(?,?,'',?,0)", (mid, email, int(actor is None)))
            result = member_summary(c.execute("SELECT * FROM members WHERE id=?", (mid,)).fetchone())
        return result

    def register_password(self, email, password):
        email = normalized_email(email)
        def approved(c):
            row = c.execute("SELECT * FROM members WHERE email=?", (email,)).fetchone()
            if row is None or not row["enabled"]:
                raise Forbidden("该邮箱尚未获准注册，请联系管理员")
            if row["password_hash"]:
                raise Conflict("该邮箱已注册，请返回登录")
            return row
        with self.connect() as c:
            approved(c)
        encoded = password_hash(password)
        with self.connect(True) as c:
            row = approved(c)  # Recheck approval and registration under the write lock.
            c.execute("UPDATE members SET password_hash=?,name=?,activated=1 WHERE id=?",
                      (encoded, row["name"] or email.split("@")[0], row["id"]))
            c.execute("DELETE FROM sessions WHERE member=?", (row["id"],))
            return row["id"]

    def limit_auth_attempt(self, email=""):
        now = time.time()
        with self.connect(True) as c:
            c.execute("DELETE FROM auth_attempts WHERE expires<=?", (now,))
            for key, maximum, window in [("global", 120, 60)] + ([(token_digest(email), 10, 900)] if email else []):
                row = c.execute("SELECT count FROM auth_attempts WHERE key=?", (key,)).fetchone()
                if row and row[0] >= maximum:
                    raise RateLimited("尝试次数过多，请稍后再试（账号限制最长 15 分钟）")
            for key, maximum, window in [("global", 120, 60)] + ([(token_digest(email), 10, 900)] if email else []):
                c.execute("INSERT INTO auth_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1", (key, now + window))

    def password_login(self, email, password):
        email = normalized_email(email)
        self.limit_auth_attempt(email)
        with self.connect() as c:
            row = c.execute("SELECT * FROM members WHERE email=?", (email,)).fetchone()
        if not password_matches(password, row["password_hash"] if row else "") or not row or not row["enabled"] or not row["activated"]:
            raise AuthenticationError("邮箱或密码不正确，或账号不可用")
        with self.connect(True) as c:
            c.execute("DELETE FROM auth_attempts WHERE key=?", (token_digest(email),))
        return row["id"]

    def activate(self, email, name):
        with self.connect(True) as c:
            row = c.execute("SELECT * FROM members WHERE email=? AND enabled=1", (email.lower(),)).fetchone()
            if not row:
                raise Forbidden("此账号没有有效邀请")
            if not row["activated"]:
                c.execute("UPDATE members SET activated=1,name=? WHERE id=?", (name, row["id"]))
            return member_summary(c.execute("SELECT * FROM members WHERE id=?", (row["id"],)).fetchone())

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
        name = project_name(name)
        self.member(owner)
        row = dict(id=new_id(), owner=owner, name=name, created=time.time())
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

    def rename_project(self, actor, project_id, name):
        name = project_name(name)
        with self.connect(True) as c:
            row = self.require_project(c, project_id, actor)
            c.execute("UPDATE projects SET name=? WHERE id=?", (name, project_id))
            row["name"] = name
            return row

    def submit(self, member_id, project_id, snapshot_id, environment_id, script_relative, args, request_id,
               connection=None, *, rerun_of=None):
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
            raise ValueError("Invalid request ID")
        def insert(c):
            self.require_project(c, project_id, member_id)
            old = self.find_request(c, member_id, request_id, rerun_of=rerun_of)
            if old:
                return old
            if c.execute("SELECT count(*) FROM jobs WHERE owner=? AND state='queued'", (member_id,)).fetchone()[0] >= 20:
                raise Conflict("最多保留 20 个等待任务，请取消部分任务后重试")
            j = new_id()
            c.execute("""INSERT INTO jobs(id,owner,project,snapshot,environment,entry,args,request_id,state,submitted,rerun_of)
                         VALUES(?,?,?,?,?,?,?,?,'queued',?,?)""", (j, member_id, project_id, snapshot_id, environment_id, script_relative, json.dumps(args, ensure_ascii=False), request_id, time.time(), rerun_of))
            return decode_job(c.execute("SELECT * FROM jobs WHERE id=?", (j,)).fetchone())
        if connection is not None:
            return insert(connection)
        with self.connect(True) as c:
            return insert(c)

    def find_request(self, c, owner, request_id, *, rerun_of=None):
        row = c.execute("SELECT * FROM jobs WHERE owner=? AND request_id=?", (owner, request_id)).fetchone()
        if row is not None and row["rerun_of"] != rerun_of:
            raise Conflict("提交标识已被另一个任务使用")
        return decode_job(row)

    def claim_next(self, capacity=1):
        if not 1 <= capacity <= 4:
            raise ValueError("Invalid capacity")
        with self.connect(True) as c:
            if c.execute("SELECT count(*) FROM jobs WHERE state IN ('starting','running','cancelling')").fetchone()[0] >= capacity:
                return None
            r = c.execute("SELECT j.*" + _QUEUED_ORDER + " LIMIT 1").fetchone()
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

    def _queue_positions(self, c):
        by_owner = {}
        for row in c.execute("SELECT j.owner,j.id" + _QUEUED_ORDER):
            by_owner.setdefault(row["owner"], deque()).append(row["id"])
        # Each claim advances that owner to the back and preserves their own FIFO order.
        waiting, positions = deque(by_owner.values()), {}
        while waiting:
            jobs = waiting.popleft()
            positions[jobs.popleft()] = len(positions) + 1
            if jobs:
                waiting.append(jobs)
        return positions

    def get_job(self, job_id, actor, *, include_metrics=False):
        with self.connect() as c:
            job = self._job(c, job_id, actor)
            if not include_metrics:
                return job
            positions = self._queue_positions(c) if job["state"] == "queued" else {}
            return _job_metrics(job, positions, time.time())

    def list_jobs(self, actor, all_members=False):
        if all_members and not self.member(actor)["admin"]:
            raise Forbidden("需要管理员权限")
        with self.connect() as c:
            query = "SELECT * FROM jobs" + ("" if all_members else " WHERE owner=?") + " ORDER BY seq DESC LIMIT 500"
            jobs = [decode_job(r) for r in c.execute(query, () if all_members else (actor,))]
            positions = self._queue_positions(c) if any(j["state"] == "queued" for j in jobs) else {}
            now = time.time()
            return [_job_metrics(j, positions, now) for j in jobs]

    def job_counts(self):
        with self.connect() as c:
            counts = dict(c.execute("SELECT state,count(*) FROM jobs WHERE state IN (?,?,?,?) GROUP BY state",
                                    ("queued", *ACTIVE)))
            return dict(active_jobs=sum(counts.get(state, 0) for state in ACTIVE), queued_jobs=counts.get("queued", 0))

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
            if j["state"] in TERMINAL:
                return j
            state = "cancelled" if j["state"] == "queued" else "cancelling" if j["state"] in ACTIVE else j["state"]
            c.execute("UPDATE jobs SET state=?,finished=? WHERE id=?", (state, time.time() if state in TERMINAL else None, job_id))
            return self._job(c, job_id)

    def recover_after_runner_cleanup(self):
        """Caller must hold exclusive worker ownership and prove its Job Objects closed."""
        with self.connect(True) as c:
            c.execute("UPDATE jobs SET state='interrupted',finished=?,reason=? WHERE state IN ('starting','running','cancelling')", (time.time(), "执行服务中断；结果未知，未自动重新执行"))
