"""Local development preview only. Never starts a runner or exposes a LAN listener."""
import argparse
import os
from pathlib import Path
import uvicorn
from .config import AppConfig
from .api import create_app


def main():
    parser = argparse.ArgumentParser(description="本机开发预览（不执行上传的 Python 代码）")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=Path(".local/data"))
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    config = AppConfig(args.data_dir, base_url=f"http://127.0.0.1:{args.port}",
                       office_url=os.environ.get("GC_OFFICE_URL", "").rstrip("/"),
                       office_secret=os.environ.get("GC_OFFICE_JWT_SECRET", ""),
                       office_callback_base=os.environ.get("GC_OFFICE_CALLBACK_BASE", "").rstrip("/"))
    uvicorn.run(create_app(config), host="127.0.0.1", port=args.port, proxy_headers=False, server_header=False)


if __name__ == "__main__":
    main()
