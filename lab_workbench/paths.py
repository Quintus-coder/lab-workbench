import ctypes
import errno
import json
import logging
import os
import re
import shutil
import stat
import tempfile
import time
import zipfile
from contextlib import contextmanager, ExitStack
from pathlib import Path
from .store import Conflict, Forbidden, NotFound, TERMINAL, new_id

logger = logging.getLogger(__name__)


class InvalidPath(ValueError):
    pass


class StorageFull(ValueError):
    pass


class UnsupportedText(ValueError):
    pass


def relative_path(value):
    if not isinstance(value, str) or not value or len(value) > 500 or value.startswith(("/", "\\")):
        raise InvalidPath("文件路径不合法")
    parts = value.replace("\\", "/").split("/")
    for part in parts:
        stem = part.split(".")[0].upper()
        if (part in ("", ".", "..") or part.endswith((".", " ")) or len(part) > 200
            or any(ord(ch) < 32 or ch in '<>:"|?*' for ch in part)
            or re.fullmatch(r"CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³]", stem)):
            raise InvalidPath("路径含有上级目录、特殊名称或 Windows 不支持的字符")
    return "/".join(parts)


def _check_tree(root, path):
    if not path.is_relative_to(root):
        raise InvalidPath("文件不在授权目录内")
    info = None
    for item in (root, *[root.joinpath(*path.relative_to(root).parts[:i]) for i in range(1, len(path.relative_to(root).parts) + 1)]):
        try:
            info = item.lstat()
        except (FileNotFoundError, NotADirectoryError):
            info = None
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise InvalidPath("不允许符号链接或重解析点")
    return info


def _final_path(fd):
    if os.name != "nt":
        return Path(os.path.realpath(f"/proc/self/fd/{fd}"))
    import msvcrt
    from ctypes import wintypes as w
    fn = ctypes.WinDLL("kernel32", use_last_error=True).GetFinalPathNameByHandleW
    fn.argtypes = (w.HANDLE, w.LPWSTR, w.DWORD, w.DWORD)
    fn.restype = w.DWORD
    buffer = ctypes.create_unicode_buffer(32768)
    length = fn(msvcrt.get_osfhandle(fd), buffer, len(buffer), 0)
    if not length or length >= len(buffer):
        raise InvalidPath("无法验证最终文件位置")
    return Path(buffer.value.removeprefix("\\\\?\\"))


def safe_open(root, relative):
    root = Path(root).absolute()
    path = root / relative_path(relative)
    info = _check_tree(root, path)
    if info is None or stat.S_ISDIR(info.st_mode):
        raise NotFound("文件不存在")
    if not stat.S_ISREG(info.st_mode):
        raise InvalidPath("只允许访问普通文件")
    f = path.open("rb")
    try:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode) or not _final_path(f.fileno()).is_relative_to(root):
            raise InvalidPath("最终文件不在授权目录内")
        _check_tree(root, path)
        return f
    except BaseException:
        f.close()
        raise


@contextmanager
def locked_directory(root, directory):
    """Hold Windows parent handles without FILE_SHARE_DELETE during file mutations."""
    _check_tree(root, directory)
    if os.name != "nt":
        directory.mkdir(parents=True, exist_ok=True)
        _check_tree(root, directory)
        yield
        return
    from ctypes import wintypes as w
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = (w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE)
    create.restype = w.HANDLE
    close = kernel.CloseHandle
    close.argtypes = (w.HANDLE,)
    with ExitStack() as stack:
        current = root
        for part in (None, *directory.relative_to(root).parts):
            if part is not None:
                current = current / part
            current.mkdir(exist_ok=True)
            handle = create(str(current), 0x80, 3, None, 3, 0x02200000, None)
            if handle == ctypes.c_void_p(-1).value:
                if ctypes.get_last_error() in (32, 33):
                    raise Conflict("目录正在使用中，请稍后重试")
                raise InvalidPath("目录正在被其他程序修改，请重试")
            stack.callback(close, handle)
            _check_tree(root, current)
        yield


