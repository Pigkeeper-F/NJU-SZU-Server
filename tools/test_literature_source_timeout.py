"""Hard per-source/page deadline with real isolated fixture processes only."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

import literature_search as search
import literature_source_runner as runner
import literature_source_worker as worker


FIXTURE = r'''
import json, pathlib, subprocess, sys, time
p = json.load(sys.stdin)
root = pathlib.Path(p["job_dir"])
root.mkdir(parents=True, exist_ok=True)
source, index = p["source"], p.get("page_index")
with (root / "fixture-calls.jsonl").open("a", encoding="utf-8") as f:
    f.write(json.dumps([source,index,p["scrape_current"]])+"\n")
slow = source in ("cnki", "hang", "inherited-stdout") or index == 1
if source == "inherited-stdout":
    child = subprocess.Popen([sys.executable,"-c","import time; time.sleep(1.3)"], stdin=subprocess.DEVNULL)
    (root / "fixture-grandchild.pid").write_text(str(child.pid))
if slow and not (root / "fixture-ready").exists():
    time.sleep(0.9)
    (root / "discovery-state.json").write_text("LATE WORKER MUST NOT WRITE THIS")
records = [{"title": source+" study "+str((index or 0)*10+i),"year":2020} for i in range(5 if index == 1 else 10)]
print(json.dumps({"status":"ok","results":records,"has_next":index == 0,"page_index":index or 0}), flush=True)
'''


class SourceTimeoutTests(unittest.TestCase):
    def test_worker_decodes_utf8_chinese_query_and_path_despite_legacy_stdin_encoding(self):
        payload = {"protocol": 1, "source": "cnki", "query": '肉鸡 "热应激" + 温度', "scrape_current": True,
                   "limit": 10, "year_from": None, "year_to": None,
                   "job_dir": "C:/测试/流程智能体/原任务", "page_index": 2, "full_page": True,
                   "parent_pid": os.getppid()}
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps(payload, ensure_ascii=False).encode("utf-8")), encoding="cp936")
        calls = []
        fake_adapter = types.SimpleNamespace(run=lambda *args, **kwargs: (calls.append((args, kwargs)) or {"status": "ok", "results": []}))
        stdout = io.StringIO()
        try:
            with patch.object(sys, "stdin", stdin), patch.dict(sys.modules, {"literature_browser": fake_adapter}), \
                    patch.object(worker, "_start_guard", return_value=None), redirect_stdout(stdout):
                self.assertEqual(worker.main(), 0)
            self.assertEqual(stdin.encoding, "utf-8")
            self.assertEqual(calls, [(("cnki", payload["query"], True, 10, None, None),
                                     {"job_dir": Path(payload["job_dir"]), "page_index": 2, "full_page": True})])
            self.assertEqual(json.loads(stdout.getvalue())["status"], "ok")
        finally:
            stdin.close()

    def fixture_processes(self, root):
        script = root / "fixture_source.py"
        script.write_text(FIXTURE, encoding="utf-8")
        processes = []

        def start(request_file, response_file):
            executable, environment = runner._python_process_spec()
            process = subprocess.Popen([executable, "-u", str(script)], stdin=request_file, env=environment,
                                       stdout=response_file, stderr=subprocess.DEVNULL,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            processes.append(process)
            return process
        return start, processes

    def execute(self, config, root, **options):
        original_runner = runner.run_source

        def short_runner(*args, **kwargs):
            return original_runner(*args, **kwargs, timeout_seconds=0.35)

        stdout = io.StringIO()
        with patch.object(search, "injected_source_runner", short_runner), redirect_stdout(stdout):
            code = search.run(config, root, **options)
        return code, [json.loads(line) for line in stdout.getvalue().splitlines()]

    def test_production_default_is_fixed_worker_with_sixty_second_deadline(self):
        waits = []

        def start(request_file, response_file):
            payload = json.load(request_file)
            self.assertEqual((payload["source"], payload["query"]), ("cnki", "frozen query"))
            response_file.write('{"status":"ok","results":[]}')
            response_file.flush()

            class Finished:
                returncode = 0
                def wait(self, *, timeout):
                    waits.append(timeout)
            return Finished()

        with tempfile.TemporaryDirectory() as temp, patch.object(runner, "_start_worker", side_effect=start):
            self.assertEqual(runner.run_source("cnki", "frozen query", False, 10, job_dir=Path(temp))["status"], "ok")
        self.assertEqual(runner.PAGE_TIMEOUT_SECONDS, 60)
        self.assertEqual(waits, [60])
        self.assertIsNone(search.injected_source_runner)
        self.assertEqual(runner._WORKER, Path(runner.__file__).resolve().with_name("literature_source_worker.py"))

    def test_guard_deadline_exit_code_is_attention_not_generic_failure(self):
        class TimedOut:
            returncode = 124
            def wait(self, *, timeout):
                return self.returncode
        with tempfile.TemporaryDirectory() as temp, patch.object(runner, "_start_worker", return_value=TimedOut()):
            result = runner.run_source("cnki", "frozen query", False, 10, job_dir=Path(temp))
        self.assertEqual((result["status"], result["reason"], result["source_key"]),
                         ("attention", "results_unrecognized", "cnki"))
        self.assertIn("超过1分钟", result["message"])

    @unittest.skipUnless(os.name == "nt", "Native Windows parent-process handle cancellation regression")
    def test_driver_cancellation_ends_actual_worker_before_late_write(self):
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bootstrap = root / "fixture_bootstrap.py"
            bootstrap.write_text(
                "import os,sys,time,types\nfrom pathlib import Path\n"
                f"sys.path.insert(0,{str(Path(worker.__file__).resolve().parent)!r})\n"
                "def fake_run(*args,**kwargs):\n"
                " root=Path(kwargs['job_dir'])\n"
                " (root/'fixture-worker.pid').write_text(str(os.getpid()))\n"
                " time.sleep(1.1)\n"
                " (root/'discovery-state.json').write_text('LATE CANCELLED WORKER')\n"
                " return {'status':'ok','results':[]}\n"
                "sys.modules['literature_browser']=types.SimpleNamespace(run=fake_run)\n"
                "import literature_source_worker\n"
                "original_guard=literature_source_worker._start_guard\n"
                "def fixture_guard(parent):\n"
                " try: return original_guard(parent)\n"
                " except Exception as e:\n"
                f"  Path({str(root / 'fixture-guard-error.txt')!r}).write_text(type(e).__name__+': '+str(e))\n"
                "  raise\n"
                "literature_source_worker._start_guard=fixture_guard\n"
                "def fixture_trace(frame,event,arg):\n"
                " if event=='exception' and frame.f_code.co_filename==literature_source_worker.__file__:\n"
                f"  Path({str(root / 'fixture-worker-error.txt')!r}).write_text(repr(arg[1]),encoding='utf-8')\n"
                " return fixture_trace\n"
                "sys.settrace(fixture_trace)\n"
                "raise SystemExit(literature_source_worker.main())\n", encoding="utf-8")
            driver_script = root / "fixture_driver.py"
            driver_script.write_text(
                "import subprocess,sys\nfrom pathlib import Path\n"
                f"sys.path.insert(0,{str(Path(worker.__file__).resolve().parent)!r})\n"
                "import literature_source_runner as runner\n"
                "def start(request,response):\n"
                " executable,environment=runner._python_process_spec()\n"
                f" return subprocess.Popen([executable,'-u',{str(bootstrap)!r}],env=environment,stdin=request,stdout=response,stderr=open({str(root / 'fixture-worker.stderr')!r},'wb'),creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))\n"
                "runner._start_worker=start\n"
                f"result=runner.run_source('cnki','肉鸡 热应激',False,10,job_dir=Path({str(root)!r}))\n"
                f"Path({str(root / 'fixture-driver-result.txt')!r}).write_text(repr(result),encoding='utf-8')\n", encoding="utf-8")
            executable, environment = runner._python_process_spec()
            driver = subprocess.Popen([executable, "-u", str(driver_script)], env=environment, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                      creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            handle = None
            try:
                ready = root / "fixture-worker.pid"
                deadline = time.monotonic() + 4
                while not ready.exists() and driver.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                diagnostic = root / "fixture-guard-error.txt"
                debug_files = [diagnostic, root / "fixture-worker.stderr", root / "fixture-driver-result.txt", root / "fixture-worker-error.txt"]
                self.assertTrue(ready.exists(), "Actual worker must reach the guarded fake adapter: "
                                + " | ".join(path.read_text(encoding="utf-8", errors="replace") for path in debug_files if path.exists()))
                handle = kernel.OpenProcess(0x00100000, False, int(ready.read_text()))
                self.assertTrue(handle)
                driver.kill()  # This is only our isolated fixture driver.
                driver.wait(timeout=2)
                self.assertEqual(kernel.WaitForSingleObject(handle, 3000), 0,
                                 "Guardian must stop its own worker when the driver exits")
                time.sleep(1.2)
                self.assertFalse((root / "discovery-state.json").exists())
            finally:
                if driver.poll() is None:
                    driver.kill()
                    driver.wait(timeout=2)
                if handle:
                    kernel.CloseHandle(handle)

    def test_real_worker_is_killed_and_cannot_write_late_checkpoint(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            checkpoint = root / "discovery-state.json"
            checkpoint.write_bytes(b'{"count":30}')
            start, processes = self.fixture_processes(root)
            began = time.monotonic()
            with patch.object(runner, "_start_worker", side_effect=start):
                result = runner.run_source("hang", "q", False, 10, job_dir=root, timeout_seconds=0.35)
            self.assertLess(time.monotonic() - began, 0.85)
            self.assertEqual((result["status"], result["reason"], result["source_key"]),
                             ("attention", "results_unrecognized", "hang"))
            self.assertIn("超过1分钟", result["message"])
            self.assertTrue(result["timed_out"])
            self.assertIsNotNone(processes[0].poll())
            time.sleep(0.95)
            self.assertEqual(checkpoint.read_bytes(), b'{"count":30}')

    def test_inherited_stdout_descendant_does_not_delay_timeout_return(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            start, processes = self.fixture_processes(root)
            began = time.monotonic()
            with patch.object(runner, "_start_worker", side_effect=start):
                result = runner.run_source("inherited-stdout", "q", False, 10, job_dir=root, timeout_seconds=0.35)
            self.assertLess(time.monotonic() - began, 0.85, "Must not wait for descendant stdout EOF")
            self.assertEqual(result["status"], "attention")
            self.assertIsNotNone(processes[0].poll())
            self.assertTrue((root / "fixture-grandchild.pid").exists())
            time.sleep(1.35)  # Let our isolated fixture descendant exit normally.
            self.assertFalse((root / "discovery-state.json").exists())

    def test_source_timeout_preserves_thirty_candidates_and_original_resume(self):
        config = {"topic": "fixture", "query": "frozen broiler query", "sources": ["pubmed", "scopus", "wanfang", "cnki"],
                  "limit": 10, "searchMode": "test"}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            start, processes = self.fixture_processes(root)
            with patch.object(runner, "_start_worker", side_effect=start):
                code, events = self.execute(config, root)
                self.assertEqual((code, events[-1]["type"], events[-1]["source"], events[-1]["count"]),
                                 (0, "attention", "cnki", 30))
                state_path = root / "discovery-state.json"
                state = json.loads(state_path.read_text(encoding="utf-8"))
                data = json.loads((root / "candidates.json").read_text(encoding="utf-8"))
                original = data["records"]
                self.assertEqual((state["pending_source"], state["pending_reason"]), ("cnki", "results_unrecognized"))
                self.assertFalse(data["discovery_complete"])
                self.assertTrue(all(process.poll() is not None for process in processes))
                time.sleep(0.95)
                self.assertEqual(json.loads(state_path.read_text(encoding="utf-8")), state)
                (root / "fixture-ready").touch()
                code, events = self.execute(config, root, resume=True)
            final = json.loads((root / "candidates.json").read_text(encoding="utf-8"))
            self.assertEqual((code, events[-1]["type"], final["count"]), (0, "result", 40))
            self.assertEqual(final["records"][:30], original)
            calls = [json.loads(line) for line in (root / "fixture-calls.jsonl").read_text().splitlines()]
            self.assertEqual([call[0] for call in calls], config["sources"] + ["cnki"])
            self.assertTrue(calls[-1][2])

    def test_formal_page_timeout_keeps_first_page_and_retries_original_page(self):
        config = {"topic": "fixture", "query": "frozen broiler query", "sources": ["pubmed"],
                  "limit": 10, "searchMode": "formal", "stopMode": "end", "perSourceLimit": None}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            start, processes = self.fixture_processes(root)
            with patch.object(runner, "_start_worker", side_effect=start):
                code, events = self.execute(config, root)
                self.assertEqual((code, events[-1]["type"], events[-1]["source"], events[-1]["count"]),
                                 (0, "attention", "pubmed", 10))
                state_path = root / "discovery-state.json"
                state = json.loads(state_path.read_text(encoding="utf-8"))
                original = json.loads((root / "candidates.json").read_text(encoding="utf-8"))["records"]
                self.assertEqual((state["sources"]["pubmed"]["next_page"], state["sources"]["pubmed"]["pages_fetched"]), (1, 1))
                time.sleep(0.95)
                self.assertEqual(json.loads(state_path.read_text(encoding="utf-8")), state)
                self.assertTrue(all(process.poll() is not None for process in processes))
                (root / "fixture-ready").touch()
                code, events = self.execute(config, root, resume=True)
            final = json.loads((root / "candidates.json").read_text(encoding="utf-8"))
            self.assertEqual((code, events[-1]["type"], final["count"]), (0, "result", 15))
            self.assertEqual(final["records"][:10], original)
            calls = [json.loads(line) for line in (root / "fixture-calls.jsonl").read_text().splitlines()]
            self.assertEqual(calls, [["pubmed", 0, False], ["pubmed", 1, False], ["pubmed", 1, True]])
            self.assertTrue(final["discovery_complete"])


if __name__ == "__main__":
    unittest.main()
