"""Offline, conservative HTML full-text evidence checks.

Length of a web page is never proof of full text.  Fresh pages must carry
evidence from an identified DOM article region; saved pages additionally need
the current evidence version and an exact content digest.  This module does
not navigate, download, modify caches, or make network requests.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from urllib.parse import urlparse

EVIDENCE_VERSION = "fulltext-evidence-v1"
MIN_ARTICLE_CHARS = 600
MIN_SECTION_CHARS = 100

_ERROR_PATTERNS = (
    (r"\b404\b.{0,80}(?:not found|page|不存在|删除)|(?:page not found|页面不存在|页面已被删除|您所访问的页面不存在)", "页面返回404或不存在，未取得全文。"),
    (r"(?:too many requests|rate limit(?:ed| exceeded)?|访问(?:过于)?频繁|操作过于频繁|请求过于频繁)", "页面提示访问频繁或限流，未取得全文。"),
    (r"(?:verify (?:that )?you are human|complete the captcha|人机验证|请完成验证|验证码验证|安全验证)", "页面需要人工验证，未取得全文。"),
    (r"(?:sign in to (?:continue|view)|log in to (?:continue|view)|登录后(?:可读|阅读|查看)|请先登录|需要登录)", "页面需要登录，未取得全文。"),
    (r"(?:access denied|you do not have access|purchase this article|purchase access|subscribe to read|权限不足|无权访问|购买全文|需订阅|订阅后(?:全文)?阅读)", "页面需要相应访问权限，未取得全文。"),
    (r"(?:error code\s*524|a timeout occurred|gateway timeout|service unavailable|服务暂不可用)", "页面加载失败或服务超时，未取得全文。"),
)
_EXCLUDED_HEADING = re.compile(
    r"^(?:abstract|summary|keywords?|references?|bibliography|literature cited|"
    r"cited by|similar (?:articles|documents)|related (?:articles|content)|"
    r"acknowledg(?:e)?ments?|funding(?: details| statement)?|"
    r"author(?:s|'s)? (?:information|contributions?|keywords?)|"
    r"conflicts? of interest|conflict of interest statement|"
    r"competing interests|affiliations?|copyright|data availability(?: statement)?|"
    r"availability of data(?: and materials)?|ethics(?: approval| statement)?|"
    r"consent(?: for publication| to participate)?|supplementary (?:material|information|data)|"
    r"摘要|关键词|参考文献|引文|相似文献|相关文章|致谢|基金(?:项目)?|"
    r"作者(?:信息|简介|贡献)|利益冲突|版权|数据可用性|伦理(?:声明|审批)?|补充材料)(?:\b|$)", re.I,
)
_NAV_HEADING = re.compile(r"^(?:contents|table of contents|article information|article info|目录|文章信息)$", re.I)
_CORE_PATTERNS = (
    ("introduction", r"^(?:introduction|background|引言|前言|研究背景|绪论)$"),
    ("methods", r"^(?:materials?(?: and| &)? methods?|methods?(?: and materials?)?|methodology|experimental(?: procedures?| design| methods?)?|材料与方法|材料和方法|研究方法|实验方法|试验方法|试验材料与方法)$"),
    ("results", r"^(?:results?(?: and| &)? discussion|results?|结果(?:与分析|与讨论|和讨论)?|研究结果|试验结果|实验结果)$"),
    ("discussion", r"^(?:discussion|讨论)$"),
    ("conclusions", r"^(?:conclusions?|concluding remarks|conclusions? and (?:perspectives|future directions)|结论(?:与展望)?|结语|总结与展望)$"),
)


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def content_sha256(text: str) -> str:
    """Digest the exact UTF-8 text saved as the HTML-body text file."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _title_key(value: object) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFKC", _string(value)).casefold() if ch.isalnum())


def _title_matches(actual: object, expected: object) -> bool:
    a, b = _title_key(actual), _title_key(expected)
    if not a or not b:
        return False
    if a == b:
        return True
    # Publisher/site suffixes are common, but short partial titles are not proof.
    shorter, longer = sorted((a, b), key=len)
    return len(shorter) >= 25 and shorter in longer and len(shorter) / len(longer) >= 0.72


