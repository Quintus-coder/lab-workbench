import codecs
import json
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import quote, urlsplit
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse, Response, RedirectResponse
from fastapi.staticfiles import StaticFiles
from jinja2 import Environment, FileSystemLoader, select_autoescape
from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError, field_validator
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from .auth import AccessAuthenticator, AuthenticationError, RateLimited, token_digest
from .config import AppConfig
from .office import OfficeService
from .paths import Workspace, InvalidPath, StorageFull, UnsupportedText, _check_tree, safe_open
from .store import Store, Conflict, Forbidden, NotFound, TERMINAL, normalized_email, project_name


PREVIEW_FORMATS = {
    "pdf": ("application/pdf", ((0, b"%PDF-"),)),
    "png": ("image/png", ((0, b"\x89PNG\r\n\x1a\n"),)),
    "jpg": ("image/jpeg", ((0, b"\xff\xd8\xff"),)),
    "jpeg": ("image/jpeg", ((0, b"\xff\xd8\xff"),)),
    "webp": ("image/webp", ((0, b"RIFF"), (8, b"WEBP"))),
}


class Form(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ProjectForm(Form):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def check_name(cls, value):
        return project_name(value)


class LoginForm(Form):
    member_id: str = Field(min_length=1, max_length=64)


class InviteForm(Form):
    email: str = Field(max_length=254)

    @field_validator("email")
    @classmethod
    def check_email(cls, value):
        return normalized_email(value)


class ActivateForm(Form):
    name: str = Field(min_length=1, max_length=64)

    @field_validator("name")
    @classmethod
    def check_name(cls, value):
        if not value.strip() or not value.strip().isprintable():
            raise ValueError("请输入姓名")
        return value.strip()


class EnabledForm(Form):
    enabled: bool


class PasswordLoginForm(InviteForm):
    password: str = Field(min_length=1, max_length=128)
    remember: bool = False


class RegisterForm(InviteForm):
    password: str = Field(min_length=15, max_length=128)


class UploadForm(Form):
    path: str = Field(min_length=1, max_length=500)
    size: StrictInt = Field(ge=0)
    overwrite: bool = False


class TextForm(Form):
    path: str = Field(min_length=1, max_length=500)
    text: str
    version: str | None = Field(max_length=200)


class DeleteFileForm(Form):
    path: str = Field(min_length=1, max_length=500)
    version: str = Field(min_length=1, max_length=200)


class RenameFileForm(DeleteFileForm):
    new_path: str = Field(min_length=1, max_length=500)


class PathForm(Form):
    path: str = Field(min_length=1, max_length=500)


class RerunForm(Form):
    request_id: str = Field(min_length=1, max_length=128)


class JobForm(Form):
    entry: str = Field(min_length=1, max_length=500)
    environment: str = Field(min_length=1, max_length=64)
    args: list[str] = Field(default_factory=list, max_length=128)
    request_id: str = Field(min_length=1, max_length=128)

    @field_validator("args")
    @classmethod
    def check_args(cls, values):
        if any("\x00" in v or len(v) > 4096 for v in values) or sum(map(len, values)) > 16000:
            raise ValueError("参数过长或含空字符")
        return values


class ClientError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


async def read_bounded(request, bound):
    try:
        length = int(request.headers.get("content-length", "0"))
    except ValueError as e:
        raise ClientError(400, "请求长度不合法") from e
    if length < 0 or length > bound:
        raise ClientError(413, "本次传输超过分块或请求大小上限")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > bound:
            raise ClientError(413, "本次传输超过分块或请求大小上限")
        data.extend(chunk)
    return bytes(data)


async def form(request, model, bound=65536):
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise ClientError(415, "请使用 JSON 提交表单")
    raw = await read_bounded(request, bound)
    try:
        return model.model_validate_json(raw)
    except ValidationError as exc:
        if model is RegisterForm:
            raise ClientError(422, "请输入完整邮箱；密码须为 15–128 个字符") from exc
        if model is PasswordLoginForm:
            raise ClientError(422, "请输入完整邮箱和密码（密码最长 128 个字符）") from exc
        raise ClientError(422, "表单格式不正确，请检查文件、入口及参数") from exc


def create_app(config: AppConfig, store=None, workspace=None, authenticator=None):
    config.validate()
    root = Path(config.data_root).absolute()
    root.mkdir(parents=True, exist_ok=True)
    store = store or Store(root / "state.sqlite")
    store.configure_members(config.mode, config.bootstrap_admin_email, config.password_auth)
    workspace = workspace or Workspace(root / "files", store, config.limits)
    if config.password_auth:
        with store.connect() as c:
            if not c.execute("SELECT 1 FROM members WHERE admin=1 AND enabled=1").fetchone():
                raise ValueError("请先使用 --password-auth --init-admin 管理员邮箱 初始化管理员")
    elif config.mode == "development":
        for mid, name, admin in [("admin", "试用管理员", True), ("alice", "组员甲", False), ("bob", "组员乙", False)]:
            store.add_member(mid, mid + "@example.org", name, admin)
    authenticator = authenticator or (AccessAuthenticator(config.access_issuer, config.access_audience) if config.mode == "production" else None)
    app = FastAPI(title="组内计算", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.config, app.state.store, app.state.workspace = config, store, workspace
    office = app.state.office = OfficeService(config, store, workspace)
    base = config.base_url.rstrip("/")
    host = urlsplit(base).netloc

    @app.middleware("http")
    async def boundary(request, call_next):
        machine = bool(config.office_url) and bool(re.fullmatch(r"/api/office/(source|callback)/[a-f0-9]{32}", request.url.path))
        allowed_hosts = {host, urlsplit(office.callback_base).netloc} if machine else {host}
        if request.headers.get("host") not in allowed_hosts:
            return JSONResponse({"error": "访问域名不匹配"}, 400)
        if not machine and config.mode == "development" and (not request.client or request.client.host not in ("127.0.0.1", "::1")):
            return JSONResponse({"error": "开发预览仅供本机访问"}, 403)
        if not machine and request.method not in ("GET", "HEAD", "OPTIONS"):
            if request.headers.get("origin") != base or request.headers.get("x-requested-with") != "GroupCompute":
                return JSONResponse({"error": "请求来源无效，请从本网站操作"}, 403)
        response = await call_next(request)
        response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin"})
        response.headers.setdefault("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        return response

    @app.exception_handler(ClientError)
    async def client_error(request, exc):
        return JSONResponse({"error": exc.message}, exc.code)

    for error_class, code in [(Forbidden, 403), (NotFound, 404), (FileNotFoundError, 404), (AuthenticationError, 401), (RateLimited, 429), (Conflict, 409), (InvalidPath, 400), (StorageFull, 507), (UnsupportedText, 415)]:
        async def domain_error(request, exc, status=code):
            message = str(exc) if isinstance(exc, (Conflict, Forbidden, InvalidPath, StorageFull, UnsupportedText, AuthenticationError, NotFound)) else "文件不存在"
            return JSONResponse({"error": message}, status)
        app.add_exception_handler(error_class, domain_error)

    def verified_email(request):
        return authenticator.authenticate(request.headers.get("cf-access-jwt-assertion", ""))["email"]

    def identity(request):
        if config.mode == "production" and not config.password_auth:
            return store.member_by_email(verified_email(request))
        token = request.cookies.get("gc_session", "")
        if config.password_auth:
            token = "password:" + token_digest(token)
        with store.connect() as c:
            row = c.execute("SELECT member FROM sessions WHERE token=? AND expires>?", (token, time.time())).fetchone()
        if row is None:
            raise AuthenticationError("请先登录" if config.password_auth else "请先选择本地试用身份")
        return store.member(row["member"])

    def member(request):
        m = identity(request)
        if not m["enabled"] or not m["activated"]:
            raise Forbidden("账号已停用或尚未完成注册")
        return m

    package = Path(__file__).parent
    templates = Environment(loader=FileSystemLoader(package / "templates"), autoescape=select_autoescape())
    app.mount("/static", StaticFiles(directory=package / "static", check_dir=False), name="static")

    @app.get("/", response_class=HTMLResponse)
    def home(request: Request):
        if config.password_auth:
            try:
                member(request)
            except (AuthenticationError, Forbidden):
                return RedirectResponse("/login", status_code=303)
        elif config.mode == "production":
            email = verified_email(request)
            try:
                account = store.member_by_email(email)
            except Forbidden:
                account = None
            if not account or not account["enabled"] or not account["activated"]:
                pending = bool(account and account["enabled"])
                return HTMLResponse(templates.get_template("activate.html").render(email=email, pending=pending),
                                    status_code=200 if pending else 403)
        return templates.get_template("index.html").render(development=config.mode == "development" and not config.password_auth,
                                                           password_auth=config.password_auth)

    @app.get("/login", response_class=HTMLResponse)
    @app.get("/register", response_class=HTMLResponse)
    def password_page(request: Request):
        if not config.password_auth:
            raise NotFound("入口不存在")
        registering = request.url.path == "/register"
        email, registration_error, status = "", "", 200
        if registering and config.mode == "production":
            email = normalized_email(verified_email(request))
            try:
                account = store.member_by_email(email)
                if not account["enabled"]:
                    raise Forbidden("该邮箱已停用，请联系管理员")
                if account["password_hash"]:
                    raise Conflict("该邮箱已注册，请返回登录")
            except (Forbidden, Conflict) as exc:
                registration_error = str(exc)
                status = 403 if isinstance(exc, Forbidden) else 409
        response = HTMLResponse(templates.get_template("account.html").render(
            register=registering, verified_email=email, registration_error=registration_error), status_code=status)
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.get("/api/config")
    def public_config():
        return {"development": config.mode == "development", "password_auth": config.password_auth, "execution_enabled": False,
                "chunk_bytes": config.limits.max_chunk_bytes, "max_file_bytes": config.limits.max_file_bytes,
                "max_text_bytes": config.limits.max_text_bytes, "terminal_enabled": False,
                "office_enabled": bool(config.office_url), "max_office_bytes": config.limits.max_office_bytes,
                "environments": config.environments}

    @app.get("/api/system/status")
    def system_status(request: Request):
        member(request)
        environments = sorted(key for key in config.environments
                              if isinstance(key, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", key))
        return {"execution_enabled": False, "terminal_enabled": False, **store.job_counts(),
                "disk_free_bytes": workspace.disk_free_bytes(), "disk_min_free_bytes": config.limits.min_free_bytes,
                "environments": environments}

    @app.get("/office", response_class=HTMLResponse)
    def office_page(request: Request):
        member(request)
        response = HTMLResponse(templates.get_template("office.html").render())
        if office.origin:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self' " + office.origin + "; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data:; connect-src 'self'; frame-src " + office.origin + "; "
                "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
            )
        return response

    @app.post("/api/projects/{pid}/office")
    async def open_office(pid: str, request: Request):
        m = await run_in_threadpool(member, request)
        data = await form(request, PathForm)
        return await run_in_threadpool(office.open, m, pid, data.path)

    @app.get("/api/office/sessions/{sid}")
    def office_status(sid: str, request: Request):
        row = office.session(sid, member(request)["id"])
        return {key: row[key] for key in ("active", "revision", "error")}

    def office_token(request):
        value = request.headers.get("authorization", "")
        return value[7:] if value.startswith("Bearer ") else ""

    @app.get("/api/office/source/{sid}")
    def office_source(sid: str, request: Request):
        opened, relative = office.source(sid, office_token(request))
        return download(opened, relative)

    @app.post("/api/office/callback/{sid}")
    async def office_callback(sid: str, request: Request):
        raw = await read_bounded(request, 65536)
        token = office_token(request)
        if not token:
            try:
                body = json.loads(raw)
                token = body.get("token", "") if isinstance(body, dict) else ""
            except (ValueError, UnicodeDecodeError):
                raise ClientError(400, "文档回写请求格式无效")
        # All mutation fields come from the verified token, never the unsigned body.
        return await run_in_threadpool(office.callback, sid, token)

    def issue_dev_session(member_id, previous_token):
        selected = store.member(member_id)
        token = secrets.token_urlsafe(32)
        with store.connect(True) as c:
            c.execute("DELETE FROM sessions WHERE expires<? OR token=?", (time.time(), previous_token))
            c.execute("INSERT INTO sessions VALUES(?,?,?)", (token, selected["id"], time.time() + 8*3600))
        response = JSONResponse({"name": selected["name"]})
        response.set_cookie("gc_session", token, max_age=8*3600, httponly=True, samesite="strict", path="/")
        return response

    def issue_password_session(member_id, previous_token, remember=False):
        token = secrets.token_urlsafe(32)
        duration = (30 * 86400) if remember else (12 * 3600)
        with store.connect(True) as c:
            if not c.execute("SELECT 1 FROM members WHERE id=? AND enabled=1 AND activated=1 AND password_hash!=''", (member_id,)).fetchone():
                raise AuthenticationError("账号不可用")
            c.execute("DELETE FROM sessions WHERE expires<=? OR token=?", (time.time(), "password:" + token_digest(previous_token)))
            c.execute("INSERT INTO sessions VALUES(?,?,?)", ("password:" + token_digest(token), member_id, time.time() + duration))
        response = JSONResponse({"ok": True})
        response.set_cookie("gc_session", token, max_age=duration if remember else None,
                            secure=config.mode == "production", httponly=True, samesite="strict", path="/")
        return response

    @app.post("/api/auth/login")
    async def password_login(request: Request):
        if not config.password_auth:
            raise NotFound("入口不存在")
        data = await form(request, PasswordLoginForm, 4096)
        mid = await run_in_threadpool(store.password_login, data.email, data.password)
        return await run_in_threadpool(issue_password_session, mid, request.cookies.get("gc_session", ""), data.remember)

    @app.post("/register")
    @app.post("/api/auth/register")
    async def password_register(request: Request):
        if not config.password_auth:
            raise NotFound("入口不存在")
        data = await form(request, RegisterForm, 4096)
        if config.mode == "production":
            email = normalized_email(await run_in_threadpool(verified_email, request))
            if email != data.email:
                raise Forbidden("注册邮箱必须与 Cloudflare 验证的邮箱一致")
        await run_in_threadpool(store.limit_auth_attempt)
        await run_in_threadpool(store.register_password, data.email, data.password)
        def finish_registration():
            with store.connect(True) as c:
                c.execute("DELETE FROM sessions WHERE token=?", ("password:" + token_digest(request.cookies.get("gc_session", "")),))
            response = JSONResponse({"ok": True, "redirect": "/login?registered=1"})
            response.delete_cookie("gc_session", secure=config.mode == "production", httponly=True, samesite="strict", path="/")
            return response
        return await run_in_threadpool(finish_registration)

    @app.post("/api/dev/login")
    async def dev_login(request: Request):
        if config.mode != "development" or config.password_auth:
            raise NotFound("入口不存在")
        data = await form(request, LoginForm)
        if data.member_id not in ("admin", "alice", "bob"):
            raise ClientError(400, "请选择试用身份")
        return await run_in_threadpool(issue_dev_session, data.member_id, request.cookies.get("gc_session", ""))

    @app.post("/api/logout")
    def logout(request: Request):
        if config.mode == "production" and not config.password_auth:
            return {"ok": True, "redirect": "/cdn-cgi/access/logout"}
        with store.connect(True) as c:
            token = request.cookies.get("gc_session", "")
            c.execute("DELETE FROM sessions WHERE token=?", ("password:" + token_digest(token) if config.password_auth else token,))
        response = JSONResponse({"ok": True, **({"redirect": "/login"} if config.password_auth else {})})
        response.delete_cookie("gc_session", secure=config.mode == "production", httponly=True, samesite="strict", path="/")
        return response

    @app.post("/api/activate")
    async def activate(request: Request):
        if config.mode != "production" or config.password_auth:
            raise NotFound("入口不存在")
        email = await run_in_threadpool(verified_email, request)
        data = await form(request, ActivateForm)
        return await run_in_threadpool(store.activate, email, data.name)

    @app.get("/api/members")
    def list_members(request: Request):
        return store.manage_members(member(request)["id"])

    @app.post("/api/members")
    async def invite(request: Request):
        actor = await run_in_threadpool(member, request)
        data = await form(request, InviteForm)
        if config.password_auth:
            return await run_in_threadpool(store.approve_registration, data.email, actor["id"])
        return await run_in_threadpool(store.manage_members, actor["id"], email=data.email)

    @app.post("/api/members/{mid}/enabled")
    async def membership(mid: str, request: Request):
        actor = await run_in_threadpool(member, request)
        data = await form(request, EnabledForm)
        return await run_in_threadpool(store.manage_members, actor["id"], target=mid, enabled=data.enabled)

    @app.get("/api/me")
    def me(request: Request):
        m = member(request)
        return {key: m[key] for key in ("id", "name", "admin")}

    @app.get("/api/projects")
    def projects(request: Request):
        return store.list_projects(member(request)["id"])

    @app.post("/api/projects")
    async def new_project(request: Request):
        m = await run_in_threadpool(member, request)
        data = await form(request, ProjectForm)
        return await run_in_threadpool(store.create_project, m["id"], data.name)

    @app.patch("/api/projects/{pid}")
    async def rename_project(pid: str, request: Request):
        m = await run_in_threadpool(member, request)
        data = await form(request, ProjectForm)
        return await run_in_threadpool(store.rename_project, m["id"], pid, data.name)

    @app.delete("/api/projects/{pid}")
    def delete_project(pid: str, request: Request):
        workspace.delete_project(member(request)["id"], pid)
        return {"ok": True}

    @app.get("/api/projects/{pid}/usage")
    def project_usage(pid: str, request: Request):
        return workspace.project_usage(member(request)["id"], pid)

    @app.get("/api/projects/{pid}/files")
    def files(pid: str, request: Request):
        return workspace.list_project(member(request)["id"], pid)

    @app.get("/api/projects/{pid}/text")
    def read_text(pid: str, path: str, request: Request):
        return workspace.read_text(member(request)["id"], pid, path)

    @app.get("/api/projects/{pid}/file-info")
    def file_info(pid: str, path: str, request: Request):
        return workspace.file_info(member(request)["id"], pid, path)

    @app.delete("/api/projects/{pid}/files")
    async def delete_file(pid: str, request: Request):
        m = await run_in_threadpool(member, request)
        data = await form(request, DeleteFileForm)
        await run_in_threadpool(workspace.delete_file, m["id"], pid, data.path, data.version)
        return {"ok": True}

    @app.post("/api/projects/{pid}/files/rename")
    async def rename_file(pid: str, request: Request):
        m = await run_in_threadpool(member, request)
        data = await form(request, RenameFileForm)
        return await run_in_threadpool(workspace.rename_file, m["id"], pid, data.path, data.new_path, data.version)

    @app.delete("/api/projects/{pid}/directories")
    async def delete_directory(pid: str, request: Request):
        m = await run_in_threadpool(member, request)
        data = await form(request, PathForm)
        await run_in_threadpool(workspace.delete_directory, m["id"], pid, data.path)
        return {"ok": True}

    @app.put("/api/projects/{pid}/text")
    async def save_text(pid: str, request: Request):
        m = await run_in_threadpool(member, request)
        data = await form(request, TextForm, config.limits.max_text_bytes * 6 + 2048)
        workspace.limits = config.limits
        return await run_in_threadpool(workspace.save_text, m["id"], pid, data.path, data.text, data.version)

    @app.post("/api/projects/{pid}/uploads")
    async def begin(pid: str, request: Request):
        m = await run_in_threadpool(member, request)
        data = await form(request, UploadForm)
        workspace.limits = config.limits
        return await run_in_threadpool(workspace.begin_upload, m["id"], pid, data.path, data.size, data.overwrite)

    @app.get("/api/projects/{pid}/uploads")
    def pending_uploads(pid: str, request: Request):
        m = member(request)
        with store.connect() as c:
            store.require_project(c, pid, m["id"])
            return [dict(r) for r in c.execute("SELECT * FROM uploads WHERE project=? AND state='uploading' ORDER BY created", (pid,))]

    @app.get("/api/uploads/{uid}")
    def upload_status(uid: str, request: Request):
        return workspace.upload_status(member(request)["id"], uid)

    @app.put("/api/uploads/{uid}")
    async def upload_chunk(uid: str, request: Request, offset: int):
        m = await run_in_threadpool(member, request)
        await run_in_threadpool(workspace.upload_status, m["id"], uid)
        content = await read_bounded(request, config.limits.max_chunk_bytes)
        return await run_in_threadpool(workspace.write_chunk, m["id"], uid, offset, content)

    @app.post("/api/uploads/{uid}/finish")
    def finish(uid: str, request: Request):
        return workspace.finalize(member(request)["id"], uid)

    @app.delete("/api/uploads/{uid}")
    def abandon(uid: str, request: Request):
        workspace.abandon(member(request)["id"], uid)
        return {"ok": True}

    def download(opened, relative, media_type="application/octet-stream"):
        def chunks():
            try:
                while data := opened.read(1024**2):
                    yield data
            finally:
                opened.close()
        return StreamingResponse(chunks(), media_type=media_type, headers={"Content-Disposition": "attachment; filename*=UTF-8''" + quote(Path(relative).name, safe="")}, background=BackgroundTask(opened.close))

    @app.get("/api/projects/{pid}/download")
    def download_project(pid: str, path: str, request: Request):
        return download(workspace.open_project(member(request)["id"], pid, path), path)

    @app.get("/api/projects/{pid}/archive")
    def archive_project(pid: str, request: Request, dir: str | None = None):
        opened, name = workspace.archive_project(member(request)["id"], pid, dir)
        return download(opened, name, "application/zip")

    @app.get("/api/projects/{pid}/preview")
    def preview(pid: str, path: str, request: Request):
        actor = member(request)["id"]
        _, dot, suffix = path.rpartition(".")
        file_format = PREVIEW_FORMATS.get(suffix.lower()) if dot else None
        if file_format is None:
            raise ClientError(415, "此预览入口仅支持 PDF、PNG、JPEG 或 WebP")
        media_type, signatures = file_format
        opened = workspace.open_project(actor, pid, path)
        try:
            header = opened.read(max(offset + len(magic) for offset, magic in signatures))
            if not all(header.startswith(magic, offset) for offset, magic in signatures):
                message = "该文件不是有效的 PDF" if media_type == "application/pdf" else "图片文件头与扩展名不符"
                raise ClientError(415, message)
            length = os.fstat(opened.fileno()).st_size
            if media_type != "application/pdf" and length > config.limits.max_image_preview_bytes:
                raise ClientError(413, "图片超过在线预览大小上限，请下载后查看")
            start, end, status = 0, length - 1, 200
            headers = {"Accept-Ranges": "bytes", "Content-Disposition": "inline; filename*=UTF-8''" + quote(Path(path).name, safe="")}
            value = request.headers.get("range")
            if value:
                match = re.fullmatch(r"bytes=([0-9]{0,20})-([0-9]{0,20})", value)
                if not match or not any(match.groups()):
                    opened.close()
                    return Response(status_code=416, headers={"Content-Range": f"bytes */{length}"})
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = min(int(last), length - 1) if last else length - 1
                else:
                    start = max(0, length - int(last))
                if start > end or start >= length:
                    opened.close()
                    return Response(status_code=416, headers={"Content-Range": f"bytes */{length}"})
                status = 206
                headers["Content-Range"] = f"bytes {start}-{end}/{length}"
            opened.seek(start)
            headers["Content-Length"] = str(end - start + 1)
            # Only this authenticated file response may be framed by the portal.
            headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
            def chunks():
                remaining = end - start + 1
                try:
                    while remaining:
                        data = opened.read(min(262144, remaining))
                        if not data:
                            break
                        remaining -= len(data)
                        yield data
                finally:
                    opened.close()
            return StreamingResponse(chunks(), status_code=status, media_type=media_type, headers=headers,
                                     background=BackgroundTask(opened.close))
        except BaseException:
            opened.close()
            raise

    def submit_checked(actor, project, environment, entry, args, request_id, *, rerun_of=None):
        if environment not in config.environments or not entry.casefold().endswith((".py", ".ps1")):
            raise ClientError(400, "请选择批准的 Python 环境和 .ps1 作业脚本或 .py 入口")
        return workspace.submit(actor, project, environment, entry, args, request_id, rerun_of=rerun_of)

    @app.post("/api/projects/{pid}/jobs")
    async def submit_job(pid: str, request: Request):
        m = await run_in_threadpool(member, request)
        data = await form(request, JobForm)
        return await run_in_threadpool(submit_checked, m["id"], pid, data.environment, data.entry, data.args, data.request_id)

    def rerun_job(actor, jid, request_id):
        original = store.get_job(jid, actor)
        if original["owner"] != actor:
            raise Forbidden("不能在其他成员的项目中重新提交任务")
        return submit_checked(actor, original["project"], original["environment"], original["entry"],
                              original["args"], request_id, rerun_of=jid)

    @app.post("/api/jobs/{jid}/rerun")
    async def rerun(jid: str, request: Request):
        m = await run_in_threadpool(member, request)
        data = await form(request, RerunForm)
        return await run_in_threadpool(rerun_job, m["id"], jid, data.request_id)

    @app.get("/api/jobs")
    def jobs(request: Request, all_members: bool = False):
        return store.list_jobs(member(request)["id"], all_members)

    @app.get("/api/jobs/{jid}")
    def job(jid: str, request: Request):
        return store.get_job(jid, member(request)["id"], include_metrics=True)

    @app.get("/api/jobs/{jid}/snapshot/files")
    def snapshot_files(jid: str, request: Request):
        j = store.get_job(jid, member(request)["id"])
        return workspace.list_snapshot(j["owner"], j["snapshot"])

    @app.get("/api/jobs/{jid}/snapshot/text")
    def snapshot_text(jid: str, path: str, request: Request):
        j = store.get_job(jid, member(request)["id"])
        return workspace.read_snapshot_text(j["owner"], j["snapshot"], path)

    @app.get("/api/jobs/{jid}/snapshot/download")
    def snapshot_download(jid: str, path: str, request: Request):
        j = store.get_job(jid, member(request)["id"])
        return download(workspace.open_snapshot(j["owner"], j["snapshot"], path), path)

    @app.post("/api/jobs/{jid}/cancel")
    def cancel(jid: str, request: Request):
        return store.request_cancel(jid, member(request)["id"])

    @app.get("/api/jobs/{jid}/log")
    def log(jid: str, request: Request, offset: int = 0):
        j = store.get_job(jid, member(request)["id"])
        if offset < 0:
            raise ClientError(400, "日志偏移不合法")
        path = workspace.root / "logs" / j["owner"] / (j["id"] + ".log")
        _check_tree(workspace.root, path)
        if not path.exists():
            return {"text": "", "offset": 0, "truncated": False}
        with safe_open(workspace.root / "logs" / j["owner"], path.name) as f:
            f.seek(min(offset, config.limits.max_log_bytes))
            raw = f.read(65536)
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            text = decoder.decode(raw, final=False)
            next_offset = f.tell() - len(decoder.getstate()[0])
            return {"text": text, "offset": next_offset, "truncated": next_offset >= config.limits.max_log_bytes}

    def completed_job(request, jid):
        j = store.get_job(jid, member(request)["id"])
        if j["state"] not in TERMINAL:
            raise Conflict("任务结束后开放结果下载；现在可以查看日志")
        return j

    @app.get("/api/jobs/{jid}/outputs")
    def outputs(jid: str, request: Request):
        return workspace.list_outputs(completed_job(request, jid))

    @app.get("/api/jobs/{jid}/outputs/archive")
    def archive_outputs(jid: str, request: Request):
        j = completed_job(request, jid)
        return download(workspace.archive_outputs(j), "outputs-" + j["id"] + ".zip", "application/zip")

    @app.get("/api/jobs/{jid}/download")
    def download_output(jid: str, path: str, request: Request):
        return download(workspace.open_output(completed_job(request, jid), path), path)

    return app
