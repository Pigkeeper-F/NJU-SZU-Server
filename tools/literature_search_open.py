"""开放 API 检索适配器（A 类来源：完全无人工、无验证码、程序化直连）。

本模块只负责「检索」这一个动作：把一次检索式变成若干条候选记录的题录元数据，
不判定相关性、不下载全文、不改写下游五个阶段（去重/全文/提取/校验/导出）的任何契约。

已接通来源（全部无需登录）：

=========  ==========================================  ==========================
key        端点（官方）                                凭据
=========  ==========================================  ==========================
pubmed     https://eutils.ncbi.nlm.nih.gov/entrez/     NCBI_API_KEY（可选）
           eutils/  esearch.fcgi → efetch.fcgi
pmc        同上，db=pmc（PubMed Central 开放获取子集）  NCBI_API_KEY（可选）
openalex   https://api.openalex.org/works              OPENALEX_API_KEY（可选）
europe-pmc https://www.ebi.ac.uk/europepmc/webservices/ 无
           rest/search
=========  ==========================================  ==========================

端点、参数、限速口径均以 2026-10-21 实测 + 官方文档为准：

- NCBI E-utilities：默认 3 请求/秒，配 ``api_key`` 后 10 请求/秒，超限返回 429；
  官方建议带 ``tool`` 与 ``email`` 参数。esearch 取 PMID，efetch（retmode=xml）一次
  带回数题名/摘要/作者/期刊/年份/DOI。年份过滤用 ``(YYYY[PDAT] : YYYY[PDAT])``。
- OpenAlex：``/works`` 列表接口，返回 ``{"meta":…, "results":[…]}``；分页用 ``per_page``
  （≤100）；年份用 ``from_publication_date``/``to_publication_date``；免密时按共享出口 IP
  的每日预算计费，超预算返回 429（JSON 错误体），需要 ``api_key`` 才有独立预算。
  正文：基本只有元数据 + 开放获取链接（best_oa_location / open_access.oa_url）。
- Europe PMC：``/rest/search``，``format=json`` + ``resultType=core`` 返回摘要、
  MeSH、开放获取全文链接；年份用 ``PUB_YEAR:[YYYY TO YYYY]``；官方 workshop 口径为
  10 请求/秒、100 请求/分钟，本模块取更保守的 0.6 秒/次。

全文可得性的诚实口径：

- PubMed：摘要必有；正文只有 PMC 开放获取子集有，其余需订阅（本工具不绕过）。
- PMC：开放获取子集有正文（落地页可读）；非 OA 子集取不到即标「待补充」。
- OpenAlex：只有元数据 + OA 链接；本身不托管绝大多数正文。
- Europe PMC：OA 文献多数带可直接下载的 PDF 链接（fullTextUrlList）。

所有网络访问都走标准库 ``urllib``（不引第三方 HTTP 客户端），且可用
``http_get`` 打桩做离线解析测试。
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

#: NCBI E-utilities 根地址
EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
#: OpenAlex Works 列表端点
OPENALEX_WORKS = "https://api.openalex.org/works"
#: Europe PMC Articles RESTful 检索端点
EUROPE_PMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
SEMANTIC_SCHOLAR_SEARCH = "https://api.semanticscholar.org/graph/v1/paper/search"

#: 本模块支持的来源 key（与 tools/literature-sources.json 的 adapter.module 对应）
SUPPORTED_SOURCES = ("pubmed", "pmc", "openalex", "europe-pmc", "semantic-scholar")

#: NCBI 建议的 tool 名（官方要求：便于 NCBI 在异常时联系调用方）
TOOL_NAME = "flow-agent-web"
USER_AGENT = "flow-agent-web/1.0 (literature discovery; python-urllib)"

DEFAULT_TIMEOUT = 30.0
MAX_RESULTS = 10  # 与 run_config.limit / batch.size 的上限一致

#: 各主机的最小请求间隔（秒）。NCBI 3 rps→0.34；Europe PMC 取官方 100/min 的保守值；
#: OpenAlex 单请求上限 100 rps，这里留足余量。
MIN_INTERVALS = {
    "eutils.ncbi.nlm.nih.gov": 0.34,
    "www.ebi.ac.uk": 0.6,
    "api.openalex.org": 0.2,
}

_LAST_REQUEST_AT: dict[str, float] = {}


class SourceError(RuntimeError):
    """来源检索失败（网络故障 / 限流 / 响应格式异常）。

    ``kind`` 取值：``network`` | ``rate_limited`` | ``error``；``status`` 为 HTTP 状态码
    （无则为 0）。调用方据此决定是让用户重试还是直接报错。
    """

    def __init__(self, message: str, *, status: int = 0, kind: str = "error") -> None:
        super().__init__(message)
        self.status = status
        self.kind = kind


def _short(text: object, limit: int = 200) -> str:
    text = " ".join(str(text or "").split())
    return text[:limit]


def _throttle(host: str) -> None:
    """按主机限速：距上次请求不足最小间隔时补足等待。"""
    interval = MIN_INTERVALS.get(host, 0.0)
    if interval <= 0:
        return
    last = _LAST_REQUEST_AT.get(host)
    if last is not None:
        wait = interval - (time.monotonic() - last)
        if wait > 0:
            time.sleep(wait)
    _LAST_REQUEST_AT[host] = time.monotonic()


def http_get(
    url: str,
    params: dict | None = None,
    *,
    timeout: float = DEFAULT_TIMEOUT,
    headers: dict | None = None,
) -> tuple[int, str]:
    """标准库 GET；返回 ``(状态码, 正文文本)``。

    非 2xx 抛 :class:`SourceError`（429 标记为 ``rate_limited``），网络故障标记
    ``network``。测试可整体替换本函数做离线打桩。
    """
    full = url
    if params:
        full = f"{url}?{urllib.parse.urlencode(params, doseq=True)}"
    host = urllib.parse.urlparse(full).netloc
    _throttle(host)
    request = urllib.request.Request(
        full,
        headers={"User-Agent": USER_AGENT, "Accept": "*/*", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            return int(getattr(response, "status", 200) or 200), body
    except urllib.error.HTTPError as error:  # 4xx/5xx
        body = ""
        try:
            body = error.read().decode("utf-8", errors="replace")
        except Exception:  # pragma: no cover - 读取错误体失败不应掩盖原始错误
            body = ""
        raise SourceError(
            f"HTTP {error.code}：{_short(body)}",
            status=int(error.code),
            kind="rate_limited" if error.code == 429 else "error",
        ) from error
    except urllib.error.URLError as error:
        raise SourceError(f"网络请求失败：{_short(error.reason)}", kind="network") from error
    except TimeoutError as error:
        raise SourceError(f"网络请求超时（{timeout}s）", kind="network") from error


def _year_bounds(year_from: int | None, year_to: int | None) -> tuple[int | None, int | None]:
    """把年份区间规整成 (from, to)；两端都为 None 表示不限年份。"""
    current = datetime.now(timezone.utc).year
    low = year_from if isinstance(year_from, int) else None
    high = year_to if isinstance(year_to, int) else None
    if low is None and high is None:
        return None, None
    if low is None:
        low = 1800
    if high is None:
        high = current
    return low, high


# ---------------------------------------------------------------------------
# 请求构造（纯函数，可离线断言）
# ---------------------------------------------------------------------------

def _ncbi_params(extra: dict) -> dict:
    """NCBI 公共参数：tool 必带，api_key/email 有则带上（都可选）。"""
    params = {"tool": TOOL_NAME}
    api_key = os.environ.get("NCBI_API_KEY", "").strip()
    email = os.environ.get("NCBI_EMAIL", "").strip()
    if api_key:
        params["api_key"] = api_key
    if email:
        params["email"] = email
    params.update(extra)
    return params


def _pubmed_term(query: str, year_from: int | None, year_to: int | None) -> str:
    """PubMed 检索式：原文放括号内，再 AND 年份区间（[PDAT] = 出版日期）。"""
    term = f"({query})"
    low, high = _year_bounds(year_from, year_to)
    if low is not None and high is not None:
        term += f" AND ({low}[PDAT] : {high}[PDAT])"
    return term


def _europe_pmc_query(query: str, year_from: int | None, year_to: int | None) -> str:
    """Europe PMC 检索式：原文放括号内，再 AND PUB_YEAR 区间。"""
    expression = f"({query})"
    low, high = _year_bounds(year_from, year_to)
    if low is not None and high is not None:
        expression += f" AND (PUB_YEAR:[{low} TO {high}])"
    return expression


def _openalex_filter(year_from: int | None, year_to: int | None) -> str:
    """OpenAlex filter 片段（年份用 from/to_publication_date）。"""
    low, high = _year_bounds(year_from, year_to)
    parts = []
    if low is not None and high is not None:
        parts.append(f"from_publication_date:{low}-01-01")
        parts.append(f"to_publication_date:{high}-12-31")
    return ",".join(parts)


def search_request(
    source_key: str,
    query: str,
    limit: int,
    year_from: int | None = None,
    year_to: int | None = None,
    page_index: int = 0,
) -> dict:
    """该来源某一页的检索请求（URL + 参数）；不发网络请求。

    供离线测试与审计使用；PMID→efetch 这类派生请求见 :func:`run`。
    """
    limit = max(1, min(int(limit or 1), MAX_RESULTS))
    offset = max(0, int(page_index or 0)) * limit
    if source_key in ("pubmed", "pmc"):
        db = "pubmed" if source_key == "pubmed" else "pmc"
        params = {
            "db": db,
            "term": _pubmed_term(query, year_from, year_to),
            "retmax": str(limit),
            "retmode": "json",
            "sort": "relevance",
        }
        if offset:
            params["retstart"] = str(offset)
        return {
            "name": "esearch",
            "url": f"{EUTILS_BASE}esearch.fcgi",
            "params": _ncbi_params(params),
        }
    if source_key == "openalex":
        params: dict[str, str] = {"search": query, "per_page": str(limit)}
        if offset:
            params["page"] = str(offset // limit + 1)
        filters = _openalex_filter(year_from, year_to)
        if filters:
            params["filter"] = filters
        api_key = os.environ.get("OPENALEX_API_KEY", "").strip()
        if api_key:
            params["api_key"] = api_key
        return {"name": "works", "url": OPENALEX_WORKS, "params": params}
    if source_key == "europe-pmc":
        # Europe PMC 没有稳定页码参数，用 cursor 才严谨；这里先用“取到本页末尾
        # 再切片”的方式支持有限翻页（<=1000 条），超过即由调度器视为到来源上限。
        page_size = min(1000, offset + limit)
        request = {
            "name": "search",
            "url": EUROPE_PMC_SEARCH,
            "params": {
                "query": _europe_pmc_query(query, year_from, year_to),
                "format": "json",
                "resultType": "core",
                "pageSize": str(page_size),
            },
        }
        if offset:
            request["_page_offset"] = offset
        return request
    if source_key == "semantic-scholar":
        params: dict[str, str] = {
            "query": query,
            "limit": str(limit),
            "fields": "title,abstract,authors,year,venue,externalIds,openAccessPdf,url",
        }
        if offset:
            params["offset"] = str(offset)
        if year_from is not None:
            params["year"] = f"{year_from}-" + (str(year_to) if year_to is not None else "")
        elif year_to is not None:
            params["year"] = "-" + str(year_to)
        return {"name": "search", "url": SEMANTIC_SCHOLAR_SEARCH, "params": params}
    raise ValueError(f"未支持的开放来源：{source_key}")


def _request_url(request: dict) -> str:
    params = request.get("params") or {}
    return f"{request['url']}?{urllib.parse.urlencode(params, doseq=True)}"


# ---------------------------------------------------------------------------
# 响应解析（纯函数，输入为原始响应文本）
# ---------------------------------------------------------------------------

def _xml_text(node: ET.Element | None) -> str:
    if node is None:
        return ""
    return " ".join("".join(node.itertext()).split())


def _parse_pubmed_xml(body: str) -> dict[str, dict]:
    """解析 PubMed efetch XML → ``{pmid: {title, abstract, authors, venue, year, doi}}``。"""
    records: dict[str, dict] = {}
    try:
        root = ET.fromstring(body)
    except ET.ParseError as error:
        raise SourceError(f"PubMed 响应不是合法 XML：{_short(error)}") from error
    for article in root.iter("PubmedArticle"):
        pmid = _xml_text(article.find("./MedlineCitation/PMID"))
        if not pmid:
            continue
        art = article.find("./MedlineCitation/Article")
        title = _xml_text(art.find("ArticleTitle")) if art is not None else ""
        abstract_parts = []
        if art is not None:
            for node in art.findall("./Abstract/AbstractText"):
                label = node.attrib.get("Label") or node.attrib.get("NlmCategory") or ""
                text = _xml_text(node)
                if text:
                    abstract_parts.append(f"{label}: {text}" if label else text)
        authors = []
        if art is not None:
            for person in art.findall("./AuthorList/Author"):
                last = _xml_text(person.find("LastName"))
                initials = _xml_text(person.find("Initials"))
                collective = _xml_text(person.find("CollectiveName"))
                if collective:
                    authors.append(collective)
                elif last:
                    authors.append(f"{last} {initials}".strip())
        venue = ""
        year = None
        if art is not None:
            journal = art.find("Journal")
            if journal is not None:
                venue = _xml_text(journal.find("ISOAbbreviation")) or _xml_text(journal.find("Title"))
                pub_date = journal.find("./JournalIssue/PubDate")
                if pub_date is not None:
                    raw_year = _xml_text(pub_date.find("Year"))
                    match = re.search(r"(1[89]\d{2}|20\d{2})", raw_year) or re.search(
                        r"(1[89]\d{2}|20\d{2})", _xml_text(pub_date.find("MedlineDate"))
                    )
                    if match:
                        year = int(match.group(1))
        doi = ""
        # DOI 有两个常见位置：ArticleIdList/ArticleId[@IdType='doi']（老记录）
        # 与 Article/ELocationID[@EIdType='doi']（2010 年后的多数记录）——两个都要认，
        # 只认一个会丢掉大批文章的 DOI。
        for node in article.findall("./PubmedData/ArticleIdList/ArticleId"):
            if node.attrib.get("IdType") == "doi":
                doi = _xml_text(node)
                break
        if not doi:
            for node in article.findall("./Article/ELocationID"):
                if str(node.attrib.get("EIdType") or "").lower() == "doi":
                    doi = _xml_text(node)
                    break
        if not doi:
            for node in article.findall("./MedlineCitation/Article/ELocationID"):
                if str(node.attrib.get("EIdType") or "").lower() == "doi":
                    doi = _xml_text(node)
                    break
        records[pmid] = {
            "title": title,
            "abstract": " ".join(abstract_parts),
            "authors": ", ".join(authors),
            "venue": venue,
            "year": year,
            "doi": doi,
            "pmid": pmid,
        }
    return records


def _parse_pmc_summary(body: str) -> dict[str, dict]:
    """解析 PMC esummary JSON → ``{pmc_id: {title, authors, venue, year, doi, pmid, pmcid}}``。"""
    try:
        payload = json.loads(body)
    except ValueError as error:
        raise SourceError(f"PMC esummary 响应不是合法 JSON：{_short(error)}") from error
    result = payload.get("result")
    if not isinstance(result, dict):
        raise SourceError("PMC esummary 响应缺少 result 段")
    records: dict[str, dict] = {}
    for uid in result.get("uids") or []:
        item = result.get(uid)
        if not isinstance(item, dict):
            continue
        ids = {}
        for entry in item.get("articleids") or []:
            if isinstance(entry, dict) and entry.get("idtype"):
                ids[str(entry["idtype"])] = str(entry.get("value") or "")
        match = re.search(r"(1[89]\d{2}|20\d{2})", str(item.get("pubdate") or ""))
        records[str(uid)] = {
            "title": str(item.get("title") or "").strip(),
            "authors": ", ".join(
                str(person.get("name") or "").strip()
                for person in item.get("authors") or []
                if isinstance(person, dict) and person.get("name")
            ),
            "venue": str(item.get("source") or item.get("fulljournalname") or "").strip(),
            "year": int(match.group(1)) if match else None,
            "doi": ids.get("doi", ""),
            "pmid": ids.get("pmid", ""),
            "pmcid": ids.get("pmcid", ""),
        }
    return records


def _openalex_abstract(index: object) -> str:
    """OpenAlex 倒排摘要 → 正常文本（词 → 位置列表，还原顺序）。"""
    if not isinstance(index, dict) or not index:
        return ""
    slots: list[tuple[int, str]] = []
    for word, positions in index.items():
        if not isinstance(positions, list):
            continue
        for position in positions:
            if isinstance(position, int):
                slots.append((position, str(word)))
    slots.sort(key=lambda item: item[0])
    return " ".join(word for _, word in slots)


def _openalex_content_pdf(work: dict) -> str:
    """OpenAlex 缓存全文链接（content_urls.pdf）；形状随版本变化，取不到就返回空串。"""
    content = work.get("content_urls")
    if not isinstance(content, dict):
        return ""
    for key in ("pdf", "pdf_url"):
        value = content.get(key)
        if isinstance(value, str) and value.startswith("http"):
            return value
        if isinstance(value, dict):
            for inner in ("url", "download_url"):
                inner_value = value.get(inner)
                if isinstance(inner_value, str) and inner_value.startswith("http"):
                    return inner_value
    return ""


def _parse_openalex(body: str) -> list[dict]:
    """解析 OpenAlex /works JSON → 原始结果列表。"""
    try:
        payload = json.loads(body)
    except ValueError as error:
        raise SourceError(f"OpenAlex 响应不是合法 JSON：{_short(error)}") from error
    if isinstance(payload, dict) and payload.get("error"):
        raise SourceError(
            f"OpenAlex 拒绝本次请求：{_short(payload.get('message') or payload.get('error'))}",
            status=429 if "budget" in str(payload.get("message") or "").lower() or "rate" in str(payload.get("message") or "").lower() else 0,
            kind="rate_limited" if "budget" in str(payload.get("message") or "").lower() or "rate" in str(payload.get("message") or "").lower() else "error",
        )
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list):
        raise SourceError("OpenAlex 响应缺少 results 段")
    records = []
    for work in results:
        if not isinstance(work, dict):
            continue
        title = str(work.get("title") or work.get("display_name") or "").strip()
        if not title:
            continue
        authors = []
        for authorship in work.get("authorships") or []:
            if not isinstance(authorship, dict):
                continue
            raw_name = str(authorship.get("raw_author_name") or "").strip()
            author = authorship.get("author") if isinstance(authorship.get("author"), dict) else {}
            name = raw_name or str(author.get("display_name") or "").strip()
            if name:
                authors.append(name)
        location = work.get("primary_location") if isinstance(work.get("primary_location"), dict) else {}
        source = location.get("source") if isinstance(location.get("source"), dict) else {}
        venue = str(source.get("display_name") or "").strip()
        open_access = work.get("open_access") if isinstance(work.get("open_access"), dict) else {}
        best_oa = work.get("best_oa_location") if isinstance(work.get("best_oa_location"), dict) else {}
        links: list[dict] = []
        for url, label in (
            (best_oa.get("pdf_url"), "OA PDF"),
            (best_oa.get("landing_page_url"), "OA 落地页"),
            (open_access.get("oa_url"), "OA 链接"),
            (_openalex_content_pdf(work), "OA 缓存正文"),
        ):
            if isinstance(url, str) and url.startswith("http") and not any(item["url"] == url for item in links):
                links.append({"label": label, "url": url})
        landing = location.get("landing_page_url")
        result_url = ""
        for candidate in (landing, best_oa.get("landing_page_url"), work.get("doi"), work.get("id")):
            if isinstance(candidate, str) and candidate.startswith("http"):
                result_url = candidate
                break
        identifiers = work.get("ids") if isinstance(work.get("ids"), dict) else {}
        records.append({
            "title": title,
            "abstract": _openalex_abstract(work.get("abstract_inverted_index")),
            "authors": ", ".join(authors),
            "venue": venue,
            "year": work.get("publication_year") if isinstance(work.get("publication_year"), int) else None,
            "doi": str(work.get("doi") or ""),
            "result_url": result_url,
            "fulltext_links": links,
            "pmid": str(identifiers.get("pmid") or "").rstrip("/").rsplit("/", 1)[-1],
            "openalex_id": str(work.get("id") or ""),
        })
    return records


def _parse_europe_pmc(body: str) -> list[dict]:
    """解析 Europe PMC search JSON → 原始结果列表。"""
    try:
        payload = json.loads(body)
    except ValueError as error:
        raise SourceError(f"Europe PMC 响应不是合法 JSON：{_short(error)}") from error
    if isinstance(payload, dict) and payload.get("error"):
        raise SourceError(f"Europe PMC 拒绝本次请求：{_short(payload.get('error'))}")
    result_list = payload.get("resultList") if isinstance(payload, dict) else None
    results = result_list.get("result") if isinstance(result_list, dict) else None
    if results is None:
        results = []
    if not isinstance(results, list):
        raise SourceError("Europe PMC 响应缺少 resultList.result 段")
    records = []
    for item in results:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        journal_info = item.get("journalInfo") if isinstance(item.get("journalInfo"), dict) else {}
        journal = journal_info.get("journal") if isinstance(journal_info.get("journal"), dict) else {}
        venue = str(journal.get("medlineAbbreviation") or journal.get("title") or "").strip()
        year = item.get("pubYear")
        # Europe PMC 的 pubYear 在真实响应里是**字符串**（"2019"），不是 int——
        # 只认 int 会把年份整个丢掉，这里两种都收。
        if isinstance(year, str) and year.strip().isdigit():
            year = int(year.strip())
        if not isinstance(year, int):
            raw_year = journal_info.get("yearOfPublication")
            match = re.search(r"(1[89]\d{2}|20\d{2})", str(raw_year or ""))
            year = int(match.group(1)) if match else None
        authors = str(item.get("authorString") or "").strip()
        if not authors:
            author_list = item.get("authorList") if isinstance(item.get("authorList"), dict) else {}
            names = []
            for person in author_list.get("author") or []:
                if isinstance(person, dict) and person.get("fullName"):
                    names.append(str(person["fullName"]).strip())
            authors = ", ".join(names)
        pmcid = str(item.get("pmcid") or "").strip()
        source_id = str(item.get("id") or "").strip()
        source = str(item.get("source") or "MED").strip()
        links: list[dict] = []
        full_text = item.get("fullTextUrlList") if isinstance(item.get("fullTextUrlList"), dict) else {}
        for entry in full_text.get("fullTextUrl") or []:
            if not isinstance(entry, dict):
                continue
            url = str(entry.get("url") or "")
            if not url.startswith("http"):
                continue
            code = str(entry.get("availabilityCode") or "")
            if code not in {"OA", "F"}:
                continue
            style = str(entry.get("documentStyle") or "html")
            label = "OA PDF" if style == "pdf" else "OA 全文页"
            if not any(link["url"] == url for link in links):
                links.append({"label": label, "url": url})
        if pmcid:
            landing = f"https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/"
            if not any(link["url"] == landing for link in links):
                links.append({"label": "PMC 全文页", "url": landing})
        records.append({
            "title": title,
            "abstract": str(item.get("abstractText") or "").strip(),
            "authors": authors,
            "venue": venue,
            "year": year,
            "doi": str(item.get("doi") or ""),
            "result_url": f"https://europepmc.org/article/{source}/{source_id}" if source_id else "",
            "fulltext_links": links,
            "pmid": str(item.get("pmid") or "").strip(),
            "pmcid": pmcid,
        })
    return records


# ---------------------------------------------------------------------------
# 各来源的检索流程
# ---------------------------------------------------------------------------

def _pmc_landing(pmcid: str) -> str:
    return f"https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/" if pmcid else ""


def _run_pubmed(query: str, limit: int, year_from: int | None, year_to: int | None, page_index: int = 0) -> dict:
    """PubMed：esearch（PMID）→ efetch（题名/摘要/作者/期刊/年份/DOI）。"""
    requests: list[dict] = []
    search = search_request("pubmed", query, limit, year_from, year_to, page_index)
    requests.append(search)
    status, body = http_get(search["url"], search["params"])
    if status >= 400:
        raise SourceError(f"PubMed esearch 返回 HTTP {status}", status=status)
    try:
        payload = json.loads(body)
    except ValueError as error:
        raise SourceError(f"PubMed esearch 响应不是合法 JSON：{_short(error)}") from error
    result = payload.get("esearchresult") if isinstance(payload, dict) else None
    ids = [str(item) for item in (result or {}).get("idlist") or [] if str(item).strip()]
    if not ids:
        return {"status": "no_results", "url": _request_url(search), "results": [], "requests": requests, "count": 0}
    fetch = {
        "name": "efetch",
        "url": f"{EUTILS_BASE}efetch.fcgi",
        "params": _ncbi_params({"db": "pubmed", "id": ",".join(ids), "retmode": "xml"}),
    }
    requests.append(fetch)
    status, body = http_get(fetch["url"], fetch["params"])
    if status >= 400:
        raise SourceError(f"PubMed efetch 返回 HTTP {status}", status=status)
    parsed = _parse_pubmed_xml(body)
    results = []
    for pmid in ids:
        item = parsed.get(pmid)
        if not item:
            continue
        results.append({
            "title": item["title"],
            "abstract": item["abstract"],
            "authors": item["authors"],
            "venue": item["venue"],
            "year": item["year"],
            "doi": item["doi"],
            "result_url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            "fulltext_links": [],
            "pmid": pmid,
        })
    return {
        "status": "ok" if results else "no_results",
        "url": _request_url(search),
        "results": results,
        "requests": requests,
        "count": len(results),
    }


def _run_pmc(query: str, limit: int, year_from: int | None, year_to: int | None, page_index: int = 0) -> dict:
    """PMC：esearch（PMC 编号）→ esummary（题录 + OA 落地页）。

    刻意不拉 JATS 正文：discover 阶段只要题录，正文由 fulltext 阶段从 PMC 落地页取，
    避免为 10 条候选下载数百 KB 的 XML。
    """
    requests: list[dict] = []
    search = search_request("pmc", query, limit, year_from, year_to, page_index)
    requests.append(search)
    status, body = http_get(search["url"], search["params"])
    if status >= 400:
        raise SourceError(f"PMC esearch 返回 HTTP {status}", status=status)
    try:
        payload = json.loads(body)
    except ValueError as error:
        raise SourceError(f"PMC esearch 响应不是合法 JSON：{_short(error)}") from error
    result = payload.get("esearchresult") if isinstance(payload, dict) else None
    ids = [str(item) for item in (result or {}).get("idlist") or [] if str(item).strip()]
    if not ids:
        return {"status": "no_results", "url": _request_url(search), "results": [], "requests": requests, "count": 0}
    summary = {
        "name": "esummary",
        "url": f"{EUTILS_BASE}esummary.fcgi",
        "params": _ncbi_params({"db": "pmc", "id": ",".join(ids), "retmode": "json"}),
    }
    requests.append(summary)
    status, body = http_get(summary["url"], summary["params"])
    if status >= 400:
        raise SourceError(f"PMC esummary 返回 HTTP {status}", status=status)
    parsed = _parse_pmc_summary(body)
    results = []
    for pmc_id in ids:
        item = parsed.get(pmc_id)
        if not item:
            continue
        pmcid = item.get("pmcid") or f"PMC{pmc_id}"
        links = []
        landing = _pmc_landing(pmcid)
        if landing:
            links.append({"label": "PMC 全文页", "url": landing})
        results.append({
            "title": item["title"],
            "abstract": "",
            "authors": item["authors"],
            "venue": item["venue"],
            "year": item["year"],
            "doi": item["doi"],
            "result_url": landing or f"https://pmc.ncbi.nlm.nih.gov/articles/PMC{pmc_id}/",
            "fulltext_links": links,
            "pmid": item.get("pmid", ""),
            "pmcid": pmcid,
        })
    return {
        "status": "ok" if results else "no_results",
        "url": _request_url(search),
        "results": results,
        "requests": requests,
        "count": len(results),
    }


def _run_openalex(query: str, limit: int, year_from: int | None, year_to: int | None, page_index: int = 0) -> dict:
    """OpenAlex：单次 /works 检索（纯元数据 + 开放获取链接）。"""
    request = search_request("openalex", query, limit, year_from, year_to, page_index)
    status, body = http_get(request["url"], request["params"])
    if status >= 400:
        raise SourceError(f"OpenAlex 返回 HTTP {status}", status=status)
    results = _parse_openalex(body)
    return {
        "status": "ok" if results else "no_results",
        "url": _request_url(request),
        "results": results,
        "requests": [request],
        "count": len(results),
    }


def _run_europe_pmc(query: str, limit: int, year_from: int | None, year_to: int | None, page_index: int = 0) -> dict:
    """Europe PMC：单次 /search 检索（resultType=core，含摘要与 OA 全文链接）。"""
    request = search_request("europe-pmc", query, limit, year_from, year_to, page_index)
    status, body = http_get(request["url"], request["params"])
    if status >= 400:
        raise SourceError(f"Europe PMC 返回 HTTP {status}", status=status)
    results = _parse_europe_pmc(body)
    offset = int(request.get("_page_offset") or 0)
    if offset:
        results = results[offset:offset + limit]
    return {
        "status": "ok" if results else "no_results",
        "url": _request_url(request),
        "results": results,
        "requests": [request],
        "count": len(results),
    }


def _parse_semantic_scholar(body: str) -> list[dict]:
    """解析 Semantic Scholar paper/search 响应。"""
    try:
        payload = json.loads(body)
    except ValueError as error:
        raise SourceError(f"Semantic Scholar 响应不是合法 JSON：{_short(error)}") from error
    results: list[dict] = []
    for work in (payload.get("data") or []) if isinstance(payload, dict) else []:
        if not isinstance(work, dict):
            continue
        title = str(work.get("title") or "").strip()
        if not title:
            continue
        authors = [str((a or {}).get("name") or "") for a in (work.get("authors") or [])]
        external = work.get("externalIds") or {}
        doi = str(external.get("DOI") or "").strip()
        links: list[dict] = []
        oa = work.get("openAccessPdf") or {}
        if isinstance(oa, dict) and oa.get("url"):
            links.append({"label": "开放获取 PDF", "url": str(oa["url"])})
        results.append({
            "title": title,
            "abstract": str(work.get("abstract") or ""),
            "authors": ", ".join(a for a in authors if a),
            "venue": str(work.get("venue") or ""),
            "year": work.get("year"),
            "doi": doi,
            "result_url": str(work.get("url") or ""),
            "fulltext_links": links,
            "paperId": str(work.get("paperId") or ""),
        })
    return results


def _run_semantic_scholar(query: str, limit: int, year_from: int | None, year_to: int | None, page_index: int = 0) -> dict:
    """Semantic Scholar：单次 /paper/search 检索。

    无 key 也能用，但共享池限流很紧（429 常见）——所以这里带退避重试；
    有 SEMANTIC_SCHOLAR_API_KEY 时走专用配额，稳得多。
    """
    request = search_request("semantic-scholar", query, limit, year_from, year_to, page_index)
    api_key = os.environ.get("SEMANTIC_SCHOLAR_API_KEY", "").strip()
    headers = {"x-api-key": api_key} if api_key else None
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            status, body = http_get(request["url"], request["params"], headers=headers)
            if status >= 400:
                raise SourceError(f"Semantic Scholar 返回 HTTP {status}", status=status)
            results = _parse_semantic_scholar(body)
            return {
                "status": "ok" if results else "no_results",
                "url": _request_url(request),
                "results": results,
                "requests": [request],
                "count": len(results),
            }
        except SourceError as error:
            last_error = error
            if error.kind != "rate_limited" or attempt == 2:
                raise
            time.sleep(2.0 * (attempt + 1))
    raise last_error or SourceError("Semantic Scholar 检索失败")


_RUNNERS = {
    "pubmed": _run_pubmed,
    "pmc": _run_pmc,
    "openalex": _run_openalex,
    "europe-pmc": _run_europe_pmc,
    "semantic-scholar": _run_semantic_scholar,
}


def supports(source_key: object) -> bool:
    """该 key 是否由本模块负责（开放 API 来源）。"""
    return isinstance(source_key, str) and source_key in _RUNNERS


def run(
    source_key: str,
    query: str,
    limit: int,
    year_from: int | None = None,
    year_to: int | None = None,
    page_index: int = 0,
) -> dict:
    """执行一次开放 API 检索。

    返回 ``{"status": "ok"|"no_results", "url", "results", "requests", "count"}``；
    失败抛 :class:`SourceError`（含 HTTP 状态与失败类型）。
    """
    if not supports(source_key):
        raise ValueError(f"未支持的开放来源：{source_key}")
    text = str(query or "").strip()
    if not text:
        raise ValueError("检索式为空")
    runner = _RUNNERS[source_key]
    return runner(text, max(1, min(int(limit or 1), MAX_RESULTS)), year_from, year_to, max(0, int(page_index or 0)))


if __name__ == "__main__":  # pragma: no cover - 手工联调用
    import argparse

    parser = argparse.ArgumentParser(description="开放 API 文献检索（联调用）")
    parser.add_argument("--source", required=True, choices=list(SUPPORTED_SOURCES))
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--year-from", type=int)
    parser.add_argument("--year-to", type=int)
    parser.add_argument("--page-index", type=int, default=0)
    args = parser.parse_args()
    try:
        outcome = run(args.source, args.query, args.limit, args.year_from, args.year_to, args.page_index)
    except SourceError as error:
        print(json.dumps({"status": "error", "message": str(error), "kind": error.kind}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps(outcome, ensure_ascii=False, indent=2))
