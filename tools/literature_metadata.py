"""Bounded, resumable original-abstract acquisition before title/abstract screening.

Only explicit article abstract fields qualify. Search previews, whole-page text,
PDF text and meta descriptions never become abstracts. Candidate and dedupe
files stay immutable; verified evidence is written to metadata/status.json.
"""
from __future__ import annotations

import argparse
import copy
import importlib
import ipaddress
import json
from pathlib import Path
import re
import time
from urllib.parse import quote, urlsplit

from literature_identity import digest, identity, exact_match
from literature_fulltext_browser import _VERIFICATION_FUNCTION_JS, sanitize_verification_evidence

common = importlib.import_module("literature-common")
VERSION = "article-metadata-v1"
ACCESS_REASONS = {"verification", "login", "access_required", "rate_limited", "access_blocked"}
TERMINAL = {"verified", "missing", "identity_mismatch", "abstract_incomplete", "no_entry"}
ALLOWED_ABSTRACT_METHODS = {"explicit_abstract_dom", "citation_abstract_meta"}
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def string(value):
    return value.strip() if isinstance(value, str) else ""


def record_hash(record):
    # All scalars are strings: identical JSON hashing in Python and JavaScript.
    authors = record.get("authors") or ""
    if isinstance(authors, list):
        authors = ";".join(str(a.get("name") or "") if isinstance(a, dict) else str(a) for a in authors)
    return digest([string(record.get(k)) for k in
                   ("candidate_id", "source_key", "title", "doi", "source_url", "result_url", "abstract_url")]
                  + [str(record.get("year") or ""), str(authors), identity(record)["source_ids"]])


def public_url(value):
    from literature_browser import safe_url
    url = safe_url(value)
    if not url:
        return ""
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.port not in (None, 80, 443) or host == "localhost" or "." not in host or host.endswith((".local", ".internal", ".localhost")):
            return ""
        try:
            if not ipaddress.ip_address(host).is_global:
                return ""
        except ValueError:
            pass
        return url
    except ValueError:
        return ""


def article_urls(record):
    result = []
    for key in ("abstract_url", "source_url", "result_url"):
        url = public_url(record.get(key))
        if not url:
            continue
        parsed = urlsplit(url)
        if ("scholar.google" in (parsed.hostname or "") or
                re.search(r"(?:^|/)(?:search|results?|download|pdf|epdf|pdfplus)(?:[/.]|$)|\.pdf$", parsed.path, re.I)):
            continue
        if url not in result:
            result.append(url)
    doi = identity(record)["doi"]
    if re.fullmatch(r"10\.\d{4,9}/[^\s<>\"#?]+", doi):
        url = "https://doi.org/" + quote(doi, safe="/():;._-")
        if url not in result:
            result.append(url)
    return result


def existing_abstract(record):
    # Legacy trusted imports used snippet as the carrier. Raw search snippets
    # are never accepted, regardless of their apparent length or content.
    abstract = string(record.get("abstract")) or (string(record.get("snippet")) if
        record.get("evidence_level") in {"imported_abstract", "source_abstract", "verified_abstract"} else "")
    if (record.get("abstract_complete") is False or record.get("abstract_truncated") is True
            or re.search(r"(?:\.{3}|…|read more|show more|展开|更多)\s*$", abstract, re.I)):
        return ""
    return abstract


def snapshot_identity(snapshot, url, source=None):
    """Use the same observed identity for readiness and final verification."""
    observed_record = {key: snapshot.get(key) for key in ("title", "doi", "year", "authors", "source_identifiers")}
    host = (urlsplit(url).hostname or "").lower()
    official_native = ((source == "scopus" and (host == "scopus.com" or host.endswith(".scopus.com")))
                       or (source == "cnki" and host == "kns.cnki.net"))
    observed_record.update(source_key=source, source_url=url if official_native else "")
    return identity(observed_record)


def sanitize_metadata_diagnostic(value):
    """Persist field presence and timing only; never page text or URL tokens."""
    if not isinstance(value, dict):
        return {}
    result = {}
    for key in ("title_present", "doi_present", "source_id_present", "year_present", "authors_present", "abstract_present", "identity_ready", "abstract_expand_attempted", "abstract_expand_failed"):
        if isinstance(value.get(key), bool):
            result[key] = value[key]
    for key in ("polls", "stable_polls", "elapsed_ms", "remaining_ms"):
        if type(value.get(key)) is int:
            result[key] = min(3600000, max(0, value[key]))
    if value.get("ready_state") in {"loading", "interactive", "complete", "unknown"}:
        result["ready_state"] = value["ready_state"]
    if value.get("phase") in {"navigation", "metadata"}:
        result["phase"] = value["phase"]
    return result


