"""Tests for tools/literature_extract.py (extract 阶段 Python 半).

Run (isolated temp cwd):  python -m unittest -v test_literature_extract
Covered: --prepare bundle contract + schema gate + --force/stale semantics +
pypdf degrade paths, and --check skeleton rules (7 keys, paper_id==stem,
row field legality, traceable evidence, provenance format).
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import literature_extract as extract  # noqa: E402

FIELDS = [
    {"key": "soc", "label": "SOC", "meaning": "土壤有机碳含量", "unit": "g/kg", "valueType": "number",
     "required": True, "allowedRange": {"min": 0, "max": 600}, "conditionKeys": ["site", "treatment", "year"]},
    {"key": "ph", "label": "pH", "meaning": "土壤 pH", "unit": "", "valueType": "number", "required": False},
    {"key": "crop", "label": "作物", "meaning": "作物类型", "unit": "", "valueType": "text", "required": False,
     "allowedValues": ["maize", "wheat"], "conditionKeys": ["site"]},
]
PDF_TEXT = "SOC 12.4 g/kg maize site A 2018"


def make_pdf(text: str = PDF_TEXT) -> bytes:
    """Minimal single-page PDF with an extractable text object (valid xref)."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        None,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream = f"BT /F1 24 Tf 72 700 Td ({text}) Tj ET".encode("latin-1")
    objects[3] = b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode("latin-1") + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("latin-1")
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode("latin-1")
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("latin-1")
    return bytes(out)


def run_cli(main, argv: list[str]) -> tuple[int, list[dict]]:
    stream = io.StringIO()
    with contextlib.redirect_stdout(stream):
        code = main(argv)
    events = [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]
    return code, events


