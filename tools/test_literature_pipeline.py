"""literature_pipeline.py / literature-common.py / literature_sources.py 测试（I1）。

用桩脚本（stub）在临时目录演示六阶段编排骨架：discover→dedupe→fulltext→extract→
validate→export 的 steps 编排 + NDJSON 事件 + events.jsonl 全量日志 + 断点续跑；
真实阶段脚本的联调归 V1。运行：

    python -m unittest tools/test_literature_pipeline.py
"""
from __future__ import annotations

import importlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import literature_pipeline as pipeline  # noqa: E402

common = importlib.import_module("literature-common")
sources = importlib.import_module("literature_sources")

STAGE_SCRIPTS = (
    "literature_search.py",
    "literature_dedupe.py",
    "literature_fulltext.py",
    "literature_extract.py",
    "literature_validate.py",
    "literature_export.py",
)

# 桩脚本：按文件名判定阶段，写最小产物并输出 NDJSON；LIT_STUB_* 环境变量控制异常路径。
STUB = r'''import argparse, json, os, sys, time
from pathlib import Path

def emit(kind, **values):
    sys.stdout.write(json.dumps({"type": kind, **values}, ensure_ascii=False) + "\n")
    sys.stdout.flush()

stage = {
    "literature_search": "discover",
    "literature_dedupe": "dedupe",
    "literature_fulltext": "fulltext",
    "literature_extract": "extract",
    "literature_validate": "validate",
    "literature_export": "export",
}[Path(__file__).stem]
parser = argparse.ArgumentParser()
parser.add_argument("--config", type=Path)
parser.add_argument("--output-dir", type=Path, required=True)
parser.add_argument("--resume", action="store_true")
parser.add_argument("--scrape-current", action="store_true")
parser.add_argument("--batch-index", type=int)
parser.add_argument("--prepare", action="store_true")
parser.add_argument("--check", action="store_true")
parser.add_argument("--force", action="store_true")
args, _unknown = parser.parse_known_args()
out = Path(args.output_dir)
runs = out / ".stub-runs"
runs.mkdir(parents=True, exist_ok=True)
with (runs / (stage + ".log")).open("a", encoding="utf-8") as handle:
    handle.write(stage + "\n")

if os.environ.get("LIT_STUB_ATTENTION") == stage:
    emit("attention", stage="verification", message="桩：需要人工验证")
    sys.exit(0)
if os.environ.get("LIT_STUB_FAIL") == stage:
    emit("error", stage=stage, message="桩：阶段失败")
    sys.exit(1)
if os.environ.get("LIT_STUB_CRASH") == stage:
    sys.stderr.write("桩：stderr 崩溃信息\n")
    sys.exit(3)
if os.environ.get("LIT_STUB_SILENT") == stage:
    sys.exit(0)
if os.environ.get("LIT_STUB_SLEEP") == stage:
    time.sleep(30)

emit("stage", stage=stage, message="桩阶段开始：" + stage)

if stage == "discover":
    (out / "candidates.json").write_text(json.dumps({"version": 2, "count": 1, "batches": [{"batch_index": 1, "count": 1}], "records": [{"candidate_id": "GSC-001", "batch_index": 1}]}, ensure_ascii=False), encoding="utf-8")
    (out / "candidates.csv").write_text("candidate_id\nGSC-001\n", encoding="utf-8-sig")
    emit("result", stage="completed", message="桩：已保存 1 条待复核候选", count=1, files=["candidates.json", "candidates.csv"])
elif stage == "dedupe":
    (out / "dedupe").mkdir(exist_ok=True)
    (out / "dedupe" / "dedupe.json").write_text(json.dumps({"version": 1, "groups": [{"canonical_id": "GSC-001"}], "counts": {"records_in": 1, "groups": 1, "merged": 0}}), encoding="utf-8")
    (out / "dedupe" / "dedupe.csv").write_text("canonical_id\nGSC-001\n", encoding="utf-8-sig")
    emit("result", stage="dedupe", message="桩：去重完成", count=1, counts={"records_in": 1, "groups": 1, "merged": 0}, files=["dedupe/dedupe.json", "dedupe/dedupe.csv"])
elif stage == "fulltext":
    (out / "fulltext").mkdir(exist_ok=True)
    (out / "fulltext" / "status.json").write_text(json.dumps({"version": 1, "items": [{"paper_id": "GSC-001", "status": "fetched_pdf"}], "counts": {"total": 1, "fetched_pdf": 1, "fetched_html": 0}}), encoding="utf-8")
    emit("result", stage="fulltext", message="桩：全文完成", count=1, counts={"fetched": 1, "unavailable": 0, "skipped": 0}, files=["fulltext/status.json"])
elif stage == "extract":
    if args.prepare:
        (out / "extraction" / "inputs").mkdir(parents=True, exist_ok=True)
        (out / "extraction" / "inputs" / "GSC-001.json").write_text(json.dumps({"paper_id": "GSC-001"}), encoding="utf-8")
        if os.environ.get("LIT_STUB_EXTRACT_DONE") == "1":
            (out / "extraction" / "GSC-001.json").write_text(json.dumps({"paper_id": "GSC-001", "source_pdf": "fulltext/files/GSC-001.pdf", "status": "ok", "classification_reason": "桩", "rows": [], "warnings": [], "skip_reason": ""}, ensure_ascii=False), encoding="utf-8")
        emit("result", stage="extraction", message="桩：提取输入包就绪", count=1, files=["extraction/inputs/GSC-001.json"])
    else:
        target = out / "extraction" / "GSC-001.json"
        payload = None
        if target.is_file():
            try:
                payload = json.loads(target.read_text(encoding="utf-8"))
            except ValueError:
                payload = None
        ok = isinstance(payload, dict) and payload.get("paper_id") == "GSC-001" and isinstance(payload.get("rows"), list)
        if not ok:
            emit("error", stage="extraction", message="桩：提取结果缺失或非法")
            sys.exit(1)
        (out / "extraction" / "check_report.json").write_text(json.dumps({"ok": ["GSC-001"]}), encoding="utf-8")
        emit("result", stage="extraction", message="桩：提取校验通过", count=1, files=["extraction/GSC-001.json"])
elif stage == "validate":
    (out / "validation").mkdir(exist_ok=True)
    (out / "validation" / "validation.json").write_text(json.dumps({"version": 1, "counts": {"parameters_total": 1, "ok": 1, "blocking": 0, "pending": 0}}), encoding="utf-8")
    (out / "validation" / "validation.md").write_text("# 待审清单\n", encoding="utf-8")
    emit("result", stage="validation", message="桩：校验完成", count=1, counts={"blocking": 0, "pending": 0, "ok": 1}, files=["validation/validation.json", "validation/validation.md"])
elif stage == "export":
    (out / "export").mkdir(exist_ok=True)
    for name in ("literature.xlsx", "parameters.xlsx"):
        (out / "export" / name).write_bytes(b"PK-stub")
    (out / "export" / "export_report.md").write_text("# 报告\n", encoding="utf-8")
    emit("result", stage="export", message="桩：导出完成", count=1, files=["export/literature.xlsx", "export/parameters.xlsx", "export/export_report.md"])
'''

