"""Read-only target expansion for unresolved probable duplicate groups.

Exact duplicate groups retain their canonical grouping. A probable/needs_review
group is a review suggestion, so each original record remains an independent
full-text and extraction target until a separate human decision is recorded.
The frozen dedupe report and every original record are left unchanged.
"""
from __future__ import annotations

import copy
import re

_PAPER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def expanded_target_groups(groups: list[dict]) -> list[dict]:
    """Return detached target groups, expanding only unresolved review groups.

    Expanded entries keep ``merge_confidence=probable`` and ``needs_review``;
    they are never proof of an accepted duplicate or eligible for reuse that
    requires an exact group. Invalid probable members fail visibly instead of
    silently disappearing from the downstream target list.
    """
    if not isinstance(groups, list):
        raise ValueError("去重目标组必须是列表，请核对原去重输入")
    result: list[dict] = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        if group.get("needs_review") is not True and str(group.get("merge_confidence") or "").lower() != "probable":
            result.append(copy.deepcopy(group))
            continue
        records = group.get("records")
        if not isinstance(records, list) or not records:
            raise ValueError("相似文献待核对组缺少原候选记录，请核对原去重输入")
        seen: set[str] = set()
        for record in records:
            paper_id = str(record.get("candidate_id") or "").strip() if isinstance(record, dict) else ""
            if not _PAPER_ID.fullmatch(paper_id) or paper_id in seen:
                raise ValueError("相似文献待核对组含缺少或重复的候选标识，请核对原去重输入")
            seen.add(paper_id)
            target = copy.deepcopy(group)
            original = copy.deepcopy(record)
            source = str(original.get("source_key") or original.get("source") or "").strip()
            target.update(
                canonical_id=paper_id,
                title=str(original.get("title") or ""),
                year=original.get("year"),
                doi=str(original.get("doi") or ""),
                sources=[source] if source else [],
                candidate_ids=[paper_id],
                records=[original],
                merge_confidence="probable",
                needs_review=True,
                target_group_expanded=True,
                unresolved_group_id=str(group.get("canonical_id") or ""),
            )
            result.append(target)
    return result
