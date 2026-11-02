"""Execute confirmed download rules offline against the verification SQLite index.

Rules compare original cell text. They never fetch, edit, fill, convert or delete
source data. Unknown rules and incomplete coverage remain human decisions.
"""
import json
import re
from decimal import Decimal, InvalidOperation


KINDS = {"required_columns", "not_empty", "allowed_values", "numeric_range", "unique_key", "row_count"}
DECIMAL_TEXT = re.compile(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")
SAMPLE_LIMIT = 10


def compact(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def decimal_value(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ValueError("不是可核对的十进制数值")
    original = str(value).strip()
    if not original or not DECIMAL_TEXT.fullmatch(original):
        raise ValueError("空白、非数值或非有限数值，不能判断数值范围")
    try:
        parsed = Decimal(original)
    except InvalidOperation as error:
        raise ValueError("数值无法按十进制解析") from error
    if not parsed.is_finite():
        raise ValueError("非有限数值，不能判断数值范围")
    return parsed


def text_list(value, label):
    if not isinstance(value, list) or not value or any(not isinstance(v, str) for v in value):
        raise ValueError(label + "必须是非空文本列表")
    if len(set(value)) != len(value):
        raise ValueError(label + "存在重复项")
    return value


def validate_rule(rule):
    if not isinstance(rule, dict):
        raise ValueError("规则不是结构化对象，需补充可执行条件")
    kind = rule.get("kind")
    if not isinstance(kind, str) or kind not in KINDS:
        raise ValueError(rule.get("reason") or "该规则需要专业判断，尚不能自动执行")
    if not isinstance(rule.get("basis"), str) or not rule["basis"].strip():
        raise ValueError("规则未注明已确认的专业依据，不能自行设定检查条件")
    columns = []
    if kind in ("required_columns", "unique_key"):
        columns = text_list(rule.get("columns"), "字段名")
        if any(not item.strip() for item in columns):
            raise ValueError("字段名不能为空")
    elif kind in ("not_empty", "allowed_values", "numeric_range"):
        if not isinstance(rule.get("column"), str) or not rule["column"].strip():
            raise ValueError("需确认一个准确字段名，不能猜测对应关系")
        columns = [rule["column"]]
    if kind == "allowed_values":
        text_list(rule.get("allowed"), "允许值")
    bounds = {}
    if kind in ("numeric_range", "row_count"):
        if "min" not in rule and "max" not in rule:
            raise ValueError("未确认上下限，不能自行设定合理范围")
        for key in ("min", "max"):
            if key in rule:
                bounds[key] = decimal_value(rule[key])
                if kind == "row_count" and (bounds[key] < 0 or bounds[key] != bounds[key].to_integral_value()):
                    raise ValueError("记录数限制必须是非负整数")
        if "min" in bounds and "max" in bounds and bounds["min"] > bounds["max"]:
            raise ValueError("规则下限大于上限，需更正规则")
    when = rule.get("when", {})
    if not isinstance(when, dict):
        raise ValueError("适用条件必须是字段名与允许文本列表，不能猜测条件")
    for column, allowed in when.items():
        if not isinstance(column, str) or not column.strip():
            raise ValueError("适用条件字段名不能为空")
        text_list(allowed, "适用条件允许值")
    return columns, when, bounds


def run_professional_rules(engine, dataset, profile):
    """Return checks, appending unresolved issues/evidence to the parent engine.

    required_columns checks each delivered table. unique_key is unique over the
    entire current batch, including rows in different files. Other row rules use
    AND across condition columns and exact-text OR within each allowed list.
    """
    config = dataset.get("professionalRules")
    if config is None:
        return []
    if not isinstance(config, dict) or type(config.get("schema")) is not int or config.get("schema") != 1 or not isinstance(config.get("rules"), list):
        rules = [{"id": "professional-rules-config", "label": "专业规则配置", "kind": "manual",
                  "reason": "专业规则配置格式或版本不支持，需确认后执行", "sourceText": str(config)}]
    else:
        rules = config["rules"]
    checks = []
    used_ids = set()
    for index, raw in enumerate(rules, 1):
        rule = raw if isinstance(raw, dict) else {"sourceText": str(raw)}
        candidate_id = rule.get("id")
        rule_id = candidate_id if isinstance(candidate_id, str) and candidate_id.strip() else "professional-rule-" + str(index)
        duplicate = rule_id in used_ids
        if duplicate:
            rule_id += "-duplicate-" + str(index)
        used_ids.add(rule_id)
        label = rule.get("label") if isinstance(rule.get("label"), str) and rule["label"].strip() else rule_id
        check = {"id": rule_id, "label": label, "kind": rule.get("kind", "manual"),
                 "status": "needs_decision", "checkedRows": 0, "failedRows": 0,
                 "basis": rule.get("basis", ""), "sourceText": rule.get("sourceText", ""), "samples": []}
        reasons = []
        evidence = engine.evidence("professional-rule-" + str(index))
        evidence_file = engine.evidence_files[-1]
        check["evidenceFile"] = evidence_file

        def emit(entry, reason=None):
            value = {"ruleId": rule_id, **entry}
            evidence.write(compact(value) + "\n")
            if len(check["samples"]) < SAMPLE_LIMIT:
                check["samples"].append(value)
            if reason and reason not in reasons:
                reasons.append(reason)

        try:
            evidence.write(compact({"type": "confirmed-rule", "ruleId": rule_id, "rule": rule}) + "\n")
            if duplicate:
                raise ValueError("规则编号重复，需确认唯一编号后执行")
            columns, when, bounds = validate_rule(raw)
            kind = rule["kind"]
            files = profile.get("files", [])
            complete = True
            if not files:
                complete = False
                emit({"type": "scope-unavailable", "detail": "本批没有数据文件"}, "没有可检查文件")
            if kind == "unique_key":
                engine.db.execute("DROP TABLE IF EXISTS professional_rule_keys")
                engine.db.execute("CREATE TEMP TABLE professional_rule_keys (key_text TEXT NOT NULL, record_id INTEGER NOT NULL)")
            for file in files:
                file_name, file_id = file.get("name"), file.get("fileId")
                if not file.get("contentChecked") or file.get("status") != "passed" or file.get("format") not in ("csv", "tsv"):
                    complete = False
                    emit({"type": "file-unavailable", "file": file_name, "detail": file.get("error") or file.get("limitation") or "文件内容未完整解析",
                          "format": file.get("format")}, "部分文件未完整解析，不能宣称整批符合专业规则")
                    continue
                needed = list(dict.fromkeys(columns + list(when)))
                missing = [name for name in needed if name not in file.get("columns", [])]
                if missing:
                    complete = False
                    emit({"type": "missing-columns", "file": file_name, "missingColumns": missing,
                          "actualColumns": file.get("columns", [])}, "缺少规则或适用条件所需字段")
                    continue
                cursor = engine.db.execute("SELECT id,row_no,line_no,payload FROM records WHERE side='current' AND file_id=? ORDER BY id", (file_id,))
                for record_id, row_no, line_no, payload in cursor:
                    values = json.loads(payload)
                    if not all(values[column] in accepted for column, accepted in when.items()):
                        continue
                    check["checkedRows"] += 1
                    location = {"file": file_name, "record": row_no, "line": line_no,
                                "values": {name: values[name] for name in needed}}
                    if kind in ("required_columns", "row_count"):
                        continue
                    if kind == "unique_key":
                        key = [values[column] for column in columns]
                        if any(not cell.strip() for cell in key):
                            check["failedRows"] += 1
                            emit({"type": "empty-key", **location}, "唯一键含空白值，无法完整判断唯一性")
                        else:
                            engine.db.execute("INSERT INTO professional_rule_keys VALUES(?,?)", (compact(key), record_id))
                        continue
                    actual = values[rule["column"]]
                    if kind == "not_empty" and not actual.strip():
                        check["failedRows"] += 1
                        emit({"type": "empty-value", **location}, "存在应填写但为空白的值")
                    elif kind == "allowed_values" and actual not in rule["allowed"]:
                        check["failedRows"] += 1
                        emit({"type": "disallowed-value", "allowed": rule["allowed"], **location}, "存在不在已确认允许值内的原值")
                    elif kind == "numeric_range":
                        try:
                            numeric = decimal_value(actual)
                        except ValueError as error:
                            check["failedRows"] += 1
                            emit({"type": "numeric-undetermined", "detail": str(error), **location}, "存在空白或非有限数值，不能判断范围")
                            continue
                        if ("min" in bounds and numeric < bounds["min"]) or ("max" in bounds and numeric > bounds["max"]):
                            check["failedRows"] += 1
                            emit({"type": "outside-range", "bounds": {key: str(value) for key, value in bounds.items()}, **location}, "存在超出已确认数值范围的原值")
            if check["checkedRows"] == 0:
                emit({"type": "scope-empty", "when": when, "matchedRows": 0}, "没有匹配适用条件的记录，未将零匹配当作通过")
            if kind == "row_count" and complete and check["checkedRows"]:
                count = check["checkedRows"]
                if ("min" in bounds and count < bounds["min"]) or ("max" in bounds and count > bounds["max"]):
                    check["failedRows"] = count
                    emit({"type": "row-count-outside-range", "actualRows": count, "bounds": {key: str(value) for key, value in bounds.items()},
                          "files": [file.get("name") for file in files]}, "匹配记录数超出已确认范围")
            if kind == "unique_key":
                engine.db.execute("CREATE INDEX professional_rule_keys_idx ON professional_rule_keys(key_text)")
                query = """SELECT k.record_id,k.key_text,n.n FROM professional_rule_keys k
                           JOIN (SELECT key_text,count(*) n FROM professional_rule_keys GROUP BY key_text HAVING count(*)>1) n
                           ON n.key_text=k.key_text ORDER BY k.record_id"""
                for record_id, key_text, count in engine.db.execute(query):
                    row = engine.row_evidence(record_id)
                    check["failedRows"] += 1
                    emit({"type": "duplicate-key", "key": json.loads(key_text), "occurrences": count, **row}, "同批记录键重复（包含跨文件重复）")
                engine.db.execute("DROP TABLE professional_rule_keys")
        except ValueError as error:
            emit({"type": "rule-undetermined", "detail": str(error), "sourceText": rule.get("sourceText", "")}, str(error))
        finally:
            if not reasons:
                check["status"] = "passed"
                check["reason"] = "已按确认规则核对本批全部适用记录；原值未修改"
            else:
                check["reason"] = "；".join(reasons)
            evidence.write(compact({"type": "rule-summary", "ruleId": rule_id, "status": check["status"],
                                    "checkedRows": check["checkedRows"], "failedRows": check["failedRows"], "reason": check["reason"]}) + "\n")
            evidence.close()
        if check["status"] != "passed":
            recommendation = "核对原值与专业依据；确认例外并说明理由，或更正规则/文件后重新核验。未自动修改数据或把例外改标通过。"
            engine.issues.append({"code": "professional-rule-" + rule_id, "ruleId": rule_id, "severity": "warning",
                                  "question": label + "：" + check["reason"], "requiresDecision": True,
                                  "affected": {"ruleId": rule_id, "checkedRows": check["checkedRows"], "failedRows": check["failedRows"]},
                                  "evidence": {"basis": check["basis"], "sourceText": check["sourceText"], "reason": check["reason"],
                                               "checkedRows": check["checkedRows"], "failedRows": check["failedRows"],
                                               "samples": check["samples"], "evidenceFile": evidence_file},
                                  "recommendation": recommendation})
        checks.append(check)
    return checks
