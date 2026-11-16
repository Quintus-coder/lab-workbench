"""Loopback-only web entry point for preview or an Access-protected tunnel."""
import argparse
import os
from pathlib import Path
import uvicorn
from .config import AppConfig
from .api import create_app


def main():
    parser = argparse.ArgumentParser(description="实验工作台（任务仅排队）")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--production", action="store_true", help="启用 Cloudflare Access 登录")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    if args.production and not args.data_dir:
        parser.error("正式运行需指定独立的 --data-dir")
    config = AppConfig(args.data_dir or Path(".local/data"), mode="production" if args.production else "development",
                       base_url=os.getenv("GC_BASE_URL", "") if args.production else f"http://127.0.0.1:{args.port}",
                       access_issuer=os.getenv("GC_ACCESS_ISSUER", ""), access_audience=os.getenv("GC_ACCESS_AUDIENCE", ""),
                       bootstrap_admin_email=os.getenv("GC_BOOTSTRAP_ADMIN_EMAIL", ""),
                       office_url=os.environ.get("GC_OFFICE_URL", "").rstrip("/"),
                       office_secret=os.environ.get("GC_OFFICE_JWT_SECRET", ""),
                       office_callback_base=os.environ.get("GC_OFFICE_CALLBACK_BASE", "").rstrip("/"))
    uvicorn.run(create_app(config), host="127.0.0.1", port=args.port, proxy_headers=False, server_header=False)


if __name__ == "__main__":
    main()
