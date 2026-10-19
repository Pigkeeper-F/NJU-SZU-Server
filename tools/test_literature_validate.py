"""Tests for tools/literature_validate.py (validate 阶段：B1–B7 阻断 / P1–P4 待审核).

Run (isolated temp cwd):  python -m unittest -v test_literature_validate
Every rule from design §6.1/§6.2 has its own case; blocking rows are asserted to
be excluded from counts.pending (blocking/pending/ok partition parameters_total).
"""
from __future__ import annotations

import copy
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

import literature_validate as validate  # noqa: E402

FIELDS = [
    {"key": "soc", "label": "SOC", "meaning": "土壤有机碳含量", "unit": "g/kg", "valueType": "number",
     "required": True, "allowedRange": {"min": 0, "max": 600}, "conditionKeys": ["site", "treatment", "year"]},
    {"key": "ph", "label": "pH", "meaning": "土壤 pH", "unit": "", "valueType": "number", "required": False},
    {"key": "crop", "label": "作物", "meaning": "作物类型", "unit": "", "valueType": "text", "required": False,
     "allowedValues": ["maize", "wheat"]},
]


def row(**overrides) -> dict:
    base = {
        "row_id": "GSC-001-R001", "field": "soc", "value_raw": "12.4", "unit_raw": "g/kg",
        "value_normalized": 12.4, "unit_normalized": "g/kg", "conversion": None,
        "evidence": {"where": "p.7 Table 3", "quote": "SOC was 12.4 g/kg", "kind": "table"},
        "conditions": {"site": "A", "treatment": "NPK", "year": "2018"}, "provenance": "",
    }
    base.update(overrides)
    return base


def record(candidate_id: str, **overrides) -> dict:
    base = {
        "candidate_id": candidate_id, "source": "Google Scholar", "query": "soc", "retrieved_at": "2026-10-15T00:00:00Z",
        "title": f"Title {candidate_id}", "byline": "Zhang", "snippet": "…", "result_url": "https://example.org/x",
        "fulltext_links": [], "screening_status": "pending_review", "evidence_level": "search_result_snippet",
        "doi": "10.1/x", "year": 2018, "authors": "Zhang et al.", "source_key": "google-scholar", "batch_index": 1,
    }
    base.update(overrides)
    return base


def base_records() -> list[dict]:
    return [
        record("GSC-001", doi="10.1/a", title="A study"),
        record("GSC-B2-003", doi="10.1/a", title="A study (2)", screening_status="auto_excluded_duplicate",
               screening_reason="duplicate of GSC-001"),
        record("GSC-002", doi="10.1/b", title="B study", year=2019),
    ]


def base_groups() -> list[dict]:
    return [
        {"canonical_id": "GSC-001", "title": "A study", "year": 2018, "doi": "10.1/a", "sources": ["google-scholar"],
         "candidate_ids": ["GSC-001", "GSC-B2-003"], "merge_confidence": "exact", "merge_reason": "doi_exact",
         "max_score": 1.0, "needs_review": False, "records": [base_records()[0], base_records()[1]]},
        {"canonical_id": "GSC-002", "title": "B study", "year": 2019, "doi": "10.1/b", "sources": ["google-scholar"],
         "candidate_ids": ["GSC-002"], "merge_confidence": "exact", "merge_reason": "doi_exact",
         "max_score": 1.0, "needs_review": False, "records": [base_records()[2]]},
    ]


def base_items() -> list[dict]:
    return [
        {"paper_id": "GSC-001", "title": "A study", "doi": "10.1/a", "source_url": "https://example.org/a",
         "fulltext_url": "https://example.org/a.pdf", "kind": "html", "status": "fetched_html",
         "path": "fulltext/files/GSC-001.txt", "size": 100, "retrieved_at": "2026-10-15T00:00:00Z",
         "evidence_level": "fulltext_html", "reason": ""},
        {"paper_id": "GSC-002", "title": "B study", "doi": "10.1/b", "source_url": "https://example.org/b",
         "fulltext_url": "", "kind": "none", "status": "unavailable", "path": "", "size": 0,
         "retrieved_at": "2026-10-15T00:00:00Z", "evidence_level": "search_result_snippet", "reason": "付费墙"},
    ]


