"""Callback-driven discovery for explicit Scholar topics and year partitions.

The caller owns the browser, candidate normalization and atomic persistence.
This module neither opens a browser itself nor changes a research configuration.
Every successful page is committed before another request; login/verification
and ambiguous pagination retain the waiting cursor for a human to resume.
"""
from __future__ import annotations

from copy import deepcopy

from literature_identity import conflicts, digest, identity

from literature_scholar_batches import (
    build_schedule, next_batch, normalize_plan, refine_on_limit, summarize,
)

_SOURCE = "google-scholar"
_HIT_FIELDS = ("id", "topic_id", "label", "query", "year_from", "year_to", "sort")
_RECOVERY_FIELDS = {"mode", "message", "from_page", "to_page", "target_page", "reason",
                    "position_verified", "continuity_verified"}
_BLOCKING_REASONS = {"login", "verification", "captcha", "access_required", "access_blocked",
                     "source_unavailable", "network", "network_error", "timeout", "rate_limited"}


def _hit(batch):
    return {key: batch[key] for key in _HIT_FIELDS}


def _recovery(value):
    """Retain page-location evidence, never arbitrary browser/session state."""
    if not isinstance(value, dict):
        return {}
    return {key: item[:1000] if isinstance(item, str) else item
            for key, item in value.items() if key in _RECOVERY_FIELDS
            and (isinstance(item, str) or type(item) in {int, bool} or item is None)}


def _summary(entry, *, trial_complete=False):
    result = summarize(entry["scholar_schedule"])
    result["gaps"] = [{**_hit(batch), "reason": (batch.get("gap") or {}).get("reason"),
                       "message": (batch.get("gap") or {}).get("message")}
                      for batch in entry["scholar_schedule"]["batches"]
                      if batch["status"] == "coverage_limited"]
    result["trial_complete"] = bool(trial_complete)
    result["pages_saved"] = len(entry.get("pages", []))
    if entry["scholar_schedule"]["plan"]["trialMaxPages"] is not None:
        result["discovery_complete"] = False
        result["trial_max_pages"] = entry["scholar_schedule"]["plan"]["trialMaxPages"]
    entry["scholar_summary"] = result
    return result


def _attention(entry, persist, *, reason, message, batch=None):
    if batch is not None:
        batch.update(status="attention", reason=reason, message=message)
        entry["next_page"] = batch["next_page"]
        entry["current_batch_id"] = batch["id"]
    entry.update(status="attention", reason=reason, message=message, trial_complete=False,
                 stop_reason=reason, count=len(entry.get("results", [])))
    if "scholar_schedule" in entry:
        try:
            _summary(entry)
        except (ValueError, KeyError, TypeError):
            # A damaged ledger must remain available for diagnosis, without
            # retaining an earlier claim that discovery was complete.
            entry["scholar_summary"] = {"discovery_complete": False,
                                        "complete_recall_claimed": False,
                                        "trial_complete": False}
    persist()
    return "attention"


def _finish_trial(entry, persist, *, reason):
    entry.update(status="ok", reason=None, message="Scholar小范围试检已停止；不代表正式检索完成。",
                 stop_reason=reason, trial_complete=True)
    _summary(entry, trial_complete=True)
    persist()
    return "trial_complete"


def _progress_valid(entry):
    """Check the persisted page ledger before using it to skip work or budget."""
    pages = entry.get("pages", [])
    if not isinstance(pages, list) or not isinstance(entry.get("results", []), list):
        raise ValueError("Scholar保存的页记录或候选格式无效")
    expected = []
    for batch in entry["scholar_schedule"]["batches"]:
        local = batch.get("pages", [])
        if not isinstance(local, list):
            raise ValueError("Scholar批次页记录无效")
        for index, saved in enumerate(local):
            if (not isinstance(saved, dict) or saved.get("batch_id") != batch["id"]
                    or type(saved.get("page_index")) is not int or saved["page_index"] != index
                    or not isinstance(saved.get("fingerprint"), str)
                    or type(saved.get("returned")) is not int or saved["returned"] < 0):
                raise ValueError("Scholar批次页记录与断点不一致")
        if batch["next_page"] != len(local):
            raise ValueError("Scholar下一页位置缺少对应的已存页记录")
        expected.extend(local)
    if pages != expected:
        raise ValueError("Scholar累计页记录与分批页记录不一致")