def verify_snapshot(record, snapshot, url):
    """Pure identity/completeness validator; no access to network or snippets."""
    original = identity(record)
    observed = snapshot_identity(snapshot, url, record.get("source_key"))
    match = exact_match(original, observed)
    # Even a matching DOI on an unrelated page/recommendation is insufficient.
    if not original["title"] or original["title"] != observed["title"] or not match:
        return {"status": "identity_mismatch", "reason": "article_identity_not_verified",
                "observed_identity": observed}
    abstract = string(snapshot.get("abstract"))
    if not abstract:
        return {"status": "missing", "reason": "explicit_abstract_not_available", "observed_identity": observed}
    method = snapshot.get("abstract_method")
    if (method not in ALLOWED_ABSTRACT_METHODS or snapshot.get("abstract_complete") is not True
            or len(abstract) < 40 or re.search(r"(?:\.{3}|…|read more|show more|more abstract|展开|更多)\s*$", abstract, re.I)):
        return {"status": "abstract_incomplete", "reason": "explicit_abstract_incomplete",
                "observed_identity": observed}
    keywords = [s.strip() for s in snapshot.get("keywords", []) if isinstance(s, str) and s.strip()] if isinstance(snapshot.get("keywords"), list) else []
    payload = {"abstract": abstract, "keywords": list(dict.fromkeys(keywords)),
               "source_url": public_url(url), "abstract_method": method,
               "abstract_selector": string(snapshot.get("abstract_selector")),
               "keyword_method": string(snapshot.get("keyword_method")),
               "expected_identity": original, "observed_identity": observed, "identity_match": match,
               "abstract_complete": True, "fetched_at": common.now_iso()}
    return {"status": "verified", "reason": "original_abstract_verified", "evidence": payload,
            "evidence_sha256": digest(payload)}


def read_status(job_dir):
    file = Path(job_dir) / "metadata" / "status.json"
    if not file.exists():
        return {"version": VERSION, "items": {}, "history": []}
    value = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("version") != VERSION or not isinstance(value.get("items"), dict):
        raise ValueError("摘要回源记录不可核验，请检查 metadata/status.json。")
    return value


def validated_evidence(record, entry):
    if not isinstance(entry, dict) or entry.get("status") != "verified" or entry.get("record_sha256") != record_hash(record):
        return None
    evidence = entry.get("evidence")
    if not isinstance(evidence, dict) or entry.get("evidence_sha256") != digest(evidence):
        return None
    if evidence.get("expected_identity") != identity(record):
        return None
    observed = evidence.get("observed_identity") or {}
    expected = evidence["expected_identity"]
    match = exact_match(expected, observed)
    if (not match or match != evidence.get("identity_match") or not expected["title"] or expected["title"] != observed.get("title")
            or evidence.get("abstract_complete") is not True or evidence.get("abstract_method") not in ALLOWED_ABSTRACT_METHODS
            or not public_url(evidence.get("source_url")) or not string(evidence.get("abstract"))):
        return None
    return evidence


def merge_record(record, state):
    entry = (state or {}).get("items", {}).get(string(record.get("candidate_id")))
    evidence = validated_evidence(record, entry)
    if not evidence or existing_abstract(record):
        return record
    result = copy.deepcopy(record)
    result.update(abstract=evidence["abstract"], evidence_level="verified_abstract", abstract_complete=True, abstract_truncated=False)
    result["metadata_keywords"] = evidence["keywords"]
    result["metadata_evidence"] = {"path": "metadata/status.json", "source_url": evidence["source_url"],
                                   "sha256": entry["evidence_sha256"], "identity_match": evidence["identity_match"]}
    return result