def _doi(value: object) -> str:
    value = _string(value).strip()
    match = re.search(r"10\.\d{4,9}/[^\s<>\"]+", value, re.I)
    return match.group(0).rstrip(".,;)]}").casefold() if match else ""


def _heading(value: object) -> str:
    text = unicodedata.normalize("NFKC", _string(value)).strip()
    text = re.sub(r"^\s*(?:(?:\d+(?:\.\d+)*|[IVX]+)[.)、:]?\s+|第[一二三四五六七八九十\d]+[章节]\s*)", "", text, flags=re.I)
    return " ".join(text.rstrip(":：.。 ").split())


def _metadata_page(url: str) -> tuple[bool, bool]:
    """Return (known metadata page, inherently bibliographic-only endpoint)."""
    parsed = urlparse(url)
    host, path = (parsed.hostname or "").lower(), parsed.path.lower()
    if host == "pubmed.ncbi.nlm.nih.gov" and re.fullmatch(r"/\d+/?", path):
        return True, True
    if host == "scopus.com" or host.endswith(".scopus.com"):
        if any(part in path for part in ("/record/", "/pages/publications/", "/inward/record", "/record/display")):
            return True, True
    if host == "cnki.net" or host.endswith(".cnki.net"):
        return any(part in path for part in ("/abstract", "/detail", "/kcms/detail/")), False
    if host == "wanfangdata.com.cn" or host.endswith(".wanfangdata.com.cn"):
        return any(part in path for part in ("/details/", "/detail/", "/periodical/", "/thesis/")), False
    return False, False


def page_problem(text: str, evidence: dict | None = None) -> str:
    """Only explicit blocker messages; ordinary navigation 'Log in' is harmless."""
    evidence = evidence if isinstance(evidence, dict) else {}
    # Error pages are normally short. Restrict broad scans to page header/footer
    # instead of treating a quoted phrase deep inside a paper as a site blocker.
    sample = "\n".join((_string(evidence.get("page_title")), text[:4000], text[-1500:] if len(text) > 4000 else ""))
    for pattern, reason in _ERROR_PATTERNS:
        if re.search(pattern, sample, re.I | re.S):
            return reason
    return ""


def _identity_problem(evidence: dict, expected_title: str, expected_doi: str) -> str:
    wanted_doi = _doi(expected_doi)
    actual_doi = _doi(evidence.get("citation_doi"))
    if wanted_doi and actual_doi:
        if wanted_doi == actual_doi:
            return ""
        return "页面DOI与目标文献不一致，未确认全文。"
    actual_title = evidence.get("citation_title") or evidence.get("page_title")
    if expected_title and _title_matches(actual_title, expected_title):
        return ""
    return "页面题名或DOI尚不能与目标文献核对，未确认全文。"


def _substantive_sections(evidence: dict, article_text: str) -> list[tuple[str, str]]:
    sections = evidence.get("sections")
    if not isinstance(sections, list):
        return []
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    normalized_article = " ".join(article_text.split())
    for section in sections[:100]:
        if not isinstance(section, dict):
            continue
        heading = _heading(section.get("heading"))
        content = " ".join(_string(section.get("text")).split())
        key = _title_key(heading)
        if not heading or len(heading) > 180 or key in seen:
            continue
        if _EXCLUDED_HEADING.search(heading) or _NAV_HEADING.search(heading):
            continue
        # DOM section text must belong to the captured article. A list of
        # navigation headings, text from another paper, or citations is not body.
        if len(content) < MIN_SECTION_CHARS or content not in normalized_article:
            continue
        if len(re.findall(r"(?:\bdoi\b|10\.\d{4,9}/|\bPMID\b)", content, re.I)) >= 5:
            continue
        seen.add(key)
        out.append((heading, content))
    return out


