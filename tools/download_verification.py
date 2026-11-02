"""Offline, read-only download profiling and update comparison (standard library only).

CSV/TSV records are indexed on disk, never loaded as a whole. No cell is converted,
filled, dropped or rewritten in a source file. Equality is textual, including flags.
"""
import argparse
import csv
import hashlib
import json
import os
import sqlite3
import tempfile
import unicodedata
import uuid
import zipfile
from pathlib import Path

try:
    from .download_professional_rules import run_professional_rules
except ImportError:
    # This module is also executed as a standalone script and loaded directly
    # by offline regression tools.
    import importlib.util
    _professional_spec = importlib.util.spec_from_file_location("download_professional_rules", Path(__file__).with_name("download_professional_rules.py"))
    _professional_module = importlib.util.module_from_spec(_professional_spec)
    _professional_spec.loader.exec_module(_professional_module)
    run_professional_rules = _professional_module.run_professional_rules


FAO_KEY = ["Reporter Country Code", "Partner Country Code", "Item Code", "Element Code", "Year"]
SAMPLE_LIMIT = 10
MAX_JSON_PARSE = 16 * 1024 * 1024
FAO_FILTER_COLUMNS = {"reporterCodes": "Reporter Country Code", "partnerCodes": "Partner Country Code",
                      "itemCodes": "Item Code", "elementCodes": "Element Code", "elementNames": "Element"}
FAO_NAME_COLUMNS = {"itemNames": ("itemCodes", "Item"), "reporterNames": ("reporterCodes", "Reporter Countries"),
                    "partnerNames": ("partnerCodes", "Partner Countries")}
NAME_ALIASES = {"小麦": "Wheat", "进口数量": "Import quantity", "进口量": "Import quantity", "出口数量": "Export quantity", "出口量": "Export quantity"}


def normalized_name(value):
    return " ".join(unicodedata.normalize("NFKC", value).split()).casefold()


