"""Internal fixed-adapter subprocess protocol; never writes discovery artifacts."""
from __future__ import annotations

from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from literature_source_runner import _python_process_spec


def _start_guard(parent_pid):
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as ready:
        executable, environment = _python_process_spec()
        guard = subprocess.Popen(
            [executable, "-u", str(Path(__file__).resolve().with_name("literature_source_guard.py")),
             str(parent_pid), str(os.getpid())],
            stdin=subprocess.DEVNULL, stdout=ready, stderr=subprocess.DEVNULL, env=environment,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                ready.seek(0)
                if ready.read(64).strip() == "ready":
                    return guard
                if guard.poll() is not None:
                    break
                time.sleep(0.02)
            raise RuntimeError("source guardian not ready")
        except BaseException:
            if guard.poll() is None:
                guard.kill()
                guard.wait(timeout=1)
            raise


def _stop_guard(guard):
    if guard is not None and guard.poll() is None:
        guard.terminate()
        try:
            guard.wait(timeout=1)
        except subprocess.TimeoutExpired:
            guard.kill()
            guard.wait(timeout=1)


def main():
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    guard = None
    try:
        # The runner sends a bounded local request. No arbitrary module,
        # command, executable or browser script is accepted by this worker.
        raw = sys.stdin.read(1_000_001)
        request = json.loads(raw) if len(raw) <= 1_000_000 else None
        if not isinstance(request, dict) or request.get("protocol") != 1:
            raise ValueError("invalid internal request")
        if not isinstance(request.get("parent_pid"), int) or request["parent_pid"] != os.getppid():
            raise ValueError("source driver identity mismatch")
        guard = _start_guard(request["parent_pid"])
        with open(os.devnull, "w", encoding="utf-8") as discard, redirect_stdout(discard):
            import literature_browser
            options = {"job_dir": Path(request["job_dir"])}
            if request.get("page_index") is not None:
                options.update(page_index=request["page_index"], full_page=request.get("full_page", False))
            result = literature_browser.run(request["source"], request["query"], request["scrape_current"],
                                            request["limit"], request.get("year_from"), request.get("year_to"), **options)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    except Exception:
        # Do not leak account pages, query URLs, browser traces or credentials.
        print(json.dumps({"status": "error", "results": [],
                          "message": "检索来源操作未完成；已有结果保留，请核对原页面后继续。"}, ensure_ascii=False), flush=True)
        return 1
    finally:
        _stop_guard(guard)


if __name__ == "__main__":
    raise SystemExit(main())