def assess_html(text: str, url: str = "", evidence: dict | None = None,
                expected_title: str = "", expected_doi: str = "") -> tuple[str, str]:
    """Classify fresh visible HTML as fulltext, abstract, or unavailable.

    ``evidence`` is generated locally from a verified, visible DOM body region.
    It contains ``origin``, ``container_verified``, ``article_text``, citation
    metadata and ``sections`` with actual heading/body text. Whole-page length,
    a 'Full text' link, DOI alone, or a generic <main> are insufficient.
    """
    text = _string(text)
    evidence = evidence if isinstance(evidence, dict) else {}
    problem = page_problem(text, evidence)
    if problem:
        return "unavailable", problem
    metadata, inherently_metadata = _metadata_page(url)
    if inherently_metadata:
        return "abstract", "这是题录或摘要页面；全文链接不等于已取得正文。"
    body = _string(evidence.get("article_text"))
    has_abstract = metadata or bool(re.search(r"(?:^|\n)\s*(?:abstract|摘要)\s*(?:\n|:|：)", text, re.I))
    fallback = "abstract" if has_abstract else "unavailable"
    if evidence.get("container_verified") is not True or evidence.get("origin") != "dom_article_region":
        return fallback, "尚无可验证的文章正文区域；整页长度不能证明取得全文。"
    if len(body.strip()) < MIN_ARTICLE_CHARS:
        return fallback, "正文区域内容不足，尚不能确认完整文章。"
    identity_problem = _identity_problem(evidence, expected_title, expected_doi)
    if identity_problem:
        return "unavailable", identity_problem
    sections = _substantive_sections(evidence, body)
    categories = set()
    for heading, _ in sections:
        for category, pattern in _CORE_PATTERNS:
            if re.fullmatch(pattern, heading, re.I):
                categories.add(category)
    # IMRAD articles need two distinct substantive body categories. Narrative
    # reviews may use subject-specific sections; require three real sections,
    # including an introduction or conclusion, rather than demanding Methods.
    structured = len(categories) >= 2 and len(sections) >= 2
    review_structured = len(sections) >= 3 and bool(categories & {"introduction", "conclusions"})
    if not (structured or review_structured):
        return fallback, "尚不能核验正文分节；摘要、目录和参考文献列表不算全文。"
    return "fulltext", "已核对目标文献及可见正文区域、正文分节。"


def verified_saved_html(item: dict, filetext: str) -> tuple[bool, str]:
    """Validate a saved HTML-body text without networking or modifying files."""
    if not isinstance(item, dict):
        return False, "保存记录无效，需复核全文。"
    if item.get("evidence_version") != EVIDENCE_VERSION:
        return False, "旧缓存缺少当前正文证据，需复核；保留原文件。"
    digest = item.get("content_sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest) or digest != content_sha256(filetext):
        return False, "保存文件与正文证据摘要不一致，需复核；保留原文件。"
    raw = item.get("html_evidence")
    evidence = dict(raw) if isinstance(raw, dict) else {}
    evidence["article_text"] = filetext
    verdict, reason = assess_html(
        filetext, _string(item.get("final_url") or item.get("fulltext_url") or item.get("source_url") or item.get("url")), evidence,
        _string(item.get("title") or item.get("expected_title")), _string(item.get("doi") or item.get("expected_doi")),
    )
    return verdict == "fulltext", reason


def revalidate_saved_html(item: dict, filetext: str) -> tuple[str, str]:
    """Return a conservative offline verdict for old or current saved HTML."""
    valid, reason = verified_saved_html(item, filetext)
    if valid:
        return "fulltext", reason
    raw = item.get("html_evidence") if isinstance(item, dict) else None
    problem = page_problem(filetext, raw if isinstance(raw, dict) else None)
    if problem:
        return "unavailable", problem
    url = _string(item.get("final_url") or item.get("fulltext_url") or item.get("source_url") or item.get("url")) if isinstance(item, dict) else ""
    metadata, _ = _metadata_page(url)
    has_abstract = metadata or bool(re.search(r"(?:^|\n)\s*(?:abstract|摘要)\s*(?:\n|:|：)", filetext, re.I))
    return ("abstract" if has_abstract else "unavailable"), reason
