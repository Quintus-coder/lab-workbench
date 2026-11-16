"""ONLYOFFICE adapter. The document service is deployed separately."""
import io
import json
import os
import time
import zipfile
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler
from urllib.error import URLError

import jwt

from .auth import AuthenticationError
from .paths import safe_open, locked_directory, relative_path, StorageFull, UnsupportedText
from .store import Conflict, Forbidden, NotFound, new_id


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Conflict("文档服务返回了重定向，未下载或覆盖项目文件")


class OfficeService:
    def __init__(self, config, store, workspace):
        self.config, self.store, self.workspace = config, store, workspace
        self.origin = config.office_url.rstrip("/")
        self.callback_base = (config.office_callback_base or config.base_url).rstrip("/")

    def require_enabled(self):
        if not self.origin:
            raise Conflict("尚未配置文档服务；服务器部署后可在网页内完整编辑 Word / Excel")

    def session(self, sid, actor=None, connection=None):
        def read(c):
            row = c.execute("SELECT * FROM office_sessions WHERE id=?", (sid,)).fetchone()
            if row is None:
                raise NotFound("文档会话不存在")
            if actor is not None and row["owner"] != actor:
                raise Forbidden("不能访问其他成员的文档")
            return dict(row)
        if connection is not None:
            return read(connection)
        with self.store.connect() as c:
            return read(c)

    def open(self, member, project, relative):
        relative = relative_path(relative)
        info = self.workspace.file_info(member["id"], project, relative)
        self.require_enabled()
        ext = Path(relative).suffix.lower().lstrip(".")
        if ext not in ("docx", "xlsx"):
            raise UnsupportedText("完整编辑支持 .docx / .xlsx；旧版 .doc / .xls 请先另存为新格式")
        if info["size"] > self.config.limits.max_office_bytes:
            raise StorageFull("文档超过在线 Office 编辑大小上限")
        with self.store.connect(True) as c:
            row = c.execute("SELECT * FROM office_sessions WHERE owner=? AND project=? AND relative=? AND version=? AND active=1 ORDER BY created DESC LIMIT 1",
                            (member["id"], project, relative, info["version"])).fetchone()
            if row:
                sid = row["id"]
            else:
                sid = new_id()
                c.execute("INSERT INTO office_sessions(id,owner,project,relative,version,created) VALUES(?,?,?,?,?,?)",
                          (sid, member["id"], project, relative, info["version"], time.time()))
        document = {
            "documentType": "word" if ext == "docx" else "cell", "type": "desktop", "width": "100%", "height": "100%",
            "document": {"fileType": ext, "key": sid, "title": Path(relative).name,
                         "url": self.callback_base + "/api/office/source/" + sid,
                         "permissions": {"edit": True, "download": True, "print": True}},
            "editorConfig": {"mode": "edit", "lang": "zh", "user": {"id": member["id"], "name": member["name"]},
                             "callbackUrl": self.callback_base + "/api/office/callback/" + sid,
                             "customization": {"forcesave": True}},
        }
        document["token"] = jwt.encode(document, self.config.office_secret, algorithm="HS256")
        return {"id": sid, "config": document, "api_url": self.origin + "/web-apps/apps/api/documents/api.js"}

    def verify(self, token, operation):
        self.require_enabled()
        try:
            claims = jwt.decode(token, self.config.office_secret, algorithms=["HS256"])
        except jwt.PyJWTError as exc:
            raise AuthenticationError("文档服务签名无效") from exc
        if claims.get("operation", operation) != operation:
            raise AuthenticationError("文档服务签名用途不符")
        payload = claims.get("payload", claims)
        if not isinstance(payload, dict):
            raise AuthenticationError("文档服务签名格式无效")
        return payload

    def source(self, sid, token):
        payload = self.verify(token, "download")
        if payload.get("url") != self.callback_base + "/api/office/source/" + sid:
            raise AuthenticationError("文档下载签名与文件不匹配")
        with self.store.connect() as c:
            row = self.session(sid, connection=c)
            if not row["active"]:
                raise Conflict("文档会话已结束，请重新打开")
            root = self.workspace._project(c, row["owner"], row["project"])
            opened = safe_open(root, row["relative"])
            s = os.fstat(opened.fileno())
            if json.dumps([s.st_ino, s.st_mtime_ns, s.st_size]) != row["version"]:
                opened.close()
                raise Conflict("项目文件已经改变，请重新打开文档")
            return opened, row["relative"]

    def validate_url(self, value):
        if not isinstance(value, str) or len(value) > 8192:
            raise Conflict("文档下载地址无效")
        try:
            u, trusted = urlsplit(value), urlsplit(self.origin)
            _ = u.port
        except ValueError as exc:
            raise Conflict("文档下载地址无效") from exc
        if (u.scheme != trusted.scheme or u.netloc != trusted.netloc or u.username or u.password
                or u.fragment or any(ch.isspace() or ord(ch) < 32 for ch in value)):
            raise Conflict("拒绝从文档服务以外的地址下载文件")

    def fetch_document(self, url):
        self.validate_url(url)
        limit = min(self.config.limits.max_office_bytes, self.config.limits.max_file_bytes)
        try:
            # Preserve normal proxy settings; redirects cannot escape the trusted origin.
            with build_opener(NoRedirect()).open(url, timeout=30) as response:
                if response.status != 200:
                    raise Conflict("文档服务未返回完整文件")
                data = response.read(limit + 1)
        except (URLError, TimeoutError, OSError) as exc:
            raise Conflict("无法从文档服务取回文件；项目原文件已保留，请重试保存") from exc
        if len(data) > limit:
            raise StorageFull("文档超过在线 Office 编辑大小上限")
        return data

    def validate_document(self, data, relative):
        if len(data) > min(self.config.limits.max_office_bytes, self.config.limits.max_file_bytes):
            raise StorageFull("文档超过在线 Office 编辑大小上限")
        expected = "word/document.xml" if relative.lower().endswith(".docx") else "xl/workbook.xml"
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                names = archive.namelist()
                if expected not in names or "[Content_Types].xml" not in names:
                    raise ValueError()
        except (zipfile.BadZipFile, ValueError) as exc:
            raise Conflict("文档服务返回的文件格式不符，未覆盖原文件") from exc

    def replace(self, c, row, data):
        ws = self.workspace
        root = ws._project(c, row["owner"], row["project"])
        relative = row["relative"]
        if ws._version(root, relative) != row["version"]:
            raise Conflict("项目文件已被删除或更新，文档未覆盖；请在编辑器中下载副本保留修改")
        pending = c.execute("SELECT relative FROM uploads WHERE project=? AND state='uploading'", (row["project"],))
        if any(r[0].casefold() == relative.casefold() for r in pending):
            raise Conflict("文件有未完成上传，请处理上传后重试文档保存")
        ws._free(len(data))
        files = ws._files(root)
        old_size = json.loads(row["version"])[2]
        reserved = c.execute("SELECT coalesce(sum(total),0) FROM uploads WHERE project=? AND state='uploading'", (row["project"],)).fetchone()[0]
        if sum(f["size"] for f in files) - old_size + len(data) + reserved > ws.limits.max_project_bytes:
            raise StorageFull("项目空间已达到上限，文档未覆盖")
        temporary = ws.root / "staging" / new_id()
        try:
            with temporary.open("xb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            with locked_directory(root, (root / relative).parent):
                if ws._version(root, relative) != row["version"]:
                    raise Conflict("文件在保存期间已改变，文档未覆盖")
                try:
                    os.replace(temporary, root / relative)
                except PermissionError as exc:
                    raise Conflict("文件正在使用中，请稍后重试文档保存") from exc
            return ws._version(root, relative)
        finally:
            temporary.unlink(missing_ok=True)

    def callback(self, sid, token):
        body = self.verify(token, "callback")
        if body.get("key") != sid or type(body.get("status")) is not int or body["status"] not in (1, 2, 3, 4, 6, 7):
            raise AuthenticationError("文档回写签名与会话不匹配")
        row = self.session(sid)
        status = body["status"]
        try:
            if not row["active"]:
                return {"error": 0}
            if status in (3, 7):
                raise Conflict("文档服务保存失败；请重试或下载副本保留修改")
            data = None
            if status in (2, 6):
                url = body.get("url")
                self.validate_url(url)
                if body.get("filetype", Path(row["relative"]).suffix[1:].lower()) != Path(row["relative"]).suffix[1:].lower():
                    raise Conflict("文档服务返回了不同格式，未覆盖原文件")
                # A cache URL may be reused for a newer force-save; it is not a revision ID.
                data = self.fetch_document(url)
                self.validate_document(data, row["relative"])
            with self.store.connect(True) as c:
                current = self.session(sid, connection=c)
                if not current["active"]:
                    return {"error": 0}
                if status in (2, 6):
                    if current["revision"] != row["revision"]:
                        raise Conflict("另一次文档保存已完成，请重新保存最新内容")
                    version = self.replace(c, current, data)
                    c.execute("UPDATE office_sessions SET version=?, revision=revision+1,last_url=?,error='' WHERE id=?", (version, body["url"], sid))
                if status in (2, 4):
                    c.execute("UPDATE office_sessions SET active=0 WHERE id=?", (sid,))
            return {"error": 0}
        except (Conflict, StorageFull, OSError) as exc:
            message = str(exc) if isinstance(exc, (Conflict, StorageFull)) else "项目文件读写失败，未确认保存成功；请在编辑器下载副本保留修改"
            with self.store.connect(True) as c:
                c.execute("UPDATE office_sessions SET error=? WHERE id=?", (message, sid))
            return {"error": 1}
