from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Limits:
    max_chunk_bytes: int = 8 * 1024**2
    max_file_bytes: int = 10 * 1024**3
    max_project_bytes: int = 20 * 1024**3
    min_free_bytes: int = 2 * 1024**3
    max_files: int = 10000
    max_active_uploads: int = 64
    max_log_bytes: int = 16 * 1024**2
    max_text_bytes: int = 1024**2
    max_office_bytes: int = 32 * 1024**2


@dataclass
class AppConfig:
    data_root: Path
    mode: str = "development"
    base_url: str = "http://127.0.0.1:8765"
    environments: dict = field(default_factory=lambda: {"py312": "Python 3.12 · venv312"})
    limits: Limits = field(default_factory=Limits)
    access_issuer: str = ""
    access_audience: str = ""
    bootstrap_admin_email: str = ""
    office_url: str = ""
    office_secret: str = field(default="", repr=False)
    office_callback_base: str = ""

    def validate(self):
        u = urlsplit(self.base_url)
        if self.mode not in ("development", "production") or u.path not in ("", "/") or u.query or u.fragment or u.username:
            raise ValueError("Invalid mode or base URL")
        if self.mode == "development":
            if u.hostname != "127.0.0.1" or u.scheme != "http":
                raise ValueError("Development must bind to 127.0.0.1 over HTTP")
        elif (u.scheme != "https" or not self.access_issuer.startswith("https://") or not self.access_audience):
            raise ValueError("Production requires HTTPS and complete Access identity configuration")
        if self.office_url or self.office_secret or self.office_callback_base:
            if not self.office_url or len(self.office_secret) < 32:
                raise ValueError("Office requires a document server URL and a JWT secret of at least 32 characters")
            for value in (self.office_url, self.office_callback_base or self.base_url):
                v = urlsplit(value)
                if (v.scheme not in ("http", "https") or not v.hostname or v.username or v.password
                        or v.path not in ("", "/") or v.query or v.fragment
                        or any(ch.isspace() or ord(ch) < 32 or ch in "\\\"'<>;" for ch in value)):
                    raise ValueError("Office URLs must be HTTP(S) origins without credentials or paths")
                _ = v.port  # Validate malformed / out-of-range ports before serving requests.
                if self.mode == "production" and v.scheme != "https":
                    raise ValueError("Production Office endpoints require HTTPS")
