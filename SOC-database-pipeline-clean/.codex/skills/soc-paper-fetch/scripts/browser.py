"""Launch / inspect / stop the persistent Chromium the skill drives.

Usage:
    python browser.py launch     # idempotent, opens the window if not already up
    python browser.py status     # JSON status: running, url, title
    python browser.py stop       # terminate the persistent browser (rarely needed)

The browser is launched as a detached Windows process so it outlives
this script. Login cookies live in state/user-data/, so later invocations
do not need to re-authenticate.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time

from common import (
    CDP_PORT,
    CDP_URL,
    PID_FILE,
    USER_DATA_DIR,
    cdp_alive,
    connect_browser,
    ensure_dirs,
    print_json,
)


def _chromium_executable() -> str:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        path = p.chromium.executable_path
    if not path or not os.path.exists(path):
        raise RuntimeError(
            "Playwright Chromium not found. Run `python -m playwright install chromium`."
        )
    return path


def launch() -> dict:
    ensure_dirs()
    if cdp_alive():
        return {
            "status": "already_running",
            "cdp_url": CDP_URL,
            "message": "CDP port already listening; reusing existing browser.",
        }

    exe = _chromium_executable()
    args = [
        exe,
        f"--remote-debugging-port={CDP_PORT}",
        f"--user-data-dir={USER_DATA_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
        # Harmless flags to make the profile feel normal
        "--disable-background-networking",
        "--disable-features=ChromeWhatsNewUI,Translate",
    ]

    creationflags = 0
    if sys.platform == "win32":
        creationflags = (
            subprocess.DETACHED_PROCESS  # type: ignore[attr-defined]
            | subprocess.CREATE_NEW_PROCESS_GROUP
        )

    proc = subprocess.Popen(
        args,
        creationflags=creationflags,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    PID_FILE.write_text(str(proc.pid), encoding="utf-8")

    # Wait up to ~15s for the CDP port to accept connections.
    deadline = time.time() + 15
    while time.time() < deadline:
        if cdp_alive():
            return {
                "status": "launched",
                "pid": proc.pid,
                "cdp_url": CDP_URL,
                "user_data_dir": str(USER_DATA_DIR),
                "message": (
                    "Chromium 已启动。请在这个浏览器窗口里手动登录"
                    "（Google Scholar / Google / 校园 VPN / 出版商站点等），"
                    "登录完成后回来继续。"
                ),
            }
        time.sleep(0.5)

    return {
        "status": "launch_timeout",
        "pid": proc.pid,
        "message": "Chromium was spawned but the CDP port never came up within 15s.",
    }


def status() -> dict:
    if not cdp_alive():
        return {"status": "down", "cdp_url": CDP_URL}
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            _, context = connect_browser(p)
            pages_info = []
            for page in context.pages[:10]:
                try:
                    pages_info.append({"url": page.url, "title": page.title()})
                except Exception as exc:
                    pages_info.append({"url": page.url, "title": f"<err:{exc}>"})
            return {
                "status": "up",
                "cdp_url": CDP_URL,
                "pages": pages_info,
            }
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def stop() -> dict:
    if not PID_FILE.exists():
        return {"status": "not_tracked", "message": "No browser.pid file — nothing to stop."}
    try:
        pid = int(PID_FILE.read_text(encoding="utf-8").strip())
    except ValueError:
        pid = -1
    killed = False
    if pid > 0:
        if sys.platform == "win32":
            rc = subprocess.call(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            killed = rc == 0
        else:
            try:
                os.kill(pid, 15)
                killed = True
            except ProcessLookupError:
                killed = False
    PID_FILE.unlink(missing_ok=True)
    return {"status": "stopped" if killed else "not_running", "pid": pid}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["launch", "status", "stop"])
    args = parser.parse_args()
    if args.command == "launch":
        print_json(launch())
    elif args.command == "status":
        print_json(status())
    elif args.command == "stop":
        print_json(stop())


if __name__ == "__main__":
    main()
