"""Pure planning and checkpoint helpers for explicitly configured Scholar batches.

This module never browses, changes configuration, guesses new search terms, or
writes files.  The discovery runner owns the page budget, source requests and
atomic persistence.  A processed schedule describes its accessible results;
it never asserts complete recall of the published literature.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import re

_PLAN_KEYS = {"version", "topics", "yearSpan", "sort", "trialMaxPages"}
_NORMALIZED_KEYS = _PLAN_KEYS | {"yearFrom", "yearTo"}
_TOPIC_KEYS = {"id", "label", "query", "refinementQueries"}
_ACTIVE = {"pending", "running", "attention"}
_PROCESSED = {"ok", "no_results"}
_STATUSES = _ACTIVE | _PROCESSED | {"split", "coverage_limited"}
_STAGES = {"initial", "year", "query"}
_MAX_QUERY_CHARS = 32768  # Local expression contract, not a Scholar allowance.


def _hash(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":")).encode("utf-8")).hexdigest()


def _text(value: object, label: str, *, maximum: int, default: str | None = None) -> str:
    if value is None and default is not None:
        return default
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{label}必须为非空文本且不超过{maximum}字符；未自动截断")
    return value.strip()


def _integer(value: object, label: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{label}必须为{low}至{high}之间的整数")
    return value


def normalize_plan(raw: dict, year_from: int, year_to: int) -> dict:
    """Normalize an explicit plan without editing its queries or input object.

    ``yearFrom`` and ``yearTo`` are internal scheduling fields.  The JavaScript
    configuration may keep them at its existing top-level year controls.
    Omitted/null ``trialMaxPages`` means no trial page budget.  The caller must
    enforce a non-null budget across all child batches, rather than per query.
    """
    if not isinstance(raw, dict) or set(raw) - _PLAN_KEYS:
        raise ValueError("Scholar分批方案必须为已知字段组成的对象")
    version = raw.get("version", 1)
    if type(version) is not int or version not in {1, 2}:
        raise ValueError("Scholar分批方案版本必须为1或2")
    low = _integer(year_from, "Scholar发表起始年份", 1800, 2200)
    high = _integer(year_to, "Scholar发表截止年份", 1800, 2200)
    if low > high:
        raise ValueError("Scholar发表起始年份不能晚于截止年份")
    # Version 1 is a frozen five-year contract. Version 2 starts each explicit
    # topic over the entire configured period; zero is a sentinel, never a
    # range() step or a promise to ignore the caller's publication bounds.
    expected_span = 5 if version == 1 else 0
    span = raw.get("yearSpan", expected_span)
    if type(span) is not int or span != expected_span:
        raise ValueError("Scholar版本1须为yearSpan=5；版本2整段优先须为yearSpan=0")
    if raw.get("sort", "relevance") != "relevance":
        raise ValueError("当前Scholar分批只支持明确的relevance排序")
    trial = raw.get("trialMaxPages")
    if trial is not None:
        trial = _integer(trial, "Scholar总试检页预算", 1, 100)
    topics = raw.get("topics")
    if not isinstance(topics, list) or not 1 <= len(topics) <= 256:
        raise ValueError("Scholar主题须为1至256项的显式列表")
    normalized, seen = [], set()
    for topic in topics:
        if not isinstance(topic, dict) or set(topic) - _TOPIC_KEYS:
            raise ValueError("Scholar主题包含未知字段或格式无效")
        topic_id = _text(topic.get("id"), "Scholar主题编号", maximum=80)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", topic_id) or topic_id in seen:
            raise ValueError("Scholar主题编号必须唯一且只含字母、数字、下划线或连字符")
        seen.add(topic_id)
        label = _text(topic.get("label"), "Scholar主题名称", maximum=200, default=topic_id)
        query = _text(topic.get("query"), "Scholar主题检索式", maximum=_MAX_QUERY_CHARS)
        refinements = topic.get("refinementQueries", [])
        if not isinstance(refinements, list) or len(refinements) > 32:
            raise ValueError("Scholar预设细分式须为不超过32项的列表")
        refinements = [_text(value, "Scholar预设细分式", maximum=_MAX_QUERY_CHARS)
                       for value in refinements]
        if len(set(refinements)) != len(refinements) or query in refinements:
            raise ValueError("Scholar预设细分式不得重复或与原式相同")
        normalized.append({"id": topic_id, "label": label, "query": query,
                           "refinementQueries": refinements})
    return {"version": version, "topics": normalized, "yearSpan": span, "sort": "relevance",
            "trialMaxPages": trial, "yearFrom": low, "yearTo": high}


def _normalized_plan(value: dict) -> dict:
    if not isinstance(value, dict) or set(value) != _NORMALIZED_KEYS:
        raise ValueError("请先用normalize_plan绑定Scholar方案的明确年份范围")
    normalized = normalize_plan({key: value[key] for key in _PLAN_KEYS},
                                value["yearFrom"], value["yearTo"])
    if normalized != value:
        raise ValueError("Scholar方案尚未规范化；未自动改写保存方案")
    return normalized


def _batch_id(batch: dict) -> str:
    identity = {key: batch[key] for key in ("topic_id", "query", "year_from", "year_to",
                                          "sort", "depth", "parent_id", "refinement_stage")}
    return "gsc-" + _hash(identity)[:24]


def _new_batch(topic: dict, low: int, high: int, *, query: str | None = None,
               parent: dict | None = None, stage: str = "initial") -> dict:
    batch = {"topic_id": topic["id"], "label": topic["label"],
             "query": query if query is not None else topic["query"],
             "year_from": low, "year_to": high, "sort": "relevance",
             "depth": parent["depth"] + 1 if parent else 0,
             "parent_id": parent["id"] if parent else None,
             "refinement_stage": stage, "status": "pending", "next_page": 0,
             "pages": [], "count": 0, "retrieved_count": 0, "children": [], "gap": None}
    batch["id"] = _batch_id(batch)
    return batch


def _initial_batches(plan: dict) -> list[dict]:
    """Keep ordered topics independent, including explicitly listed supplements."""
    if plan["version"] == 2:
        windows = [(plan["yearFrom"], plan["yearTo"])]
    else:
        windows = [(low, min(low + 4, plan["yearTo"]))
                   for low in range(plan["yearFrom"], plan["yearTo"] + 1, 5)]
    return [_new_batch(topic, low, high)
            for topic in plan["topics"] for low, high in windows]


def build_schedule(plan: dict) -> dict:
    """Create ordered topic roots: v1 five-year windows, v2 whole period first.

    The supplied topic order is preserved. A fixed supplementary query belongs
    in ``topics`` after the primary queries; ``refinementQueries`` are separate
    child partitions used only after a documented source result cap.
    """
    definition = _normalized_plan(plan)
    batches = _initial_batches(definition)
    return {"version": definition["version"], "fingerprint": _hash(definition),
            "plan": deepcopy(definition), "batches": batches}


def _validated_schedule(schedule: dict) -> list[dict]:
    if (not isinstance(schedule, dict) or type(schedule.get("version")) is not int
            or schedule["version"] not in {1, 2}):
        raise ValueError("Scholar分批检查点版本无效；请保留原件核对")
    plan = _normalized_plan(schedule.get("plan"))
    if schedule["version"] != plan["version"]:
        raise ValueError("Scholar检查点与方案版本不一致；不能静默迁移旧断点")
    if schedule.get("fingerprint") != _hash(plan):
        raise ValueError("Scholar分批方案指纹已变化，不能混用原断点")
    batches = schedule.get("batches")
    if not isinstance(batches, list) or not batches:
        raise ValueError("Scholar分批检查点缺少原批次")
    topics = {topic["id"]: topic for topic in plan["topics"]}
    lookup = {}
    for batch in batches:
        if not isinstance(batch, dict):
            raise ValueError("Scholar分批检查点条目格式无效")
        required = ("id", "topic_id", "query", "year_from", "year_to", "sort", "depth",
                    "parent_id", "refinement_stage", "status", "next_page", "children")
        if any(key not in batch for key in required):
            raise ValueError("Scholar分批检查点字段不完整")
        if (not isinstance(batch["id"], str) or not isinstance(batch["topic_id"], str)
                or not isinstance(batch["status"], str)
                or not isinstance(batch["refinement_stage"], str)
                or (batch["parent_id"] is not None and not isinstance(batch["parent_id"], str))
                or batch["id"] in lookup or batch["topic_id"] not in topics
                or batch["status"] not in _STATUSES or batch["sort"] != "relevance"
                or batch["refinement_stage"] not in _STAGES):
            raise ValueError("Scholar批次编号、来源主题或状态无效")
        _integer(batch["depth"], "Scholar细分层级", 0, 2)
        low = _integer(batch["year_from"], "Scholar批次起始年份", plan["yearFrom"], plan["yearTo"])
        high = _integer(batch["year_to"], "Scholar批次截止年份", low, plan["yearTo"])
        _integer(batch["next_page"], "Scholar下一页位置", 0, 1000000)
        if (not isinstance(batch["query"], str) or not batch["query"].strip()
                or batch["id"] != _batch_id(batch)
                or not isinstance(batch["children"], list)
                or any(not isinstance(child, str) for child in batch["children"])
                or len(set(batch["children"])) != len(batch["children"])):
            raise ValueError("Scholar批次检索式、指纹或细分关系不一致")
        topic = topics[batch["topic_id"]]
        if batch["refinement_stage"] == "query":
            if batch["query"] not in topic["refinementQueries"] or low != high:
                raise ValueError("Scholar细分查询不属于预设短式或未限定单年")
        elif batch["query"] != topic["query"]:
            raise ValueError("Scholar保存的检索式已偏离原主题")
        lookup[batch["id"]] = batch
    expected_roots = {batch["id"] for batch in _initial_batches(plan)}
    if {batch["id"] for batch in batches if batch["parent_id"] is None} != expected_roots:
        raise ValueError("Scholar检查点遗漏或改变了原计划的主题/年份批次")
    for batch in batches:
        parent = lookup.get(batch["parent_id"]) if batch["parent_id"] else None
        if batch["parent_id"]:
            if (parent is None or parent["status"] != "split"
                    or batch["id"] not in parent["children"]
                    or batch["topic_id"] != parent["topic_id"]
                    or batch["depth"] != parent["depth"] + 1
                    or not parent["year_from"] <= batch["year_from"] <= batch["year_to"] <= parent["year_to"]):
                raise ValueError("Scholar子批次不能脱离原批次或跨越年份范围")
        elif batch["depth"] != 0 or batch["refinement_stage"] != "initial":
            raise ValueError("Scholar初始批次层级无效")
        if batch["status"] == "split":
            if not batch["children"] or any(child not in lookup or lookup[child]["parent_id"] != batch["id"]
                                             for child in batch["children"]):
                raise ValueError("Scholar拆分批次缺少完整子记录")
            topic = topics[batch["topic_id"]]
            if batch["year_from"] < batch["year_to"]:
                expected_children = {_new_batch(topic, year, year, parent=batch, stage="year")["id"]
                                     for year in range(batch["year_from"], batch["year_to"] + 1)}
            elif batch["refinement_stage"] != "query" and topic["refinementQueries"]:
                expected_children = {_new_batch(topic, batch["year_from"], batch["year_to"],
                                                query=query, parent=batch, stage="query")["id"]
                                     for query in topic["refinementQueries"]}
            else:
                raise ValueError("Scholar批次已到有限细分边界，不能继续拆分")
            if set(batch["children"]) != expected_children:
                raise ValueError("Scholar拆分检查点遗漏或更换了必要年份/预设查询")
        elif batch["children"]:
            raise ValueError("Scholar未拆分批次不能带有子记录")
    return batches


def next_batch(schedule: dict) -> dict | None:
    """Locate the next active leaf; does not authorize execution or alter state.

    The returned dictionary belongs to ``schedule`` so the discovery owner can
    advance its cursor and atomically save that same ledger.  Only the caller
    decides whether an attention state may resume after human intervention.
    """
    return next((batch for batch in _validated_schedule(schedule)
                 if batch["status"] in _ACTIVE and not batch["children"]), None)


def refine_on_limit(schedule: dict, batch_id: str, *, reason: str = "source_limit_reached") -> dict:
    """Return a new ledger with a finite, explicitly justified partition.

    This must be called for an established display/access result cap, never as
    an automatic response to a captcha, login requirement or network failure.
    Completed parent pages/candidates remain untouched for the caller's dedupe.
    """
    if reason != "source_limit_reached":
        raise ValueError("只有明确来源结果上限可触发细分，登录/验证/网络问题须保留断点")
    batches = _validated_schedule(schedule)
    if not isinstance(batch_id, str) or not any(batch["id"] == batch_id for batch in batches):
        raise ValueError("Scholar待细分批次不属于当前检查点")
    result = deepcopy(schedule)
    parent = next(batch for batch in result["batches"] if batch["id"] == batch_id)
    if parent["status"] in {"split", "coverage_limited"}:
        return result
    if parent["status"] in _PROCESSED:
        raise ValueError("已处理完的Scholar批次不能静默重新拆分")
    topic = next(topic for topic in result["plan"]["topics"] if topic["id"] == parent["topic_id"])
    children = []
    if parent["year_from"] < parent["year_to"]:
        children = [_new_batch(topic, year, year, parent=parent, stage="year")
                    for year in range(parent["year_from"], parent["year_to"] + 1)]
    elif parent["refinement_stage"] != "query" and topic["refinementQueries"]:
        children = [_new_batch(topic, parent["year_from"], parent["year_to"], query=query,
                               parent=parent, stage="query") for query in topic["refinementQueries"]]
    if children:
        parent.update(status="split", children=[child["id"] for child in children], gap=None)
        index = result["batches"].index(parent) + 1
        result["batches"][index:index] = children
    else:
        parent.update(status="coverage_limited", gap={
            "reason": "source_limit_reached",
            "message": "已到单年及可用预设短式的有限细分边界；现有结果保留，剩余覆盖受限。",
        })
    _validated_schedule(result)
    return result


def summarize(schedule: dict) -> dict:
    """Summarize processed leaves and gaps; never claim exhaustive retrieval."""
    batches = _validated_schedule(schedule)
    leaves = [batch for batch in batches if not batch["children"]]
    pending = sum(batch["status"] in _ACTIVE for batch in leaves)
    limited = sum(batch["status"] == "coverage_limited" for batch in leaves)
    processed = sum(batch["status"] in _PROCESSED for batch in leaves)
    status = "pending" if pending else "coverage_limited" if limited else "processed"
    active = next((batch for batch in leaves if batch["status"] in _ACTIVE), None)
    return {"status": status, "total_batches": len(batches), "leaf_batches": len(leaves),
            "pending_batches": pending, "processed_batches": processed,
            "split_batches": sum(batch["status"] == "split" for batch in batches),
            "coverage_limited_batches": limited,
            "current_batch_id": active["id"] if active else None,
            "discovery_complete": pending == 0 and limited == 0,
            "complete_recall_claimed": False}
