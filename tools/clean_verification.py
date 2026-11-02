"""Independently verify cleaning outputs offline, without executing cleaning code.

CSV/TSV rows and provenance claims are indexed on disk. Original inputs and
outputs are read only; reports record all observed changes and unresolved cases.
"""
import argparse
import csv
import hashlib
import importlib.util
import json
import os
import sqlite3
import tempfile
from decimal import Decimal, localcontext
from pathlib import Path


_spec = importlib.util.spec_from_file_location("clean_download_rules", Path(__file__).with_name("download_professional_rules.py"))
_rules = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rules)
decimal_value = _rules.decimal_value
SAMPLE_LIMIT = 10
ACTIONS = {"keep", "transform", "exclude", "duplicate", "pending", "merge", "split"}
DUPLICATE_FIRST_QUERY = "SELECT MIN(row_no) FROM records WHERE side='input' AND file_id=? AND payload=?"
A_PRESERVE_ADAPTER = "fbsh80-a-preserve-v1"
A_PRESERVE_COLUMNS = ["Area Code", "Area Code (M49)", "Area", "Item Code", "Item Code (FBS)", "Item",
                      "Element Code", "Element", "Year Code", "Year", "Unit", "Value", "Flag"]


def compact(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def local_path(value):
    value = os.path.normpath(os.path.abspath(os.fspath(value)))
    if os.name == "nt" and not value.startswith("\\\\?\\"):
        return "\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value
    return value


def file_sha(filename):
    value = hashlib.sha256()
    with open(local_path(filename), "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


class PostconditionAdapter:
    """Reuse the real confirmed-rule scanner against cleaned rows only."""
    def __init__(self, parent):
        self.parent = parent
        self.db = parent.db
        self.issues = []
        self.evidence_files = []

    def evidence(self, name):
        filename = name + ".jsonl"
        location = os.path.join(self.parent.output_dir, filename)
        self.evidence_files.append({"name": filename, "path": location, "kind": "professional-rule"})
        self.parent.artifacts.append({"name": filename, "label": "输出条件核验依据"})
        return open(local_path(location), "w", encoding="utf-8", newline="\n")

    def row_evidence(self, record_id):
        row = self.db.execute("SELECT file_id,row_no,line_no,payload FROM records WHERE id=?", (record_id,)).fetchone()
        descriptor = self.parent.files_by_id[row[0]]
        return {"file": descriptor["name"], "record": row[1], "line": row[2], "values": json.loads(row[3])}


class CleanVerifier:
    def __init__(self, request):
        self.request = request
        self.output_dir = local_path(request["outputDir"])
        os.makedirs(self.output_dir, exist_ok=True)
        work_dir = local_path(request.get("workDir") or self.output_dir)
        os.makedirs(work_dir, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="clean-check-", dir=work_dir)
        self.db = sqlite3.connect(local_path(os.path.join(self.temp.name, "records.sqlite")))
        self.db.executescript("""
          CREATE TABLE records(id INTEGER PRIMARY KEY, side TEXT, file_id INTEGER, row_no INTEGER, line_no INTEGER, payload TEXT,
                               UNIQUE(side,file_id,row_no));
          CREATE INDEX records_file_idx ON records(side,file_id,row_no);
          CREATE INDEX records_duplicate_first_idx ON records(side,file_id,payload,row_no) WHERE side='input';
          CREATE TABLE claims(side TEXT,file_id INTEGER,row_no INTEGER,event_no INTEGER,action TEXT,cleaned_target INTEGER,
                              UNIQUE(side,file_id,row_no));
          CREATE TABLE duplicate_refs(event_no INTEGER,file_id INTEGER,row_no INTEGER);
        """)
        self.issues = {}
        self.artifacts = [{"name": "changes.jsonl", "label": "实际改值及规则依据"},
                          {"name": "verification-evidence.jsonl", "label": "全部核验问题及位置"}]
        self.evidence_stream = open(local_path(os.path.join(self.output_dir, "verification-evidence.jsonl")), "w", encoding="utf-8", newline="\n")
        self.changes_stream = open(local_path(os.path.join(self.output_dir, "changes.jsonl")), "w", encoding="utf-8", newline="\n")
        self.files = {}
        self.files_by_id = {}
        self.summary = {"inputRows": 0, "cleanedRows": 0, "pendingRows": 0, "duplicateRows": 0, "excludedRows": 0,
                        "changedCells": 0, "verifiedCells": 0, "unverifiedCells": 0, "lineageEvents": 0,
                        "mergedEvents": 0, "splitEvents": 0}
        self.value_rules = []
        self.duplicate_policies = []
        self.value_checks = []
        self.post_checks = []
        self.adapter_checks = []

    def problem(self, code, severity, title, detail, rule_id=None, recommendation=None):
        key = (code, rule_id)
        entry = {"code": code, "severity": severity, "title": title, "detail": detail}
        if rule_id:
            entry["ruleId"] = rule_id
        self.evidence_stream.write(compact(entry) + "\n")
        if key not in self.issues:
            self.issues[key] = {"code": code, "severity": severity, "title": title, "impact": {"occurrences": 0}, "evidence": [],
                                "recommendation": recommendation or ("修正文件、对应关系或明确规则后重新核验；保留原始文件。" if severity == "error" else "核对原值与方案依据；确认处理办法或例外并留下理由。"),
                                "attempts": ["已独立读取原始数据、结果与已确认规则进行核对；未执行或重跑清洗代码。"]}
            if rule_id:
                self.issues[key]["ruleId"] = rule_id
        issue = self.issues[key]
        issue["impact"]["occurrences"] += 1
        if severity == "error":
            issue["severity"] = "error"
        if len(issue["evidence"]) < SAMPLE_LIMIT:
            issue["evidence"].append({"label": "核验位置与依据", "detail": detail if isinstance(detail, str) else compact(detail)})

    def register_files(self, descriptors, side):
        if not isinstance(descriptors, list) or not descriptors:
            self.problem("files-missing", "error", "缺少原始数据或清洗结果", {"side": side})
            return
        for descriptor in descriptors:
            if not isinstance(descriptor, dict) or not isinstance(descriptor.get("name"), str) or not descriptor["name"]:
                self.problem("file-descriptor-invalid", "error", "文件清单格式不正确", {"side": side})
                continue
            name = descriptor["name"]
            if (side, name) in self.files:
                self.problem("file-name-duplicate", "error", "本次文件名称重复", {"file": name, "side": side})
                continue
            role = "input" if side == "input" else descriptor.get("role")
            if role not in ("input", "cleaned", "pending"):
                self.problem("file-role-invalid", "error", "结果文件用途不明确", {"file": name, "role": role})
                role = "unknown"
            item = {"name": name, "fileId": len(self.files_by_id) + 1, "role": role, "format": Path(name).suffix.lower().lstrip("."),
                    "status": "failed", "contentChecked": False, "columns": [], "rowCount": 0}
            self.files[(side, name)] = item
            self.files_by_id[item["fileId"]] = item
            try:
                location = local_path(descriptor["path"])
                if not os.path.isfile(location):
                    raise ValueError("文件不存在或不是普通文件")
                actual_size, actual_sha = os.path.getsize(location), file_sha(location)
                item.update(size=actual_size, sha256=actual_sha)
                if descriptor.get("size") is not None and descriptor["size"] != actual_size:
                    raise ValueError("实际文件大小与冻结清单不一致")
                if descriptor.get("sha256") is not None and descriptor["sha256"] != actual_sha:
                    raise ValueError("实际文件SHA-256与冻结清单不一致")
                if item["format"] not in ("csv", "tsv"):
                    item.update(status="limited", limitation="本版仅完整解析CSV/TSV，当前格式仅核对文件与哈希")
                    self.problem("format-unverified", "warning", "部分格式尚不能逐记录核验", {"file": name, "format": item["format"]})
                    continue
                self.db.execute("SAVEPOINT read_file")
                try:
                    with open(location, "r", encoding="utf-8-sig", newline="") as stream:
                        reader = csv.reader(stream, delimiter="\t" if item["format"] == "tsv" else ",", strict=True)
                        header = next(reader, None)
                        if not header or any(not cell for cell in header) or len(set(header)) != len(header):
                            raise ValueError("表头缺失、空白或字段名重复")
                        item["columns"] = header
                        count = 0
                        for row in reader:
                            if not row:
                                continue
                            if len(row) != len(header):
                                raise ValueError("逻辑记录字段数不等于表头：物理行" + str(reader.line_num))
                            count += 1
                            self.db.execute("INSERT INTO records(side,file_id,row_no,line_no,payload) VALUES(?,?,?,?,?)",
                                            (side if side == "input" else "current", item["fileId"], count, reader.line_num, compact(dict(zip(header, row)))))
                    self.db.execute("RELEASE read_file")
                except Exception:
                    self.db.execute("ROLLBACK TO read_file")
                    self.db.execute("RELEASE read_file")
                    raise
                item.update(status="passed", contentChecked=True, rowCount=count)
                if role in ("input", "cleaned", "pending"):
                    self.summary[role + "Rows"] += count
            except (OSError, ValueError, UnicodeError, csv.Error, KeyError, TypeError) as error:
                item["error"] = str(error)
                self.problem("file-unreadable", "error", "文件无法完整核对", {"file": name, "side": side, "reason": str(error)})
        self.db.commit()

    def compile_value_rules(self):
        plan = self.request.get("plan")
        config = plan.get("valueRules") if isinstance(plan, dict) else None
        if not isinstance(config, dict) or config.get("schema") != 1 or not isinstance(config.get("rules"), list):
            self.problem("value-rules-unspecified", "warning", "改值与换算规则尚未明确", "未把清洗程序声明的成功当作专业规则已经通过。")
            return
        ids = set()
        for index, raw in enumerate(config["rules"], 1):
            rule = dict(raw) if isinstance(raw, dict) else {}
            rule_id = rule.get("id") or "value-rule-" + str(index)
            try:
                if not isinstance(rule_id, str) or rule_id in ids:
                    raise ValueError("规则编号为空或重复")
                ids.add(rule_id)
                if rule.get("kind") not in ("copy", "trim", "map", "affine", "duplicate"):
                    raise ValueError(rule.get("reason") or "该方法需要专业判断，尚不能自动复算")
                if not isinstance(rule.get("basis"), str) or not rule["basis"].strip():
                    raise ValueError("规则缺少已确认依据")
                rule["id"] = rule_id
                if rule["kind"] == "duplicate":
                    if rule.get("columns") not in ("*", ["*"]) or rule.get("keep") != "first" or rule.get("when") != {}:
                        raise ValueError("自动去重目前只支持已确认：全部原字段完全相同，同原文件内保留最早记录，适用全部")
                    self.duplicate_policies.append(rule)
                    continue
                for field in ("inputColumn", "outputColumn"):
                    if not isinstance(rule.get(field), str) or not rule[field]:
                        raise ValueError("规则缺少准确的输入或输出字段")
                when = rule.get("when", {})
                if not isinstance(when, dict) or any(not isinstance(key, str) or not key or not isinstance(values, list) or not values or any(not isinstance(value, str) for value in values) for key, values in when.items()):
                    raise ValueError("适用条件必须为准确字段名和非空文本值列表")
                rule["when"] = when
                if rule["kind"] == "map" and (not isinstance(rule.get("mapping"), dict) or not rule["mapping"] or any(not isinstance(key, str) or not isinstance(value, str) for key, value in rule["mapping"].items())):
                    raise ValueError("映射表必须明确列出原文本与目标文本")
                if rule["kind"] == "affine":
                    rule["_factor"] = decimal_value(rule["factor"])
                    rule["_offset"] = decimal_value(rule.get("offset", "0"))
                    rule["_tolerance"] = decimal_value(rule.get("absoluteTolerance", "0"))
                    if rule["_tolerance"] < 0:
                        raise ValueError("允许误差不能为负数")
                rule.update(_matched=0, _checked=0, _failed=0, _undetermined=0)
                self.value_rules.append(rule)
            except (ValueError, KeyError, TypeError) as error:
                self.problem("value-rule-manual", "warning", "部分规则尚不能自动复算", {"rule": raw, "reason": str(error)}, str(rule_id))

    def resolve(self, reference, side, event_no):
        if not isinstance(reference, dict) or not isinstance(reference.get("file"), str) or type(reference.get("record")) is not int or reference["record"] < 1:
            self.problem("lineage-reference-invalid", "error", "对应关系的记录引用不正确", {"event": event_no, "side": side, "reference": reference})
            return None
        descriptor = self.files.get((side, reference["file"]))
        if not descriptor:
            self.problem("lineage-file-missing", "error", "对应关系引用本批不存在的文件", {"event": event_no, "side": side, "reference": reference})
            return None
        row = self.db.execute("SELECT id,payload FROM records WHERE side=? AND file_id=? AND row_no=?",
                              ("input" if side == "input" else "current", descriptor["fileId"], reference["record"])).fetchone()
        if not row:
            if descriptor["contentChecked"]:
                self.problem("lineage-record-missing", "error", "对应关系引用不存在的记录", {"event": event_no, "side": side, "reference": reference})
            else:
                self.problem("lineage-format-undetermined", "warning", "文件未完整解析，无法核对记录引用", {"event": event_no, "reference": reference})
            return None
        return {"ref": reference, "file": descriptor, "id": row[0], "values": json.loads(row[1])}

    def claim(self, row, side, event_no, action, has_cleaned):
        try:
            self.db.execute("INSERT INTO claims VALUES(?,?,?,?,?,?)", (side, row["file"]["fileId"], row["ref"]["record"], event_no, action, int(has_cleaned)))
        except sqlite3.IntegrityError:
            self.problem("lineage-duplicate-claim", "error", "同一记录被多次归属", {"event": event_no, "side": side, "reference": row["ref"]})

    def change(self, source, target, column, before, after, rules, status):
        self.summary["changedCells"] += 1
        self.changes_stream.write(compact({"source": source["ref"], "target": target["ref"], "column": column,
                                          "before": before, "after": after, "status": status,
                                          "inputValues": {rule["inputColumn"]: source["values"].get(rule["inputColumn"]) for rule in rules},
                                          "rules": [{"id": rule["id"], "basis": rule["basis"], "inputColumn": rule["inputColumn"], "outputColumn": rule["outputColumn"], "sourceText": rule.get("sourceText", "")} for rule in rules]}) + "\n")

    def compare_one(self, source, target, event):
        original, result = source["values"], target["values"]
        if target["file"]["role"] == "pending":
            for column in original.keys() | result.keys():
                if original.get(column) != result.get(column):
                    self.change(source, target, column, original.get(column), result.get(column), [], "pending")
                    if column in original:
                        self.problem("pending-value-changed", "warning", "待处理记录的原值也发生变化", {"source": source["ref"], "target": target["ref"], "column": column, "before": original[column], "after": result.get(column)})
            return
        by_target = {}
        for rule in self.value_rules:
            missing = [key for key in rule["when"] if key not in original]
            if missing:
                self.problem("value-rule-condition-missing", "error", "原始数据缺少规则适用条件字段", {"source": source["ref"], "missingColumns": missing}, rule["id"])
                continue
            if not all(original[key] in accepted for key, accepted in rule["when"].items()):
                continue
            rule["_matched"] += 1
            if rule["inputColumn"] not in original:
                self.problem("value-rule-input-missing", "error", "原始数据缺少规则声明字段", {"source": source["ref"], "column": rule["inputColumn"]}, rule["id"])
                continue
            if rule["outputColumn"] not in result:
                self.problem("value-rule-output-missing", "error", "结果缺少已声明的目标字段", {"target": target["ref"], "column": rule["outputColumn"]}, rule["id"])
                continue
            by_target.setdefault(rule["outputColumn"], []).append(rule)
        for column, after in result.items():
            before = original.get(column)
            applicable = by_target.get(column, [])
            verified = True
            if applicable:
                for rule in applicable:
                    raw = original[rule["inputColumn"]]
                    try:
                        if rule["kind"] == "copy":
                            expected, equal = raw, after == raw
                        elif rule["kind"] == "trim":
                            expected, equal = raw.strip(), after == raw.strip()
                        elif rule["kind"] == "map":
                            if raw not in rule["mapping"]:
                                raise ValueError("原文本不在已确认映射表中")
                            expected = rule["mapping"][raw]
                            equal = after == expected
                        else:
                            value = decimal_value(raw)
                            try:
                                actual = decimal_value(after)
                            except ValueError:
                                verified = False
                                rule["_checked"] += 1
                                rule["_failed"] += 1
                                self.problem("value-result-wrong", "error", "实际结果不是规则要求的有效数值", {"source": source["ref"], "target": target["ref"], "column": column, "original": raw, "actual": after, "basis": rule["basis"]}, rule["id"])
                                continue
                            precision = max(64, len(raw) + len(str(rule["_factor"])) + len(str(rule["_offset"])) + len(after) + 16)
                            with localcontext() as context:
                                context.prec = precision
                                expected = value * rule["_factor"] + rule["_offset"]
                                equal = abs(actual - expected) <= rule["_tolerance"]
                            expected = str(expected)
                        rule["_checked"] += 1
                        if not equal:
                            verified = False
                            rule["_failed"] += 1
                            self.problem("value-result-wrong", "error", "实际结果不符合已确认规则", {"source": source["ref"], "target": target["ref"], "inputColumn": rule["inputColumn"], "column": column, "original": raw, "actual": after, "expected": expected, "basis": rule["basis"]}, rule["id"])
                    except (ValueError, ArithmeticError) as error:
                        verified = False
                        rule["_undetermined"] += 1
                        self.problem("value-result-undetermined", "warning", "部分原值不能按确认规则复算", {"source": source["ref"], "target": target["ref"], "column": column, "original": raw, "actual": after, "reason": str(error), "basis": rule["basis"]}, rule["id"])
            elif column == "source_row":
                try:
                    verified = decimal_value(after) == source["ref"]["record"]
                except ValueError:
                    verified = False
                if not verified:
                    self.problem("source-row-wrong", "error", "结果记录的原始行号不正确", {"source": source["ref"], "target": target["ref"], "actual": after})
            elif column in original and before == after:
                self.summary["verifiedCells"] += 1
                continue
            else:
                verified = False
                self.problem("value-change-unexplained", "warning", "实际改值或新增字段缺少可复算规则", {"source": source["ref"], "target": target["ref"], "column": column, "before": before, "after": after, "declaredRuleIds": event.get("ruleIds", [])})
            self.summary["verifiedCells" if verified else "unverifiedCells"] += 1
            if column not in original or before != after:
                self.change(source, target, column, before, after, applicable, "verified" if verified else "unresolved")
        mapped = {rule["inputColumn"] for rules in by_target.values() for rule in rules}
        for column in original.keys() - result.keys() - mapped:
            self.change(source, target, column, original[column], None, [], "unresolved")
            self.summary["unverifiedCells"] += 1
            self.problem("column-removal-unexplained", "warning", "原字段被移除但缺少明确处理依据", {"source": source["ref"], "target": target["ref"], "column": column, "original": original[column]})

    def lineage(self):
        location = self.request.get("lineagePath")
        if not location:
            self.problem("lineage-missing", "error", "缺少逐条去向文件", "未将前后总行数相等当作去向完整的依据。")
            return
        try:
            with open(local_path(location), "r", encoding="utf-8-sig") as stream:
                for line_no, text in enumerate(stream, 1):
                    if not text.strip():
                        continue
                    try:
                        event = json.loads(text)
                        if not isinstance(event, dict) or event.get("action") not in ACTIONS or not isinstance(event.get("sources"), list) or not event["sources"] or not isinstance(event.get("targets"), list):
                            raise ValueError("事件必须明确操作及非空原始记录列表和结果列表")
                        if not isinstance(event.get("ruleIds", []), list) or any(not isinstance(item, str) for item in event.get("ruleIds", [])):
                            raise ValueError("规则编号应为文本列表")
                    except (ValueError, TypeError) as error:
                        self.problem("lineage-event-invalid", "error", "逐条去向文件的事件不正确", {"line": line_no, "reason": str(error)})
                        continue
                    self.summary["lineageEvents"] += 1
                    action = event["action"]
                    sources = [self.resolve(item, "input", line_no) for item in event["sources"]]
                    targets = [self.resolve(item, "output", line_no) for item in event["targets"]]
                    valid = all(item is not None for item in sources + targets)
                    sources, targets = [item for item in sources if item], [item for item in targets if item]
                    has_cleaned = any(row["file"]["role"] == "cleaned" for row in targets)
                    for row in sources:
                        self.claim(row, "input", line_no, action, has_cleaned)
                    for row in targets:
                        self.claim(row, "output", line_no, action, has_cleaned)
                    shape = (len(event["sources"]), len(event["targets"]))
                    shape_ok = ((action in ("keep", "transform", "pending") and shape == (1, 1)) or
                                (action in ("exclude", "duplicate") and shape[0] >= 1 and shape[1] == 0) or
                                (action == "merge" and shape[0] >= 2 and shape[1] >= 1) or
                                (action == "split" and shape[0] == 1 and shape[1] >= 2))
                    if not shape_ok:
                        self.problem("lineage-action-shape", "error", "操作类型与记录对应方式不符", {"line": line_no, "action": action, "sourceCount": shape[0], "targetCount": shape[1]})
                    if not valid or not shape_ok:
                        continue
                    if action == "pending":
                        if any(row["file"]["role"] != "pending" for row in targets):
                            self.problem("pending-role-wrong", "error", "待处理记录被放入主结果", {"line": line_no, "targets": event["targets"]})
                        else:
                            self.problem("pending-records", "warning", "有记录等待研究者决定", {"source": event["sources"], "target": event["targets"], "reason": event.get("reason") or "未注明原因", "ruleIds": event.get("ruleIds", [])})
                            self.compare_one(sources[0], targets[0], event)
                    elif any(row["file"]["role"] != "cleaned" for row in targets):
                        self.problem("cleaned-role-wrong", "error", "主结果操作的目标用途不正确", {"line": line_no, "action": action, "targets": event["targets"]})
                    elif action == "exclude":
                        self.summary["excludedRows"] += len(sources)
                        self.problem("excluded-records", "warning", "有记录被排除，需要核对依据", {"sources": event["sources"], "reason": event.get("reason") or "未注明依据", "ruleIds": event.get("ruleIds", [])})
                    elif action == "duplicate":
                        self.summary["duplicateRows"] += len(sources)
                        policies = [rule for rule in self.duplicate_policies if rule["id"] in event.get("ruleIds", [])]
                        if not policies:
                            self.problem("duplicate-policy-unconfirmed", "warning", "去重判据或本次引用尚未确认", {"sources": event["sources"], "ruleIds": event.get("ruleIds", []), "reason": "即使原始整行完全相同，也不能替代研究者确认允许去重及保留方式。"})
                        retained = self.resolve(event.get("retainedSource"), "input", line_no)
                        if retained:
                            self.db.execute("INSERT INTO duplicate_refs VALUES(?,?,?)", (line_no, retained["file"]["fileId"], retained["ref"]["record"]))
                            if any(row["id"] == retained["id"] for row in sources):
                                self.problem("duplicate-self-reference", "error", "重复记录引用了自身作为保留记录", {"line": line_no, "retainedSource": retained["ref"]})
                            for row in sources:
                                if row["values"] != retained["values"]:
                                    self.problem("duplicate-not-identical", "warning", "去重记录并非原始整行完全相同", {"source": row["ref"], "retainedSource": retained["ref"], "original": row["values"], "retainedValues": retained["values"], "reason": event.get("reason") or "业务判据未独立验证"})
                                elif policies and row["file"]["fileId"] != retained["file"]["fileId"]:
                                    self.problem("duplicate-policy-scope-unverified", "warning", "跨原文件去重超出已确认策略的自动核验范围", {"source": row["ref"], "retainedSource": retained["ref"], "basis": policies[0]["basis"]})
                                elif policies:
                                    earliest = self.db.execute(DUPLICATE_FIRST_QUERY, (row["file"]["fileId"], compact(row["values"]))).fetchone()[0]
                                    if retained["ref"]["record"] != earliest:
                                        self.problem("duplicate-retained-not-first", "error", "去重未保留方案要求的最早原始记录", {"source": row["ref"], "retainedSource": retained["ref"], "expectedFirstRecord": earliest, "basis": policies[0]["basis"]}, policies[0]["id"])
                    elif action in ("merge", "split"):
                        self.summary["mergedEvents" if action == "merge" else "splitEvents"] += 1
                        self.problem("aggregate-semantics-unverified", "warning", "合并或拆分的专业计算尚需核对", {"action": action, "sources": event["sources"], "targets": event["targets"], "reason": event.get("reason", ""), "ruleIds": event.get("ruleIds", [])})
                        self.changes_stream.write(compact({"type": "multi-row-transformation", "action": action, "status": "unresolved", "ruleIds": event.get("ruleIds", []), "reason": event.get("reason", ""),
                                                          "before": [{"source": row["ref"], "values": row["values"]} for row in sources],
                                                          "after": [{"target": row["ref"], "values": row["values"]} for row in targets]}) + "\n")
                    else:
                        self.compare_one(sources[0], targets[0], event)
        except (OSError, UnicodeError) as error:
            self.problem("lineage-unreadable", "error", "逐条去向文件无法读取", str(error))
        self.db.commit()
        for event, file_id, row_no in self.db.execute("SELECT event_no,file_id,row_no FROM duplicate_refs"):
            claim = self.db.execute("SELECT cleaned_target,action FROM claims WHERE side='input' AND file_id=? AND row_no=?", (file_id, row_no)).fetchone()
            if not claim or not claim[0] or claim[1] not in ("keep", "transform", "merge", "split"):
                self.problem("duplicate-retained-not-kept", "error", "去重后没有有效保留记录", {"line": event, "retainedSource": {"file": self.files_by_id[file_id]["name"], "record": row_no}})

    def coverage(self):
        query = """SELECT r.side,r.file_id,r.row_no FROM records r LEFT JOIN claims c
                   ON c.side=CASE WHEN r.side='input' THEN 'input' ELSE 'output' END AND c.file_id=r.file_id AND c.row_no=r.row_no
                   WHERE c.file_id IS NULL ORDER BY r.id"""
        for side, file_id, row_no in self.db.execute(query):
            code, title = ("input-without-destination", "原始记录没有交代去向") if side == "input" else ("output-without-source", "结果记录没有原始来源")
            self.problem(code, "error", title, {"file": self.files_by_id[file_id]["name"], "record": row_no})

    def postconditions(self):
        plan = self.request.get("plan")
        config = plan.get("checks") if isinstance(plan, dict) else None
        if not isinstance(config, dict) or config.get("schema") != 1 or not isinstance(config.get("rules"), list):
            self.problem("postconditions-unspecified", "warning", "清洗验收条件尚未明确", "基础追溯检查不能代替本项目的专业验收条件。")
            return
        adapter = PostconditionAdapter(self)
        profile = {"files": [item for (side, name), item in self.files.items() if side == "output" and item["role"] == "cleaned"]}
        self.post_checks = _rules.run_professional_rules(adapter, {"professionalRules": config}, profile)
        for issue in adapter.issues:
            evidence = issue.get("evidence", {})
            self.problem(issue["code"], "warning", issue["question"], evidence, issue.get("ruleId"), issue.get("recommendation"))

    def verify_a_preservation(self):
        """Exact, offline checks for the explicitly frozen FBSH80 A adapter.

        This does not expand other plans or infer a cleaning policy. It never
        edits data, treats a duplicate as permission to delete it, interprets
        Flags/stock signs, or signs the separate H1-H3 human standards.
        """
        plan = self.request.get("plan")
        if not isinstance(plan, dict) or plan.get("executionAdapter") != A_PRESERVE_ADAPTER:
            return
        evidence_name = "fbsh80-a-preservation.jsonl"
        self.artifacts.append({"name": evidence_name, "label": "A规则逐格保真与类型核验依据"})
        self.summary.update(aPreserveRowsCompared=0, aPreserveCellsCompared=0, aPreserveMismatchCells=0,
                            aPreserveNewEmptyCells=0, aPreserveTypeFailures=0, aPreserveCodeNameConflicts=0,
                            aPreserveFullDuplicateGroups=0, aPreserveBusinessDuplicateGroups=0)
        with open(local_path(os.path.join(self.output_dir, evidence_name)), "w", encoding="utf-8", newline="\n") as stream:
            def emit(kind, **values):
                stream.write(compact({"adapter": A_PRESERVE_ADAPTER, "type": kind, **values}) + "\n")

            def check(rule_id, label, failures, **counts):
                value = {"id": rule_id, "label": label, "status": "failed" if failures else "passed",
                         "failedRows": failures, "evidenceFile": evidence_name, **counts}
                self.adapter_checks.append(value)
                emit("check", **value)

            inputs = [item for (side, _), item in self.files.items() if side == "input"]
            outputs = [item for (side, _), item in self.files.items() if side == "output"]
            shape_ok = len(inputs) == 1 and len(outputs) == 1 and outputs[0]["role"] == "cleaned"
            if not shape_ok:
                detail = {"inputFiles": [item["name"] for item in inputs],
                          "outputFiles": [{"name": item["name"], "role": item["role"]} for item in outputs]}
                self.problem("a-preserve-shape", "error", "A规则要求单输入和单一清洗主表", detail)
                emit("shape-error", **detail)
                check("a-preserve-shape", "A规则文件及原13列、80条范围", 1)
                return
            source, target = inputs[0], outputs[0]
            bad_schema = [item for item in (source, target) if not item["contentChecked"] or item["status"] != "passed"
                          or item["columns"] != A_PRESERVE_COLUMNS or item["rowCount"] != 80]
            for item in bad_schema:
                detail = {"file": item["name"], "actualColumns": item["columns"], "expectedColumns": A_PRESERVE_COLUMNS,
                          "actualRows": item["rowCount"], "expectedRows": 80, "contentChecked": item["contentChecked"]}
                self.problem("a-preserve-schema", "error", "A规则原13列顺序或80条范围不一致", detail)
                emit("schema-error", **detail)
            check("a-preserve-shape", "A规则文件及原13列、80条范围", len(bad_schema))
            if bad_schema:
                return

            def rows(item):
                return [(record, json.loads(payload)) for record, payload in self.db.execute(
                    "SELECT row_no,payload FROM records WHERE file_id=? ORDER BY row_no", (item["fileId"],))]

            original_rows, result_rows = rows(source), rows(target)
            mismatch_rows = 0
            for (original_no, original), (result_no, result) in zip(original_rows, result_rows):
                self.summary["aPreserveRowsCompared"] += 1
                mismatches = []
                for column in A_PRESERVE_COLUMNS:
                    before, after = original[column], result[column]
                    self.summary["aPreserveCellsCompared"] += 1
                    if before != after:
                        self.summary["aPreserveMismatchCells"] += 1
                        mismatches.append({"column": column, "before": before, "after": after})
                        if before != "" and after == "":
                            self.summary["aPreserveNewEmptyCells"] += 1
                            self.problem("a-preserve-new-empty", "error", "A规则不允许新增空值",
                                         {"record": result_no, "column": column, "before": before})
                emit("row-comparison", source={"file": source["name"], "record": original_no},
                     target={"file": target["name"], "record": result_no}, comparedCells=len(A_PRESERVE_COLUMNS),
                     sameTextAndPosition=not mismatches, mismatches=mismatches)
                if mismatches:
                    mismatch_rows += 1
                    self.problem("a-preserve-cell-mismatch", "error", "A规则原文或记录顺序发生改变",
                                 {"sourceRecord": original_no, "targetRecord": result_no, "mismatches": mismatches})
            check("a-preserve-content", "80条记录原顺序及1040格原文逐格核对", mismatch_rows,
                  checkedRows=self.summary["aPreserveRowsCompared"], checkedCells=self.summary["aPreserveCellsCompared"])

            pairs = [("Area Code", "Area"), ("Area Code (M49)", "Area"), ("Item Code", "Item"),
                     ("Item Code (FBS)", "Item"), ("Element Code", "Element")]
            business_columns = ["Area Code (M49)", "Item Code", "Element Code", "Year"]
            type_failures = 0
            code_conflicts = 0
            for side, item, actual_rows in [("input", source, original_rows), ("output", target, result_rows)]:
                mappings = {pair: {} for pair in pairs}
                full_groups, key_groups = {}, {}
                for record, values in actual_rows:
                    detail = {"side": side, "file": item["name"], "record": record}
                    try:
                        year_code, year = int(values["Year Code"]), int(values["Year"])
                        if year_code != year or year != 1992:
                            raise ValueError("Year Code与Year须为一致的整数1992")
                        decimal_value(values["Value"])
                        emit("types", **detail, status="passed", yearCode=values["Year Code"], year=values["Year"], value=values["Value"])
                    except (ValueError, ArithmeticError) as error:
                        type_failures += 1
                        self.problem("a-preserve-type", "error", "A规则年份或Value无法按指定类型核对",
                                     {**detail, "yearCode": values["Year Code"], "year": values["Year"], "value": values["Value"], "reason": str(error)})
                        emit("types", **detail, status="failed", reason=str(error))
                    for code_column, name_column in pairs:
                        code, name = values[code_column], values[name_column]
                        previous = mappings[(code_column, name_column)].get(code)
                        if previous and previous["name"] != name:
                            code_conflicts += 1
                            conflict = {**detail, "codeColumn": code_column, "nameColumn": name_column, "code": code,
                                        "firstRecord": previous["record"], "firstName": previous["name"], "actualName": name}
                            self.problem("a-preserve-code-name", "error", "A规则发现同代码名称冲突", conflict)
                            emit("code-name-conflict", **conflict)
                        else:
                            mappings[(code_column, name_column)].setdefault(code, {"name": name, "record": record})
                    full_groups.setdefault(tuple(values[column] for column in A_PRESERVE_COLUMNS), []).append(record)
                    key_groups.setdefault(tuple(values[column] for column in business_columns), []).append(record)
                full_duplicates = [records for records in full_groups.values() if len(records) > 1]
                key_duplicates = [records for records in key_groups.values() if len(records) > 1]
                if side == "input":
                    self.summary["aPreserveFullDuplicateGroups"] = len(full_duplicates)
                    self.summary["aPreserveBusinessDuplicateGroups"] = len(key_duplicates)
                emit("duplicates-report-only", side=side, file=item["name"], fullRowGroups=full_duplicates,
                     businessKeyColumns=business_columns, businessKeyGroups=key_duplicates,
                     policy="仅报告，全部原始记录仍须原位置保留，重复不构成删除授权")
                emit("code-name-scan", side=side, file=item["name"], checkedRows=len(actual_rows),
                     pairs=[{"codeColumn": pair[0], "nameColumn": pair[1]} for pair in pairs])
            self.summary["aPreserveTypeFailures"] = type_failures
            self.summary["aPreserveCodeNameConflicts"] = code_conflicts
            check("a-preserve-types", "Year整数一致及Value有限十进制解析", type_failures, checkedRows=160)
            check("a-preserve-code-names", "各代码与名称逐条对应检查", code_conflicts, checkedRows=160)
            check("a-preserve-duplicates", "全行与业务键重复扫描（只报告、不删除）", 0, checkedRows=160,
                  fullDuplicateGroups=self.summary["aPreserveFullDuplicateGroups"],
                  businessDuplicateGroups=self.summary["aPreserveBusinessDuplicateGroups"])

    def finish_value_checks(self):
        for rule in self.value_rules:
            if not rule["_matched"] or not rule["_checked"]:
                self.problem("value-rule-not-executed", "warning", "已声明规则在本批没有实际完成核验", {"ruleId": rule["id"], "matchedRows": rule["_matched"], "checkedRows": rule["_checked"], "when": rule["when"], "basis": rule["basis"], "reason": "没有匹配或可复算的主结果记录；未将未执行规则标为通过。"}, rule["id"])
            self.value_checks.append({"id": "value-rule-" + rule["id"], "label": rule["id"] + " · " + rule["kind"] + "独立核验",
                                      "status": "failed" if rule["_failed"] else "needs_decision" if not rule["_checked"] or rule["_undetermined"] else "passed",
                                      "matchedRows": rule["_matched"], "checkedRows": rule["_checked"], "failedRows": rule["_failed"], "undeterminedRows": rule["_undetermined"], "basis": rule["basis"]})

    def run(self):
        try:
            if self.request.get("schema") != 1:
                self.problem("request-schema", "error", "核验请求版本不支持", {"schema": self.request.get("schema")})
            plan = self.request.get("plan")
            if not isinstance(plan, dict) or not isinstance(plan.get("text"), str) or not plan["text"].strip() or not isinstance(plan.get("sha256"), str) or hashlib.sha256(plan["text"].encode("utf-8")).hexdigest() != plan["sha256"]:
                self.problem("plan-hash-wrong", "error", "冻结方案缺失或版本不匹配", "不能用清洗程序自己声明的方案代替冻结规则。")
            self.register_files(self.request.get("inputs"), "input")
            self.register_files(self.request.get("outputs"), "output")
            if not any(item["role"] == "cleaned" for item in self.files_by_id.values()):
                self.problem("cleaned-output-missing", "error", "没有明确的清洗主结果", "待处理清单和说明文件不能冒充清洗结果。")
            self.compile_value_rules()
            self.lineage()
            self.coverage()
            self.postconditions()
            self.verify_a_preservation()
            self.finish_value_checks()
            issues = list(self.issues.values())
            for item in issues:
                item["evidence"].append({"label": "完整核验依据", "detail": "全部异常位置已保存，页面仅展示前10项样例。", "artifact": {"name": "verification-evidence.jsonl", "label": "全部核验问题及位置"}})
            self.summary["blockingIssues"] = sum(item["severity"] == "error" for item in issues)
            self.summary["decisionIssues"] = sum(item["severity"] != "error" for item in issues)
            checks = [{"id": "files", "label": "实际文件及冻结版本", "status": "failed" if any(item["code"].startswith(("file-", "files-", "plan-")) and item["severity"] == "error" for item in issues) else "limited" if any(item["code"] == "format-unverified" for item in issues) else "passed"},
                      {"id": "lineage", "label": "逐记录去向及结果来源", "status": "failed" if any(item["code"].startswith(("lineage-", "input-without", "output-without", "duplicate-retained", "duplicate-self", "pending-role", "cleaned-role")) and item["severity"] == "error" for item in issues) else "limited" if any(item["code"] == "format-unverified" for item in issues) else "passed"},
                      {"id": "values", "label": "原值对照与规则独立复算", "status": "failed" if any(item["severity"] == "error" and item["code"].startswith(("value-", "source-row")) for item in issues) else "limited" if any(item["code"] in ("format-unverified", "lineage-format-undetermined") for item in issues) else "needs_decision" if any(item["code"].startswith(("value-", "aggregate-", "column-removal")) for item in issues) else "passed"}]
            checks.extend(self.value_checks)
            checks.extend(self.adapter_checks)
            checks.extend({"id": "postcondition-" + item["id"], "label": item["label"], "status": item["status"],
                           "checkedRows": item["checkedRows"], "failedRows": item["failedRows"], "basis": item["basis"], "reason": item.get("reason", "")}
                          for item in self.post_checks)
            return {"schema": 1, "checks": checks, "professionalChecks": self.post_checks, "issues": issues, "summary": self.summary, "artifacts": self.artifacts,
                    "limitations": ["逐记录核验支持UTF-8 CSV/TSV；其他格式仅核对文件完整性并列待处理。", "合并/拆分仅核对来源与去向，业务公式未自动判定通过。", "未执行原清洗代码，也未修改输入或结果文件。"]}
        finally:
            self.changes_stream.close()
            self.evidence_stream.close()
            self.db.close()
            self.temp.cleanup()


def verify_cleaning(request):
    return CleanVerifier(request).run()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    with open(local_path(args.request), "r", encoding="utf-8-sig") as handle:
        request = json.load(handle)
    result = verify_cleaning(request)
    with open(local_path(args.output), "w", encoding="utf-8", newline="\n") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
