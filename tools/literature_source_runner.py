"""One fixed, killable source/page worker; the discovery driver owns artifacts."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


PAGE_TIMEOUT_SECONDS = 60
_WORKER = Path(__file__).resolve().with_name("literature_source_worker.py")
_TIMEOUT_MESSAGE = "当前来源加载超过1分钟，已暂停；已有结果保留。请查看原页面后检查并继续，或暂缓此来源。"


def _timeout_result(source):
    return {"status": "attention", "reason": "results_unrecognized", "source_key": source,
            "message": _TIMEOUT_MESSAGE, "results": [], "timed_out": True}


def _python_process_spec():
    """Avoid a Windows venv redirector PID while preserving that venv.

    A venv's python.exe can launch another interpreter process. Targeting that
    redirector would not identify the worker executing browser operations.
    CPython's launcher environment preserves its original venv configuration.
    """
    executable, environment = sys.executable, os.environ.copy()
    if os.name == "nt" and getattr(sys, "_base_executable", None):
        executable = sys._base_executable
        environment["__PYVENV_LAUNCHER__"] = sys.executable
    return executable, environment


def _start_worker(request_file, response_file):
    """Fixed executable/script; tests may replace this internal process seam."""
    executable, environment = _python_process_spec()
    return subprocess.Popen(
        [executable, "-u", str(_WORKER)], cwd=str(_WORKER.parent.parent), env=environment,
        stdin=request_file, stdout=response_file, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def run_source(source, query, scrape_current, limit, year_from=None, year_to=None, *,
               job_dir, page_index=None, full_page=False, timeout_seconds=PAGE_TIMEOUT_SECONDS):
    """Fetch one source/page with a hard deadline; no driver checkpoint writes.

    ``timeout_seconds`` and ``_start_worker`` are internal Python test seams,
    never exposed through the web API, frozen configuration, or stage CLI.
    Killing this worker does not target the persistent browser or other tasks.
    """
    payload = {"protocol": 1, "source": source, "query": query, "scrape_current": scrape_current,
               "limit": limit, "year_from": year_from, "year_to": year_to,
               "job_dir": str(Path(job_dir).resolve()), "page_index": page_index, "full_page": full_page,
               "parent_pid": os.getpid()}
    # Files, rather than PIPE, ensure a browser/driver descendant inheriting
    # stdout cannot keep communicate() waiting for EOF after worker termination.
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as request_file, \
            tempfile.TemporaryFile(mode="w+", encoding="utf-8") as response_file:
        request_file.write(json.dumps(payload, ensure_ascii=False))
        request_file.flush()
        request_file.seek(0)
        process = _start_worker(request_file, response_file)
        try:
            process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            # Terminate only the fixed Python worker and reap it before the
            # parent driver saves attention. No late result can then be used.
            process.kill()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                raise RuntimeError("超时后无法确认检索工作进程已停止；已有结果保留，请检查本机环境。") from None
            return _timeout_result(source)
        if process.returncode == 124:  # guardian's own deadline won the race
            return _timeout_result(source)
        if process.returncode != 0:
            return {"status": "error", "source_key": source, "results": [],
                    "message": "检索来源操作未完成；已有结果保留，请核对原页面后继续。"}
        try:
            response_file.seek(0)
            output = response_file.read(16_000_001)
            if len(output) > 16_000_000:
                raise ValueError("source response too large")
            result = json.loads(output)
        except (TypeError, ValueError):
            result = None
        if not isinstance(result, dict) or result.get("status") not in {"ok", "no_results", "attention", "captcha", "error"}:
            return {"status": "error", "source_key": source, "results": [],
                    "message": "检索来源返回了无效状态；已有结果保留，请检查并继续。"}
        return result
