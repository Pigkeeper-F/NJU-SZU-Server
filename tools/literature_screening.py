"""Read-only screening contract and gates; no model, browser or network access."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import re

from literature_identity import digest
from literature_target_groups import expanded_target_groups
from literature_metadata import read_status as read_metadata, merge_record as merge_metadata, existing_abstract

VERSION = "title-abstract-screening-v1"
PAPER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
DECISIONS = {"include", "pending", "exclude"}


class ScreeningAttention(ValueError):
    pass


def _string(value):
    return value.strip() if isinstance(value, str) else ""


def _keywords(record):
    result = []
    for key in ("keywords", "author_keywords", "index_keywords", "metadata_keywords"):
        value = record.get(key) or []
        values = value if isinstance(value, list) else re.split(r"[;；|]", str(value))
        for entry in values:
            word = _string(entry)
            if word and word not in result:
                result.append(word)
    return result


def document(record):
    abstract = existing_abstract(record)
    result = {"source_id": _string(record.get("candidate_id")), "source_key": _string(record.get("source_key")),
              "title": _string(record.get("title")), "abstract": abstract, "keywords": _keywords(record)}
    if record.get("metadata_evidence"):
        result["metadata_evidence"] = record["metadata_evidence"]
    return result


def policy_identity(policy):
    if policy is None:
        return None
    if not isinstance(policy, dict):
        raise ScreeningAttention("篇关摘筛选规则结构无效，请先核对配置。")
    policy_id = _string(policy.get("id") or policy.get("policyId"))
    line = _string(policy.get("line"))
    if not policy_id or not line or not _string(policy.get("text") or policy.get("policyText")):
        raise ScreeningAttention("篇关摘筛选规则缺少id、line或完整text，请先完成规则配置。")
    return {"policyId": policy_id, "line": line, "policyHash": digest(policy)}


def load_inputs(job_dir):
    job = Path(job_dir)
    try:
        metadata = read_metadata(job)
    except (OSError, ValueError, TypeError) as error:
        raise ScreeningAttention("摘要回源证据文件不可核验，请检查 metadata/status.json。") from error
    path = job / "candidates.json"
    try:
        candidates = json.loads(path.read_text(encoding="utf-8"))
        records = candidates.get("records", candidates.get("results"))
        if not isinstance(records, list):
            raise ValueError("no records")
        records = [r for r in records if isinstance(r, dict)]
    except (OSError, ValueError, AttributeError) as error:
        raise ScreeningAttention("尚无可核验的候选题录，不能执行篇关摘筛选。") from error
    groups_path = job / "dedupe" / "dedupe.json"
    if groups_path.exists():
        try:
            report = json.loads(groups_path.read_text(encoding="utf-8"))
            file_hash = report.get("candidate_file_sha256")
            current = (file_hash == hashlib.sha256(path.read_bytes()).hexdigest()) if file_hash else report.get("candidate_input_hash") == digest(records)
            if not current:
                raise ScreeningAttention("候选题录已更新或去重版本未核验，请先重新去重，再执行篇关摘筛选。")
            groups = expanded_target_groups(report["groups"])
        except (OSError, ValueError, KeyError, TypeError) as error:
            if isinstance(error, ScreeningAttention):
                raise
            raise ScreeningAttention("去重结果不可核验，请先重新去重。") from error
    else:
        groups = [{"canonical_id": r.get("candidate_id"), "records": [r]} for r in records]
    result, seen = [], set()
    for group in groups:
        paper_id = _string(group.get("canonical_id"))
        if not PAPER_ID.fullmatch(paper_id) or paper_id in seen:
            raise ScreeningAttention("候选文献标识缺失或重复，请先核对去重结果。")
        seen.add(paper_id)
        documents = sorted([document(merge_metadata(r, metadata)) for r in group.get("records", []) if isinstance(r, dict)], key=lambda d: d["source_id"])
        if not documents:
            raise ScreeningAttention("候选文献没有篇关摘来源记录。")
        result.append({"paper_id": paper_id, "documents": documents})
    return result


def input_hash(bundle):
    return digest(bundle)


def select_inputs(bundles, paper_ids):
    """Validate an explicit batch without silently discarding unknown IDs."""
    if (not isinstance(paper_ids, list) or not paper_ids
            or any(not isinstance(key, str) or not PAPER_ID.fullmatch(key) for key in paper_ids)
            or len(set(paper_ids)) != len(paper_ids)):
        raise ScreeningAttention("篇关摘批次标识必须为非空、无重复的有效文献编号列表。")
    known = [bundle.get("paper_id") for bundle in bundles]
    if len(set(known)) != len(known) or any(key not in known for key in paper_ids):
        raise ScreeningAttention("篇关摘批次包含未知或重复文献，未执行获取。")
    selected = set(paper_ids)
    return [bundle for bundle in bundles if bundle["paper_id"] in selected]


def record_key(paper_id, policy, bundle):
    context = policy_identity(policy)
    return digest([paper_id, context["policyId"], context["line"], context["policyHash"], input_hash(bundle)])


def _quote_valid(entry, documents):
    if not isinstance(entry, dict) or entry.get("field") not in {"title", "abstract", "keywords"}:
        return False
    quote = _string(entry.get("quote"))
    if not quote:
        return False
    for source in documents:
        if source["source_id"] != entry.get("source_id"):
            continue
        value = source[entry["field"]]
        values = value if isinstance(value, list) else [value]
        return any(quote in part for part in values)
    return False


def _fulltext_reference_valid(job_dir, paper_id, reference):
    if not job_dir or not isinstance(reference, dict) or not _string(reference.get("pages")):
        return False
    from literature_fulltext_reuse import contained_file
    relative = _string(reference.get("path")).replace("\\", "/")
    file = contained_file(job_dir, relative)
    if file is None or not reference.get("sha256"):
        return False
    try:
        status = json.loads((Path(job_dir) / "fulltext/status.json").read_text(encoding="utf-8"))
        item = next((item for item in status.get("items", []) if item.get("paper_id") == paper_id
                     and item.get("status") == "fetched_pdf" and str(item.get("path", "")).replace("\\", "/") == relative), None)
        size = file.stat().st_size
        if not item or not 0 < size <= 64 * 1024 * 1024 or (item.get("size") and item["size"] != size):
            return False
        blob = file.read_bytes()
        checksum = hashlib.sha256(blob).hexdigest()
        hashes = [reference["sha256"], item.get("content_sha256"), item.get("observed_content_sha256"),
                  (item.get("pdf_evidence") or {}).get("sha256")]
        return (blob.startswith(b"%PDF") and b"%%EOF" in blob[-2048:]
                and all(value is None or value == checksum for value in hashes))
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def validated_record(record, bundle, policy, job_dir=None):
    context = policy_identity(policy)
    if not isinstance(record, dict) or record.get("paper_id") != bundle["paper_id"]:
        return None
    if any(record.get(key) != value for key, value in context.items()) or record.get("inputHash") != input_hash(bundle):
        return None
    if record.get("decision") not in DECISIONS or not _string(record.get("reason")):
        return None
    reviewer = record.get("reviewer")
    if not isinstance(reviewer, dict) or reviewer.get("type") not in {"codex", "human", "rule"}:
        return None
    if reviewer.get("type") == "rule" and (
            reviewer.get("ruleId") != "missing-full-abstract-v1" or record["decision"] != "pending"
            or record.get("extraction_allowed") is not False or _string(record.get("exclusionRule"))
            or any(d["abstract"] for d in bundle["documents"])):
        return None
    if record.get("reviewStage") == "fulltext_selection":
        if (reviewer.get("type") != "human" or record.get("fulltextReviewed") is not True
                or record.get("extraction_allowed") is not False or record.get("requires_fulltext_eligibility") is not True
                or (record["decision"] == "exclude" and not _string(record.get("exclusionRule")))
                or not _fulltext_reference_valid(job_dir, bundle["paper_id"], record.get("sourceReference"))):
            return None
        return record
    evidence = record.get("evidence")
    if not isinstance(evidence, list) or not all(_quote_valid(entry, bundle["documents"]) for entry in evidence):
        return None
    if record["decision"] in {"include", "exclude"} and not evidence:
        return None
    if record["decision"] == "exclude" and not _string(record.get("exclusionRule")):
        return None
    # Incomplete snippets are not sufficient proof to eliminate a report.
    if not any(d["abstract"] for d in bundle["documents"]) and record["decision"] != "pending":
        return None
    return record


def _load_status(job_dir):
    try:
        result = json.loads((Path(job_dir) / "screening" / "status.json").read_text(encoding="utf-8"))
        return result if (isinstance(result, dict) and result.get("version") == VERSION
                          and isinstance(result.get("records"), dict)
                          and isinstance(result.get("history", {}), dict)) else {}
    except (OSError, ValueError):
        return {}


def screening_decision(job_dir, target, policy, *, inputs=None, status=None):
    if not policy_identity(policy):
        return {"decision": "legacy", "extraction_allowed": True}
    paper_id = target if isinstance(target, str) else target.get("paper_id")
    inputs = {b["paper_id"]: b for b in load_inputs(job_dir)} if inputs is None else inputs
    bundle = inputs.get(paper_id)
    if not bundle:
        return {"decision": "unscreened", "reason": "目标不在当前题录版本中。", "extraction_allowed": False}
    status = _load_status(job_dir) if status is None else status
    records, history = status.get("records", {}), status.get("history", {})
    candidates = [records.get(paper_id), history.get(record_key(paper_id, policy, bundle))]
    for record in candidates:
        valid = validated_record(record, bundle, policy, job_dir)
        if valid:
            return {**valid, "extraction_allowed": valid["decision"] == "include" and valid.get("extraction_allowed") is not False}
    return {"decision": "unscreened", "reason": "没有与当前篇关摘和规则版本一致的有效筛选记录。", "extraction_allowed": False}


def gate_targets(job_dir, targets, policy):
    """Exclude only proven exclusions; missing/stale reviews are returned to caller."""
    context = policy_identity(policy)
    if not context:
        return {"targets": targets, "excluded": [], "pending": [], "unscreened": []}
    inputs = {b["paper_id"]: b for b in load_inputs(job_dir)}
    status = _load_status(job_dir)
    result = {"targets": [], "excluded": [], "pending": [], "unscreened": []}
    for original in targets:
        target = copy.deepcopy(original)
        review = screening_decision(job_dir, target, policy, inputs=inputs, status=status)
        decision, paper_id = review["decision"], target["paper_id"]
        if decision == "exclude":
            result["excluded"].append(paper_id)
            continue
        if decision == "unscreened":
            result["unscreened"].append(paper_id)
            continue
        if decision == "pending":
            result["pending"].append(paper_id)
        target.update(screening_decision=decision, screening_policy_id=context["policyId"],
                      screening_line=context["line"], extraction_allowed=review["extraction_allowed"],
                      screening_input_hash=review["inputHash"], screening_policy_hash=context["policyHash"])
        if review.get("requires_fulltext_eligibility"):
            target["requires_fulltext_eligibility"] = True
        result["targets"].append(target)
    return result
