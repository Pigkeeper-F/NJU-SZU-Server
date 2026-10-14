"""Shared helpers for the soc-paper-fetch skill.

Everything here is intentionally small and boring. The skill drives the
browser one atomic action at a time from Codex's side; this module just
centralizes paths, the CDP connection, and human-like pacing so the
individual command scripts stay short.
"""
from __future__ import annotations

import json
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Optional

# Repository root is four levels up from the skill scripts dir.
# .codex/skills/soc-paper-fetch/scripts/common.py -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]
SKILL_ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = SKILL_ROOT / "state"
USER_DATA_DIR = STATE_DIR / "user-data"
PID_FILE = STATE_DIR / "browser.pid"
CDP_PORT = 9222
CDP_URL = f"http://127.0.0.1:{CDP_PORT}"

# Papers live at the repo root — change this if you move the papers folder.
PAPERS_DIR = REPO_ROOT / "papers"


def ensure_dirs() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    PAPERS_DIR.mkdir(parents=True, exist_ok=True)


def cdp_alive() -> bool:
    """Return True if a Chromium is already listening on the CDP port."""
    import urllib.request
    import urllib.error
    try:
        with urllib.request.urlopen(f"{CDP_URL}/json/version", timeout=2) as r:
            return r.status == 200
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        return False


def human_pause(lo: float = 0.6, hi: float = 1.8) -> None:
    """Sleep for a random interval to avoid clockwork-looking cadence."""
    time.sleep(random.uniform(lo, hi))


def connect_browser(playwright):
    """Attach to the already-running Chromium over CDP and return the
    first browser context (the persistent one). Callers should not close
    the context — we want it to outlive the script.
    """
    browser = playwright.chromium.connect_over_cdp(CDP_URL)
    if not browser.contexts:
        raise RuntimeError("CDP browser has no contexts — unexpected.")
    return browser, browser.contexts[0]


def get_or_create_page(context):
    """Return an existing blank page if available, otherwise create a new one."""
    for page in context.pages:
        if page.url in ("about:blank", ""):
            return page
    return context.new_page()


def apply_stealth(page) -> None:
    """Apply playwright-stealth tweaks to reduce bot-detection signals."""
    try:
        from playwright_stealth import Stealth
        Stealth().apply_stealth_sync(page)
    except Exception:
        # Stealth is best-effort; persistent profile + real login already
        # does most of the work. Don't blow up if the import shape changes.
        pass


def next_paper_id() -> int:
    """Next integer id to use for a new PDF, based on the papers/ folder."""
    if not PAPERS_DIR.exists():
        return 1
    highest = 0
    for entry in PAPERS_DIR.iterdir():
        m = re.fullmatch(r"(\d+)\.pdf", entry.name, flags=re.IGNORECASE)
        if m:
            highest = max(highest, int(m.group(1)))
    return highest + 1


def papers_dir() -> Path:
    return PAPERS_DIR


def print_json(data) -> None:
    """Emit JSON on stdout so Codex can parse it back."""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write(json.dumps(data, ensure_ascii=False, indent=2))
    sys.stdout.write("\n")
    sys.stdout.flush()


def looks_like_captcha(text: str) -> bool:
    """Heuristic: does the page *foreground* look like a challenge?

    We only scan the first ~1000 characters of body text. Many legitimate
    CNKI / publisher pages contain hidden <div>s with captcha strings as
    fallback UI for security modals that never actually render, and those
    nodes are always at the tail of body.innerText. Restricting the scan
    to the top of the page lets real, page-dominating challenges trigger
    while ignoring dormant hidden modals.
    """
    if not text:
        return False
    prefix = text[:1000]
    markers = [
        "验证码", "人机验证", "滑动验证", "请完成验证",
        "captcha", "verify you are", "are you a robot",
        "cf-challenge", "cloudflare", "attention required",
    ]
    low = prefix.lower()
    return any(m.lower() in low for m in markers)