METADATA_SNAPSHOT_JS = r"""/* literature_metadata_snapshot */ () => {
  const visible = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)
    && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const txt = e => (e?.innerText || '').trim();
  const metas = name => Array.from(document.querySelectorAll('meta')).filter(e =>
    (e.name || e.getAttribute('property') || '').toLowerCase() === name.toLowerCase()).map(e => e.content?.trim()).filter(Boolean);
  const meta = names => names.map(metas).flat().find(Boolean) || '';
  const title = meta(['citation_title','dc.title']) || txt(Array.from(document.querySelectorAll('h1')).find(visible));
  let doi = meta(['citation_doi','prism.doi','article:doi']) || meta(['dc.identifier']).match(/10\.\d{4,9}\/[^\s<>]+/)?.[0] || '';
  let year = meta(['citation_publication_date','citation_date','dc.date','prism.publicationDate']).match(/(?:19|20)\d{2}/)?.[0] || '';
  let authors = metas('citation_author').length ? metas('citation_author') : metas('dc.creator');
  // CNKI detail pages do not consistently publish citation meta tags. Read
  // only their explicit bibliographic elements, never references or body text.
  const cnkiDetail = typeof location !== 'undefined' && location.protocol === 'https:'
    && location.hostname === 'kns.cnki.net' && /^\/(?:kcms2?\/article\/abstract|kcms\/detail\/detail\.aspx)/i.test(location.pathname);
  if (cnkiDetail) {
    const articleField = e => visible(e) && !e.closest('aside,nav,.references,.related-articles,.search-results');
    if (!authors.length) {
      // The surrounding .author containers can also contain affiliations.
      // Prefer CNKI's dedicated author list over their combined descendants.
      const authorLinks=Array.from(document.querySelectorAll('#authorpart a')).filter(articleField);
      const fallbackLinks=authorLinks.length ? authorLinks : Array.from(document.querySelectorAll('.wx-tit .author a,.brief .author a'))
        .filter(e=>!e.closest('.org,.orgn,.organization,.institution,.affiliation'));
      authors=fallbackLinks
        .filter(articleField).map(e=>{const c=e.cloneNode(true);c.querySelectorAll('sup').forEach(s=>s.remove());return (c.textContent||'').trim();})
        .filter(Boolean);
      authors=[...new Set(authors)];
    }
    if (!year) {
      const bibliographic=Array.from(document.querySelectorAll('.top-tip,.wx-tit .source,.brief .source,[data-field="publication-date"]')).filter(articleField);
      year=bibliographic.map(txt).map(t=>t.match(/(?:19|20)\d{2}/)?.[0]).find(Boolean)||'';
    }
    if (!doi) {
      const fields=Array.from(document.querySelectorAll('#DOI,#doi,.doi,[data-field="doi"],.brief .row')).filter(articleField);
      doi=fields.map(txt).filter(t=>/^DOI\s*[:：]/i.test(t)||/^10\.\d{4,9}\//.test(t))
        .map(t=>t.match(/10\.\d{4,9}\/[^\s<>]+/)?.[0]).find(Boolean)||'';
    }
  }
  const source_identifiers = {};
  for (const [name,key] of [['citation_pmid','pubmed'],['citation_eid','scopus'],['citation_wos_id','web-of-science'],['citation_cnki_id','cnki']]) {
    const value=meta([name]); if(value) source_identifiers[key]=value;
  }
  let abstract='', abstract_method='', abstract_selector='', abstract_complete=false;
  const root = Array.from(document.querySelectorAll('article,main,[role="main"]')).find(e=>visible(e)&&e.querySelector('.abstract,#abstract,[itemprop="abstract"]')) || document;
  const selectors=['#enc-abstract','.abstract-content','.abstract__content','[itemprop="abstract"]','#ChDivSummary','#Abs1-content','#html-abstract','.html-abstract','.article-section__abstract','#abstract','.abstract','section[aria-label="Abstract"]','section[data-title="Abstract"]'];
  for (const selector of selectors) {
    const regions=Array.from(root.querySelectorAll(selector)).filter(visible).filter(e=>!e.closest('aside,nav,.references,.related-articles,.search-results'));
    if(!regions.length) continue;
    const region=regions.sort((a,b)=>txt(b).length-txt(a).length)[0];
    const clone=region.cloneNode(true);
    clone.querySelectorAll('button,script,style,.keywords,.keyword').forEach(e=>e.remove());
    clone.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(e=>{if(/^(?:Abstract|摘要)\s*[:：]?$/i.test((e.textContent||'').trim()))e.remove();});
    // Use the complete explicit region text, never the page body or description.
    const text=(clone.textContent||'').trim().replace(/^\s*(?:Abstract|摘要)\s*[:：]?\s*/i,'');
    if(text.length<40)continue;
    const wrapper=region.closest('.abstract,#abstract,[itemprop="abstract"],section[aria-label="Abstract"]') || region;
    const style=getComputedStyle(region), controls=Array.from(wrapper.querySelectorAll('button,a,[role="button"]')).filter(visible).map(txt).join(' ');
    const clipped=!!wrapper.querySelector('[aria-expanded="false"]') || !!region.closest('[aria-expanded="false"]') || /(?:read|show)\s+more|展开|更多/i.test(controls)
      || (style.webkitLineClamp && !['none','0'].includes(style.webkitLineClamp))
      || (['hidden','clip'].includes(style.overflowY) && region.scrollHeight > region.clientHeight+2);
    abstract=text;abstract_method='explicit_abstract_dom';abstract_selector=selector;abstract_complete=!clipped;break;
  }
  if(!abstract) {
    const value=meta(['citation_abstract']);
    if(value){abstract=value;abstract_method='citation_abstract_meta';abstract_selector='meta[name="citation_abstract"]';abstract_complete=true;}
  }
  const keywords=[];
  for(const name of ['citation_keywords','keywords','dc.subject']) for(const value of metas(name))
    for(const term of value.split(/[;；|]/)){if(term.trim()&&!keywords.includes(term.trim()))keywords.push(term.trim());}
  let keyword_method=keywords.length?'explicit_keyword_meta':'';
  for(const region of root.querySelectorAll('.keywords,.keyword-group,[itemprop="keywords"],#Keywords')) {
    if(!visible(region)||region.closest('aside,nav,.related-articles,.search-results'))continue;
    const leaves=Array.from(region.querySelectorAll('.keyword,[itemprop="keyword"],a')).filter(visible);
    const terms=leaves.length?leaves.map(txt):txt(region).replace(/^\s*(?:Author\s+)?Keywords?\s*[:：]?|^\s*关键词\s*[:：]?/i,'').split(/[;,；，|\n]/);
    for(const term of terms){if(term.trim()&&!keywords.includes(term.trim()))keywords.push(term.trim());}
    if(terms.some(t=>t.trim()))keyword_method=keyword_method?'explicit_keyword_meta_and_dom':'explicit_keyword_dom';
  }
  const prefix=txt(document.body).slice(0,4000);
  const verificationState=(__VERIFICATION_FUNCTION__)({
    articleText:abstract,citationTitle:meta(['citation_title','dc.title'])
  });
  return {title,doi,year,authors,source_identifiers,abstract,abstract_method,abstract_selector,abstract_complete,
    keywords,keyword_method,ready_state:document.readyState,
    verification:verificationState.verification,verification_evidence:verificationState.verification_evidence,
    rate_limited:/too many requests|请求过于频繁|访问过于频繁|操作过于频繁|rate limit/i.test(prefix),
    login:Array.from(document.querySelectorAll('input[type="password"]')).some(visible)
      || /请先登录|请登录后|sign in to access|log in to access|please sign in|please log in/i.test(prefix),
    access_required:/您所在的机构未订购|没有访问权限|无访问权限|not entitled|subscription required|you do not have access|not authorized to access/i.test(prefix),
    page_error:/^\s*(?:404|page not found|页面不存在)/i.test(document.title||'')};
}""".replace("__VERIFICATION_FUNCTION__", _VERIFICATION_FUNCTION_JS)


