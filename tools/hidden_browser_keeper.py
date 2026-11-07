"""Keeper for a hidden-desktop Chromium: holds the desktop handle while the browser runs.

Started detached by tools/hidden_research_browser.py. Stops when the browser
exits or the stop file appears.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, r"C:\Users\33477\.zcode\skills\virtual-desktop\scripts")
from hidden_desktop import HiddenDesktop  # noqa: E402


def port_open(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def chromium_executable() -> str:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        path = p.chromium.executable_path
    if not path or not Path(path).exists():
        raise RuntimeError("Playwright Chromium 未安装")
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--stop-file", required=True)
    args = parser.parse_args()
    stop_file = Path(args.stop_file)
    state_file = Path(args.state)
    try:
        stop_file.unlink()
    except OSError:
        pass

    desktop = HiddenDesktop("ZCodeBrowser", cleanup_on_exit=False, audit=False)
    proc = desktop.launch(chromium_executable(), [
        f"--remote-debugging-port={args.port}",
        f"--user-data-dir={args.profile}",
        "--no-first-run", "--no-default-browser-check",
        "--disable-gpu", "--disable-background-networking",
        "--disable-features=ChromeWhatsNewUI,Translate",
        "--window-size=1280,900",
    ])
    pid = proc[1]
    deadline = time.time() + 45
    while time.time() < deadline and not port_open(args.port):
        time.sleep(0.4)
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps({
        "pid": pid, "keeper_pid": os.getpid(), "port": args.port,
        "profile": args.profile, "desktop": "ZCodeBrowser",
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "cdp": port_open(args.port),
    }, ensure_ascii=False), encoding="utf-8")

    while not port_open(args.port):
        if stop_file.exists() or not HiddenDesktop.is_running(pid):
            break
        time.sleep(0.5)
    while not stop_file.exists() and HiddenDesktop.is_running(pid):
        time.sleep(1.0)
    try:
        if HiddenDesktop.is_running(pid):
            HiddenDesktop.kill_pid(pid)
    finally:
        try:
            desktop.close()
        except Exception:
            pass
        try:
            stop_file.unlink()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
