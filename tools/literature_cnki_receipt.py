"""Pure receipts for a witnessed CNKI visible-UI submit / next-page chain.

These are local checkpoint evidence, not signatures or server receipts. The
caller must still enforce the official source, access guards, bound browser
tab and ordinary (never force) clicks. Existing results cannot mint a receipt.
"""
from __future__ import annotations

import hashlib
import json

from literature_cnki_dates import bounds_match, year_bound_value


VERSION = "cnki-visible-submit-chain-v1"
_BLOCKS = ("captcha", "password", "loginPrompt", "accessRequired", "rateLimited",
           "accessBlocked", "service_error", "resultsLoading", "_source_loading_pending")
_EVIDENCE = {"empty_before_submit": True, "normal_submit_click": True,
             "exact_editor_before_after": True, "full_date_bounds": True,
             "first_page_observed": True}


def _request(query, year_from, year_to):
    if not isinstance(query, str) or not query.strip():
        return None
    bounds = {}
    for role, year in (("from", year_from), ("to", year_to)):
        bounds[role] = year_bound_value(role, year) if year is not None else None
        if year is not None and bounds[role] is None:
            return None
    if year_from is not None and year_to is not None and year_from > year_to:
        return None
    return {"query_sha256": hashlib.sha256(query.encode("utf-8")).hexdigest(), "bounds": bounds}


def _dates(state, supplied):
    if supplied is not None:
        return supplied
    result = {}
    rows = state.get("years", []) if isinstance(state, dict) else []
    if not isinstance(rows, list):
        return {}
    for role in ("from", "to"):
        matches = [row for row in rows if isinstance(row, dict) and row.get("role") == role
                   and row.get("tag") == "cnki-date"]
        if len(matches) != 1:
            return {}
        result[role] = matches[0].get("value")
    return result


def _state_ok(state, query, year_from, year_to, dates):
    return (isinstance(state, dict) and state.get("modeVerified") is True
            and isinstance(state.get("editor"), dict) and state["editor"].get("value") == query
            and not state.get("syntaxError")
            and bounds_match(_dates(state, dates), year_from, year_to))


def _snapshot_ok(snapshot):
    return (isinstance(snapshot, dict) and isinstance(snapshot.get("results"), list)
            and all(isinstance(row, dict) for row in snapshot["results"])
            and not any(snapshot.get(key) for key in _BLOCKS))


def _fingerprint(snapshot):
    # Intentionally identical to literature_browser._row_fingerprint.
    rows = [{key: row.get(key) for key in ("title", "result_url", "doi", "pmid")}
            for row in snapshot["results"]]
    return hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def _result(snapshot, state, page_index, supplied_fingerprint=None):
    if not _snapshot_ok(snapshot) or isinstance(page_index, bool) or not isinstance(page_index, int) or page_index < 0:
        return None
    rows, zero = snapshot["results"], snapshot.get("noResults") is True
    count = snapshot.get("visible_result_count", len(rows))
    if isinstance(count, bool) or not isinstance(count, int) or count < len(rows):
        return None
    if rows:
        if zero or state.get("pageNumber") != page_index + 1 or isinstance(state.get("pageNumber"), bool):
            return None
        if any(not any(row.get(key) for key in ("title", "result_url", "doi", "pmid")) for row in rows):
            return None
        kind = "records"
    elif zero and count == 0 and page_index == 0 and state.get("pageNumber") in (None, 1):
        kind = "no_results"
    else:
        return None
    fingerprint = _fingerprint(snapshot)
    if supplied_fingerprint is not None and supplied_fingerprint != fingerprint:
        return None
    return {"page_index": page_index, "result_fingerprint": fingerprint, "result_kind": kind}


def create_receipt(query, year_from, year_to, *, before_snapshot, before_state,
                   after_snapshot, after_state, clicked_normally,
                   result_fingerprint=None, before_dates=None, after_dates=None):
    """Mint only from a fresh, witnessed empty-form -> first-result transition."""
    request = _request(query, year_from, year_to)
    if (request is None or clicked_normally is not True or not _snapshot_ok(before_snapshot)
            or before_snapshot["results"] or before_snapshot.get("noResults")
            or before_snapshot.get("visible_result_count", 0) != 0
            or not isinstance(before_state, dict) or not before_state.get("button")
            or not _state_ok(before_state, query, year_from, year_to, before_dates)
            or not _state_ok(after_state, query, year_from, year_to, after_dates)):
        return None
    result = _result(after_snapshot, after_state, 0, result_fingerprint)
    if result is None:
        return None
    return {"version": VERSION, "source": "cnki", **request, **result,
            "initial_result_fingerprint": result["result_fingerprint"],
            "transition": "submit", "evidence": dict(_EVIDENCE)}


def validate_receipt(receipt, query, year_from, year_to, *, current_snapshot,
                     current_state, result_fingerprint=None, current_dates=None,
                     expected_page_index=None):
    """Verify an unchanged bound page against a previously witnessed receipt."""
    request = _request(query, year_from, year_to)
    if (not isinstance(receipt, dict) or request is None or receipt.get("version") != VERSION
            or receipt.get("source") != "cnki" or receipt.get("evidence") != _EVIDENCE
            or any(receipt.get(key) != value for key, value in request.items())
            or not _state_ok(current_state, query, year_from, year_to, current_dates)):
        return False
    index = receipt.get("page_index")
    if expected_page_index is not None and (isinstance(expected_page_index, bool)
                                           or expected_page_index != index):
        return False
    result = _result(current_snapshot, current_state, index, result_fingerprint)
    if result is None or any(receipt.get(key) != value for key, value in result.items()):
        return False
    initial = receipt.get("initial_result_fingerprint")
    if not isinstance(initial, str) or len(initial) != 64 or any(c not in "0123456789abcdef" for c in initial):
        return False
    return ((index == 0 and receipt.get("transition") == "submit" and initial == result["result_fingerprint"])
            or (index > 0 and receipt.get("transition") == "next" and receipt.get("previous_page_index") == index - 1
                and isinstance(receipt.get("previous_result_fingerprint"), str)
                and receipt["previous_result_fingerprint"] != result["result_fingerprint"]))


def advance_receipt(receipt, query, year_from, year_to, *, before_snapshot, before_state,
                    after_snapshot, after_state, clicked_normally,
                    result_fingerprint=None, before_dates=None, after_dates=None,
                    expected_page_index=None):
    """Advance exactly one witnessed normal Next click from a validated page."""
    if (clicked_normally is not True or not validate_receipt(receipt, query, year_from, year_to,
            current_snapshot=before_snapshot, current_state=before_state, current_dates=before_dates)
            or receipt.get("result_kind") != "records"):
        return None
    index = receipt["page_index"] + 1
    if expected_page_index is not None and (isinstance(expected_page_index, bool) or expected_page_index != index):
        return None
    if not _state_ok(after_state, query, year_from, year_to, after_dates):
        return None
    result = _result(after_snapshot, after_state, index, result_fingerprint)
    if result is None or result["result_fingerprint"] == receipt["result_fingerprint"]:
        return None
    return {**receipt, **result, "evidence": dict(_EVIDENCE), "transition": "next",
            "previous_page_index": receipt["page_index"],
            "previous_result_fingerprint": receipt["result_fingerprint"]}
