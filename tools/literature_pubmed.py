"""Small PubMed batches through the official, public NCBI E-utilities.

ESearch returns identifiers; EFetch returns bibliographic XML, not full text.
Only fixed HTTPS ESearch/EFetch endpoints may be requested or followed.  No
credentials are read or stored.  The browser discovery caller may explicitly
fall back to PubMed's own website after an ``error`` result.

API/date/rate-limit references:
https://www.ncbi.nlm.nih.gov/books/NBK25499/
https://www.ncbi.nlm.nih.gov/books/NBK25497/
https://pubmed.ncbi.nlm.nih.gov/help/#publication-date-dp
"""
from __future__ import annotations

import json
import re
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import xml.etree.ElementTree as ET


BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MIN_REQUEST_INTERVAL = 0.35  # NCBI: at most 3 requests/second without an API key.
_request_lock = threading.Lock()
_last_request: float | None = None


class PubMedError(Exception):
    """A fixed, non-sensitive public explanation; never the underlying URL."""


def _official_api_url(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        return (parsed.scheme == "https" and parsed.hostname == "eutils.ncbi.nlm.nih.gov"
                and parsed.port in (None, 443) and not parsed.username and not parsed.password
                and parsed.path in ("/entrez/eutils/esearch.fcgi", "/entrez/eutils/efetch.fcgi"))
    except (TypeError, ValueError):
        return False


class _OfficialRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _official_api_url(newurl):
            raise PubMedError("PubMed 接口重定向至非预期地址；请改用官方网页继续。")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _throttle(sleep, clock):
    global _last_request
    with _request_lock:
        now = clock()
        if _last_request is not None:
            delay = MIN_REQUEST_INTERVAL - (now - _last_request)
            if delay > 0:
                sleep(delay)
        _last_request = clock()


def _read(endpoint: str, params: dict, *, opener, timeout: float, maximum: int,
          sleep, clock) -> bytes:
    url = BASE + endpoint + "?" + urlencode(params)
    if not _official_api_url(url):
        raise PubMedError("PubMed 接口地址无效。")
    _throttle(sleep, clock)
    request = Request(url, headers={"User-Agent": "NJU-SZU-Workbench/1.0 (PubMed discovery)",
                                    "Accept-Encoding": "identity"})
    try:
        response = (opener.open if hasattr(opener, "open") else opener)(request, timeout=timeout)
        with response:
            if not _official_api_url(response.geturl()):
                raise PubMedError("PubMed 接口返回非预期地址；请改用官方网页继续。")
            status = getattr(response, "status", 200)
            if status != 200:
                raise PubMedError("PubMed 接口暂时不可用；请稍后重试或改用官方网页。")
            encoding = response.headers.get("Content-Encoding", "identity").lower()
            if encoding not in ("", "identity"):
                raise PubMedError("PubMed 接口返回不支持的压缩格式。")
            length = response.headers.get("Content-Length")
            if length is not None:
                try:
                    if int(length) > maximum:
                        raise PubMedError("PubMed 接口响应超出大小限制；请缩小本批次。")
                except (ValueError, TypeError):
                    raise PubMedError("PubMed 接口响应长度无效。") from None
            data = response.read(maximum + 1)
            if len(data) > maximum:
                raise PubMedError("PubMed 接口响应超出大小限制；请缩小本批次。")
            if not data:
                raise PubMedError("PubMed 接口返回空响应，不能据此判定零命中。")
            return data
    except HTTPError as exc:
        if exc.code == 429:
            raise PubMedError("PubMed 接口限流（HTTP 429）；请稍后重试或改用官方网页。") from None
        raise PubMedError("PubMed 接口请求失败；请稍后重试或改用官方网页。") from None
    except (URLError, TimeoutError, OSError):
        raise PubMedError("PubMed 接口网络或超时错误；请稍后重试或改用官方网页。") from None


def _text(element) -> str:
    return " ".join("".join(element.itertext()).split()) if element is not None else ""


def _year(date) -> tuple[int | None, str]:
    if date is None:
        return None, ""
    explicit = _text(date.find("Year"))
    if re.fullmatch(r"[12]\d{3}", explicit):
        return int(explicit), explicit
    medline = _text(date.find("MedlineDate"))
    years = re.findall(r"(?<!\d)[12]\d{3}(?!\d)", medline)
    # A winter date spanning two years remains unknown; choose no guessed year.
    abbreviated_range = re.search(r"(?<!\d)[12]\d{3}\s*[-/]\s*\d{1,4}(?!\d)", medline)
    return (int(years[0]) if len(set(years)) == 1 and not abbreviated_range else None), medline


def _doi(raw: str) -> str:
    raw = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", raw.strip(), flags=re.I)
    raw = re.sub(r"^doi:\s*", "", raw, flags=re.I)
    return raw.lower() if re.fullmatch(r"10\.\d{4,9}/[^\s<>\"']{1,250}", raw) else ""


def _record(node) -> dict:
    book = node.tag == "PubmedBookArticle"
    citation = node.find("BookDocument" if book else "MedlineCitation")
    article = citation if book else citation.find("Article") if citation is not None else None
    if citation is None or article is None:
        raise PubMedError("PubMed XML 缺少论文书目字段。")
    pmid = _text(citation.find("PMID"))
    title = _text(article.find("ArticleTitle"))
    if book and not title:
        title = _text(article.find("Book/BookTitle"))
    if not re.fullmatch(r"[1-9]\d{0,19}", pmid) or not title:
        raise PubMedError("PubMed XML 缺少有效 PMID 或题名。")
    authors = []
    for author in article.findall("AuthorList/Author"):
        name = _text(author.find("CollectiveName"))
        if not name:
            name = " ".join(filter(None, (_text(author.find("LastName")),
                    _text(author.find("ForeName")) or _text(author.find("Initials")),
                    _text(author.find("Suffix")))))
        if name:
            authors.append(name)
    venue = _text(article.find("Book/BookTitle" if book else "Journal/Title"))
    if not venue and not book:
        venue = _text(article.find("Journal/ISOAbbreviation"))
    year, publication_date = _year(article.find("Book/PubDate" if book else "Journal/JournalIssue/PubDate"))
    # ArticleDate is a reported publication date; never use submission, indexing,
    # creation or experimental dates to fill a missing publication year.
    if year is None and not publication_date:
        for date in article.findall("ArticleDate"):
            year, publication_date = _year(date)
            if year is not None:
                break
    ids = node.find("PubmedBookData/ArticleIdList" if book else "PubmedData/ArticleIdList")
    doi, pmc = "", ""
    if ids is not None:
        for item in ids.findall("ArticleId"):
            kind, value = item.get("IdType", "").lower(), _text(item)
            if kind == "doi" and not doi:
                doi = _doi(value)
            elif kind == "pmc" and re.fullmatch(r"PMC[1-9]\d*", value, flags=re.I):
                pmc = value.upper()
            elif kind == "pubmed" and value != pmid:
                raise PubMedError("PubMed XML 中 PMID 不一致；请重试。")
    if not doi:
        for item in article.findall("ELocationID"):
            if item.get("EIdType", "").lower() == "doi" and item.get("ValidYN", "Y") != "N":
                doi = _doi(_text(item))
                if doi:
                    break
    links = []
    if pmc:
        links.append({"label": "PubMed Central full text", "url": f"https://pmc.ncbi.nlm.nih.gov/articles/{pmc}/"})
    if doi:
        links.append({"label": "DOI landing page (full-text access unverified)",
                      "url": "https://doi.org/" + quote(doi, safe="/()_-.:;")})
    abstracts = []
    for abstract in article.findall("Abstract/AbstractText"):
        value = _text(abstract)
        if value:
            label = abstract.get("Label", "").strip()
            abstracts.append((label + ": " if label else "") + value)
    return {"title": title, "authors": "; ".join(authors),
            "byline": " - ".join(filter(None, ("; ".join(authors), ", ".join(filter(None, (venue, str(year or ""))))))),
            "venue": venue, "year": year, "publication_date": publication_date,
            "year_status": "reported" if year is not None else "unknown",
            "doi": doi, "pmid": pmid, "pmcid": pmc, "source_key": "pubmed",
            "result_url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            "fulltext_links": links, "snippet": "\n".join(abstracts),
            "evidence_level": "search_result_snippet", "transport": "ncbi_eutilities"}


def _fetch_records(data: bytes, ids: list[str]) -> list[dict]:
    if re.search(br"<!\s*ENTITY\b", data, re.I):
        raise PubMedError("PubMed XML 含不支持的实体定义。")
    try:
        root = ET.fromstring(data)
    except (ET.ParseError, ValueError):
        raise PubMedError("PubMed 接口 XML 损坏，不能据此判定零命中。") from None
    if root.tag != "PubmedArticleSet" or root.find(".//ERROR") is not None:
        raise PubMedError("PubMed 接口未返回有效论文 XML，不能据此判定零命中。")
    records = []
    for node in root:
        if node.tag not in ("PubmedArticle", "PubmedBookArticle"):
            raise PubMedError("PubMed XML 含未识别的论文类型。")
        records.append(_record(node))
    by_id = {record["pmid"]: record for record in records}
    if len(by_id) != len(records) or set(by_id) != set(ids):
        raise PubMedError("PubMed 返回的论文 PMID 与检索清单不一致；请重试。")
    return [by_id[pmid] for pmid in ids]


def run(query: str, limit: int = 10, year_from: int | None = None,
        year_to: int | None = None, *, page_index: int = 0, opener=None, timeout: float = 25,
        max_response_bytes: int = MAX_RESPONSE_BYTES, sleep=time.sleep,
        clock=time.monotonic) -> dict[str, Any]:
    """Return public bibliographic candidates; ``opener`` is injectable for tests.

    The API error is explicit and sanitized.  Callers decide whether to offer a
    researcher-controlled, same-source PubMed webpage fallback.
    """
    applied = ["query"]
    result: dict[str, Any] = {"status": "error", "message": "", "source_key": "pubmed",
                            "url": "https://pubmed.ncbi.nlm.nih.gov/", "results": [],
                            "applied_filters": applied, "deferred_rules": [],
                            "transport": "ncbi_eutilities", "page_index": page_index,
                            "has_next": None, "total_count": None}
    try:
        if not isinstance(query, str) or not query.strip() or len(query) > 2000:
            raise PubMedError("PubMed 检索式必须为 1 到 2000 字的非空文本。")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 10:
            raise PubMedError("PubMed 每批返回数量必须为 1 到 10。")
        if isinstance(page_index, bool) or not isinstance(page_index, int) or not 0 <= page_index <= 999:
            raise PubMedError("PubMed 页码必须为 0 到 999。")
        for value in (year_from, year_to):
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 1000 <= value <= 9999):
                raise PubMedError("PubMed 发表年份必须为四位整数。")
        if year_from is not None and year_to is not None and year_from > year_to:
            raise PubMedError("PubMed 发表年份起止顺序无效。")
        if not isinstance(timeout, (int, float)) or not 0 < timeout <= 60:
            raise PubMedError("PubMed 请求超时配置无效。")
        if not isinstance(max_response_bytes, int) or not 1 <= max_response_bytes <= MAX_RESPONSE_BYTES:
            raise PubMedError("PubMed 响应大小配置无效。")
        query = query.strip()
        params = {"db": "pubmed", "term": query, "retmode": "json",
                  "retmax": limit, "retstart": page_index * limit, "sort": "relevance", "tool": "NJU_SZU_Workbench"}
        web_query = query
        if year_from is not None or year_to is not None:
            lower, upper = year_from or 1000, year_to or 9999
            params.update(datetype="pdat", mindate=f"{lower}/01/01", maxdate=f"{upper}/12/31")
            web_query = f"({query}) AND ({lower}:{upper}[dp])"
            result["filter_details"] = {"publication_year": {"date_type": "pdat", "from": year_from,
                                                           "to": year_to, "scope": "publication_not_experiment"}}
        if year_from is not None:
            applied.append("publicationYearFrom")
        if year_to is not None:
            applied.append("publicationYearTo")
        result["url"] = "https://pubmed.ncbi.nlm.nih.gov/?" + urlencode({"term": web_query})
        opener = opener if opener is not None else build_opener(_OfficialRedirects())
        request_options = dict(opener=opener, timeout=timeout, maximum=max_response_bytes, sleep=sleep, clock=clock)
        raw = _read("esearch.fcgi", params, **request_options)
        try:
            payload = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError):
            raise PubMedError("PubMed 接口 JSON 无效，不能据此判定零命中。") from None
        search = payload.get("esearchresult") if isinstance(payload, dict) else None
        if (not isinstance(search, dict) or payload.get("error") or search.get("error") or search.get("errorlist")):
            raise PubMedError("PubMed 接口未返回有效检索结果，不能据此判定零命中。")
        raw_count, ids = search.get("count"), search.get("idlist")
        if (isinstance(raw_count, bool) or not re.fullmatch(r"\d+", str(raw_count))
                or not isinstance(ids, list) or any(not isinstance(pmid, str) or not re.fullmatch(r"[1-9]\d{0,19}", pmid) for pmid in ids)):
            raise PubMedError("PubMed 检索计数或 PMID 清单无效。")
        count = int(raw_count)
        if len(ids) != min(max(count - page_index * limit, 0), limit) or len(set(ids)) != len(ids):
            raise PubMedError("PubMed 检索计数与 PMID 清单不一致，不能据此判定零命中。")
        result["total_count"] = count
        result["has_next"] = page_index * limit + len(ids) < count
        if count == 0:
            result.update(status="no_results", message="PubMed 官方接口确认本检索式零命中。")
            return result
        if not ids:
            result.update(status="ok", message="PubMed 官方接口确认已到本次结果末尾。")
            return result
        raw = _read("efetch.fcgi", {"db": "pubmed", "id": ",".join(ids), "retmode": "xml",
                                    "tool": "NJU_SZU_Workbench"}, **request_options)
        records = _fetch_records(raw, ids)
        result.update(status="ok", message=f"PubMed 取得 {len(records)} 条书目记录；摘要不是全文证据。", results=records)
        return result
    except PubMedError as exc:
        result["message"] = str(exc)
    except Exception:
        # Never serialize exceptions: proxy URLs and diagnostic responses may
        # contain local credentials, tokens or authentication state.
        result["message"] = "PubMed 接口处理失败；请稍后重试或改用官方网页。"
    return result