def _merge_results(entry, batch, rows, record_keys):
    """Fold identical observations, preserving distinct reports and batch hits."""
    transient = {"_query", "_retrieved_at", "query", "retrieved_at", "hit_batches", "transport",
                 "candidate_id", "batch_index"}

    def observation(row):
        return digest({key: value for key, value in row.items() if key not in transient})

    saved = entry["results"]
    lookup = {}
    for row in saved:
        for key in record_keys(row):
            lookup.setdefault(key, []).append(row)
    hit = _hit(batch)
    for row in rows:
        keys = record_keys(row)
        current_identity, current_observation = identity(row), observation(row)
        matched = next((previous for key in sorted(keys) for previous in lookup.get(key, [])
                        if not conflicts(identity(previous), current_identity)
                        and observation(previous) == current_observation), None)
        if matched is None:
            matched = deepcopy(row)
            matched["hit_batches"] = []
            saved.append(matched)
            for key in keys:
                lookup.setdefault(key, []).append(matched)
        hits = matched.setdefault("hit_batches", [])
        if not any(existing.get("id") == hit["id"] for existing in hits):
            hits.append(deepcopy(hit))
    batch["count"] = sum(any(hit.get("id") == batch["id"]
                             for hit in row.get("hit_batches", [])) for row in saved)
    entry["count"] = len(saved)


def _metadata(entry, filtered, search, batch):
    for key in ("url", "transport", "retrieved_at"):
        if filtered.get(key) is not None:
            entry[key] = filtered[key]
    for key in ("applied_filters", "deferred_rules"):
        entry[key] = list(dict.fromkeys(entry.get(key, []) + filtered.get(key, [])))
    years = filtered.get("year_filtering", {})
    if isinstance(years, dict):
        previous = entry.get("year_filtering", {})
        entry["year_filtering"] = {
            "mode": years.get("mode", previous.get("mode")),
            "excluded": previous.get("excluded", 0) + years.get("excluded", 0),
            "unknown_year_retained": previous.get("unknown_year_retained", 0)
                                     + years.get("unknown_year_retained", 0),
        }
    if type(search.get("total_count")) is int and search["total_count"] >= 0:
        batch["total_count"] = search["total_count"]
        entry["total_count"] = search["total_count"]
        entry["reported_total_scope"] = "current_scholar_batch"
    entry.update(query=batch["query"], current_batch_id=batch["id"], next_page=batch["next_page"])