def write_job(root: Path, *, fields=FIELDS, max_chars=120000, statuses=None, html_text="SOC 12.4 g/kg，2018 年玉米季。") -> Path:
    """Build a minimal job dir with run_config / confirmations / fulltext/status."""
    job = root / "job"
    (job / "fulltext" / "files").mkdir(parents=True, exist_ok=True)
    (job / "run_config.json").write_text(json.dumps({
        "version": 2, "query": "soil organic carbon", "sources": ["google-scholar"],
        "extraction": {"maxCharsPerPaper": max_chars, "model": None},
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if fields is not None:
        (job / "confirmations.json").write_text(json.dumps({
            "records": [{"at": "2026-10-15T00:00:00Z", "by": "researcher", "kind": "fieldDefinitions",
                         "fields": fields, "note": ""}],
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (job / "fulltext" / "files" / "GSC-001.txt").write_text(html_text, encoding="utf-8")
    (job / "fulltext" / "files" / "GSC-002.pdf").write_bytes(make_pdf())
    (job / "fulltext" / "files" / "GSC-003.pdf").write_bytes(b"%PDF-1.4\nthis is not a real pdf\n")
    items = statuses if statuses is not None else [
        {"paper_id": "GSC-001", "title": "A", "doi": "10.1/a", "source_url": "https://example.org/a",
         "fulltext_url": "https://example.org/a.pdf", "kind": "html", "status": "fetched_html",
         "path": "fulltext/files/GSC-001.txt", "size": 100, "retrieved_at": "2026-10-15T00:00:00Z",
         "evidence_level": "fulltext_html", "reason": ""},
        {"paper_id": "GSC-002", "title": "B", "doi": "", "source_url": "https://example.org/b",
         "fulltext_url": "https://example.org/b.pdf", "kind": "pdf", "status": "fetched_pdf",
         "path": "fulltext/files/GSC-002.pdf", "size": 800, "retrieved_at": "2026-10-15T00:00:00Z",
         "evidence_level": "fulltext_pdf", "reason": ""},
        {"paper_id": "GSC-003", "title": "C", "doi": "", "source_url": "https://example.org/c",
         "fulltext_url": "", "kind": "pdf", "status": "fetched_pdf",
         "path": "fulltext/files/GSC-003.pdf", "size": 800, "retrieved_at": "2026-10-15T00:00:00Z",
         "evidence_level": "fulltext_pdf", "reason": ""},
        {"paper_id": "GSC-004", "title": "D", "doi": "", "source_url": "https://example.org/d",
         "fulltext_url": "", "kind": "none", "status": "unavailable",
         "path": "", "size": 0, "retrieved_at": "2026-10-15T00:00:00Z",
         "evidence_level": "search_result_snippet", "reason": "付费墙"},
    ]
    (job / "fulltext" / "status.json").write_text(json.dumps({
        "version": 1, "generated_at": "2026-10-15T00:00:00Z", "policy": "…", "items": items,
        "counts": {"total": len(items)},
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return job


def valid_result(paper_id: str, *, rows=None, status="ok", skip_reason="") -> dict:
    return {
        "paper_id": paper_id,
        "source_pdf": f"fulltext/files/{paper_id}.txt",
        "status": status,
        "classification_reason": "田间试验报告了 SOC",
        "rows": rows if rows is not None else [{
            "row_id": f"{paper_id}-R001", "field": "soc", "value_raw": "12.4", "unit_raw": "g/kg",
            "value_normalized": 12.4, "unit_normalized": "g/kg", "conversion": None,
            "evidence": {"where": "p.7 Table 3", "quote": "SOC was 12.4 g/kg", "kind": "table"},
            "conditions": {"site": "A", "treatment": "NPK", "year": "2018"}, "provenance": "",
        }],
        "warnings": [],
        "skip_reason": skip_reason,
    }


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lit-i4-extract-")
        self.addCleanup(self.tmp.cleanup)
        self.job = write_job(Path(self.tmp.name))

    def test_prepare_bundles_contract(self):
        code, events = run_cli(extract.main, ["--config", str(self.job / "run_config.json"), "--output-dir", str(self.job), "--prepare"])
        self.assertEqual(code, 0)
        final = events[-1]
        self.assertEqual(final["type"], "result")
        self.assertEqual(final["count"], 3)
        self.assertEqual(final["counts"], {"bundles": 3, "created": 3, "reused": 0, "degraded": 1, "skipped": 1})
        self.assertNotIn("GSC-004", "".join(final["files"]))

        html_bundle = json.loads((self.job / "extraction" / "inputs" / "GSC-001.json").read_text(encoding="utf-8"))
        self.assertEqual(html_bundle["paper_id"], "GSC-001")
        self.assertEqual(html_bundle["instructions_version"], "extract-contract-v1")
        self.assertEqual(html_bundle["schema_version"], 1)
        self.assertEqual(html_bundle["field_definitions"], FIELDS)
        self.assertEqual(html_bundle["condition_keys"], ["site", "treatment", "year"])
        self.assertEqual(html_bundle["fulltext"]["kind"], "html")
        self.assertEqual(html_bundle["fulltext"]["path"], "fulltext/files/GSC-001.txt")
        self.assertIn("SOC 12.4", html_bundle["fulltext"]["text"])
        self.assertFalse(html_bundle["fulltext"]["truncated"])
        self.assertNotIn("degraded", html_bundle)
        expected_sha = extract.load_effective_schema(self.job)["sha256"]
        self.assertEqual(html_bundle["schema_sha256"], expected_sha)

    @unittest.skipUnless(__import__("importlib").util.find_spec("pypdf"), "pypdf 未安装")
    def test_prepare_extracts_pdf_text(self):
        run_cli(extract.main, ["--config", str(self.job / "run_config.json"), "--output-dir", str(self.job), "--prepare"])
        bundle = json.loads((self.job / "extraction" / "inputs" / "GSC-002.json").read_text(encoding="utf-8"))
        self.assertIn("SOC 12.4", bundle["fulltext"]["text"])
        self.assertNotIn("degraded", bundle)

    def test_prepare_degraded_on_unparsable_pdf(self):
        code, events = run_cli(extract.main, ["--config", str(self.job / "run_config.json"), "--output-dir", str(self.job), "--prepare"])
        self.assertEqual(code, 0)
        bundle = json.loads((self.job / "extraction" / "inputs" / "GSC-003.json").read_text(encoding="utf-8"))
        self.assertEqual(bundle["fulltext"]["text"], "")
        self.assertEqual(bundle["fulltext"]["chars"], 0)
        self.assertIn("待补充", bundle["degraded"]["reason"])
        self.assertEqual(events[-1]["counts"]["degraded"], 1)

    def test_prepare_pypdf_missing_degrades(self):
        import unittest.mock as mock
        with mock.patch.dict(sys.modules, {"pypdf": None}):
            text, reason = extract.extract_pdf_text(self.job / "fulltext" / "files" / "GSC-002.pdf")
        self.assertEqual(text, "")
        self.assertIn("pypdf 未安装", reason)

    def test_prepare_truncates_to_max_chars(self):
        job = write_job(Path(self.tmp.name) / "small", max_chars=20, html_text="x" * 500)
        run_cli(extract.main, ["--config", str(job / "run_config.json"), "--output-dir", str(job), "--prepare"])
        bundle = json.loads((job / "extraction" / "inputs" / "GSC-001.json").read_text(encoding="utf-8"))
        self.assertEqual(bundle["fulltext"]["chars"], 20)
        self.assertTrue(bundle["fulltext"]["truncated"])
        self.assertEqual(len(bundle["fulltext"]["text"]), 20)

    def test_prepare_reuse_then_force(self):
        argv = ["--config", str(self.job / "run_config.json"), "--output-dir", str(self.job), "--prepare"]
        run_cli(extract.main, argv)
        code, events = run_cli(extract.main, argv)
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]["count"], 0)
        self.assertEqual(events[-1]["counts"]["reused"], 3)
        code, events = run_cli(extract.main, argv + ["--force"])
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]["count"], 3)

    def test_prepare_requires_confirmed_schema(self):
        job = write_job(Path(self.tmp.name) / "nogate", fields=None)
        code, events = run_cli(extract.main, ["--config", str(job / "run_config.json"), "--output-dir", str(job), "--prepare"])
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertEqual(events[-1]["message"], "提取前需先在研究者确认参数字段含义与单位")

    def test_prepare_stale_bundle_requires_force(self):
        argv = ["--config", str(self.job / "run_config.json"), "--output-dir", str(self.job), "--prepare"]
        run_cli(extract.main, argv)
        changed = [dict(FIELDS[0], unit="%"), *FIELDS[1:]]
        confirmations = json.loads((self.job / "confirmations.json").read_text(encoding="utf-8"))
        confirmations["records"].append({"at": "2026-10-16T00:00:00Z", "by": "researcher",
                                         "kind": "fieldDefinitions", "fields": changed, "note": ""})
        (self.job / "confirmations.json").write_text(json.dumps(confirmations, ensure_ascii=False), encoding="utf-8")
        code, events = run_cli(extract.main, argv)
        self.assertEqual(code, 1)
        self.assertIn("--force", events[-1]["message"])
        code, events = run_cli(extract.main, argv + ["--force"])
        self.assertEqual(code, 0)
        bundle = json.loads((self.job / "extraction" / "inputs" / "GSC-001.json").read_text(encoding="utf-8"))
        self.assertEqual(bundle["field_definitions"][0]["unit"], "%")

    def test_prepare_without_fulltext_status(self):
        job = write_job(Path(self.tmp.name) / "nostatus")
        (job / "fulltext" / "status.json").unlink()
        code, events = run_cli(extract.main, ["--config", str(job / "run_config.json"), "--output-dir", str(job), "--prepare"])
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["message"], "尚未完成全文获取")


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lit-i4-check-")
        self.addCleanup(self.tmp.cleanup)
        self.job = write_job(Path(self.tmp.name))
        run_cli(extract.main, ["--config", str(self.job / "run_config.json"), "--output-dir", str(self.job), "--prepare"])
        self.argv = ["--config", str(self.job / "run_config.json"), "--output-dir", str(self.job), "--check"]

    def write_result(self, paper_id: str, payload: dict):
        (self.job / "extraction" / f"{paper_id}.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def write_all_valid(self):
        self.write_result("GSC-001", valid_result("GSC-001"))
        self.write_result("GSC-002", valid_result("GSC-002", rows=[{
            "row_id": "GSC-002-R001", "field": "crop", "value_raw": "maize", "unit_raw": "",
            "value_normalized": "maize", "unit_normalized": "", "conversion": None,
            "evidence": {"where": "", "quote": "cropping system was continuous maize", "kind": "text"},
            "conditions": {"site": "B"}, "provenance": "",
        }]))
        self.write_result("GSC-003", valid_result("GSC-003", rows=[], status="skipped",
                                                  skip_reason="PDF 未解析出可读文本，待补充"))

    def test_check_passes_and_writes_report(self):
        self.write_all_valid()
        code, events = run_cli(extract.main, self.argv)
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]["type"], "result")
        self.assertEqual(events[-1]["count"], 3)
        self.assertEqual(events[-1]["counts"]["degraded"], 1)
        report = json.loads((self.job / "extraction" / "check_report.json").read_text(encoding="utf-8"))
        self.assertEqual((report["bundles"], report["ok"], report["failed"]), (3, 3, 0))
        self.assertEqual(report["degraded"][0]["paper_id"], "GSC-003")

    def test_check_requires_bundles(self):
        for path in (self.job / "extraction" / "inputs").glob("*.json"):
            path.unlink()
        code, events = run_cli(extract.main, self.argv)
        self.assertEqual(code, 1)
        self.assertIn("尚未生成提取输入包", events[-1]["message"])

    def test_check_skeleton_violations(self):
        cases = {
            "missing_file": (None, "缺少提取结果文件"),
            "paper_id_mismatch": (dict(valid_result("GSC-001"), paper_id="GSC-999"), "与文件名"),
            "missing_top_key": ({key: value for key, value in valid_result("GSC-001").items() if key != "warnings"}, "缺少顶层键"),
            "bad_status": (dict(valid_result("GSC-001"), status="done"), "不在 ok/partial/skipped"),
            "skipped_without_reason": (dict(valid_result("GSC-001"), status="skipped", rows=[], skip_reason="  "), "必须给出 skip_reason"),
            "bad_field": (valid_result("GSC-001", rows=[dict(valid_result("GSC-001")["rows"][0], field="soc_total")]), "不在已确认字段定义中"),
            "missing_evidence": (valid_result("GSC-001", rows=[dict(valid_result("GSC-001")["rows"][0], evidence={"where": "", "quote": ""})]), "缺少可追溯出处"),
            "missing_row_id": (valid_result("GSC-001", rows=[dict(valid_result("GSC-001")["rows"][0], row_id="")]), "缺少 row_id"),
            "bad_provenance": (valid_result("GSC-001", rows=[dict(valid_result("GSC-001")["rows"][0], provenance="read from Fig 2 by eye")]), "不符合冻结格式"),
            "ok_status_empty_rows": (valid_result("GSC-001", rows=[], status="ok"), "rows 为空"),
        }
        for name, (payload, expected) in cases.items():
            with self.subTest(case=name):
                for paper in ("GSC-001", "GSC-002", "GSC-003"):
                    result = (self.job / "extraction" / f"{paper}.json")
                    if result.exists():
                        result.unlink()
                self.write_all_valid()
                if payload is None:
                    (self.job / "extraction" / "GSC-001.json").unlink()
                else:
                    self.write_result("GSC-001", payload)
                code, events = run_cli(extract.main, self.argv)
                self.assertEqual(code, 1)
                self.assertEqual(events[-1]["type"], "error")
                self.assertIn(expected, events[-1]["message"])

    def test_check_message_summarises_papers(self):
        self.write_all_valid()
        self.write_result("GSC-002", dict(valid_result("GSC-002"), status="?!"))
        code, events = run_cli(extract.main, self.argv)
        self.assertEqual(code, 1)
        self.assertIn("GSC-002", events[-1]["message"])
        self.assertIn("提取结果校验未通过（1 篇）", events[-1]["message"])


if __name__ == "__main__":
    unittest.main()