VALID_RESULT = {"paper_id": "GSC-001", "source_pdf": "fulltext/files/GSC-001.pdf", "status": "ok",
                "classification_reason": "示例", "rows": [], "warnings": [], "skip_reason": ""}


class PipelineFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tools = self.root / "tools"
        self.tools.mkdir()
        for name in STAGE_SCRIPTS:
            (self.tools / name).write_text(STUB, encoding="utf-8")
        self.job = self.root / "job"
        self.job.mkdir()
        self.config_path = self.root / "run_config.json"
        self.config_path.write_text(json.dumps({"topic": "t", "query": "q", "sources": ["google-scholar"], "limit": 10}), encoding="utf-8")
        patcher = patch.object(pipeline, "TOOLS_DIR", self.tools)
        patcher.start()
        self.addCleanup(patcher.stop)
        # 默认假定「网页端已完成提取」（桩直接放置结果）；需要观察 expand/extract 关口的测试自行覆写。
        env_patcher = patch.dict(os.environ, {"LIT_STUB_EXTRACT_DONE": "1"})
        env_patcher.start()
        self.addCleanup(env_patcher.stop)

    def run_main(self, *argv: str):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = pipeline.main(["--config", str(self.config_path), "--output-dir", str(self.job), *argv])
        events = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
        return code, events, stderr.getvalue()

    def logs(self) -> dict:
        result = {}
        for stage in common.STAGES:
            path = self.job / ".stub-runs" / f"{stage}.log"
            result[stage] = path.read_text(encoding="utf-8").split() if path.is_file() else []
        return result

    def test_full_pipeline_runs_all_stages_in_order_and_logs_events(self) -> None:
        code, events, _stderr = self.run_main()
        self.assertEqual(code, 0)
        for relative in (
            "candidates.json", "candidates.csv", "dedupe/dedupe.json", "dedupe/dedupe.csv",
            "fulltext/status.json", "extraction/inputs/GSC-001.json", "extraction/GSC-001.json",
            "validation/validation.json", "validation/validation.md",
            "export/literature.xlsx", "export/parameters.xlsx", "export/export_report.md",
        ):
            self.assertTrue((self.job / relative).is_file(), relative)
        # 六个阶段按顺序执行（extract 先 --prepare 再 --check，故两次调用）
        stage_events = [event["stage"] for event in events if event["type"] == "stage"]
        self.assertEqual(stage_events, ["discover", "dedupe", "fulltext", "extract", "extract", "validate", "export"])
        logs = self.logs()
        self.assertEqual({stage: len(items) for stage, items in logs.items() if len(items) != 1}, {"extract": 2})
        # 收尾：流水线 result，且末条事件即末条（透传发现的候选 result 在前）
        self.assertEqual(events[-1]["type"], "result")
        self.assertEqual(events[-1]["stage"], "completed")
        self.assertIn("流水线完成（discover → export）", events[-1]["message"])
        self.assertIn("counts", events[-1])
        self.assertTrue(any(event["type"] == "result" and event.get("message") == "桩：已保存 1 条待复核候选" for event in events))
        # events.jsonl = 与 stdout 同序同形的全量审计流水
        logged = [json.loads(line) for line in (self.job / "events.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(logged), len(events))
        for entry, event in zip(logged, events):
            self.assertEqual((entry["type"], entry["stage"], entry["message"]), (event["type"], event["stage"], event["message"]))
            self.assertIn("at", entry)
        result_entry = next(entry for entry in logged if entry["type"] == "result" and entry["message"] == "桩：已保存 1 条待复核候选")
        self.assertIn("files", result_entry["extra"])

    def test_no_event_log_switch(self) -> None:
        code, _events, _stderr = self.run_main("--no-event-log")
        self.assertEqual(code, 0)
        self.assertFalse((self.job / "events.jsonl").exists())

    def test_attention_pauses_then_resume_continues(self) -> None:
        with patch.dict(os.environ, {"LIT_STUB_ATTENTION": "fulltext"}):
            code, events, _stderr = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]["type"], "attention")
        self.assertEqual(events[-1]["stage"], "verification")
        self.assertFalse((self.job / "extraction").exists())
        self.assertFalse((self.job / "export").exists())
        code, events, _stderr = self.run_main("--resume")
        self.assertEqual(code, 0)
        self.assertTrue((self.job / "export" / "literature.xlsx").is_file())
        logs = self.logs()
        self.assertEqual(len(logs["discover"]), 1)   # --resume 跳过已完成的 discover
        self.assertEqual(len(logs["dedupe"]), 1)
        self.assertEqual(len(logs["fulltext"]), 2)   # 验证关口后重跑
        self.assertEqual(events[-1]["stage"], "completed")

    def test_failure_propagates_and_stops_pipeline(self) -> None:
        with patch.dict(os.environ, {"LIT_STUB_FAIL": "dedupe"}):
            code, events, _stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("桩：阶段失败", events[-1]["message"])
        logs = self.logs()
        self.assertEqual(logs["fulltext"], [])
        self.assertFalse((self.job / "export").exists())

    def test_clean_exit_without_terminal_event_is_failure(self) -> None:
        with patch.dict(os.environ, {"LIT_STUB_SILENT": "dedupe"}):
            code, events, _stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["message"], "阶段脚本未返回结果")
        with patch.dict(os.environ, {"LIT_STUB_SILENT": "discover"}):
            job2 = self.root / "job2"
            job2.mkdir()
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = pipeline.main(["--config", str(self.config_path), "--output-dir", str(job2)])
            events2 = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertEqual(code, 1)
        self.assertEqual(events2[-1]["message"], "检索脚本未返回结果")

    def test_crash_stage_reports_stderr_tail(self) -> None:
        with patch.dict(os.environ, {"LIT_STUB_CRASH": "dedupe"}):
            code, events, _stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("桩：stderr 崩溃信息", events[-1]["message"])

    def test_resume_reports_nothing_to_do_when_all_stages_done(self) -> None:
        self.assertEqual(self.run_main()[0], 0)
        before = self.logs()
        code, events, _stderr = self.run_main("--resume")
        self.assertEqual(code, 0)
        self.assertIn("全部阶段已完成，无需续跑。", events[-1]["message"])
        self.assertEqual(self.logs(), before)

    def test_from_until_window(self) -> None:
        code, _events, _stderr = self.run_main("--until", "dedupe")
        self.assertEqual(code, 0)
        logs = self.logs()
        self.assertEqual(len(logs["discover"]), 1)
        self.assertEqual(len(logs["dedupe"]), 1)
        self.assertEqual(logs["fulltext"], [])
        code, _events, _stderr = self.run_main("--from", "fulltext")
        self.assertEqual(code, 0)
        logs = self.logs()
        self.assertEqual(len(logs["discover"]), 1)   # 未重复执行
        self.assertEqual(len(logs["export"]), 1)
        self.assertTrue((self.job / "export" / "parameters.xlsx").is_file())

    def test_extract_pauses_for_web_extraction_then_resumes(self) -> None:
        with patch.dict(os.environ, {"LIT_STUB_EXTRACT_DONE": ""}):
            code, events, _stderr = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]["type"], "attention")
        self.assertEqual(events[-1]["stage"], "extraction")
        self.assertIn("提取输入包已生成（1 篇）", events[-1]["message"])
        self.assertFalse((self.job / "validation").exists())
        # 模拟网页端完成提取后，--resume 从 extract 续跑（--check 通过）
        (self.job / "extraction" / "GSC-001.json").write_text(json.dumps(VALID_RESULT, ensure_ascii=False), encoding="utf-8")
        with patch.dict(os.environ, {"LIT_STUB_EXTRACT_DONE": ""}):
            code, events, _stderr = self.run_main("--resume")
        self.assertEqual(code, 0)
        self.assertTrue((self.job / "export" / "literature.xlsx").is_file())
        self.assertEqual(events[-1]["stage"], "completed")

    def test_timeout_kills_stage_and_reports(self) -> None:
        self.config_path.write_text(json.dumps({"topic": "t", "query": "q", "sources": ["google-scholar"], "limit": 10, "limits": {"dedupe": 1}}), encoding="utf-8")
        with patch.dict(os.environ, {"LIT_STUB_SLEEP": "dedupe"}):
            code, events, _stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["message"], "阶段执行超过 1 秒，已停止；已完成的产物保留。")
        self.assertEqual(self.logs()["fulltext"], [])

    def test_missing_stage_script_reports_clearly(self) -> None:
        (self.tools / "literature_validate.py").unlink()
        code, events, _stderr = self.run_main("--from", "validate")
        self.assertEqual(code, 1)
        self.assertIn("阶段脚本不存在：tools/literature_validate.py", events[-1]["message"])

    def test_gate_adapter_seam(self) -> None:
        with patch.object(pipeline, "GATE_ADAPTER", lambda job_dir, config: {"met": False, "reason": "尚未达到目标数量（预留接口演示）"}):
            code, events, _stderr = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]["type"], "attention")
        self.assertEqual(events[-1]["stage"], "export")
        self.assertIn("预留接口演示", events[-1]["message"])
        with patch.object(pipeline, "GATE_ADAPTER", lambda job_dir, config: {"met": True}):
            code, events, _stderr = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]["type"], "result")
        self.assertEqual(events[-1]["stage"], "completed")


class CommonHelpersTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.job = Path(self.temp.name) / "job"
        self.job.mkdir()

    def test_atomic_write_and_load_roundtrip(self) -> None:
        target = self.job / "nested" / "data.json"
        common.atomic_write_json(target, {"键": "值"}, indent=2)
        self.assertEqual(common.load_json(target), {"键": "值"})
        self.assertTrue(target.read_text(encoding="utf-8").endswith("\n"))
        self.assertEqual(list((self.job / "nested").glob("*.tmp")), [])
        self.assertIsNone(common.load_json(self.job / "missing.json"))
        broken = self.job / "broken.json"
        broken.write_text("{not json", encoding="utf-8")
        self.assertEqual(common.load_json(broken, default="fallback"), "fallback")

    def test_csv_encoding_and_cells(self) -> None:
        target = self.job / "table.csv"
        common.atomic_write_text(target, "a,b\n1,2\n", encoding="utf-8-sig")
        self.assertEqual(target.read_bytes()[:3], b"\xef\xbb\xbf")
        self.assertEqual(common.safe_csv_cell("=1+1"), "'=1+1")
        self.assertEqual(common.safe_csv_cell("普通"), "普通")
        self.assertEqual(common.safe_url("https://example.org/a"), "https://example.org/a")
        self.assertEqual(common.safe_url("javascript:alert(1)"), "")

    def test_append_event_log_shape(self) -> None:
        common.append_event_log(self.job, {"type": "stage", "stage": "dedupe", "message": "开始", "count": 3})
        common.append_event_log(self.job, {"type": "result", "message": "完成"})
        lines = (self.job / "events.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        first = json.loads(lines[0])
        self.assertEqual((first["type"], first["stage"], first["message"]), ("stage", "dedupe", "开始"))
        self.assertEqual(first["extra"], {"count": 3})
        self.assertIn("at", first)
        second = json.loads(lines[1])
        self.assertEqual((second["type"], second["stage"], second["message"]), ("result", "", "完成"))
        self.assertNotIn("extra", second)

    def test_detect_completed_stages_and_counts(self) -> None:
        detected = common.detect_completed_stages(self.job)
        self.assertEqual(detected, {stage: "pending" for stage in common.STAGES})
        common.atomic_write_json(common.job_paths(self.job)["candidates_json"], {"version": 2, "count": 3, "batches": [{"batch_index": 1}], "records": [{}, {}, {}]})
        common.atomic_write_json(common.job_paths(self.job)["dedupe_json"], {"version": 1, "groups": [], "counts": {"groups": 2}})
        common.atomic_write_json(common.job_paths(self.job)["fulltext_status"], {"version": 1, "items": [{"paper_id": "a", "status": "fetched_pdf"}], "counts": {"fetched_pdf": 1, "fetched_html": 1}})
        detected = common.detect_completed_stages(self.job)
        self.assertEqual(detected["discover"], "done")
        self.assertEqual(detected["dedupe"], "done")
        self.assertEqual(detected["fulltext"], "done")
        self.assertEqual(detected["extract"], "pending")   # 无输入包
        counts = common.stage_counts(self.job)
        self.assertEqual(counts["candidates"], 3)
        self.assertEqual(counts["uniqueGroups"], 2)
        self.assertEqual(counts["fulltextFetched"], 2)
        self.assertIsNone(counts["parameterRows"])
        # 输入包齐备 + 结果合法 → extract done；缺结果 → pending
        (self.job / "extraction" / "inputs").mkdir(parents=True)
        (self.job / "extraction" / "inputs" / "GSC-001.json").write_text("{}", encoding="utf-8")
        coverage = common.extraction_coverage(self.job)
        self.assertEqual(coverage["pending"], ["GSC-001"])
        self.assertEqual(common.detect_completed_stages(self.job)["extract"], "pending")
        (self.job / "extraction" / "GSC-001.json").write_text(json.dumps({"paper_id": "GSC-001", "status": "ok", "rows": []}), encoding="utf-8")
        coverage = common.extraction_coverage(self.job)
        self.assertEqual((coverage["results"], coverage["pending"], coverage["invalid"]), (1, [], []))
        self.assertEqual(common.detect_completed_stages(self.job)["extract"], "done")
        common.atomic_write_json(common.job_paths(self.job)["validation_json"], {"version": 1})
        paths = common.job_paths(self.job)
        paths["export_literature_xlsx"].parent.mkdir(parents=True, exist_ok=True)
        paths["export_literature_xlsx"].write_bytes(b"PK")
        self.assertEqual(common.detect_completed_stages(self.job)["export"], "pending")
        common.atomic_write_json(paths["validation_json"], {"version": 1, "counts": {"parameters_total": 7}})
        paths["export_parameters_xlsx"].write_bytes(b"PK")
        self.assertEqual(common.detect_completed_stages(self.job)["export"], "done")
        self.assertEqual(common.stage_counts(self.job)["parameterRows"], 7)

    def test_resolve_limits(self) -> None:
        self.assertEqual(common.resolve_limits(None), common.DEFAULT_LIMITS)
        merged = common.resolve_limits({"limits": {"discover": 60, "bogus": 5, "dedupe": "x"}})
        self.assertEqual(merged["discover"], 60)
        self.assertEqual(merged["dedupe"], common.DEFAULT_LIMITS["dedupe"])
        self.assertNotIn("bogus", merged)


class SourcesRegistryTest(unittest.TestCase):
    def test_registry_contents(self) -> None:
        # 注册表是**能力清单**，会随接入能力扩展——所以这里断言"性质"，不硬编码完整列表
        # （硬编码会让每次加源都误报回归，2026-10-21 已踩两次）。
        keys = sources.all_keys()
        # 1) 必备来源都在
        for key in ("google-scholar", "pubmed", "openalex", "cnki"):
            self.assertIn(key, keys, key + " 应已登记")
        # 2) 人工类源：不可自动执行，且必须说清原因、给出人工步骤与可导入格式
        for key in ("cnki", "wanfang", "web-of-science", "scopus"):
            self.assertIn(key, keys)
            self.assertFalse(sources.is_executable(key), key + " 不应可自动执行")
            self.assertTrue(sources.reason_of(key), key + " 应给出不可执行原因")
            self.assertTrue(sources.manual_steps_of(key), key + " 应给出人工步骤")
            self.assertTrue(sources.import_formats_of(key), key + " 应给出可导入的清单格式")
        # 3) 可执行源：open/浏览器源都应有 id 前缀（下游候选 id 依赖它）
        for key in sources.executable_keys():
            self.assertTrue(sources.id_prefix_of(key), key + " 应有 id 前缀")
        # 4) 每个来源的 access 取值合法
        for source in sources.list_sources():
            self.assertIn(source.get("access"), ("browser", "api", "manual"), str(source.get("key")))

    def test_reject_message_is_verbatim(self) -> None:
        expected = "尚未接通以下检索来源：cnki、pubmed；请明确改为仅检索 Google Scholar，或等待相应连接器。"
        self.assertEqual(sources.unconnected_message(["cnki", "pubmed"]), expected)

    def test_search_validate_config_reads_registry(self) -> None:
        import literature_search

        literature_search.validate_config({"query": "q", "limit": 10, "sources": ["google-scholar"]})
        with self.assertRaisesRegex(ValueError, "尚未接通以下检索来源：cnki"):
            literature_search.validate_config({"query": "q", "limit": 10, "sources": ["google-scholar", "cnki"]})
        with self.assertRaisesRegex(ValueError, "运行配置缺少检索式或包含未接通来源"):
            literature_search.validate_config({"query": "q", "limit": 10, "sources": ["arxiv"]})
        with self.assertRaisesRegex(ValueError, "运行配置缺少检索式或包含未接通来源"):
            literature_search.validate_config({"query": "", "limit": 10, "sources": ["google-scholar"]})
        with self.assertRaisesRegex(ValueError, "运行配置缺少检索式或包含未接通来源"):
            literature_search.validate_config({"query": "q", "limit": 11, "sources": ["google-scholar"]})
        with self.assertRaisesRegex(ValueError, "运行配置缺少检索式或包含未接通来源"):
            literature_search.validate_config({"query": "q", "limit": 10, "sources": ["google-scholar", "google-scholar"]})


if __name__ == "__main__":
    unittest.main()