def run_plan(config, output_dir, entry, *, resumed, fetch, normalize_page,
             record_keys, page_fingerprint, persist, emit):
    """Run explicit topics, returning ``processed``, ``attention`` or a trial stop.

    ``fetch`` has the existing source-worker calling convention.  ``normalize_page``
    has ``filtered_source_results``'s signature and binds each actual child query
    and year range. ``persist()`` must atomically save the caller's outer state;
    persistence failures propagate so another page can never be requested first.
    A trial page budget counts saved pages across all children and resumptions.
    """
    try:
        plan = normalize_plan(config.get("scholarPlan"), config.get("publicationYearFrom"),
                              config.get("publicationYearTo"))
        expected = build_schedule(plan)
        existing = entry.get("scholar_schedule")
        if existing is None:
            if entry.get("results") or entry.get("pages") or entry.get("next_page", 0):
                raise ValueError("原Scholar结果没有分批台账，不能静默套用新方案；请保留旧结果另建试检任务")
            entry["scholar_schedule"] = expected
            entry.setdefault("results", [])
            entry.setdefault("pages", [])
            entry.setdefault("retrieved_count", 0)
            entry.setdefault("count", 0)
            _summary(entry)
            persist()
        elif not isinstance(existing, dict) or existing.get("fingerprint") != expected["fingerprint"]:
            raise ValueError("Scholar分批方案与保存断点不一致；未改写原任务或混合检索结果")
        summarize(entry["scholar_schedule"])
        _progress_valid(entry)
    except (ValueError, KeyError, TypeError) as error:
        return _attention(entry, persist, reason="results_unrecognized", message=str(error))

    budget = plan["trialMaxPages"]
    if budget is not None and len(entry["pages"]) >= budget:
        return _finish_trial(entry, persist, reason="trial_budget_reached")
    if entry.get("status") == "attention" and not resumed:
        return "attention"
    scrape_next = bool(resumed)
    while True:
        schedule = entry["scholar_schedule"]
        batch = next_batch(schedule)
        if batch is None:
            summary = _summary(entry)
            if summary["coverage_limited_batches"]:
                return _attention(entry, persist, reason="source_limit_reached",
                                  message="Scholar有限细分后仍存在覆盖缺口；已存候选保留，请查看逐批台账。")
            if budget is not None:
                return _finish_trial(entry, persist, reason="trial_plan_processed")
            entry.update(status="ok" if entry["results"] else "no_results", reason=None, trial_complete=False,
                         stop_reason="accessible_batches_processed", message="Scholar计划内可访问批次已处理。")
            persist()
            return "processed"

        page_index = batch["next_page"]
        batch.update(status="running", reason=None, message=None)
        entry.update(status="running", reason=None, message=None,
                     current_batch_id=batch["id"], next_page=page_index, query=batch["query"])
        _summary(entry)
        persist()
        emit("stage", stage="search", source=_SOURCE, scholar_batch=_hit(batch), page_index=page_index,
             message=f"Scholar：{batch['label']}，{batch['year_from']}—{batch['year_to']}，第{page_index + 1}页")
        try:
            search = fetch(_SOURCE, batch["query"], scrape_next, 10,
                           batch["year_from"], batch["year_to"], job_dir=output_dir,
                           page_index=page_index, full_page=True)
            scrape_next = False
        except Exception as error:
            return _attention(entry, persist, reason="source_unavailable", batch=batch,
                              message=f"Scholar页面请求失败（{type(error).__name__}）；已保存原断点，等待检查并继续。")

        if not isinstance(search, dict):
            return _attention(entry, persist, reason="results_unrecognized", batch=batch,
                              message="Scholar未返回可核对的页面结构；未跳过当前页。")
        recovery = _recovery(search.get("recovery"))
        if recovery:
            entry["recovery"] = recovery
            persist()
            if recovery.get("message"):
                emit("stage", stage="search", source=_SOURCE,
                     recovery=recovery, message=recovery["message"])
        status = search.get("status")
        limited = search.get("source_limit_reached") is True
        # The browser also publishes a cap as attention/results_unrecognized.
        # Only its explicit cap flag permits that variant; authentication and
        # network failures always take precedence over any stale cap marker.
        reason = search.get("reason")
        cap_attention = limited and status == "attention" and reason in {
            None, "results_unrecognized", "source_limit_reached"}
        blocked = reason in _BLOCKING_REASONS
        if blocked or (status not in {"ok", "no_results"} and not cap_attention):
            return _attention(entry, persist, batch=batch,
                              reason=search.get("reason") or "source_unavailable",
                              message=str(search.get("message") or "Scholar需要人工处理；原查询和等待页已保留。"))
        index = search.get("page_index")
        if type(index) is not int or index != page_index:
            return _attention(entry, persist, reason="results_unrecognized", batch=batch,
                              message="Scholar实际页码不能与等待位置对应；未导入当前页或重置原断点。")
        raw = search.get("results", [])
        if not isinstance(raw, list) or any(not isinstance(row, dict) for row in raw):
            return _attention(entry, persist, reason="results_unrecognized", batch=batch,
                              message="Scholar当前页记录结构不完整；未推进断点。")
        more = search.get("has_next")
        if not raw and not limited and status != "no_results" and more is not False:
            return _attention(entry, persist, reason="results_unrecognized", batch=batch,
                              message="Scholar空白页不能作为零命中或末页；等待核对当前页面。")

        if raw or not limited:
            try:
                fingerprint = page_fingerprint(raw)
                if raw and any(saved.get("fingerprint") == fingerprint for saved in batch["pages"]):
                    return _attention(entry, persist, reason="results_unrecognized", batch=batch,
                                      message="Scholar当前批次重复显示已保存页；断点保留在尚未取得的新页。")
                local_config = {**config, "publicationYearFrom": batch["year_from"],
                                "publicationYearTo": batch["year_to"]}
                filtered = normalize_page(search, local_config, _SOURCE, batch["query"], full_page=True)
                rows = filtered.get("results", [])
                if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                    raise ValueError("Scholar规范化候选格式无效")
            except (ValueError, KeyError, TypeError) as error:
                return _attention(entry, persist, reason="results_unrecognized", batch=batch, message=str(error))
            _merge_results(entry, batch, rows, record_keys)
            saved_page = {"batch_id": batch["id"], "page_index": page_index,
                          "fingerprint": fingerprint, "returned": len(raw), "accepted": len(rows),
                          "recovery": _recovery(search.get("recovery"))}
            batch["pages"].append(deepcopy(saved_page))
            entry["pages"].append(saved_page)
            batch["retrieved_count"] += len(raw)
            entry["retrieved_count"] = sum(item["returned"] for item in entry["pages"])
            batch["next_page"] = page_index + 1
            entry["pages_fetched"] = len(entry["pages"])
            _metadata(entry, filtered, search, batch)
            if not limited and (more is False or status == "no_results"):
                batch.update(status="ok" if batch["count"] else "no_results",
                             stop_reason="exhausted" if raw else "no_results")
            _summary(entry)
            persist()
            emit("stage", stage="save", source=_SOURCE, scholar_batch=_hit(batch), page_index=page_index,
                 message=f"Scholar已保存第{page_index + 1}页，累计{entry['count']}条不同候选。")

        if limited:
            entry["scholar_schedule"] = refine_on_limit(schedule, batch["id"])
            _summary(entry)
            persist()
        if budget is not None and len(entry["pages"]) >= budget:
            return _finish_trial(entry, persist, reason="trial_budget_reached")
        if not limited and more is not True and more is not False and status != "no_results":
            return _attention(entry, persist, reason="results_unrecognized", batch=batch,
                              message="Scholar候选已保存，但不能确认下一页或末页；等待核对，不声明检全。")