class MetadataBrowserFetcher:
    """Only article navigation and read-only DOM, with a separate task tab."""
    def __init__(self, config, job_dir, *, on_progress=None):
        from literature_fulltext_browser import FulltextBrowserFetcher
        self.browser = FulltextBrowserFetcher(config, Path(job_dir) / "metadata" / "browser", on_progress=on_progress)

    def close(self):
        self.browser.close()

    def complete_record(self, record, item):
        """Close this completed metadata lookup only after its record is saved."""
        if record.get("source_key") != "cnki":
            return {"closed": True}
        if item.get("status") not in TERMINAL:
            return {"closed": False}
        from literature_cnki_fulltext import _hash, _norm
        target = {**record, "source_candidate_id": record.get("source_candidate_id") or record.get("candidate_id")}
        binding = self.browser._binding
        flow = binding.get("cnki_flow") or {}
        if not flow and not binding.get("target_id"):
            return {"closed": True}
        if (not isinstance(flow, dict)
                or flow.get("paper_hash") != _hash("\n".join(str(target.get(key) or "") for key in
                    ("source_key", "source_candidate_id", "paper_id", "id")))
                or flow.get("title_hash") != _hash(_norm(target.get("title")))
                or binding.get("pdf_click_pending") or flow.get("file_verified")
                or flow.get("step") == "download_clicked" or flow.get("download_click_count")
                or flow.get("download_click_target_ids")
                or (flow.get("pending_popup") or {}).get("action") == "download"):
            return {"closed": False}
        result = self.browser.complete_paper()
        if result.get("closed"):
            self.browser._progress("摘要证据已保存，已关闭本篇详情页及对应的检索页。")
        return result

    def _read_metadata(self, page, deadline, *, status=0, downloads=None, cnki=False):
        previous, stable, snapshot = None, 0, None
        expanded = False
        expansion_failed = False
        ready = False
        started, polls = time.monotonic(), 0
        observed = identity({})

        def diagnostic():
            return sanitize_metadata_diagnostic({"phase": "metadata", "polls": polls, "stable_polls": stable,
                "elapsed_ms": int((time.monotonic() - started) * 1000),
                "remaining_ms": int((deadline - time.monotonic()) * 1000),
                "ready_state": (snapshot or {}).get("ready_state", "unknown"),
                "title_present": bool(observed["title"]), "doi_present": bool(observed["doi"]),
                "source_id_present": bool(observed["source_ids"]), "year_present": bool(observed["year"]),
                "authors_present": bool(observed["authors"]), "abstract_present": bool(string((snapshot or {}).get("abstract"))),
                "identity_ready": ready, "abstract_expand_attempted": expanded,
                "abstract_expand_failed": expansion_failed})

        while time.monotonic() < deadline:
            if downloads:
                return {"status": "missing", "reason": "pdf_not_metadata_page"}
            snapshot = page.evaluate(METADATA_SNAPSHOT_JS)
            polls += 1
            reason = "verification" if snapshot.get("verification") else self.browser._reason(snapshot, status)
            if reason:
                result = {"status": "attention" if reason in ACCESS_REASONS else "missing", "reason": reason,
                          "url": public_url(page.url)}
                if reason == "verification":
                    result["verification_evidence"] = sanitize_verification_evidence(snapshot.get("verification_evidence"))
                if reason in ACCESS_REASONS:
                    self.browser._blocked = result
                return result
            if not public_url(page.url):
                return {"status": "attention", "reason": "login", "url": ""}
            if cnki:
                from literature_cnki_fulltext import _official
                if not _official(page.url):
                    return {"status": "attention", "reason": "access_blocked", "url": ""}
                # Use only CNKI's specific original-abstract expansion control.
                # It reveals the article's own abstract, never a PDF or a search
                # preview. Do this once, within the same record time budget.
                truncated = (snapshot.get("abstract_complete") is False or
                    bool(re.search(r"(?:\.{3}|…)\s*$", string(snapshot.get("abstract")))))
                if truncated and not expanded and callable(getattr(page, "locator", None)):
                    control = page.locator("#ChDivSummaryMore")
                    remaining_ms = int((deadline - time.monotonic()) * 1000)
                    if remaining_ms > 250:
                        try:
                            if (control.count() == 1 and control.is_visible()
                                    and re.fullmatch(r"\s*(?:更多|展开|展开全部)\s*", control.inner_text(timeout=min(1500, remaining_ms)))):
                                expanded = True
                                remaining_ms = int((deadline - time.monotonic()) * 1000)
                                if remaining_ms <= 250:
                                    continue
                                control.click(timeout=min(5000, remaining_ms))
                                previous, stable = None, 0
                                continue
                        except Exception:
                            # An unavailable control cannot authorize using a
                            # clipped abstract. The final validator still rejects it.
                            expanded = True
                            expansion_failed = True
            observed = snapshot_identity(snapshot, page.url, "cnki" if cnki else None)
            # Stable empty shells and title-only loading pages do not prove
            # an unavailable abstract or a different article.
            ready = bool(observed["title"] and (observed["doi"] or observed["source_ids"]
                         or (observed["year"] and observed["authors"])))
            # An ahead-of-print article can have an explicit author list and
            # complete abstract but no publication year/DOI. Its page has
            # loaded; final identity verification must still fail closed and
            # send the record to pending, rather than retrying an empty shell.
            detail_ready = bool(cnki and observed["title"] and observed["authors"]
                                and snapshot.get("abstract_method") in ALLOWED_ABSTRACT_METHODS
                                and snapshot.get("abstract_complete") is True
                                and len(string(snapshot.get("abstract"))) >= 40)
            signature = digest(snapshot)
            stable = stable + 1 if signature == previous else 0
            if (ready or detail_ready) and snapshot.get("ready_state") == "complete" and stable >= 2 and string(snapshot.get("abstract")):
                return {"status": "ok", "url": public_url(page.url), "snapshot": snapshot, "metadata_diagnostic": diagnostic()}
            previous = signature
            page.wait_for_timeout(min(500, max(1, int((deadline-time.monotonic())*1000))))
        if ready and snapshot.get("ready_state") == "complete" and stable >= 2:
            return {"status": "ok", "url": public_url(page.url), "snapshot": snapshot, "metadata_diagnostic": diagnostic()}
        return {"status": "attention", "reason": "page_not_ready", "url": public_url(page.url),
                "metadata_diagnostic": diagnostic(),
                "message": "原页面尚未提供可核对的文献身份，断点保留；未将空页面判为缺摘要或身份不符。"}

    def fetch_record(self, record, url, timeout_sec=30):
        if record.get("source_key") != "cnki":
            return self.fetch(url, timeout_sec=timeout_sec)
        deadline = time.monotonic() + timeout_sec
        # CNKI's old opaque article links may no longer resolve. Reuse the
        # normal exact-title UI locator in a mode that cannot scan materials,
        # click PDF controls, read file bodies, or resume prior download state.
        target_record = {**record, "source_candidate_id": record.get("source_candidate_id") or record.get("candidate_id")}
        result = self.browser.fetch_cnki(target_record, {"metadata_only": True, "metadata_timeout_sec": timeout_sec})
        if result.get("status") != "ok":
            if result.get("status") == "fetch_error":
                return {"status": "attention", "reason": "page_not_ready", "url": public_url(result.get("url")),
                        "message": "知网摘要任务页暂未连接，断点保留待继续。"}
            return result
        if result.get("metadata_only") is not True:
            return {"status": "attention", "reason": "page_error", "message": "摘要定位返回未经确认的页面模式，未读取全文。"}
        page = self.browser._page
        downloads = []
        def cancel_download(download):
            downloads.append(True)
            try:
                download.cancel()
            except Exception:
                pass
        try:
            page.on("download", cancel_download)
            observed = self._read_metadata(page, deadline, downloads=downloads, cnki=True)
            observed["navigation_method"] = "cnki_exact_title_ui"
            return observed
        except Exception:
            return {"status": "attention", "reason": "page_not_ready", "url": public_url(getattr(page, "url", ""))}
        finally:
            if page is not None:
                try:
                    page.remove_listener("download", cancel_download)
                except Exception:
                    pass

    def fetch(self, url, timeout_sec=30):
        browser = self.browser
        if browser._blocked:
            return dict(browser._blocked)
        target = public_url(url)
        if not target:
            return {"status": "missing", "reason": "unsafe_or_non_article_entry"}
        deadline = time.monotonic() + timeout_sec
        page = None
        downloads = []
        rejected_navigation = []
        def cancel_download(download):
            downloads.append(True)
            try:
                download.cancel()
            except Exception:
                pass
        def guard_navigation(route):
            request = route.request
            if request.is_navigation_request() and not public_url(request.url):
                rejected_navigation.append(True)
                route.abort()
            else:
                route.continue_()
        try:
            page = browser._get_page()
            page.on("download", cancel_download)
            page.route("**/*", guard_navigation)
            browser._pace(target)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"status": "attention", "reason": "page_not_ready"}
            response = None
            try:
                response = page.goto(target, wait_until="domcontentloaded", timeout=max(1, int(remaining * 1000)))
            except Exception:
                # A timeout may still leave usable article metadata; examine
                # only this owned page within the original deadline.
                pass
            browser._record_destination(page.url or target)
            if rejected_navigation:
                return {"status": "attention", "reason": "access_blocked", "url": ""}
            status = int(getattr(response, "status", 0) or 0)
            headers = getattr(response, "headers", {}) or {}
            if downloads or "application/pdf" in headers.get("content-type", "").lower():
                return {"status": "missing", "reason": "pdf_not_metadata_page"}
            return self._read_metadata(page, deadline, status=status, downloads=downloads)
        except Exception:
            return {"status": "attention", "reason": "page_not_ready", "message": "摘要页面暂未就绪，保留断点待继续核对。"}
        finally:
            if page is not None:
                try:
                    page.remove_listener("download", cancel_download)
                    page.unroute("**/*", guard_navigation)
                except Exception:
                    pass