def compact(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def local_path(value):
    """Use Windows extended paths for every filesystem/SQLite boundary.

    Normalizing before prefixing also accepts the C:/... paths sent by Node.
    Existing extended paths and UNC shares are preserved without double prefixes.
    """
    absolute = os.path.normpath(os.path.abspath(os.fspath(value)))
    if os.name == "nt" and not absolute.startswith("\\\\?\\"):
        return "\\\\?\\UNC\\" + absolute[2:] if absolute.startswith("\\\\") else "\\\\?\\" + absolute
    return absolute


def file_sha(path):
    digest = hashlib.sha256()
    with open(local_path(path), "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def issue(code, question, affected, evidence, recommendation, severity="warning", decision=True):
    return {"code": code, "severity": severity, "question": question,
            "affected": affected, "evidence": evidence,
            "recommendation": recommendation, "requiresDecision": decision}


def is_fao(dataset):
    kind = str(dataset.get("kind") or "").lower()
    result = dataset.get("result") or {}
    return "faostat" in kind or result.get("dataset") == "TM"


def requested_keys(dataset, request):
    value = dataset.get("keyColumns", request.get("keyColumns"))
    if value is not None:
        if not isinstance(value, list) or not value or any(not isinstance(x, str) or not x for x in value) or len(set(value)) != len(value):
            raise ValueError("keyColumns 必须是已确认且无重复的字段名列表")
        return value
    return FAO_KEY if is_fao(dataset) else []


def scope_of(dataset):
    """Versions and requested years may change; source identity and other filters may not."""
    config = dataset.get("config") or {}
    result = dataset.get("result") or {}
    catalog = dataset.get("catalog") or {}
    resolved = result.get("resolvedConfig") or config
    filters = resolved.get("filters")
    normalized = None
    if isinstance(filters, dict):
        normalized = {key: sorted(set(str(v) for v in values)) if isinstance(values, list) else values
                      for key, values in filters.items() if values not in (None, [], "")}
    return {"kind": dataset.get("kind"), "dataset": result.get("dataset") or config.get("dataset") or catalog.get("dataset"),
            "source": dataset.get("sourceId") or catalog.get("sourceId") or catalog.get("provider"),
            "filters": normalized,
            "scope": dataset.get("scope") or config.get("scope")}


def scope_reasons(current, baseline):
    left, right = scope_of(current), scope_of(baseline)
    reasons = []
    for name in left:
        if left[name] is not None and right[name] is not None and left[name] != right[name]:
            reasons.append({"field": name, "current": left[name], "baseline": right[name]})
    return reasons


class Engine:
    def __init__(self, request, output_dir):
        self.request = request
        self.output_dir = Path(local_path(output_dir)).resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        # The service supplies an unlisted private staging directory. Evidence files
        # remain in output_dir; transient databases must not appear as deliverables.
        self.work_dir = Path(local_path(request.get("workDir") or self.output_dir)).resolve()
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="download-verification-", dir=self.work_dir)
        self.db = sqlite3.connect(local_path(Path(self.temp.name) / "index.sqlite"))
        self.db.execute("PRAGMA temp_store=FILE")
        self.db.execute("PRAGMA cache_size=-8192")
        self.db.execute("CREATE TABLE records (id INTEGER PRIMARY KEY, side TEXT, file_id INTEGER, row_no INTEGER, line_no INTEGER, key_text TEXT, year TEXT, payload TEXT, unit TEXT, element TEXT)")
        self.issues = []
        self.limitations = []
        self.profiles = {}
        self.prefix = "verification-" + uuid.uuid4().hex[:12]
        self.evidence_files = []
        self.samples = []

    def close(self):
        self.db.close()
        self.temp.cleanup()

    def evidence(self, name):
        path = self.output_dir / (self.prefix + "-" + name + ".jsonl")
        self.evidence_files.append({"name": path.name, "path": str(path), "kind": name})
        return path.open("x", encoding="utf-8", newline="\n")

    def write_difference(self, handle, value):
        handle.write(compact(value) + "\n")
        if len(self.samples) < SAMPLE_LIMIT:
            self.samples.append(value)

    def read_csv(self, path, spec, dataset, side, file_id, profile):
        keys = requested_keys(dataset, self.request)
        year_column = dataset.get("yearColumn", self.request.get("yearColumn"))
        delimiter = spec.get("delimiter") or dataset.get("delimiter") or ("\t" if path.suffix.lower() == ".tsv" else ",")
        if not isinstance(delimiter, str) or len(delimiter) != 1:
            raise ValueError("CSV 分隔符必须是一个字符")
        encoding = spec.get("encoding") or dataset.get("encoding")
        if not encoding:
            with path.open("rb") as raw:
                bom = raw.read(4)
            encoding = "utf-16" if bom.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
        profile.update({"format": "tsv" if delimiter == "\t" else "csv", "encoding": encoding,
                        "checks": ["file-bytes", "sha256", "complete-csv-parse"], "contentChecked": True})
        rows = 0
        plan_mismatches = 0
        mismatch_samples = []
        mismatch_output = None
        self.db.execute("SAVEPOINT current_file")
        try:
            with path.open(encoding=encoding, newline="") as text:
                reader = csv.reader(text, delimiter=delimiter, strict=True)
                header = next(reader, None)
                if not header:
                    raise ValueError("文件为空或没有表头")
                if len(header) > 10000:
                    raise ValueError("字段数超过 10000，未继续解析")
                if len(set(header)) != len(header) or any(not name.strip() for name in header):
                    raise ValueError("存在重复或空白列名")
                missing_keys = [name for name in keys if name not in header]
                if missing_keys:
                    raise ValueError("缺少已确认的记录键字段：" + ", ".join(missing_keys))
                if year_column and year_column not in header:
                    raise ValueError("缺少指定年份字段：" + year_column)
                if year_column is None and "Year" in header:
                    year_column = "Year"
                profile.update({"columns": header, "keyColumns": keys, "yearColumn": year_column,
                                "rowCount": 0, "status": "passed"})
                expected_years = {str(y) for y in ((dataset.get("config") or {}).get("years") or [])}
                plan_conditions = []
                unchecked_filters = []
                if is_fao(dataset):
                    configured = (dataset.get("config") or {}).get("filters") or {}
                    resolved = ((dataset.get("result") or {}).get("resolvedConfig") or {}).get("filters") or configured
                    for name, values in configured.items():
                        if not values:
                            continue
                        column = FAO_FILTER_COLUMNS.get(name)
                        accepted = values
                        names = name.endswith("Names")
                        if name in FAO_NAME_COLUMNS:
                            code_name, column = FAO_NAME_COLUMNS[name]
                            if resolved.get(code_name):
                                column, accepted, names = FAO_FILTER_COLUMNS[code_name], resolved[code_name], False
                        elif name == "elementNames" and resolved.get("elementCodes"):
                            column, accepted, names = "Element Code", resolved["elementCodes"], False
                        if column not in header:
                            unchecked_filters.append(name)
                        else:
                            accepted = {normalized_name(NAME_ALIASES.get(str(v), str(v))) if names else str(v) for v in accepted}
                            plan_conditions.append((name, column, accepted, names))
                    if unchecked_filters:
                        profile["uncheckedFilters"] = unchecked_filters
                        self.issues.append(issue("filter-check-incomplete", "缺少核对筛选条件所需的字段，需确认范围。",
                                                 {"side": side, "file": profile["name"], "filters": unchecked_filters},
                                                 {"columns": header}, "补充官方代码对应或包含筛选字段的文件；不将未检查项标记通过。"))
                for record_no, row in enumerate(reader, 1):
                    if len(row) != len(header):
                        raise ValueError(f"CSV 第 {reader.line_num} 行字段数量不符；未跳过该行")
                    cells = dict(zip(header, row))
                    if keys and any(cells[name] == "" for name in keys):
                        raise ValueError(f"CSV 第 {reader.line_num} 行记录键为空；未猜测补齐")
                    year = cells[year_column] if year_column else ""
                    if is_fao(dataset) and (len(year) != 4 or not year.isascii() or not year.isdigit()):
                        raise ValueError(f"CSV 第 {reader.line_num} 行 FAOSTAT 年份不合法")
                    violations = []
                    if is_fao(dataset):
                        if expected_years and year not in expected_years:
                            violations.append("years")
                        for name, column, accepted, names in plan_conditions:
                            actual = normalized_name(cells[column]) if names else cells[column]
                            if actual not in accepted:
                                violations.append(name)
                    if violations:
                        plan_mismatches += 1
                        entry = {"side": side, "file": profile["name"], "record": record_no,
                                 "line": reader.line_num, "violations": violations, "values": cells}
                        if mismatch_output is None:
                            mismatch_output = self.evidence(side + "-file-" + str(file_id) + "-plan-mismatches")
                        mismatch_output.write(compact(entry) + "\n")
                        if len(mismatch_samples) < SAMPLE_LIMIT:
                            mismatch_samples.append(entry)
                    self.db.execute("INSERT INTO records(side,file_id,row_no,line_no,key_text,year,payload,unit,element) VALUES(?,?,?,?,?,?,?,?,?)",
                                    (side, file_id, record_no, reader.line_num,
                                     compact([cells[name] for name in keys]) if keys else "", year,
                                     compact(cells), cells.get("Unit", ""), cells.get("Element Code", "")))
                    rows += 1
            if rows == 0:
                raise ValueError("文件只有表头，没有数据记录")
            self.db.execute("RELEASE current_file")
            profile.update({"rowCount": rows, "rows": rows, "planMismatchRows": plan_mismatches})
            profile["emptyYearRows"] = self.db.execute("SELECT count(*) FROM records WHERE side=? AND file_id=? AND year=''", (side, file_id)).fetchone()[0] if year_column else 0
            if plan_mismatches:
                self.issues.append(issue("rows-outside-plan", "文件中存在不符合已定年份或筛选条件的记录，需重新获取正确范围。",
                                         {"side": side, "file": profile["name"], "rows": plan_mismatches},
                                         {"samples": mismatch_samples, "artifact": self.evidence_files[-1]},
                                         "退回重取或明确更正方案；本次不自动删除越界记录。", "error"))
        except (ValueError, csv.Error, UnicodeError, LookupError, OSError):
            self.db.execute("ROLLBACK TO current_file")
            self.db.execute("RELEASE current_file")
            profile.update({"status": "failed", "contentChecked": False, "rowCount": 0,
                            "rowsReadBeforeFailure": rows})
            raise
        finally:
            if mismatch_output is not None:
                mismatch_output.close()

    def basic_file(self, path, profile):
        suffix = path.suffix.lower()
        with path.open("rb") as handle:
            prefix = handle.read(1024)
        profile.update({"contentChecked": False, "status": "limited", "checks": ["file-bytes", "sha256"]})
        if suffix == ".pdf":
            profile["format"] = "pdf"
            if not prefix.lstrip().startswith(b"%PDF-"):
                raise ValueError("PDF 扩展名与文件签名不符，可能保存了网页或错误页")
            profile["checks"].append("pdf-signature")
            profile["limitation"] = "仅核对 PDF 文件签名，未检查全文、页数、文献对应关系或附件完整性。"
        elif suffix in (".zip", ".xlsx", ".docx"):
            profile["format"] = suffix[1:]
            with zipfile.ZipFile(path) as archive:
                members = archive.infolist()
                if not members:
                    raise ValueError("压缩容器为空")
                if suffix == ".xlsx" and "xl/workbook.xml" not in archive.namelist():
                    raise ValueError("XLSX 容器缺少工作簿")
                if suffix == ".docx" and "word/document.xml" not in archive.namelist():
                    raise ValueError("DOCX 容器缺少正文文档")
                profile["members"] = len(members)
            profile["checks"].append("zip-directory")
            profile["limitation"] = "仅检查容器目录，未逐成员复核 CRC，也未解析其中的数据内容。"
        elif suffix == ".json":
            profile["format"] = "json"
            if profile["size"] <= MAX_JSON_PARSE:
                with path.open(encoding="utf-8-sig") as handle:
                    value = json.load(handle)
                profile.update({"jsonType": type(value).__name__, "contentChecked": False})
                profile["checks"].append("json-syntax")
                profile["limitation"] = "已检查 JSON 语法，未确认数据模式、记录键、业务含义或更新差异。"
            else:
                profile["limitation"] = "JSON 超过 16 MiB，本次仅检查文件字节与校验值，未完整解析。"
        else:
            profile["format"] = suffix[1:] or "unknown"
            profile["limitation"] = "该格式未实现内容解析，本次只记录文件大小与 SHA-256。"

    def profile_dataset(self, dataset, side):
        files = dataset.get("files")
        if not isinstance(files, list) or len(files) > 10000:
            raise ValueError(side + ".files 必须是文件列表（最多 10000 项）")
        result = {"files": [], "rowCount": 0, "scope": scope_of(dataset),
                  "keyColumns": requested_keys(dataset, self.request), "years": [], "yearCounts": {},
                  "columns": [], "csvFiles": 0, "failedFiles": 0, "limitedFiles": 0}
        for file_id, spec in enumerate(files):
            if not isinstance(spec, dict) or not isinstance(spec.get("path"), str):
                raise ValueError("每项文件需提供 path")
            path = Path(local_path(spec["path"])).resolve()
            profile = {"name": spec.get("name") or path.name, "path": str(path), "fileId": file_id}
            try:
                if not path.is_file():
                    raise ValueError("文件不存在或不是普通文件")
                profile["size"] = path.stat().st_size
                if profile["size"] == 0:
                    raise ValueError("文件为空")
                profile["sha256"] = file_sha(path)
                if spec.get("sha256") and str(spec["sha256"]).lower() != profile["sha256"]:
                    raise ValueError("实际 SHA-256 与已有下载记录不一致")
                if path.suffix.lower() in (".csv", ".tsv"):
                    self.read_csv(path, spec, dataset, side, file_id, profile)
                    result["csvFiles"] += 1
                    result["rowCount"] += profile["rowCount"]
                    if not result["columns"]:
                        result["columns"] = list(profile["columns"])
                    elif set(result["columns"]) != set(profile["columns"]):
                        result["inconsistentSchemas"] = True
                else:
                    self.basic_file(path, profile)
                    result["limitedFiles"] += 1
                    self.limitations.append({"side": side, "file": profile["name"], "message": profile["limitation"]})
            except (ValueError, OSError, UnicodeError, csv.Error, LookupError, zipfile.BadZipFile, json.JSONDecodeError) as error:
                profile.update({"status": "failed", "contentChecked": False, "error": str(error)})
                result["failedFiles"] += 1
                self.issues.append(issue("file-check-failed", "该文件检查未通过，是否重新获取或提供正确文件？",
                                         {"side": side, "file": profile["name"]}, {"path": str(path), "error": str(error)},
                                         "先核实来源及文件，再重新获取；本次不覆盖原件。", "error"))
            result["files"].append(profile)
            if profile.get("contentChecked") and profile.get("format") in ("csv", "tsv"):
                years = list(self.db.execute("SELECT year,count(*) FROM records WHERE side=? AND file_id=? AND year<>'' GROUP BY year ORDER BY year LIMIT 10001", (side, file_id)))
                profile["years"] = [year for year, _ in years[:10000]]
                profile["yearCounts"] = dict(years[:10000])
                profile["yearProfileComplete"] = len(years) <= 10000
                profile["units"] = [{"elementCode": element, "unit": unit, "rows": count} for element, unit, count in
                                    self.db.execute("SELECT element,unit,count(*) FROM records WHERE side=? AND file_id=? GROUP BY element,unit ORDER BY element,unit LIMIT 10", (side, file_id))]
        self.db.commit()
        result["rows"] = result["rowCount"]
        result["emptyYearRows"] = sum(file.get("emptyYearRows", 0) for file in result["files"])
        if result["emptyYearRows"]:
            self.issues.append(issue("year-values-missing", "有记录的年份为空，无法完整核对时间范围。",
                                     {"side": side, "rows": result["emptyYearRows"]},
                                     {"files": [{"name": file["name"], "emptyYearRows": file["emptyYearRows"]} for file in result["files"] if file.get("emptyYearRows")]},
                                     "核对年份字段或补取源数据；不把未知年份记录静默排除后宣称全部可比。"))
        years = list(self.db.execute("SELECT year,count(*) FROM records WHERE side=? AND year<>'' GROUP BY year ORDER BY year LIMIT 10001", (side,)))
        result["yearProfileComplete"] = len(years) <= 10000
        for year, count in years[:10000]:
            result["years"].append(year)
            result["yearCounts"][year] = count
        unit_count = self.db.execute("SELECT count(*) FROM (SELECT element,unit FROM records WHERE side=? GROUP BY element,unit)", (side,)).fetchone()[0]
        result["units"] = {"distinctElementUnitPairs": unit_count, "samples": []}
        with self.evidence(side + "-unit-counts") as output:
            for element, unit, count in self.db.execute("SELECT element,unit,count(*) FROM records WHERE side=? GROUP BY element,unit ORDER BY element,unit", (side,)):
                entry = {"elementCode": element, "unit": unit, "rows": count}
                output.write(compact(entry) + "\n")
                if len(result["units"]["samples"]) < SAMPLE_LIMIT:
                    result["units"]["samples"].append(entry)
        expected = (dataset.get("config") or {}).get("years")
        if side == "current" and isinstance(expected, list) and result["csvFiles"]:
            absent = sorted(set(str(y) for y in expected) - set(result["years"]))
            if absent:
                self.issues.append(issue("requested-years-missing", "本次要求的年份仍有缺口，是否接受部分数据？",
                                         {"years": absent}, {"requestedYears": expected, "actualYearCounts": result["yearCounts"]},
                                         "先补取缺失年份；仍无数据时请决定接受缺口或调整来源。"))
        if result.get("inconsistentSchemas"):
            self.issues.append(issue("mixed-csv-schema", "同批 CSV 的字段结构不一致，需确认是否应作为同一数据集比较。",
                                     {"side": side}, {"files": [{"name": f["name"], "columns": f.get("columns")} for f in result["files"]]},
                                     "按一致的数据模式分组比较，或先确认字段对应关系。"))
        if not result["yearProfileComplete"]:
            self.issues.append(issue("year-profile-limit", "年份字段出现超过 10000 个不同值，尚未完成覆盖比较。",
                                     {"side": side}, {"limit": 10000}, "核实年份字段定义；未将未完成检查标记通过。", "error"))
        self.profiles[side] = result
        return result

    def row_evidence(self, record_id):
        row = self.db.execute("SELECT side,file_id,row_no,line_no,payload FROM records WHERE id=?", (record_id,)).fetchone()
        profile = self.profiles[row[0]]["files"][row[1]]
        return {"file": profile["name"], "path": profile["path"], "record": row[2], "line": row[3], "values": json.loads(row[4])}

    def compare(self, current, baseline):
        pcur = self.profiles["current"]
        summary = {"added": 0, "removed": 0, "revised": 0, "unchanged": 0,
                   "schemaChanges": 0, "unitChanges": 0, "duplicateKeys": 0,
                   "ambiguousCurrentRows": 0, "ambiguousBaselineRows": 0}
        report = {"status": "first-acquisition", "comparable": False, "method": None,
                  "reasons": [], "summary": summary, "coverage": {}, "schema": {}}
        if baseline is None:
            report["reasons"].append("没有历史基线，这是首次获取；不要求人工重复审核全部数据。")
            return report
        pold = self.profiles["baseline"]
        reasons = scope_reasons(current, baseline)
        if reasons:
            report.update({"status": "incomparable", "reasons": reasons})
            self.issues.append(issue("scope-not-comparable", "新旧来源或非年份筛选条件不同，是否需要按相同范围重新比较？",
                                     {"comparison": "current/baseline"}, {"scopeDifferences": reasons},
                                     "先统一来源与筛选范围，再判断历史修订和删除；不将范围变化误报为数据删除。"))
            return report
        if pcur["failedFiles"] or pold["failedFiles"] or pcur.get("inconsistentSchemas") or pold.get("inconsistentSchemas") or not pcur["yearProfileComplete"] or not pold["yearProfileComplete"] or pcur["emptyYearRows"] or pold["emptyYearRows"]:
            report.update({"status": "blocked", "reasons": ["存在未通过文件检查或不同结构的 CSV，未用部分成功记录推断整批差异。"]})
            return report
        if not pcur["csvFiles"] or not pold["csvFiles"]:
            report.update({"status": "unsupported", "reasons": ["缺少可完整解析的 CSV/TSV；仅完成文件基础检查，未做记录级更新比较。"]})
            self.issues.append(issue("comparison-unsupported", "该文件格式尚不能自动比较内容，需选择可比的表格或由人确认变化。",
                                     {"currentFormats": [x.get("format") for x in pcur["files"]],
                                      "baselineFormats": [x.get("format") for x in pold["files"]]},
                                     {"supported": ["csv", "tsv"]}, "提供 CSV/TSV 及已确认的记录键，或保留格式交人工专项核查。"))
            return report
        keys = pcur["keyColumns"]
        if keys != pold["keyColumns"]:
            report.update({"status": "incomparable", "reasons": ["新旧记录键定义不同，未猜测对应。"]})
            self.issues.append(issue("key-definition-changed", "新旧记录键不同，请确认统一的键。", {},
                                     {"currentKeys": keys, "baselineKeys": pold["keyColumns"]}, "提供同一组已确认键后重新比较。"))
            return report
        ccols, bcols = set(pcur["columns"]), set(pold["columns"])
        added_cols, removed_cols = sorted(ccols - bcols), sorted(bcols - ccols)
        report["schema"] = {"addedColumns": added_cols, "removedColumns": removed_cols,
                            "orderChanged": not added_cols and not removed_cols and pcur["columns"] != pold["columns"]}
        summary["schemaChanges"] = len(added_cols) + len(removed_cols)
        if summary["schemaChanges"]:
            self.issues.append(issue("schema-changed", "新版字段有增减，是否仍满足模型输入要求？", report["schema"],
                                     {"currentColumns": pcur["columns"], "baselineColumns": pold["columns"]},
                                     "确认新增字段用途及缺失字段的替代方式；原件和历史版本保留。"))
        cyears, byears = set(pcur["years"]), set(pold["years"])
        has_years = bool(cyears and byears)
        common = sorted(cyears & byears)
        report["coverage"] = {"commonYears": common, "addedYears": sorted(cyears - byears),
                              "missingYears": sorted(byears - cyears),
                              "addedYearRows": sum(pcur["yearCounts"][year] for year in cyears - byears),
                              "missingYearRows": sum(pold["yearCounts"][year] for year in byears - cyears),
                              "comparisonRestrictedToCommonYears": has_years}
        if byears - cyears:
            self.issues.append(issue("coverage-reduced", "新版不包含部分旧年份，是否符合本次方案？",
                                     {"years": sorted(byears - cyears)}, report["coverage"],
                                     "核对本次年份范围；缺失年份不计作逐条删除，必要时补取。"))
        if bool(cyears) != bool(byears):
            report.update({"status": "incomparable", "reasons": ["只有一侧能识别年份，不能安全限定共同年份。"]})
            self.issues.append(issue("year-definition-changed", "新旧年份字段定义不同，需确认对应关系。", {},
                                     {"currentYears": sorted(cyears), "baselineYears": sorted(byears)},
                                     "为两侧提供相同的 yearColumn 后重新比较。"))
            return report
        if has_years and not common:
            report.update({"status": "no-overlap", "reasons": ["新旧年份无交集，只记录覆盖变化，不推断历史修订或删除。"]})
            return report
        if not keys and (added_cols or removed_cols):
            report.update({"status": "incomparable", "reasons": ["无已确认键且字段增减，完整行无法同口径比较；未将所有记录误报为新增/删除。"]})
            return report
        report.update({"comparable": True, "status": "compared", "method": "confirmed-key" if keys else "full-row-multiset"})
        if not keys:
            self.limitations.append({"message": "未提供已确认记录键；只比较完整行多重集的新增/缺失，不能识别哪一条是历史修订。"})
        where, params = "", []
        if has_years:
            where = " WHERE year IN (" + ",".join("?" for _ in common) + ")"
            params = common
        self.db.execute("CREATE INDEX record_side_key ON records(side,key_text)")
        if keys:
            self.compare_keys(report, where, params, sorted(ccols & bcols))
        else:
            self.compare_multiset(report, where, params)
        return report

    def compare_keys(self, report, where, params, shared_columns):
        summary = report["summary"]
        self.db.execute("CREATE TABLE groups AS SELECT side,key_text,count(*) AS n,min(id) AS representative FROM records" + where + " GROUP BY side,key_text", params)
        self.db.execute("CREATE UNIQUE INDEX grouped_key ON groups(side,key_text)")
        self.db.execute("CREATE TABLE ambiguous AS SELECT key_text FROM groups GROUP BY key_text HAVING max(n)>1")
        self.db.execute("CREATE UNIQUE INDEX ambiguous_key ON ambiguous(key_text)")
        summary["duplicateKeys"] = self.db.execute("SELECT count(*) FROM ambiguous").fetchone()[0]
        if summary["duplicateKeys"]:
            with self.evidence("ambiguous-keys") as output:
                for record_id, in self.db.execute("SELECT r.id FROM records r JOIN ambiguous a ON a.key_text=r.key_text" + where + " ORDER BY r.key_text,r.side,r.id", params):
                    evidence = self.row_evidence(record_id)
                    side = self.db.execute("SELECT side FROM records WHERE id=?", (record_id,)).fetchone()[0]
                    summary["ambiguousCurrentRows" if side == "current" else "ambiguousBaselineRows"] += 1
                    output.write(compact({"side": side, **evidence}) + "\n")
            self.issues.append(issue("duplicate-record-key", "同一记录键出现多行，需确认区分字段，不能自动配对判定修订。",
                                     {"keys": summary["duplicateKeys"], "currentRows": summary["ambiguousCurrentRows"], "baselineRows": summary["ambiguousBaselineRows"]},
                                     {"evidenceFile": self.evidence_files[-1]}, "确认是否缺少记录维度；本次保留所有重复行，不去重、不随意配对。"))
        sql = """SELECT c.representative,b.representative,cr.payload,br.payload FROM groups c LEFT JOIN groups b
                 ON b.side='baseline' AND b.key_text=c.key_text
                 JOIN records cr ON cr.id=c.representative LEFT JOIN records br ON br.id=b.representative
                 WHERE c.side='current' AND NOT EXISTS(SELECT 1 FROM ambiguous a WHERE a.key_text=c.key_text)
                 UNION ALL SELECT NULL,b.representative,NULL,NULL FROM groups b
                 WHERE b.side='baseline' AND NOT EXISTS(SELECT 1 FROM groups c WHERE c.side='current' AND c.key_text=b.key_text)
                 AND NOT EXISTS(SELECT 1 FROM ambiguous a WHERE a.key_text=b.key_text)"""
        with self.evidence("differences") as output:
            for cur_id, old_id, current_payload, old_payload in self.db.execute(sql):
                if cur_id is None:
                    summary["removed"] += 1
                    self.write_difference(output, {"type": "removed", "baseline": self.row_evidence(old_id)})
                elif old_id is None:
                    summary["added"] += 1
                    self.write_difference(output, {"type": "added", "current": self.row_evidence(cur_id)})
                elif current_payload == old_payload:
                    summary["unchanged"] += 1
                else:
                    cur, old = self.row_evidence(cur_id), self.row_evidence(old_id)
                    changed = [column for column in shared_columns if cur["values"][column] != old["values"][column]]
                    if changed:
                        summary["revised"] += 1
                        if "Unit" in changed:
                            summary["unitChanges"] += 1
                        self.write_difference(output, {"type": "revised", "changedColumns": changed, "current": cur, "baseline": old})
                    else:
                        summary["unchanged"] += 1

    def compare_multiset(self, report, where, params):
        self.db.execute("CREATE TABLE multisets AS SELECT side,payload,count(*) AS n,min(id) AS representative FROM records" + where + " GROUP BY side,payload", params)
        self.db.execute("CREATE UNIQUE INDEX multiset_payload ON multisets(side,payload)")
        sql = """SELECT c.n,coalesce(b.n,0),c.representative,b.representative FROM multisets c
                 LEFT JOIN multisets b ON b.side='baseline' AND b.payload=c.payload WHERE c.side='current'
                 UNION ALL SELECT 0,b.n,NULL,b.representative FROM multisets b
                 WHERE b.side='baseline' AND NOT EXISTS(SELECT 1 FROM multisets c WHERE c.side='current' AND c.payload=b.payload)"""
        with self.evidence("differences") as output:
            for ncur, nold, cur_id, old_id in self.db.execute(sql):
                report["summary"]["unchanged"] += min(ncur, nold)
                if ncur > nold:
                    report["summary"]["added"] += ncur - nold
                    self.write_difference(output, {"type": "added", "count": ncur - nold, "current": self.row_evidence(cur_id)})
                elif nold > ncur:
                    report["summary"]["removed"] += nold - ncur
                    self.write_difference(output, {"type": "removed", "count": nold - ncur, "baseline": self.row_evidence(old_id)})

    def run(self):
        current, baseline = self.request.get("current"), self.request.get("baseline")
        if not isinstance(current, dict) or (baseline is not None and not isinstance(baseline, dict)):
            raise ValueError("current 必须是数据集，baseline 必须是数据集或 null")
        self.profile_dataset(current, "current")
        professional_checks = run_professional_rules(self, current, self.profiles["current"])
        if baseline is not None:
            self.profile_dataset(baseline, "baseline")
        comparison = self.compare(current, baseline)
        summary = comparison["summary"]
        if comparison["comparable"]:
            if self.profiles["current"]["keyColumns"] and (summary["revised"] or summary["removed"] or summary["unitChanges"]):
                self.issues.append(issue("historical-data-changed", "共同覆盖范围内存在历史修订、缺失记录或单位变化，是否采用新版？",
                                         {key: summary[key] for key in ("revised", "removed", "unitChanges")},
                                         {"samples": self.samples, "evidenceFiles": [x for x in self.evidence_files if x["kind"] == "differences"]},
                                         "先核对官方修订说明及差异样例；确认后采用新版，历史原件保留。"))
            elif summary["removed"] and not self.profiles["current"]["keyColumns"]:
                self.issues.append(issue("unkeyed-records-changed", "完整行有新增或缺失，但没有记录键，需确认是新增记录还是历史修改。",
                                         {"added": summary["added"], "removed": summary["removed"]},
                                         {"samples": self.samples, "method": comparison["method"]},
                                         "若需精确区分新增、删除和修订，提供已确认键；本次不猜测行的对应关系。"))
        if not self.profiles["current"]["files"]:
            self.issues.append(issue("no-current-files", "尚无可检查的数据文件。", {}, {}, "先取得文件后再核验。", "error"))
        return {"schema": 1, "profile": self.profiles, "comparison": comparison,
                "issues": self.issues, "samples": self.samples, "professionalChecks": professional_checks,
                "evidenceFiles": self.evidence_files, "limitations": self.limitations,
                "sourceFilesUnmodified": True,
                "method": "仅离线读取文件。原始单元格文本逐字比较；不换算、不插补、不去重，不判定科学阈值。"}


def verify_download(request, output_dir=None):
    directory = output_dir or request.get("outputDir")
    if not directory:
        raise ValueError("需要 outputDir，保存完整差异依据")
    csv.field_size_limit(1024 * 1024)
    engine = Engine(request, directory)
    try:
        return engine.run()
    finally:
        engine.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    request = json.loads(Path(local_path(args.request)).read_text(encoding="utf-8-sig"))
    output = Path(local_path(args.output)).resolve()
    protected = {Path(local_path(args.request)).resolve()}
    for side in ("current", "baseline"):
        for entry in (request.get(side) or {}).get("files", []):
            if isinstance(entry, dict) and isinstance(entry.get("path"), str):
                protected.add(Path(local_path(entry["path"])).resolve())
    if output in protected:
        raise ValueError("核验报告不能覆盖输入文件")
    result = verify_download(request, request.get("outputDir") or output.parent)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp-" + uuid.uuid4().hex[:12])
    try:
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()
    print(json.dumps({"status": "completed", "issues": len(result["issues"]), "comparison": result["comparison"]["status"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
