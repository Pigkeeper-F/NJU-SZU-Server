"""Safe, deterministic explanations for native-search verification failures.

This module never reads a browser or mutates a job. Call it only after the
caller has excluded authentication / access / challenge failures. The outer
reason remains ``results_unrecognized`` for existing continuation handling.
"""
from __future__ import annotations


_MESSAGES = {
    "native_entry_missing": "当前页面未找到可识别的高级／专业检索入口，尚未确认进入原生检索表单。",
    "native_editor_missing": "尚未识别高级／专业检索编辑器，原检索式未被确认提交。",
    "native_search_control_missing": "已识别原生检索编辑器，但未找到唯一可用的最终检索按钮。",
    "native_year_controls_missing": "尚未识别与本次年份范围对应的起止日期控件。",
    "native_year_bounds_unverified": "页面上的起止日期尚未与本次要求的时间范围一致，未确认年份限制生效。",
    "native_query_length_exceeded": "完整检索式超过当前原生编辑器显示的长度上限，未截断或提交。",
    "native_query_write_unverified": "编辑器中的完整检索式未能与原式逐字核对，尚未确认提交。",
    "native_query_summary_missing": "页面未提供可识别的已执行检索式摘要，不能仅凭编辑器内容或结果数量认定执行成功。",
    "native_query_summary_mismatch": "页面显示的已执行检索式与本次完整原式不一致，未接收这些结果。",
    "native_syntax_error": "页面明确提示检索式或语法错误，本次结果未被接收。",
    "native_page_position_missing": "尚未取得当前结果页的可靠页位证明，未推进分页断点。",
    "native_page_position_mismatch": "页面显示的当前页位与本任务要求的页位不一致，未推进分页断点。",
    "native_page_loading": "当前原生检索页面仍在加载或结果服务未就绪，尚未确认本页结果。",
    "native_source_scope_unverified": "当前页面的来源或数据库范围与本次检索要求不符，未提交或接收结果。",
    "native_resume_binding_unverified": "原任务绑定页面、已执行原式或结果指纹未能核实，未重新提交或重置断点。",
    "native_navigation_unverified": "点击原生检索入口后，尚未确认到达本任务的高级／专业检索表单。",
    "native_verification_incomplete": "原生检索验证未完成，当前证据不足以确认具体失败环节。",
}
_PHASES = {"entry", "form", "submit", "result", "resume", "verification"}
_SAFE_BOOLEAN_DETAILS = {
    "editor_present", "entry_present", "search_control_present",
    "query_summary_present", "query_matches", "year_controls_present",
    "years_match", "page_matches", "syntax_error",
}


def native_failure(code, *, phase="verification", details=None):
    """Build a pause payload without retaining query text, URLs or page text.

    Unknown codes / phases degrade to an explicit incomplete verification;
    arbitrary diagnostic detail fields are discarded rather than persisted.
    """
    if code not in _MESSAGES:
        code = "native_verification_incomplete"
    if phase not in _PHASES:
        phase = "verification"
    diagnostics = {"native_failure_code": code, "native_failure_phase": phase}
    if isinstance(details, dict):
        diagnostics.update({key: value for key, value in details.items()
                            if key in _SAFE_BOOLEAN_DETAILS and isinstance(value, bool)})
    return {
        "reason": "results_unrecognized",
        "message": _MESSAGES[code] + "本轮未确认检索完成；请核对本任务官方页面后继续，或导出完整题录后导入。",
        "diagnostics": diagnostics,
    }


def diagnose_native_failure(state=None, *, phase="verification", require_years=False,
                            query_matches=None, years_match=None,
                            require_page=False, page_matches=None):
    """Classify a known failure using positive evidence from the visible probe.

    The caller supplies comparison booleans using its existing canonical-query,
    full date-boundary and page checks. ``None`` means unknown, never success.
    Do not call this function as a substitute for the caller's success guard.
    For known navigation, length, write or binding failures use native_failure
    directly so that no unrelated failure is inferred from an older probe.
    """
    state = state if isinstance(state, dict) else {}
    summaries = state.get("summaries")
    summary_present = isinstance(summaries, (list, tuple)) and any(
        isinstance(item, str) and item.strip() for item in summaries)
    details = {
        "editor_present": bool(state.get("editor")),
        "entry_present": bool(state.get("entry")),
        "search_control_present": bool(state.get("button")),
        "query_summary_present": summary_present,
        "year_controls_present": bool(state.get("years")),
        "syntax_error": bool(state.get("syntaxError")),
        "query_matches": query_matches, "years_match": years_match,
        "page_matches": page_matches,
    }
    code = "native_verification_incomplete"
    if state.get("syntaxError"):
        code = "native_syntax_error"
    elif phase in {"entry", "form", "submit"}:
        if not state.get("editor"):
            code = ("native_entry_missing" if phase == "entry" and not state.get("entry")
                    else "native_editor_missing")
        elif not state.get("button"):
            code = "native_search_control_missing"
        elif require_years and years_match is not True:
            code = ("native_year_controls_missing" if not state.get("years")
                    and not state.get("dateSummaries") else "native_year_bounds_unverified")
        elif query_matches is False:
            code = "native_query_write_unverified"
    elif phase == "result":
        if not summary_present:
            code = "native_query_summary_missing"
        elif query_matches is False:
            code = "native_query_summary_mismatch"
        elif require_years and years_match is not True:
            code = "native_year_bounds_unverified"
        elif page_matches is False:
            code = "native_page_position_mismatch"
        elif require_page and page_matches is not True:
            code = "native_page_position_missing"
    return native_failure(code, phase=phase, details=details)