def run(config, job_dir, *, total_budget_sec=300, per_record_timeout_sec=30, retry_attention=False, retry_unavailable=False,
        fetcher=None, clock=time.monotonic, on_event=None, only=None):
    job_dir = Path(job_dir)
    emit = on_event or common.emit
    state = read_status(job_dir)
    candidate_file = job_dir / "candidates.json"
    candidates = json.loads(candidate_file.read_text(encoding="utf-8"))
    records = candidates.get("records", candidates.get("results"))
    if not isinstance(records, list) or any(not isinstance(r, dict) or not ID.fullmatch(string(r.get("candidate_id"))) for r in records):
        raise ValueError("原始候选题录结构或标识无效。")
    if len({r["candidate_id"] for r in records}) != len(records):
        raise ValueError("候选题录标识重复，不能合并回源证据。")
    all_records = records
    if only is not None:
        if (not isinstance(only, list) or not only
                or any(not isinstance(cid, str) or not ID.fullmatch(cid) for cid in only)
                or len(set(only)) != len(only)
                or not set(only).issubset({r["candidate_id"] for r in records})):
            raise ValueError("摘要回源批次须为当前候选中非空、无重复的文献编号集合。")
        selected = set(only)
        records = [r for r in records if r["candidate_id"] in selected]
    total_budget_sec = max(1, min(3600, float(total_budget_sec)))
    per_record_timeout_sec = max(1, min(60, float(per_record_timeout_sec)))
    started = clock()
    attempted = 0
    stop_reason = ""
    stop_message = ""
    stop_verification_evidence = []
    last_metadata_diagnostic = {}
    state.setdefault("history", [])
    def save():
        state["updated_at"] = common.now_iso()
        state["last_stop_reason"] = stop_reason
        state["last_stop_message"] = stop_message
        state["last_verification_evidence"] = stop_verification_evidence
        state["last_metadata_diagnostic"] = last_metadata_diagnostic
        common.atomic_write_json(job_dir / "metadata" / "status.json", state)
    needs = [r for r in records if not existing_abstract(r)]
    pending = []
    for record in needs:
        item = state["items"].get(record["candidate_id"], {})
        same = item.get("record_sha256") == record_hash(record)
        observed = item.get("observed_identity")
        # Migrate only the known old empty-shell outcome, and only when the
        # caller explicitly resumed. A real conflicting identity is untouched.
        retry_empty_shell = (retry_attention and item.get("status") == "identity_mismatch"
            and item.get("reason") == "article_identity_not_verified" and isinstance(observed, dict)
            and "title" in observed and not any(observed.get(key) for key in ("title", "doi", "source_ids", "year", "authors")))
        if same and not item.get("cleanup_pending") and (validated_evidence(record, item) or (not retry_unavailable and not retry_empty_shell and item.get("status") in TERMINAL - {"verified"})):
            continue
        pending.append(record)
    if state.get("last_stop_reason") in ACCESS_REASONS and (pending or only is not None) and not retry_attention:
        result = {"ok": True, "complete": False, "stop_reason": state["last_stop_reason"], "pending_count": len(pending),
                  "attempted": 0, "message": "回源访问限制仍登记在案；原摘要缺口保留待定，需显式重试才再次访问。"}
        if state["last_stop_reason"] == "verification":
            result["verification_evidence"] = sanitize_verification_evidence(state.get("last_verification_evidence"))
        emit("result", stage="metadata", **result)
        return result
    own_fetcher = fetcher is None
    try:
        for record in pending:
            if clock() - started >= total_budget_sec:
                stop_reason = "total_budget_exhausted"
                break
            cid = record["candidate_id"]
            previous = state["items"].get(cid, {})
            if previous.get("cleanup_pending") and previous.get("record_sha256") == record_hash(record):
                if fetcher is None:
                    fetcher = MetadataBrowserFetcher(config, job_dir, on_progress=lambda msg: emit("stage", stage="metadata", message=msg))
                complete = getattr(fetcher, "complete_record", None)
                closed = complete(record, previous) if callable(complete) else {"closed": False}
                if not isinstance(closed, dict) or closed.get("closed") is not True:
                    stop_reason, stop_message = "page_error", "本篇摘要已保存，但检索页尚未关闭；保留清理断点，未开始下一篇。"
                    break
                previous.pop("cleanup_pending", None)
                save()
                continue
            urls = article_urls(record)
            if record.get("source_key") == "cnki" and string(record.get("title")):
                urls = urls[:1] or ["https://kns.cnki.net/"]
            item = {"candidate_id": cid, "record_sha256": record_hash(record), "status": "no_entry", "reason": "no_official_article_entry", "attempts": []}
            if fetcher is None and urls:
                fetcher = MetadataBrowserFetcher(config, job_dir, on_progress=lambda msg: emit("stage", stage="metadata", message=msg))
            paper_started = clock()
            for url in urls:
                remaining = min(total_budget_sec - (clock()-started), per_record_timeout_sec - (clock()-paper_started))
                if remaining <= 0:
                    stop_reason = "page_not_ready"
                    item.update(status="attention", reason=stop_reason)
                    break
                attempted += 1
                emit("stage", stage="metadata", paper_id=cid, message="回源核对完整摘要与关键词。")
                fetch_record = getattr(fetcher, "fetch_record", None)
                result = fetch_record(record, url, timeout_sec=remaining) if callable(fetch_record) else fetcher.fetch(url, timeout_sec=remaining)
                item["attempts"].append({"url": public_url(url), "status": result.get("status"), "reason": result.get("reason", ""), "at": common.now_iso()})
                last_metadata_diagnostic = sanitize_metadata_diagnostic(result.get("metadata_diagnostic"))
                if last_metadata_diagnostic:
                    item["metadata_diagnostic"] = last_metadata_diagnostic
                    item["attempts"][-1]["metadata_diagnostic"] = last_metadata_diagnostic
                verification_evidence = sanitize_verification_evidence(result.get("verification_evidence")) if result.get("reason") == "verification" else []
                if verification_evidence:
                    item["attempts"][-1]["verification_evidence"] = verification_evidence
                if result.get("navigation_method"):
                    item["attempts"][-1].update(navigation_method=result["navigation_method"], resolved_url=public_url(result.get("url")))
                if result.get("status") == "attention":
                    stop_reason = result.get("reason") or "access_blocked"
                    stop_message = string(result.get("message"))
                    item.update(status="attention", reason=stop_reason)
                    if stop_reason == "verification":
                        stop_verification_evidence = verification_evidence
                        item["verification_evidence"] = verification_evidence
                    if stop_message:
                        item["message"] = stop_message
                    break
                if result.get("status") == "ok":
                    verified = verify_snapshot(record, result.get("snapshot") or {}, result.get("url") or url)
                    item.update(verified)
                    if verified["status"] == "verified":
                        break
                else:
                    item.update(status="missing", reason=result.get("reason") or "metadata_page_unavailable")
            old = state["items"].get(cid)
            if old:
                state["history"].append(old)
            state["items"][cid] = item
            save()
            if item.get("status") == "attention":
                break
            complete = getattr(fetcher, "complete_record", None)
            if item.get("attempts") and callable(complete):
                try:
                    closed = complete(record, item)
                except Exception:
                    closed = {"closed": False}
                if not isinstance(closed, dict) or closed.get("closed") is not True:
                    item["cleanup_pending"] = True
                    stop_reason, stop_message = "page_error", "本篇摘要已保存，但检索页尚未关闭；保留清理断点，未开始下一篇。"
                    save()
                    break
    finally:
        if own_fetcher and fetcher is not None:
            fetcher.close()
    remaining_records = [r for r in needs if state["items"].get(r["candidate_id"], {}).get("record_sha256") != record_hash(r)
                         or state["items"].get(r["candidate_id"], {}).get("status") == "attention"
                         or state["items"].get(r["candidate_id"], {}).get("cleanup_pending")]
    def counts_for(rows):
        missing = [r for r in rows if not existing_abstract(r)]
        verified = sum(bool(validated_evidence(r, state["items"].get(r["candidate_id"]))) for r in missing)
        unresolved = sum(not (state["items"].get(r["candidate_id"], {}).get("record_sha256") == record_hash(r)
                         and (validated_evidence(r, state["items"].get(r["candidate_id"]))
                              or state["items"].get(r["candidate_id"], {}).get("status") in TERMINAL - {"verified"}))
                         for r in missing)
        return {"candidate_records": len(rows), "already_have_abstract": len(rows)-len(missing),
                "verified": verified, "pending": unresolved, "attempted_this_run": attempted,
                "unresolved_abstracts": len(missing)-verified}
    state["counts"] = counts_for(all_records)
    scoped_counts = state["counts"] if only is None else counts_for(records)
    if only is not None:
        state["last_scope"] = {"candidate_ids": [r["candidate_id"] for r in records], "counts": scoped_counts}
    else:
        state.pop("last_scope", None)
    save()
    result = {"ok": True, "complete": not remaining_records, "stop_reason": stop_reason,
              "pending_count": len(remaining_records), "attempted": attempted, "counts": scoped_counts,
              "message": stop_message or ({"page_not_ready": "摘要原页面尚未就绪，原页面与断点保留；等待页面加载后继续，尚未进入初筛或下载。",
                  "page_error": "摘要原页面或身份定位无法核对，原页面与断点保留；请核对后继续。"}.get(stop_reason)
                  or "摘要证据已保存；未取得或身份未核验的文献仍按待定处理。")}
    if only is not None:
        result.update(selected_candidate_ids=[r["candidate_id"] for r in records], global_counts=state["counts"])
    if stop_reason == "verification":
        result["verification_evidence"] = stop_verification_evidence
    if last_metadata_diagnostic:
        result["metadata_diagnostic"] = last_metadata_diagnostic
    emit("result", stage="metadata", **result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--total-budget-sec", type=float, default=300)
    parser.add_argument("--per-record-timeout-sec", type=float, default=30)
    parser.add_argument("--retry-attention", action="store_true")
    parser.add_argument("--retry-unavailable", action="store_true", help="显式重查曾缺失、截断或身份未核验项；仍复用成功项")
    parser.add_argument("--only", help="本批原始候选编号的 JSON 数组；未指定时保持全量")
    args = parser.parse_args(argv)
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        run(config, args.output_dir, total_budget_sec=args.total_budget_sec,
            per_record_timeout_sec=args.per_record_timeout_sec, retry_attention=args.retry_attention,
            retry_unavailable=args.retry_unavailable, only=json.loads(args.only) if args.only is not None else None)
        return 0
    except Exception as error:
        common.emit("error", stage="metadata", message=f"摘要回源失败：{error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
