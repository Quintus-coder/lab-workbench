"""Loopback-only web entry point for preview or an Access-protected tunnel."""
import argparse
import os
from pathlib import Path
import uvicorn
from .config import AppConfig
from .api import create_app
from .store import Store


def main():
    parser = argparse.ArgumentParser(description="实验工作台（任务仅排队）")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--production", action="store_true", help="正式模式，默认 Access 登录；可配合 --password-auth")
    parser.add_argument("--password-auth", action="store_true", help="使用邮箱白名单注册和密码登录")
    parser.add_argument("--init-admin", metavar="EMAIL", help="批准首次管理员邮箱注册（需 --password-auth）")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    if args.production and not args.data_dir:
        parser.error("正式运行需指定独立的 --data-dir")
    if args.init_admin and not args.password_auth:
        parser.error("--init-admin 需要 --password-auth")
    config = AppConfig(args.data_dir or Path(".local/password-data" if args.password_auth else ".local/data"), mode="production" if args.production else "development",
                       base_url=os.getenv("GC_BASE_URL", "") if args.production else f"http://127.0.0.1:{args.port}",
                       access_issuer=os.getenv("GC_ACCESS_ISSUER", ""), access_audience=os.getenv("GC_ACCESS_AUDIENCE", ""),
                       bootstrap_admin_email=os.getenv("GC_BOOTSTRAP_ADMIN_EMAIL", ""),
                       password_auth=args.password_auth,
                       office_url=os.environ.get("GC_OFFICE_URL", "").rstrip("/"),
                       office_secret=os.environ.get("GC_OFFICE_JWT_SECRET", ""),
                       office_callback_base=os.environ.get("GC_OFFICE_CALLBACK_BASE", "").rstrip("/"))
    if args.init_admin:
        config.validate()
        store = Store(config.data_root / "state.sqlite")
        store.configure_members(config.mode, password_auth=True)
        store.approve_registration(args.init_admin)
        print("管理员邮箱已获准注册。启动服务后，从登录页点击注册并设置密码：")
        print(config.base_url.rstrip("/") + "/login")
        print("接着用相同参数启动服务，去掉 --init-admin EMAIL。")
        return
    uvicorn.run(create_app(config), host="127.0.0.1", port=args.port, proxy_headers=False, server_header=False)


if __name__ == "__main__":
    main()
