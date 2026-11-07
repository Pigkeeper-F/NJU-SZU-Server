"""Run an isolated research browser on a hidden desktop (no window on the user desktop).

The browser is a separate Chromium process with its own profile and CDP port, kept
alive by a detached keeper process. Login state is seeded by copying cookies over
CDP from the already-running research browser, so the user's window is untouched.
"""
from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_PORT = 9333
DESKTOP = "ZCodeBrowser"
CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008


def state_path(port: int) -> Path:
    return REPO / ".workbench" / f"hidden-browser-{port}.json"


def stop_path(port: int) -> Path:
    return REPO / ".workbench" / f"hidden-browser-{port}.stop"


def port_open(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def launch(port: int, profile: Path) -> dict:
    if port_open(port):
        return {"ok": True, "reused": True, "port": port, "message": "该端口已有浏览器，未重复启动"}
    profile.mkdir(parents=True, exist_ok=True)
    state, stop = state_path(port), stop_path(port)
    state.unlink(missing_ok=True)
    stop.unlink(missing_ok=True)
    keeper = REPO / "tools" / "hidden_browser_keeper.py"
    subprocess.Popen(
        [sys.executable, str(keeper), "--port", str(port), "--profile", str(profile),
         "--state", str(state), "--stop-file", str(stop)],
        cwd=str(REPO), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, close_fds=True,
        creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
    )
    deadline = time.time() + 50
    while time.time() < deadline:
        if state.exists():
            info = json.loads(state.read_text(encoding="utf-8"))
            if info.get("cdp") and port_open(port):
                return {"ok": True, "reused": False, **info}
        time.sleep(0.5)
    return {"ok": False, "port": port, "message": "隐藏浏览器未在 50 秒内就绪"}


def stop(port: int) -> dict:
    state = state_path(port)
    info = json.loads(state.read_text(encoding="utf-8")) if state.exists() else {}
    stop_path(port).write_text("stop", encoding="utf-8")
    deadline = time.time() + 15
    while time.time() < deadline and port_open(port):
        time.sleep(0.3)
    if port_open(port):
        pid = int(info.get("pid") or 0)
        if pid:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
    state.unlink(missing_ok=True)
    return {"ok": not port_open(port), "port": port, "pid": info.get("pid")}


def status(port: int) -> dict:
    state = state_path(port)
    info = json.loads(state.read_text(encoding="utf-8")) if state.exists() else {}
    return {"ok": True, "port": port, "open": port_open(port), **info}


def seed(from_port: int, to_port: int) -> dict:
    """Copy cookies between the two browsers over CDP; nothing is written to disk."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        source = p.chromium.connect_over_cdp(f"http://127.0.0.1:{from_port}")
        target = p.chromium.connect_over_cdp(f"http://127.0.0.1:{to_port}")
        cookies = source.contexts[0].cookies()
        target.contexts[0].add_cookies(cookies)
        source.close()
        target.close()
    return {"ok": True, "seeded": len(cookies), "from": from_port, "to": to_port}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["launch", "stop", "status", "seed"])
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--from-port", type=int, default=9222)
    parser.add_argument("--profile", default=str(REPO / ".workbench" / "hidden-profile"))
    args = parser.parse_args()
    try:
        if args.action == "launch":
            result = launch(args.port, Path(args.profile))
        elif args.action == "stop":
            result = stop(args.port)
        elif args.action == "status":
            result = status(args.port)
        else:
            result = seed(args.from_port, args.port)
    except Exception as error:
        result = {"ok": False, "error": str(error)[:300]}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