def base_docs() -> dict[str, dict]:
    return {
        "GSC-001": {
            "paper_id": "GSC-001", "source_pdf": "fulltext/files/GSC-001.txt", "status": "ok",
            "classification_reason": "报告了 SOC", "rows": [
                row(),
                row(row_id="GSC-001-R002", field="crop", value_raw="maize", unit_raw="", value_normalized="maize",
                    unit_normalized="", evidence={"where": "", "quote": "continuous maize", "kind": "text"},
                    conditions={"site": "A"}),
            ], "warnings": [], "skip_reason": "",
        },
        "GSC-002": {
            "paper_id": "GSC-002", "source_pdf": "fulltext/files/GSC-002.pdf", "status": "ok",
            "classification_reason": "报告了 pH", "rows": [
                row(row_id="GSC-002-R001", field="ph", value_raw="6.5", unit_raw="-", value_normalized=6.5,
                    unit_normalized="-", conditions={"site": "B"}),
            ], "warnings": [], "skip_reason": "",
        },
    }


def write_job(root: Path, *, records=None, groups=None, items=None, docs=None, fields=FIELDS) -> Path:
    job = root / "job"
    (job / "fulltext").mkdir(parents=True, exist_ok=True)
    (job / "run_config.json").write_text(json.dumps({"version": 2, "query": "soc", "sources": ["google-scholar"]}) + "\n", encoding="utf-8")
    if fields is not None:
        (job / "confirmations.json").write_text(json.dumps({"records": [
            {"at": "2026-10-15T00:00:00Z", "by": "researcher", "kind": "fieldDefinitions", "fields": fields, "note": ""}]},
            ensure_ascii=False) + "\n", encoding="utf-8")
    (job / "candidates.json").write_text(json.dumps({
        "version": 2, "source": "Google Scholar", "query": "soc", "count": len(records if records is not None else base_records()),
        "records": records if records is not None else base_records()}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if groups is not None:
        (job / "dedupe").mkdir(parents=True, exist_ok=True)
        (job / "dedupe" / "dedupe.json").write_text(json.dumps({"version": 1, "threshold": 0.55, "groups": groups},
                                                                ensure_ascii=False) + "\n", encoding="utf-8")
    (job / "fulltext" / "status.json").write_text(json.dumps({
        "version": 1, "items": items if items is not None else base_items(), "counts": {"total": 2}},
        ensure_ascii=False) + "\n", encoding="utf-8")
    docs = docs if docs is not None else base_docs()
    if docs:
        (job / "extraction").mkdir(parents=True, exist_ok=True)
        for paper_id, document in docs.items():
            (job / "extraction" / f"{paper_id}.json").write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return job


def run_cli(argv: list[str]) -> tuple[int, list[dict]]:
    stream = io.StringIO()
    with contextlib.redirect_stdout(stream):
        code = validate.main(argv)
    return code, [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


class ValidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lit-i4-validate-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def job_argv(self, job: Path) -> list[str]:
        return ["--config", str(job / "run_config.json"), "--output-dir", str(job)]

    def run_job(self, *, records=None, groups=None, items=None, docs=None, fields=FIELDS, name="job"):
        job = write_job(self.root / name, records=records, groups=groups, items=items, docs=docs, fields=fields)
        code, events = run_cli(self.job_argv(job))
        validation = json.loads((job / "validation" / "validation.json").read_text(encoding="utf-8"))
        return job, code, events, validation

    @staticmethod
    def rules(issues: list[dict]) -> list[str]:
        return [rule for issue in issues for rule in issue.get("rules", [])]

    def test_clean_job_has_no_issues(self):
        job, code, events, validation = self.run_job()
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]["type"], "result")
        self.assertEqual(validation["counts"]["parameters_total"], 3)
        self.assertEqual(validation["counts"]["ok"], 3)
        self.assertEqual(validation["counts"]["blocking"], 0)
        self.assertEqual(validation["counts"]["pending"], 0)
        self.assertEqual(validation["counts"]["literature_total"], 3)
        self.assertEqual(validation["blocking"], [])
        self.assertEqual(validation["pending"], [])
        self.assertEqual(validation["schema_source"], "confirmations.json#fieldDefinitions@2026-10-15T00:00:00Z")
        self.assertEqual(validation["version"], 1)
        markdown = (job / "validation" / "validation.md").read_text(encoding="utf-8")
        self.assertIn("校验待审清单", markdown)
        self.assertIn("（无）", markdown)

    def test_blocking_rules_b1_to_b7(self):
        cases: dict[str, tuple[dict, str]] = {}
        # B1 参数行无法关联文献：提取结果里的论文不在文献表中
        orphan = copy.deepcopy(base_docs()["GSC-001"])
        orphan["paper_id"] = "GSC-999"
        orphan["rows"][0]["row_id"] = "GSC-999-R001"
        docs = base_docs()
        docs["GSC-999"] = orphan
        cases["B1"] = ({"docs": docs}, "missing_paper_link")
        # B2 缺可追溯来源
        docs = base_docs()
        docs["GSC-001"] = copy.deepcopy(docs["GSC-001"])
        docs["GSC-001"]["rows"][0]["evidence"] = {"where": "", "quote": ""}
        cases["B2"] = ({"docs": docs}, "missing_evidence")
        # B3 缺字段名
        docs = base_docs()
        docs["GSC-001"] = copy.deepcopy(docs["GSC-001"])
        docs["GSC-001"]["rows"][0]["field"] = ""
        cases["B3"] = ({"docs": docs}, "missing_field")
        # B4 缺原值
        docs = base_docs()
        docs["GSC-001"] = copy.deepcopy(docs["GSC-001"])
        docs["GSC-001"]["rows"][0]["value_raw"] = ""
        cases["B4"] = ({"docs": docs}, "missing_value")
        # B5 数值字段不是有效数字
        docs = base_docs()
        docs["GSC-001"] = copy.deepcopy(docs["GSC-001"])
        docs["GSC-001"]["rows"][0]["value_normalized"] = "abc"
        cases["B5"] = ({"docs": docs}, "invalid_number")
        # B6 字段不符合确认结构
        docs = base_docs()
        docs["GSC-001"] = copy.deepcopy(docs["GSC-001"])
        docs["GSC-001"]["rows"][0]["field"] = "soc_total"
        cases["B6"] = ({"docs": docs}, "unknown_field")
        # B7 文献行缺 paper_id（组内记录无 candidate_id）
        records = base_records() + [record("", title="no id")]
        groups = base_groups() + [{"canonical_id": "", "candidate_ids": [""], "needs_review": False,
                                   "records": [record("", title="no id")]}]
        cases["B7-missing"] = ({"records": records, "groups": groups}, "invalid_paper_id")
        # B7 文献行 paper_id 重复（同一 candidate_id 出现两次）
        duplicate = record("GSC-002", title="B study duplicate")
        records = base_records() + [duplicate]
        groups = [base_groups()[0], {**base_groups()[1], "records": [base_records()[2], duplicate]}]
        cases["B7-duplicate"] = ({"records": records, "groups": groups}, "invalid_paper_id")

        for name, (kwargs, expected) in cases.items():
            with self.subTest(case=name):
                _, code, events, validation = self.run_job(name=name, **kwargs)
                self.assertEqual(code, 0)
                self.assertEqual(events[-1]["type"], "result")
                self.assertIn(expected, self.rules(validation["blocking"]))
                parameter_blocking = [issue for issue in validation["blocking"] if issue["entity"] == "parameter"]
                literature_blocking = [issue for issue in validation["blocking"] if issue["entity"] == "literature"]
                self.assertEqual(validation["counts"]["blocking"], len(parameter_blocking))
                self.assertEqual(validation["counts"]["literature_blocking"], len(literature_blocking))
                self.assertGreaterEqual(len(validation["blocking"]), 1)

    def test_pending_rules_p1_to_p4(self):
        cases: dict[str, tuple[dict, str]] = {}
        # P1 缺 DOI
        records = base_records()
        records[2]["doi"] = ""
        groups = base_groups()
        groups[1]["doi"] = ""
        groups[1]["records"][0]["doi"] = ""
        cases["P1"] = ({"records": records, "groups": groups}, "missing_doi")
        # P2 单位不明（数值字段 unit_raw 为空）
        docs = base_docs()
        docs["GSC-001"] = copy.deepcopy(docs["GSC-001"])
        docs["GSC-001"]["rows"][0]["unit_raw"] = ""
        cases["P2"] = ({"docs": docs}, "missing_unit")
        # P3 疑似重复（dedupe needs_review）
        groups = base_groups()
        groups[0] = {**groups[0], "needs_review": True, "merge_confidence": "probable",
                     "merge_reason": "title_jaccard", "max_score": 0.61}
        cases["P3"] = ({"groups": groups}, "probable_duplicate")
        # P4 异常值（allowedRange 上限 600）
        docs = base_docs()
        docs["GSC-001"] = copy.deepcopy(docs["GSC-001"])
        docs["GSC-001"]["rows"][0]["value_normalized"] = 900
        cases["P4-range"] = ({"docs": docs}, "value_out_of_range")
        # P4 取值域（allowedValues：crop=rice 不在允许值内）
        docs = base_docs()
        docs["GSC-001"] = copy.deepcopy(docs["GSC-001"])
        docs["GSC-001"]["rows"][1]["value_normalized"] = "rice"
        cases["P4-values"] = ({"docs": docs}, "value_out_of_range")

        for name, (kwargs, expected) in cases.items():
            with self.subTest(case=name):
                job, code, events, validation = self.run_job(name=name, **kwargs)
                self.assertEqual(code, 0)
                self.assertEqual(events[-1]["type"], "result")
                self.assertIn(expected, self.rules(validation["pending"]))
                self.assertEqual(validation["blocking"], [])
                markdown = (job / "validation" / "validation.md").read_text(encoding="utf-8")
                self.assertIn(expected, markdown)

    def test_p4_ignored_without_explicit_range(self):
        docs = base_docs()
        docs["GSC-001"] = copy.deepcopy(docs["GSC-001"])
        docs["GSC-001"]["rows"][0]["value_normalized"] = 99999  # soc 有范围 → 会命中；改用无范围的 ph 验证
        _, _, _, validation = self.run_job(name="norange", docs=docs)
        self.assertIn("value_out_of_range", self.rules(validation["pending"]))
        fields = [dict(entry) for entry in FIELDS]
        fields[0] = {key: value for key, value in fields[0].items() if key != "allowedRange"}
        docs = base_docs()
        docs["GSC-001"] = copy.deepcopy(docs["GSC-001"])
        docs["GSC-001"]["rows"][0]["value_normalized"] = 99999
        _, _, _, validation = self.run_job(name="norange2", docs=docs, fields=fields)
        self.assertNotIn("value_out_of_range", self.rules(validation["pending"]))

    def test_blocking_rule_wins_over_pending_for_the_same_row(self):
        docs = base_docs()
        docs["GSC-001"] = copy.deepcopy(docs["GSC-001"])
        docs["GSC-001"]["rows"][0]["value_raw"] = ""      # B4
        docs["GSC-001"]["rows"][0]["unit_raw"] = ""        # P2（同一行）
        _, code, _, validation = self.run_job(name="both", docs=docs)
        self.assertEqual(code, 0)
        self.assertIn("missing_value", self.rules(validation["blocking"]))
        self.assertNotIn("missing_unit", self.rules(validation["pending"]))
        self.assertEqual(validation["counts"]["blocking"], 1)
        self.assertEqual(validation["counts"]["pending"], 0)
        self.assertEqual(validation["counts"]["ok"], 2)

    def test_counts_partition_parameters_total(self):
        docs = base_docs()
        docs["GSC-001"] = copy.deepcopy(docs["GSC-001"])
        docs["GSC-001"]["rows"][0]["value_raw"] = ""       # blocking
        docs["GSC-002"] = copy.deepcopy(docs["GSC-002"])
        docs["GSC-002"]["rows"][0]["unit_raw"] = ""        # pending
        _, _, _, validation = self.run_job(name="partition", docs=docs)
        counts = validation["counts"]
        self.assertEqual(counts["parameters_total"], counts["ok"] + counts["blocking"] + counts["pending"])

    def test_skipped_extraction_rows_are_ignored(self):
        docs = base_docs()
        docs["GSC-002"] = {"paper_id": "GSC-002", "source_pdf": "x.pdf", "status": "skipped",
                           "classification_reason": "无正文", "rows": [row(row_id="GSC-002-R001", field="", value_raw="")],
                           "warnings": [], "skip_reason": "正文缺失"}
        _, code, _, validation = self.run_job(name="skipped", docs=docs)
        self.assertEqual(code, 0)
        self.assertEqual(validation["counts"]["parameters_total"], 2)
        self.assertEqual(validation["blocking"], [])

    def test_public_api_literature_and_parameters(self):
        job = write_job(self.root / "api")
        literature_issues = validate.validate_literature(job)
        parameter_issues = validate.validate_parameters(job)
        self.assertEqual(literature_issues, [])
        self.assertEqual(parameter_issues, [])
        self.assertTrue(all(issue["entity"] == "parameter" for issue in validate.validate_parameters(job, FIELDS)))

    def test_no_extraction_directory_is_fine(self):
        job = write_job(self.root / "noextract", docs={})
        code, events = run_cli(self.job_argv(job))
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]["count"], 0)

    def test_rule_catalogue_matches_design_numbers(self):
        self.assertEqual([entry.split(":")[0] for entry in validate.BLOCKING_RULES], ["B1", "B2", "B3", "B4", "B5", "B6", "B7"])
        self.assertEqual([entry.split(":")[0] for entry in validate.PENDING_RULES], ["P1", "P2", "P3", "P4"])


if __name__ == "__main__":
    unittest.main()