def _file_version(info):
    return json.dumps([info.st_ino, info.st_mtime_ns, info.st_size])


def _walk_tree(root, *, reject_case_collisions=False):
    info = _check_tree(root, root)
    if info is None:
        return
    if not stat.S_ISDIR(info.st_mode):
        raise NotFound("目录不存在")

    def raise_walk_error(error):
        raise error

    for parent, dirs, names in os.walk(root, onerror=raise_walk_error, followlinks=False):
        parent = Path(parent)
        if reject_case_collisions and len({name.casefold() for name in dirs + names}) != len(dirs) + len(names):
            raise Conflict("目录内存在仅大小写不同的同名路径，无法安全打包")
        files = set(names)
        for name in dirs + names:
            relative = (parent / name).relative_to(root).as_posix()
            if relative_path(relative) != relative:
                raise InvalidPath("目录内含无效的相对路径")
            info = _check_tree(root, parent / name)
            if info is None:
                raise Conflict("目录内容已改变，请重试")
            if name in files:
                yield relative, info


class Workspace:
    def __init__(self, root, store, limits):
        self.root = Path(root).absolute()
        self.store, self.limits = store, limits
        for area in ("projects", "staging", "snapshots", "runs", "logs"):
            (self.root / area).mkdir(parents=True, exist_ok=True)
            _check_tree(self.root, self.root / area)

    def _project(self, c, actor, project):
        row = self.store.require_project(c, project, actor)
        path = self.root / "projects" / row["owner"] / row["id"]
        _check_tree(self.root, path)
        return path

    def project_root(self, actor, project):
        with self.store.connect(True) as c:
            path = self._project(c, actor, project)
            with locked_directory(self.root, path):
                return path

    def disk_free_bytes(self):
        return shutil.disk_usage(self.root).free

    def _free(self, additional=0):
        if self.disk_free_bytes() < self.limits.min_free_bytes + additional:
            raise StorageFull("剩余磁盘空间不足，已暂停新上传和提交")

    def _files(self, root, *, reject_case_collisions=False):
        found = []
        for relative, _ in _walk_tree(root, reject_case_collisions=reject_case_collisions):
            with safe_open(root, relative) as f:
                info = os.fstat(f.fileno())
                found.append(dict(path=relative, size=info.st_size, modified=info.st_mtime, version=_file_version(info)))
            if len(found) > self.limits.max_files:
                raise StorageFull("文件数量超过项目上限")
        return sorted(found, key=lambda r: r["path"].casefold())

    def list_project(self, actor, project):
        with self.store.connect() as c:
            return self._files(self._project(c, actor, project))

    def open_project(self, actor, project, relative):
        with self.store.connect() as c:
            return safe_open(self._project(c, actor, project), relative)

    def file_info(self, actor, project, relative):
        relative = relative_path(relative)
        with self.open_project(actor, project, relative) as f:
            info = os.fstat(f.fileno())
            return dict(path=relative, size=info.st_size, version=_file_version(info))

    def _reserved_bytes(self, c, project):
        return c.execute("SELECT coalesce(sum(total),0) FROM uploads WHERE project=? AND state='uploading'",
                         (project,)).fetchone()[0]

    def project_usage(self, actor, project):
        with self.store.connect(True) as c:
            root = self._project(c, actor, project)
            try:
                files = self._files(root)
            except PermissionError as exc:
                raise Conflict("项目文件正在使用中，请稍后重试") from exc
            return dict(file_count=len(files), used_bytes=sum(item["size"] for item in files),
                        reserved_bytes=self._reserved_bytes(c, project), max_project_bytes=self.limits.max_project_bytes,
                        disk_free_bytes=self.disk_free_bytes())

    def _pending_in(self, c, project, root, *relatives):
        rows = c.execute("SELECT relative FROM uploads WHERE project=? AND state='uploading'", (project,))
        if not relatives:
            return rows.fetchone() is not None

        def path_key(relative):
            if os.name != "nt":
                return relative.casefold()
            path = root / relative
            _check_tree(root, path)
            # Include Windows aliases for existing components, such as short directory names.
            resolved = path.resolve()
            resolved_root = root.resolve()
            if not resolved.is_relative_to(resolved_root):
                raise InvalidPath("文件不在授权目录内")
            return resolved.relative_to(resolved_root).as_posix().casefold()

        keys = [path_key(relative) for relative in relatives]
        for (relative,) in rows:
            pending = path_key(relative)
            if any(pending == key or pending.startswith(key + "/") or key.startswith(pending + "/") for key in keys):
                return True
        return False

    def _rename_target(self, root, relative):
        path = root
        for part in relative.split("/"):
            info = _check_tree(root, path)
            if info is None:
                path /= part
                continue
            if not stat.S_ISDIR(info.st_mode):
                raise Conflict("目标路径的上级不是目录")
            matches = [child for child in path.iterdir() if child.name.casefold() == part.casefold()]
            if len(matches) > 1:
                raise Conflict("目录内存在仅大小写不同的同名路径")
            path = matches[0] if matches else path / part
        if _check_tree(root, path) is not None:
            raise Conflict("目标路径已存在，不支持仅更改文件名大小写")
        return path

    def rename_file(self, actor, project, relative, new_relative, expected_version):
        relative, new_relative = relative_path(relative), relative_path(new_relative)
        with self.store.connect(True) as c:
            root = self._project(c, actor, project)
            source = root / relative
            try:
                current_version = self._version(root, relative)
                if current_version is None:
                    raise NotFound("文件不存在")
                if current_version != expected_version:
                    raise Conflict("文件已改变，未移动；请刷新后重试")
                if relative.casefold() == new_relative.casefold():
                    raise Conflict("目标路径已存在，不支持仅更改文件名大小写")
                target = self._rename_target(root, new_relative)
                if self._pending_in(c, project, root, relative, target.relative_to(root).as_posix()):
                    raise Conflict("源或目标路径涉及未完成的上传，请先处理上传")
                with locked_directory(root, source.parent), locked_directory(root, target.parent):
                    try:
                        with safe_open(root, relative) as f:
                            info = os.fstat(f.fileno())
                    except FileNotFoundError as exc:
                        raise Conflict("源文件在移动前已改变，请刷新后重试") from exc
                    if _file_version(info) != expected_version:
                        raise Conflict("文件已改变，未移动；请刷新后重试")
                    if self._rename_target(root, new_relative) != target:
                        raise Conflict("目标目录已改变，请刷新后重试")
                    try:
                        source.rename(target)
                    except (FileExistsError, FileNotFoundError) as exc:
                        raise Conflict("源或目标路径已改变，未移动文件") from exc
            except PermissionError as exc:
                raise Conflict("文件或目录正在使用中，原文件已保留，请稍后重试") from exc
            return dict(path=target.relative_to(root).as_posix(), size=info.st_size, version=expected_version)

    def _directory(self, root, relative):
        directory = root / relative
        info = _check_tree(root, directory)
        if info is None or not stat.S_ISDIR(info.st_mode):
            raise NotFound("目录不存在")
        return directory

    def _detach_directory(self, directory):
        staging = self.root / "staging"
        detached = staging / new_id()
        try:
            with locked_directory(self.root, directory.parent), locked_directory(self.root, staging):
                for _, info in _walk_tree(directory):
                    if getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_READONLY:
                        raise Conflict("目录内含只读文件，未删除目录")
                # A single move fails before deleting any children on Windows when a download holds a file open.
                directory.rename(detached)
        except PermissionError as exc:
            raise Conflict("目录或其中的文件正在使用中，未删除目录") from exc
        return detached

    def _purge_detached(self, detached):
        try:
            with locked_directory(self.root, detached.parent):
                _check_tree(self.root, detached)
                shutil.rmtree(detached)
        except (OSError, InvalidPath, Conflict):
            logger.exception("无法清理已移出项目的暂存目录")

    def delete_directory(self, actor, project, relative):
        relative = relative_path(relative)
        with self.store.connect(True) as c:
            root = self._project(c, actor, project)
            if self._pending_in(c, project, root, relative):
                raise Conflict("目录内有未完成的上传，请先处理上传")
            detached = self._detach_directory(self._directory(root, relative))
        self._purge_detached(detached)

    def delete_project(self, actor, project):
        with self.store.connect(True) as c:
            root = self._project(c, actor, project)
            if self._pending_in(c, project, root):
                raise Conflict("项目有未完成的上传，请先处理上传")
            if c.execute("SELECT 1 FROM jobs WHERE project=? AND state NOT IN (?,?,?,?) LIMIT 1",
                         (project, *TERMINAL)).fetchone():
                raise Conflict("项目仍有未结束任务，请等待任务结束后再删除")
            detached = self._detach_directory(root) if root.exists() else None
            try:
                c.execute("DELETE FROM projects WHERE id=?", (project,))
                c.commit()
            except BaseException:
                if detached is not None:
                    with locked_directory(self.root, root.parent), locked_directory(self.root, detached.parent):
                        detached.rename(root)
                raise
        if detached is not None:
            self._purge_detached(detached)

    def delete_file(self, actor, project, relative, expected_version):
        relative = relative_path(relative)
        with self.store.connect(True) as c:
            root = self._project(c, actor, project)
            current = self._version(root, relative)
            if current is None:
                raise NotFound("文件不存在")
            if current != expected_version:
                raise Conflict("文件已改变，未删除；请刷新文件列表后重试")
            pending = c.execute("SELECT relative FROM uploads WHERE project=? AND state='uploading'", (project,))
            if any(row[0].casefold() == relative.casefold() for row in pending):
                raise Conflict("该文件有未完成上传，请先继续或放弃上传再删除")
            with locked_directory(root, (root / relative).parent):
                if self._version(root, relative) != expected_version:
                    raise Conflict("文件在删除前已改变，请刷新后重试")
                try:
                    (root / relative).unlink()
                except PermissionError as exc:
                    raise Conflict("文件正在使用中，请关闭预览或编辑后重试删除") from exc

    def _text(self, root, relative):
        with safe_open(root, relative) as f:
            return self._read_text(f, relative)

    def _read_text(self, f, relative):
        info = os.fstat(f.fileno())
        raw = f.read(self.limits.max_text_bytes + 1)
        if len(raw) > self.limits.max_text_bytes or b"\x00" in raw:
            raise UnsupportedText("文件过大或属于二进制，请下载后查看；在线编辑仅支持小型 UTF-8 文本")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise UnsupportedText("该文件不是 UTF-8 文本，请下载后使用原编码编辑") from exc
        return dict(path=relative, text=text, size=len(raw),
                    version=_file_version(info),
                    encoding="UTF-8 BOM" if raw.startswith(b"\xef\xbb\xbf") else "UTF-8",
                    newline="CRLF" if b"\r\n" in raw else "LF")

    def read_text(self, actor, project, relative):
        relative = relative_path(relative)
        with self.store.connect() as c:
            return self._text(self._project(c, actor, project), relative)

    def save_text(self, actor, project, relative, text, expected_version):
        relative = relative_path(relative)
        with self.store.connect(True) as c:
            root = self._project(c, actor, project)
            root.mkdir(parents=True, exist_ok=True)
            current_version = self._version(root, relative)
            if current_version != expected_version:
                raise Conflict("文件已被其他操作更新；你的编辑仍保留，请重新读取后再合并保存")
            pending = c.execute("SELECT relative FROM uploads WHERE project=? AND state='uploading'", (project,))
            if any(row[0].casefold() == relative.casefold() for row in pending):
                raise Conflict("该文件有未完成上传，请先继续或放弃上传再编辑")
            existing = self._text(root, relative) if current_version is not None else None
            normalized = text.replace("\r\n", "\n")
            if existing and existing["newline"] == "CRLF":
                normalized = normalized.replace("\n", "\r\n")
            try:
                encoded = normalized.encode("utf-8")
            except UnicodeEncodeError as exc:
                raise UnsupportedText("文本包含无法保存的 Unicode 字符") from exc
            if existing and existing["encoding"] == "UTF-8 BOM":
                encoded = b"\xef\xbb\xbf" + encoded
            if b"\x00" in encoded or len(encoded) > min(self.limits.max_text_bytes, self.limits.max_file_bytes):
                raise UnsupportedText("编辑内容过大或包含空字符，未保存")
            self._free(len(encoded))
            files = self._files(root)
            old_size = existing["size"] if existing else 0
            reserved = self._reserved_bytes(c, project)
            if sum(f["size"] for f in files) - old_size + len(encoded) + reserved > self.limits.max_project_bytes:
                raise StorageFull("项目空间已达到上限，编辑内容未保存")
            if existing is None and len(files) >= self.limits.max_files:
                raise StorageFull("文件数量达到上限，未创建文件")
            temporary = self.root / "staging" / new_id()
            try:
                with temporary.open("xb") as f:
                    f.write(encoded)
                    f.flush()
                    os.fsync(f.fileno())
                with locked_directory(root, (root / relative).parent):
                    if self._version(root, relative) != expected_version:
                        raise Conflict("文件在保存期间已改变，编辑内容未覆盖")
                    try:
                        os.replace(temporary, root / relative)
                    except PermissionError as exc:
                        raise Conflict("文件正在使用中，原文件已保留，请稍后重试保存") from exc
                return self._text(root, relative)
            finally:
                temporary.unlink(missing_ok=True)

    def _version(self, root, relative):
        path = root / relative
        _check_tree(root, path)
        if not path.exists():
            return None
        with safe_open(root, relative) as f:
            s = os.fstat(f.fileno())
            return _file_version(s)

    def begin_upload(self, actor, project, relative, total, overwrite=False):
        relative = relative_path(relative)
        if type(total) is not int or not 0 <= total <= self.limits.max_file_bytes:
            raise StorageFull("文件大小超过上限")
        with self.store.connect(True) as c:
            root = self._project(c, actor, project)
            root.mkdir(parents=True, exist_ok=True)
            original = self._version(root, relative)
            if original is not None and not overwrite:
                raise Conflict("同名文件已存在，请明确确认覆盖")
            active = c.execute("SELECT count(*) FROM uploads WHERE owner=? AND state='uploading'", (actor,)).fetchone()[0]
            if active >= self.limits.max_active_uploads:
                raise Conflict("未完成的上传过多，请先继续或放弃旧上传")
            reserved = self._reserved_bytes(c, project)
            files = self._files(root)
            size = sum(item["size"] for item in files)
            if size + reserved + total > self.limits.max_project_bytes or len(files) + active >= self.limits.max_files:
                raise StorageFull("项目空间或文件数量超过上限")
            self._free(total)
            uid = new_id()
            staged = self.root / "staging" / uid
            staged.touch(exist_ok=False)
            info = staged.stat()
            identity = json.dumps([info.st_dev, info.st_ino])
            c.execute("INSERT INTO uploads(id,owner,project,relative,total,original,staged_id,created) VALUES(?,?,?,?,?,?,?,?)", (uid, actor, project, relative, total, original, identity, time.time()))
            return dict(c.execute("SELECT * FROM uploads WHERE id=?", (uid,)).fetchone())

    def _upload(self, c, actor, uid):
        row = c.execute("SELECT * FROM uploads WHERE id=?", (uid,)).fetchone()
        if row is None:
            raise NotFound("上传记录不存在")
        if row["owner"] != actor:
            raise Forbidden("不能访问其他成员的上传")
        return dict(row)

    def upload_status(self, actor, uid):
        with self.store.connect() as c:
            return self._upload(c, actor, uid)

    def write_chunk(self, actor, uid, offset, content):
        if len(content) > self.limits.max_chunk_bytes:
            raise StorageFull("分块超过上限")
        with self.store.connect(True) as c:
            u = self._upload(c, actor, uid)
            if u["state"] != "uploading" or offset < 0 or offset > u["received"] or offset + len(content) > u["total"]:
                raise Conflict("上传偏移不匹配，请刷新进度后重试")
            self._free(len(content))
            with (self.root / "staging" / uid).open("r+b") as f:
                f.truncate(u["received"])
                f.seek(offset)
                if offset < u["received"]:
                    if offset + len(content) > u["received"] or f.read(len(content)) != content:
                        raise Conflict("重试的数据与已接收内容不一致")
                    return u
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            c.execute("UPDATE uploads SET received=received+? WHERE id=?", (len(content), uid))
            return self._upload(c, actor, uid)

    def finalize(self, actor, uid):
        with self.store.connect(True) as c:
            u = self._upload(c, actor, uid)
            if u["state"] == "complete":
                return u
            if u["state"] != "uploading" or u["received"] != u["total"]:
                raise Conflict("文件尚未完整上传")
            root = self._project(c, actor, u["project"])
            target = root / u["relative"]
            with locked_directory(root, target.parent):
                staging = self.root / "staging" / uid
                if not staging.exists():
                    # A process may die after replace but before SQLite commits.
                    # Compare the file's OS identity, never file hashes or content guesses.
                    try:
                        with safe_open(root, u["relative"]) as f:
                            info = os.fstat(f.fileno())
                            same = json.dumps([info.st_dev, info.st_ino]) == u["staged_id"] and info.st_size == u["total"]
                    except FileNotFoundError:
                        same = False
                    if not same:
                        raise Conflict("上传状态不完整，请放弃此上传后重新选择文件")
                    c.execute("UPDATE uploads SET state='complete' WHERE id=?", (uid,))
                    return self._upload(c, actor, uid)
                if self._version(root, u["relative"]) != u["original"]:
                    raise Conflict("目标文件在上传期间已改变，请重新确认覆盖")
                # Same volume: replacement exposes the full file in one operation.
                try:
                    os.replace(staging, target)
                except PermissionError as exc:
                    raise Conflict("目标文件暂不能替换，可能正在下载或被其他程序占用；关闭后重试，原文件已保留") from exc
                c.execute("UPDATE uploads SET state='complete' WHERE id=?", (uid,))
            return self._upload(c, actor, uid)

    def abandon(self, actor, uid):
        with self.store.connect(True) as c:
            u = self._upload(c, actor, uid)
            if u["state"] == "uploading":
                (self.root / "staging" / uid).unlink(missing_ok=True)
                c.execute("UPDATE uploads SET state='abandoned' WHERE id=?", (uid,))

    def _snapshot(self, c, actor, project):
        root = self._project(c, actor, project)
        files = self._files(root)
        self._free(sum(item["size"] for item in files))
        sid = new_id()
        dest = self.root / "snapshots" / actor / sid
        with locked_directory(self.root, dest.parent):
            dest.mkdir()
            try:
                for item in files:
                    target = dest / item["path"]
                    with locked_directory(dest, target.parent):
                        _check_tree(dest, target)
                        with safe_open(root, item["path"]) as src, target.open("xb") as out:
                            shutil.copyfileobj(src, out, 1024**2)
                c.execute("INSERT INTO snapshots VALUES(?,?,?,?)", (sid, actor, project, time.time()))
                return sid
            except BaseException:
                shutil.rmtree(dest)
                raise

    def snapshot(self, actor, project):
        with self.store.connect(True) as c:
            return self._snapshot(c, actor, project)

    def submit(self, actor, project, environment, entry, args, request_id, *, rerun_of=None):
        entry = relative_path(entry)
        with self.store.connect(True) as c:
            root = self._project(c, actor, project)
            previous = self.store.find_request(c, actor, request_id, rerun_of=rerun_of)
            if previous:
                if (previous["project"], previous["environment"], previous["entry"], previous["args"]) != (project, environment, entry, args):
                    raise Conflict("提交标识已被另一个任务使用")
                return previous
            with safe_open(root, entry):
                pass
            if self._pending_in(c, project, root):
                raise Conflict("项目有未完成的上传，请继续或放弃上传后提交")
            sid = self._snapshot(c, actor, project)
            try:
                return self.store.submit(actor, project, sid, environment, entry, args, request_id,
                                         connection=c, rerun_of=rerun_of)
            except BaseException:
                dest = self._snapshot_root(c, actor, sid)
                with locked_directory(self.root, dest.parent):
                    shutil.rmtree(dest)
                raise

    def _snapshot_root(self, c, actor, sid):
        row = c.execute("SELECT owner FROM snapshots WHERE id=?", (sid,)).fetchone()
        if not row or row["owner"] != actor:
            raise Forbidden("不能访问该运行副本")
        root = self.root / "snapshots" / actor / sid
        _check_tree(self.root, root)
        return root

    def list_snapshot(self, actor, sid):
        with self.store.connect() as c:
            return self._files(self._snapshot_root(c, actor, sid))

    def open_snapshot(self, actor, sid, relative):
        with self.store.connect() as c:
            return safe_open(self._snapshot_root(c, actor, sid), relative)

    def read_snapshot_text(self, actor, sid, relative):
        relative = relative_path(relative)
        with self.open_snapshot(actor, sid, relative) as f:
            return self._read_text(f, relative)

    def output_root(self, job):
        root = self.root / "runs" / job["owner"] / job["id"]
        _check_tree(self.root, root)
        return root

    def list_outputs(self, job):
        return self._files(self.output_root(job))

    def open_output(self, job, relative):
        return safe_open(self.output_root(job), relative)

    def _archive(self, root):
        # Finish validation and ZIP creation before sending headers. Only disk holds the complete ZIP.
        archived = None
        try:
            files = self._files(root, reject_case_collisions=True)
            size = sum(item["size"] for item in files)
            if size > self.limits.max_archive_bytes:
                raise StorageFull("文件总大小超过打包上限")
            overhead = 128 + sum(256 + 2 * len(item["path"].encode("utf-8")) for item in files)
            self._free(size + overhead)
            with locked_directory(self.root, self.root / "staging"):
                archived = tempfile.TemporaryFile(mode="w+b", dir=self.root / "staging")
            with zipfile.ZipFile(archived, "w") as zipped:
                for item in files:
                    entry = zipfile.ZipInfo(item["path"])
                    entry.file_size = item["size"]
                    with safe_open(root, item["path"]) as source, zipped.open(entry, "w") as target:
                        if _file_version(os.fstat(source.fileno())) != item["version"]:
                            raise Conflict("打包期间文件已改变，请重试")
                        remaining = item["size"]
                        while remaining:
                            block = source.read(min(1024**2, remaining))
                            if not block:
                                raise Conflict("打包期间文件已改变，请重试")
                            target.write(block)
                            remaining -= len(block)
                        if _file_version(os.fstat(source.fileno())) != item["version"]:
                            raise Conflict("打包期间文件已改变，请重试")
            archived.seek(0)
            return archived
        except BaseException as exc:
            if archived is not None:
                archived.close()
            if isinstance(exc, OSError):
                if exc.errno == errno.ENOSPC:
                    raise StorageFull("剩余磁盘空间不足，无法打包") from exc
                raise Conflict("文件正在使用或已改变，无法打包，请重试") from exc
            raise

    def archive_project(self, actor, project, relative=None):
        relative = relative_path(relative) if relative is not None else None
        with self.store.connect(True) as c:
            root = self._project(c, actor, project)
            directory = self._directory(root, relative) if relative is not None else root
            paths = () if relative is None else (relative,)
            if self._pending_in(c, project, root, *paths):
                raise Conflict("打包范围内有未完成的上传，请先处理上传")
            name = (directory.name if relative is not None else "project-" + project) + ".zip"
            return self._archive(directory), name

    def archive_outputs(self, job):
        # Serialize disk reservations for concurrent archive creation, as with project archives.
        with self.store.connect(True):
            return self._archive(self.output_root(job))
