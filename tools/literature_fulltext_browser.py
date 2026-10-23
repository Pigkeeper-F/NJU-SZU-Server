"""Sequential full-text access in one task-owned persistent browser tab.

The browser profile belongs to the researcher.  This module only disconnects
its CDP client, never closes that browser or borrows unrelated existing tabs.
The driver may close this task's page after its verified artifact is saved.
Visible login, verification and access problems are returned to the driver.
"""
from __future__ import annotations

import hashlib
import importlib
import json
from email.message import Message
import os
import mimetypes
from pathlib import Path
import re
import tempfile
import time
import unicodedata
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit
from urllib.request import Request, urlopen

import literature_browser
atomic_write_json = importlib.import_module("literature-common").atomic_write_json


DEFAULT_SITE_INTERVAL_SECONDS = 8.0
CNKI_SITE_INTERVAL_SECONDS = 10.0
MAX_PAGE_TIMEOUT_MS = 60_000
MATERIAL_DOWNLOAD_TIMEOUT_MS = 180_000
MAX_PDF_BYTES = 64 * 1024 * 1024
MIN_PDF_BYTES = 50 * 1024
MAX_MATERIAL_BYTES = 256 * 1024 * 1024

# This routine is also embedded into the normal article snapshot.  Only
# explicitly labelled supplementary regions/links qualify; an empty page is
# never evidence that a paper has no supplements.
_MATERIALS_FUNCTION_JS = r"""() => {
  const visible = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)
    && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const text = e => (e?.innerText || e?.textContent || '').trim();
  // "Supplemental zinc ..." is an article title, not a materials heading.
  // Bare labels qualify only when the entire label is the section name.
  const label = /\bsupplement(?:ary|al)?[\s_-]+(?:materials?|data|files?|information|figures?|tables?|appendi(?:x|ces))\b|\bsupporting[\s_-]+(?:information|materials?|data|files?)\b|\badditional[\s_-]+(?:files?|materials?|data)\b|补充(?:材料|信息|数据|文件)|附件|附录文件/i;
  const labelled = value => label.test(value) || /^\s*supplement(?:ary|al|s)?\s*$/i.test(value);
  for (const d of document.querySelectorAll('details:not([open])')) {
    const s = d.querySelector?.('summary');
    if ((s && visible(s) && labelled(text(s))) || [d.id, d.className, d.getAttribute?.('aria-label')].some(v => labelled(String(v || '')))) {
      try { d.open = true; } catch (_) {}
    }
  }
  const areas = new Set();
  for (const e of document.querySelectorAll('[id],[class],[aria-label]')) {
    if (visible(e) && [e.id,e.className,e.getAttribute('aria-label')].some(value=>labelled(String(value||'')))
        && !/^(HTML|BODY)$/.test(e.tagName)) areas.add(e);
  }
  for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6,summary,[role="heading"]')) {
    if (!visible(h) || !labelled(text(h))) continue;
    const section = h.closest('section,details,article > div');
    if (section && section !== document.querySelector('article') && section !== document.querySelector('main')) areas.add(section);
    else {
      let node = h.nextElementSibling;
      while (node && !/^H[1-6]$/.test(node.tagName)) { areas.add(node); node=node.nextElementSibling; }
    }
  }
  const anchors = new Set();
  for (const area of areas) {
    if (area.matches('a[href]') && visible(area)) anchors.add(area);
    for (const a of area.querySelectorAll('a[href]')) if (visible(a)) anchors.add(a);
  }
  for (const a of document.querySelectorAll('a[href]')) if (visible(a) && labelled(text(a) || a.title || '')) anchors.add(a);
  const links=Array.from(anchors).filter(a=>a.href && !/^javascript:|^mailto:/i.test(a.href)).map(a=>({
    url:a.href,label:(text(a)||a.title||a.querySelector('img')?.alt||'').slice(0,300),
    filename:a.getAttribute('download')||'',mime_type:a.getAttribute('type')||''}));
  const declaration=Array.from(document.querySelectorAll('article,main,section,div,p')).filter(visible).some(e=>{
    const s=text(e); return s.length<1000 && /(?:no\s+(?:supplementary|supplemental|supporting|additional)\s+(?:materials?|information|data|files?)\s+(?:is|are|was|were)\s+(?:provided|available|included)|(?:there\s+(?:is|are)\s+no\s+(?:supplementary|supporting)\s+(?:materials?|information|files?))|(?:无|没有|未提供)\s*(?:补充材料|补充文件|附件))/i.test(s);
  });
  return {links:links.slice(0,200),complete:links.length<=200,region_found:areas.size>0||anchors.size>0,none_declared:declaration};
}"""
_MATERIALS_JS = "/* literature_materials_snapshot */ (" + _MATERIALS_FUNCTION_JS + ")"

_SNAPSHOT_JS = r"""/* literature_fulltext_snapshot */ () => {
  const visible = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)
    && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const text = e => (e?.innerText || '').trim();
  const meta = names => { for (const name of names) { const e = document.querySelector(`meta[name="${name}"],meta[property="${name}"]`); if(e?.content) return e.content; } return ''; };
  const candidates = [
    '[itemprop="articleBody"]', '#article-body', '#bodymatter', '.article-body',
    '.article__body', '.fulltext-body', '.article-body-content', '.main-article-body',
    '#maincontent article', 'article', 'main'
  ];
  let chosen = null, selector = '';
  for (const sel of candidates) {
    const found = Array.from(document.querySelectorAll(sel)).filter(visible)
      .sort((a,b) => text(b).length-text(a).length)[0];
    if (found && text(found).length > 200) { chosen=found; selector=sel; break; }
  }
  let articleText='', articleHtml='', headings=[], sections=[];
  if (chosen) {
    const copy = chosen.cloneNode(true);
    const originals=Array.from(chosen.querySelectorAll('*'));
    const copies=Array.from(copy.querySelectorAll('*'));
    originals.forEach((e,i)=>{if(!visible(e)) copies[i]?.remove();});
    copy.querySelectorAll('nav,header,footer,aside,script,style,[role="navigation"],.references,#references,.ref-list,.abstract,#abstract,[id="acknowledgements"],.acknowledgements').forEach(e=>e.remove());
    copy.querySelectorAll('section').forEach(e => {
      const h=e.querySelector('h2,h3,h4,h5,h6');
      if(h && /^(references|bibliography|literature cited|参考文献|致谢|acknowledg)/i.test((h.textContent||'').trim())) e.remove();
    });
    // Detached nodes have no innerText: textContent is the fallback after
    // selecting a visible article region and removing its non-body blocks.
    const clean = e => (e.innerText || e.textContent || '').trim().replace(/\n{3,}/g,'\n\n');
    articleText=clean(copy).slice(0,1500000);
    articleHtml=copy.outerHTML.slice(0,2000000);
    headings=Array.from(copy.querySelectorAll('h2,h3,h4,h5,h6')).map(e=>({level:Number(e.tagName.slice(1)),text:clean(e)})).filter(h=>h.text).slice(0,100);
    sections=Array.from(copy.querySelectorAll('section')).map(e=>({heading:clean(e.querySelector('h2,h3,h4,h5,h6')||{}),text:clean(e).slice(0,100000)})).filter(s=>s.heading&&s.text).slice(0,80);
    if (sections.length < 2) {
      const hs=Array.from(copy.querySelectorAll('h2,h3,h4,h5,h6'));
      sections=hs.slice(0,80).map((h,i)=>{
        const range=document.createRange(); range.selectNodeContents(copy); range.setStartAfter(h);
        if(hs[i+1]) range.setEndBefore(hs[i+1]);
        return {heading:clean(h),text:(range.cloneContents().textContent||'').trim().slice(0,100000)};
      }).filter(s=>s.heading&&s.text);
    }
  }
  const structural = headings.filter(h=>/\b(methods?|materials|results|discussion|conclusions?|introduction|experiments?)\b|方法|材料|结果|讨论|结论|引言|试验/.test(h.text.toLowerCase()));
  const explicit = !!selector && !['article','main','#maincontent article'].includes(selector);
  const linkValue = a => ({url:a.href,text:(text(a)||a.querySelector('img')?.alt||'').slice(0,180)});
  const materials = (__MATERIALS_FUNCTION__)();
  const materialUrls = new Set(materials.links.map(a=>a.url));
  const supplementalUrl = value => /(?:^|[\/_.-])(?:supplementary|supplemental|supplement|supporting-information|additional-files?)(?:[\/_.-]|$)/i.test(value);
  const fulltextAnchors = Array.from(document.querySelectorAll('.full-text-links a[href],.full-text-links-list a[href],.linkout-list a[href]')).filter(a=>visible(a)&&!materialUrls.has(a.href)&&!supplementalUrl(a.href)).slice(0,8).map(linkValue);
  const labelledAnchors = Array.from(document.querySelectorAll('a[href]')).filter(visible).map(linkValue)
    .filter(a=>!materialUrls.has(a.url)&&!supplementalUrl(a.url)&&/pdf|full[ -]?text|全文|阅读全文|view article/i.test(a.text+' '+a.url)).slice(0,50);
  const metaPdfUrls = [meta(['citation_pdf_url']), ...Array.from(document.querySelectorAll('link[rel="alternate"][type="application/pdf"][href]')).map(e=>e.href)]
    .filter(u=>u&&!materialUrls.has(u)&&!supplementalUrl(u)).map(url=>({url,text:'PDF'}));
  const links = [...new Map([...fulltextAnchors,...labelledAnchors,...metaPdfUrls].map(a=>[a.url,a])).values()];
  const bodyText=(document.body?.innerText || '').slice(0,2000000);
  const prefix=bodyText.slice(0,5000);
  const headline=Array.from(document.querySelectorAll('h1,h2,[role="alert"]')).filter(visible).map(text).join(' ').slice(0,2000);
  const sourceApplicationError=/(?:来源应用|来源程序)(?:不正确|错误|无效)|(?:下载入口|(?:下载|来源)?链接)(?:已(?:经)?)?(?:失效|无效|错误)/i.test(headline+'\n'+prefix.slice(0,2000));
  return {
    text:bodyText,
    page_title:document.title || '',
    citation_title:meta(['citation_title','dc.title','DC.Title','og:title']) || text(Array.from(document.querySelectorAll('h1')).find(visible)),
    citation_doi:meta(['citation_doi','dc.identifier','DC.Identifier','prism.doi','article:doi']),
    article_text:articleText,article_html:articleHtml,headings,sections,links,materials,container:selector,
    container_verified:!!chosen && articleText.length>=800 && (explicit || structural.length>=2),
    origin:'dom_article_region',
    verification:Array.from(document.querySelectorAll('iframe[src*="captcha"],iframe[src*="recaptcha"],.geetest_panel,.verifybox,#captcha,.captcha')).some(visible)
      || /人机验证|滑动验证|请完成验证|访问验证|unusual traffic|verify you are human|are you a robot/i.test(prefix.slice(0,2000)),
    rate_limited:/too many requests|请求过于频繁|访问过于频繁|操作过于频繁|访问频率|rate limit|retry later/i.test(prefix.slice(0,2000)),
    source_application_error:sourceApplicationError,
    page_error:sourceApplicationError || /^(?:\s*(?:404|page not found|not found|页面不存在|页面错误))\b/i.test(headline)
      || /您所访问的页面不存在|页面不存在或已被删除|requested page (?:does not exist|could not be found)/i.test(prefix.slice(0,2000)),
    login:Array.from(document.querySelectorAll('input[type="password"]')).some(visible)
      || /请先登录|请登录后|登录后方可|sign in to access|log in to access|please sign in|please log in/i.test(prefix.slice(0,2000)),
    access_required:/您所在的机构未订购|没有访问权限|无访问权限|不在授权范围|机构没有订购|your institution does not have|institutional access is required|not entitled|subscription required|you do not have access|not authorized to access/i.test(prefix.slice(0,2500))
  };
}""".replace("__MATERIALS_FUNCTION__", _MATERIALS_FUNCTION_JS)


#: A long visible page without a verified article container is usually a body
#: that is still rendering (PMC finishes its DOM just after domcontentloaded).
#: Login/verification/error pages are excluded: waiting there cannot help.
def _needs_article_settle(snapshot: object) -> bool:
    if not isinstance(snapshot, dict) or snapshot.get("container_verified"):
        return False
    if any(snapshot.get(key) for key in
           ("page_error", "verification", "rate_limited", "source_application_error", "login", "access_required")):
        return False
    body = str(snapshot.get("text") or "")
    headings = snapshot.get("headings")
    return len(body) >= 1500 and isinstance(headings, list) and len(headings) >= 1


def _settle_article_snapshot(page, snapshot: object, *, timeout_ms: int = 4000, pause_ms: int = 1200):
    """Wait once for a delayed article body, then re-snapshot.

    Keeps the original snapshot unless the retry found a verified container or
    strictly more article text. This makes first-pass PMC access deterministic
    without treating paywall/login pages as articles.
    """
    if not _needs_article_settle(snapshot):
        return snapshot
    try:
        page.wait_for_selector(
            '[itemprop="articleBody"], #bodymatter, .main-article-body, .article-body, article section',
            timeout=timeout_ms,
        )
    except Exception:
        # No section markup is not a failure; the re-snapshot below still runs.
        pass
    page.wait_for_timeout(pause_ms)
    retry = page.evaluate(_SNAPSHOT_JS)
    if not isinstance(retry, dict):
        return snapshot
    if retry.get("container_verified"):
        return retry
    if len(str(retry.get("article_text") or "")) > len(str(snapshot.get("article_text") or "")):
        return retry
    return snapshot


def _material_identity(snapshot, record):
    norm = lambda value: " ".join(unicodedata.normalize("NFKC", str(value or "")).split()).casefold()
    doi = lambda value: re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", norm(value))
    wanted_doi, actual_doi = doi(record.get("doi")), doi(snapshot.get("citation_doi"))
    if wanted_doi and actual_doi and wanted_doi != actual_doi:
        return False
    if wanted_doi and wanted_doi == actual_doi:
        return True
    wanted_title, actual_title = norm(record.get("title")), norm(snapshot.get("citation_title"))
    if not wanted_title or not actual_title:
        return False
    if wanted_title == actual_title:
        return True
    # PubMed titles often carry a subtitle/suffix that the article page renders
    # differently. Require a long containment match, not a loose token overlap.
    shorter, longer = sorted((wanted_title, actual_title), key=len)
    return len(shorter) >= 12 and shorter in longer and len(shorter) / len(longer) >= 0.8


def _material_key(record):
    return _url_hash("\n".join(str(record.get(key) or "") for key in
                              ("source_key", "source_candidate_id", "paper_id", "id", "title", "doi")))


def _material_url(value):
    """Ephemeral actual DOM link, never serialized to browser bindings."""
    try:
        parsed = urlsplit(str(value or ""))
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            return ""
        # No replay of CNKI's transfer/order endpoints, even if a cached
        # descriptor happens to contain one. Actual visible clicks below are
        # used for all accepted links; this is an additional entry guard.
        if _site(value) == "cnki.net" and re.search(r"/bar/|/order/|/download/transfer|[?&]v=", str(value), re.I):
            return ""
        return str(value)
    except (ValueError, TypeError):
        return ""


def _non_material_navigation(target, record, page_url=""):
    """Exclude positively identified author/navigation links, not data DOIs."""
    parsed = urlsplit(target)
    host, path = (parsed.hostname or "").lower(), unquote(parsed.path).lower()
    if page_url and parsed.fragment and target.split("#", 1)[0] == str(page_url).split("#", 1)[0]:
        return True
    if host == "orcid.org" or host.endswith(".orcid.org") or host == "creativecommons.org" or host.endswith(".creativecommons.org"):
        return True
    if host in {"s100.copyright.com", "rightslink.com", "crossmark.crossref.org"} or host.endswith(".rightslink.com"):
        return True
    if (re.search(r"/(?:authors?|profile|profiles)(?:/|$)", path)
        and not re.search(r"\.(?:pdf|docx?|xlsx?|csv|tsv|zip|rar|7z|gz|txt|xml|json|png|jpe?g|tiff?|r|rds|sav|dta)$", path)):
        return True
    if host == "pubmed.ncbi.nlm.nih.gov":
        terms = parse_qs(parsed.query).get("term", [])
        if any(re.search(r"\[(?:author|au|fau)\]", term, re.I) for term in terms):
            return True
    if parsed.fragment and re.match(r"(?:affiliation|aff\d|author|fn\d|ref\b|bib\b|cit\b|sec\b)", parsed.fragment, re.I):
        return True
    if host in {"doi.org", "dx.doi.org"}:
        wanted = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", str(record.get("doi") or "").strip(), flags=re.I)
        if wanted and unquote(parsed.path).lstrip("/").casefold() == wanted.casefold():
            return True
    return False


_CDN_EQUIVALENT_FAMILIES = (
    {"nih.gov", "europepmc.org"},
    {"sciencedirect.com", "elsevier.com", "els-cdn.com", "sciencedirectassets.com", "cell.com"},
    {"springer.com", "nature.com", "springernature.com", "biomedcentral.com"},
    {"wiley.com", "onlinelibrary.wiley.com"},
    {"oup.com", "silverchair-cdn.com"},
)


def _registrable_domain(host: str) -> str:
    clean = (host or "").lower().strip(".").removeprefix("www.")
    parts = [p for p in clean.split(".") if p]
    if len(parts) >= 3 and parts[-2] in {"ac", "co", "edu", "gov", "org", "com"} and len(parts[-1]) <= 3:
        return ".".join(parts[-3:])
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return clean


def _material_host_allowed(actual_host: str, origin_hosts: set[str]) -> bool:
    actual = (actual_host or "").lower().strip(".")
    if not actual:
        return False
    valid_origins = {h.lower().strip(".") for h in origin_hosts if h}
    if actual in valid_origins:
        return True
    actual_reg = _registrable_domain(actual)
    origin_regs = {_registrable_domain(h) for h in valid_origins if h}
    if actual_reg and actual_reg in origin_regs:
        return True
    for family in _CDN_EQUIVALENT_FAMILIES:
        if actual_reg in family and (origin_regs & family):
            return True
    return False

_MESSAGES = {
    "verification": "全文页面需要人工验证，已暂停；请在原页面处理后检查并继续。",
    "login": "全文页面需要登录，已暂停；请在原页面登录后检查并继续。",
    "access_required": "全文页面需要机构或订阅权限，已暂停；请在原页面核对权限后继续。",
    "rate_limited": "全文页面提示访问过于频繁，已暂停；请稍后在原页面核对后继续。",
    "page_error": "全文页面返回错误或404，已暂停；请核对原页面及文献入口。",
    "load_timeout": "全文页面加载超过1分钟或设定时限，已暂停；已有材料保留，请在原页面核对后继续。",
}


def _site(url):
    host = (urlsplit(url).hostname or "").lower()
    if host == "cnki.net" or host.endswith(".cnki.net"):
        return "cnki.net"
    return host.removeprefix("www.")


def _url_hash(url):
    return hashlib.sha256(str(url).encode("utf-8")).hexdigest()


def _save_pdf(path, blob):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(prefix=".fulltext-pdf-", suffix=".tmp", dir=target.parent)
    temporary = Path(name)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


class FulltextBrowserFetcher:
    def __init__(self, config=None, job_dir=None, *, on_progress=None,
                 runtime_factory=None, clock=time.time, sleep=time.sleep):
        if job_dir is None:
            raise ValueError("全文浏览器必须绑定原任务目录。")
        self.job_dir = Path(job_dir).resolve()
        self.binding_path = self.job_dir / "fulltext-browser.json"
        self.on_progress = on_progress
        self._runtime_factory = runtime_factory or literature_browser._runtime
        self._clock, self._sleep = clock, sleep
        self._runtime_cm = None
        self._context = None
        self._page = None
        self._binding = self._read_binding()
        previous_requests = self._binding.get("last_request_at")
        self._last_request = dict(previous_requests) if isinstance(previous_requests, dict) else {}
        self._blocked = None
        self._blocked_url = ""
        # A batch may skip a restricted site without repeatedly visiting its
        # login/challenge. This is intentionally not restored after restart:
        # an explicit later run must be able to inspect a solved restriction.
        self._deferred_sites = {}
        self._material_discoveries = {}
        self._material_results = {}

    def _read_binding(self):
        try:
            data = json.loads(self.binding_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError, TypeError):
            return {}

    def _write_binding(self):
        self.job_dir.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self.binding_path, self._binding)

    def _connect(self):
        if self._context is None:
            self._runtime_cm = self._runtime_factory()
            self._context = self._runtime_cm.__enter__()
        return self._context

    def _find_bound_page(self):
        return self._find_target_page(self._binding.get("target_id"))

    def _find_target_page(self, wanted):
        """Locate only an exact target already recorded as task owned."""
        context = self._connect()
        if wanted:
            for page in context.pages:
                try:
                    if literature_browser._target_id(context, page) == wanted:
                        return page
                except Exception:
                    pass
        return None

    def _get_page(self):
        if self._page is not None:
            try:
                if not self._page.is_closed():
                    return self._page
            except Exception:
                pass
        self._page = self._find_bound_page()
        if self._page is None:
            self._page = self._context.new_page()
            self._binding.update(version=1, target_id=literature_browser._target_id(self._context, self._page))
            self._binding.pop("pending_url_hash", None)
            self._binding.pop("attention_reason", None)
            self._binding.pop("cnki_flow", None)
            self._write_binding()
        return self._page

    def ensure_ready(self):
        try:
            self._get_page()
            return {"status": "ok"}
        except Exception:
            self.close()
            return {"status": "error", "message": "本机全文浏览器未能连接，请检查浏览器环境。"}

    def open_current(self):
        """Show the exact retained task window without navigation or adoption.

        A pending CNKI popup may be the window needing the researcher's help,
        even before its origin or artifact is accepted for automatic fetching.
        Its persisted opener witness allows showing it, never treating it as
        downloaded content or changing the active task-page binding.
        """
        try:
            binding = self._binding
            if not binding.get("target_id"):
                deferred = binding.get("last_deferred_paper")
                if isinstance(deferred, dict) and isinstance(deferred.get("binding"), dict):
                    binding = deferred["binding"]
            material = binding.get("material_flow")
            if isinstance(material, dict) and material.get("child_target_id"):
                parent = self._find_target_page(material.get("parent_target_id"))
                child = self._find_target_page(material.get("child_target_id"))
                if (parent is None or child is None or child.opener() is not parent
                    or material.get("parent_target_id") != binding.get("target_id")):
                    return {"opened": False, "message": "原补充材料任务窗口已关闭或打开关系无法核对，未打开其他页面。"}
                child.bring_to_front()
                return {"opened": True, "message": "已显示原补充材料窗口，请在该页处理后继续。"}
            flow = binding.get("cnki_flow")
            if isinstance(flow, dict) and "pending_popup" in flow:
                witness = flow.get("pending_popup")
                if not isinstance(witness, dict):
                    return {"opened": False, "message": "任务下载窗口的记录无法核对，未打开其他页面。"}
                owner_id, child_id = witness.get("owner_target_id"), witness.get("target_id")
                bound_id = binding.get("target_id")
                if (witness.get("opener_verified") is not True
                    or witness.get("action") not in {"title", "download"}
                    or not all(isinstance(value, str) and value and len(value) <= 200
                               for value in (owner_id, child_id))
                    or owner_id == child_id or bound_id not in {owner_id, child_id}
                    or flow.get("target_id") != bound_id):
                    return {"opened": False, "message": "任务下载窗口与当前任务的记录不一致，未打开其他页面。"}
                context = self._connect()

                def recorded_page(target_id):
                    unverified = False
                    for candidate in context.pages:
                        try:
                            if not candidate.is_closed() and literature_browser._target_id(context, candidate) == target_id:
                                return candidate
                        except Exception:
                            unverified = True
                    if unverified:
                        raise RuntimeError("Recorded task window cannot be verified")
                    return None

                child = recorded_page(child_id)
                if child is None:
                    return {"opened": False, "message": "原任务记录的下载窗口已关闭或无法找到，未改为打开父页面。"}
                owner = recorded_page(owner_id)
                opener = child.opener()
                if owner is not None:
                    owned = opener is owner
                else:
                    # A successfully adopted popup normally loses its opener
                    # when our old locator page closes. Unadopted windows with
                    # no verifiable live opener remain for explicit review.
                    owned = (opener is None and witness.get("adopted") is True and bound_id == child_id)
                if not owned:
                    return {"opened": False, "message": "原任务下载窗口的打开关系无法核对，未打开其他页面。"}
                child.bring_to_front()
                return {"opened": True, "message": "已显示原任务记录的待核对下载窗口；尚未确认全文下载完成。"}
            page = self._find_target_page(binding.get("target_id"))
            if page is None or page.is_closed():
                return {"opened": False, "message": "原任务的全文页面已关闭，请显式继续原任务。"}
            page.bring_to_front()
            return {"opened": True, "message": "已打开原任务的全文页面，请在该页处理后检查并继续。"}
        except Exception:
            return {"opened": False, "message": "无法打开原任务的全文页面，请检查本机浏览器。"}

    def _deferred_attention(self, url):
        """Return a known batch restriction without opening or navigating."""
        try:
            cached = self._deferred_sites.get(_site(str(url or "")))
        except (TypeError, ValueError):
            cached = None
        if cached:
            return dict(cached, deferred_site=True,
                        message="该站点本批次仍待登录、验证或权限处理，已跳过当前材料；原页面保留，未重复访问。")
        return None

    def defer_paper(self, *, reason="", url=""):
        """Retain this paper's exact windows and release the task for another.

        Skipping is a caller policy, never an access workaround. A login,
        challenge, subscription or rate limit also suppresses fresh requests
        to that actual destination for this fetcher instance. Bad links and
        timeouts apply only to this paper. No page is closed or adopted here.
        """
        blocked = dict(self._blocked or {})
        actual = (self._blocked_url or blocked.get("url") or "") if blocked else ""
        if not actual and self._page is not None:
            try:
                actual = self._page.url
            except Exception:
                pass
        # A cached-site response has no new current page to release. In
        # particular it must not replace the retained original window record.
        if not blocked and not self._binding.get("target_id"):
            return {"deferred": True, "reason": str(reason or "unavailable")}
        actual = actual or str(url or "")
        why = str(reason or blocked.get("reason") or "unavailable")
        try:
            destination = _site(actual)
        except (TypeError, ValueError):
            destination = ""
        # DOI resolvers and the common PubMed entry are shared gateways, not
        # evidence that every publisher linked from them is inaccessible.
        gateways = {"doi.org", "dx.doi.org", "pubmed.ncbi.nlm.nih.gov"}
        # The visible tab may still be on the preceding article after a failed
        # navigation. Keep its actual site for pacing, but attribute the failed
        # entry to the URL requested for this paper.
        reported = literature_browser.safe_url(blocked.get("url") or url) if blocked else literature_browser.safe_url(actual)
        result = {"status": "attention", "reason": why,
                  "url": reported,
                  "message": blocked.get("message") or _MESSAGES.get(why, "该材料尚未取得，原页面保留待处理。")}
        if why in {"login", "verification", "access_required", "rate_limited"} and destination and destination not in gateways:
            self._deferred_sites[destination] = dict(result)
        retained = {key: self._binding[key] for key in
                    ("target_id", "pending_url_hash", "attention_reason", "cnki_flow", "material_flow")
                    if key in self._binding}
        self._binding["last_deferred_paper"] = {
            "reason": why, "url": result["url"], "site": destination,
            "deferred_at": self._clock(), "binding": retained,
        }
        for key in retained:
            self._binding.pop(key, None)
        self._write_binding()
        self._page = None
        self._blocked = None
        self._blocked_url = ""
        self._progress("全文获取：暂未取得的页面已保留，继续尝试可访问入口。")
        return {"deferred": True, "reason": why, "url": result["url"]}

    def close(self):
        cm, self._runtime_cm = self._runtime_cm, None
        self._context, self._page = None, None
        if cm is not None:
            try:
                cm.__exit__(None, None, None)
            except Exception:
                pass

    def complete_paper(self):
        """Close only the task page after the caller saved a verified result.

        Access problems always leave that page open for the researcher.  The
        driver calls this only after both the artifact and status are saved.
        """
        if self._blocked or self._binding.get("material_flow"):
            return {"closed": False}
        try:
            page = self._find_bound_page()
            if page is None:
                return {"closed": False}
            page.close(run_before_unload=False)
            self._page = None
            flow = self._binding.get("cnki_flow") or {}
            cleanup_id = flow.get("cleanup_target_id") if isinstance(flow, dict) else None
            if cleanup_id and cleanup_id != self._binding.get("target_id"):
                cleanup = self._find_target_page(cleanup_id)
                if cleanup is not None and not cleanup.is_closed():
                    try:
                        cleanup.close(run_before_unload=False)
                    except Exception:
                        self._progress("全文获取：文件已保存，任务的旧定位页未能关闭，请手动关闭该旧页。")
                        return {"closed": False}
            self._binding.pop("target_id", None)
            self._binding.pop("pending_url_hash", None)
            self._binding.pop("attention_reason", None)
            self._binding.pop("cnki_flow", None)
            self._write_binding()
            self._progress("全文获取：文件已完成并保存，已关闭本任务的文献页面。")
            return {"closed": True}
        except Exception:
            return {"closed": False}

    def _progress(self, message):
        if self.on_progress:
            self.on_progress(message)

    def _pace(self, url):
        site = _site(url)
        interval = CNKI_SITE_INTERVAL_SECONDS if (site == "cnki.net" or self._binding.get("last_site") == "cnki.net") else DEFAULT_SITE_INTERVAL_SECONDS
        remaining = 0.0
        # A global minimum also limits redirects (e.g. DOI -> publisher),
        # whose destination cannot be known before the official redirect.
        for key in (site, "*"):
            previous = self._last_request.get(key)
            if isinstance(previous, (int, float)) and not isinstance(previous, bool):
                remaining = max(remaining, interval - max(0, self._clock() - previous))
        if remaining > 0:
            self._progress(f"全文获取：等待站点访问间隔 {remaining:.0f} 秒，再处理下一项。")
            self._sleep(remaining)
        self._last_request[site] = self._clock()
        self._last_request["*"] = self._clock()
        self._binding["last_site"] = site
        self._binding["last_request_at"] = self._last_request
        self._write_binding()

    def _record_destination(self, url):
        site = _site(url)
        if site:
            self._binding["last_site"] = site
            self._last_request[site] = self._last_request.get("*", self._clock())
            self._binding["last_request_at"] = self._last_request
            self._write_binding()

    def _attention(self, reason, url, *, snapshot=None, observed_url=None):
        safe = literature_browser.safe_url(url)
        if observed_url and urlsplit(str(observed_url)).scheme in {"http", "https"} and not literature_browser.safe_url(observed_url):
            safe = ""  # Do not expose a redirected login/token URL or replace it with an apparent article link.
        self._binding["pending_url_hash"] = _url_hash(self._request_url)
        self._binding["attention_reason"] = reason
        self._write_binding()
        message = _MESSAGES[reason]
        if reason == "page_error" and isinstance(snapshot, dict) and snapshot.get("source_application_error"):
            message = "知网提示来源应用不正确或下载入口失效，已暂停；请从知网正常详情或检索页面核对入口后继续。"
        result = {"status": "attention", "reason": reason, "url": safe, "message": message}
        self._blocked = result
        self._blocked_url = str(observed_url or url or "")
        return result

    def _clear_pending(self):
        if "pending_url_hash" in self._binding:
            self._binding.pop("pending_url_hash", None)
            self._binding.pop("attention_reason", None)
            self._write_binding()

    @staticmethod
    def _reason(snapshot, status=0):
        if status == 429 or snapshot.get("rate_limited"):
            return "rate_limited"
        if status == 404 or snapshot.get("page_error") or snapshot.get("source_application_error"):
            return "page_error"
        if snapshot.get("verification"):
            return "verification"
        if snapshot.get("login"):
            return "login"
        if status in (401, 403) or snapshot.get("access_required"):
            return "access_required"
        if status >= 500:
            return "page_error"
        return None

    def _read_download(self, download, out_path=None):
        # This is the actual browser download artifact, not a new HTTP request
        # or a guessed publisher download URL.
        temporary = None
        try:
            # save_as works for a CDP-attached browser as well; path() is not
            # available for every remote-connection artifact implementation.
            directory = self.job_dir / "fulltext" / ".downloads"
            directory.mkdir(parents=True, exist_ok=True)
            handle, name = tempfile.mkstemp(prefix="browser-", suffix=".part", dir=directory)
            os.close(handle)
            temporary = Path(name)
            self._progress("全文获取：文件正在生成或下载，等待实际传输完成后再保存。")
            download.save_as(str(temporary))
            file = temporary
            if file.stat().st_size > MAX_PDF_BYTES:
                return None
            blob = file.read_bytes()
            if not blob.startswith(b"%PDF") or len(blob) < MIN_PDF_BYTES:
                return None
            if out_path is not None:
                _save_pdf(out_path, blob)
            return blob
        except Exception:
            return None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def _discovery(self, record, snapshot, url):
        result = {"status": "unknown", "reason": "article_materials_not_observed",
                  "source_url": literature_browser.safe_url(url), "links": []}
        if not isinstance(record, dict) or not _material_identity(snapshot, record):
            result["reason"] = "same_paper_identity_unverified"
            return result
        reason = self._reason(snapshot)
        if reason:
            result.update(status="needs_attention", reason=reason)
            return result
        try:
            parsed = urlsplit(url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
                return result
            if _site(url) == "cnki.net":
                from literature_cnki_fulltext import _official, _lookup_page
                if not _official(url) or _lookup_page(url):
                    return result
        except (ValueError, TypeError):
            return result
        raw = snapshot.get("materials")
        if not isinstance(raw, dict) or raw.get("complete") is not True:
            return result
        links, rejected = [], False
        for item in raw.get("links", []):
            if not isinstance(item, dict):
                rejected = True
                continue
            target = _material_url(urljoin(url, str(item.get("url") or "")))
            if not target:
                rejected = True
                continue
            if _non_material_navigation(target, record, url):
                # Author/affiliation/main-article metadata was never an
                # attachment. Do not treat it as a missing material either.
                continue
            label = str(item.get("label") or "")[:300]
            filename = str(item.get("filename") or "").replace("\\", "/").split("/")[-1][:200]
            extension = Path(filename or urlsplit(target).path).suffix.lower().lstrip(".")
            links.append({"url": target, "label": label, "filename": filename,
                          "format": extension, "mime_type": str(item.get("mime_type") or mimetypes.guess_type(filename or urlsplit(target).path)[0] or "application/octet-stream")})
        result["links"] = list({(item["url"], item["label"]): item for item in links}.values())
        if rejected:
            result["reason"] = "some_material_links_require_manual_access"
        elif links and raw.get("region_found") is True:
            result.update(status="checked", reason="same_paper_visible_material_links_enumerated")
        elif not links and raw.get("none_declared") is True:
            result.update(status="none_declared", reason="article_explicitly_declares_no_supplements")
        elif not links and raw.get("region_found") is not True:
            # The article body was fully inspected and no supplementary region
            # or labelled link exists. Report this as an observation, not as
            # “unknown”: otherwise every paper without supplements stays
            # forever unverified and blocks the completeness report.
            result.update(status="none_found", reason="article_page_has_no_visible_supplementary_region")
        return result

    def _observe_materials(self, record, snapshot, url, opts=None):
        result = self._discovery(record, snapshot, url)
        key = _material_key(record or {})
        if record:
            self._material_discoveries[key] = result
        callback = (opts or {}).get("on_material_discovery")
        if callable(callback):
            try:
                outcome = callback(result)
            except Exception:
                outcome = {"status": "attention", "reason": "page_error", "message": "补充材料保存或状态记录未完成，已暂停正文下载；原页面保留。", "url": result["source_url"]}
            if isinstance(outcome, dict) and outcome.get("status") in {"attention", "fetch_error", "error"}:
                return result, outcome
            if self._blocked:
                return result, dict(self._blocked)
        return result, None

    def capture_material_discovery(self, record, opts=None):
        """Read only this exact task detail; never click or borrow another tab."""
        try:
            page = self._find_bound_page()
            if page is None or page.is_closed():
                return {"status": "unknown", "reason": "original_article_page_unavailable", "source_url": "", "links": []}
            snapshot = page.evaluate(_SNAPSHOT_JS)
            if not isinstance(snapshot, dict):
                raise ValueError("No article snapshot")
            reason = self._reason(snapshot)
            if reason:
                self._request_url = page.url
                self._attention(reason, page.url, snapshot=snapshot)
            result, _ = self._observe_materials(record, snapshot, page.url, opts)
            return result
        except Exception:
            return {"status": "unknown", "reason": "original_article_page_unreadable", "source_url": "", "links": []}

    def inspect_materials(self, record, opts=None):
        """Explicit future-run entry: normal article lookup, never main PDF."""
        options = dict(opts or {}, record=record)
        article_url = str(record.get("materials_url") or record.get("source_url") or "")
        deferred = self._deferred_attention(article_url)
        if deferred:
            return deferred
        if record.get("source_key") == "cnki":
            options["materials_only"] = True
            return self.fetch_cnki(record, options)
        current = self.capture_material_discovery(record)
        if self._blocked:
            return dict(self._blocked, material_discovery=current)

        def accept(discovery):
            callback = options.get("on_material_discovery")
            outcome = callback(discovery) if callable(callback) else None
            if isinstance(outcome, dict) and outcome.get("status") in {"attention", "error", "fetch_error"}:
                return outcome
            return {"status": "ok", "material_discovery": discovery}

        if current.get("status") in {"checked", "none_declared"}:
            return accept(current)
        candidates: list[str] = []
        raw_links = [article_url] + [str(item.get("url") or "") for item in (record.get("fulltext_links") or [])
                                     if isinstance(item, dict)]
        for source in raw_links:
            safe = literature_browser.safe_url(source)
            if (safe and safe not in candidates
                    and not re.search(r"\.(?:pdf|caj)(?:$|[?#])", safe, re.I)
                    and _site(safe) != "cnki.net"):
                candidates.append(safe)
        options["materials_only"] = True
        last = current
        blocked = None
        for source in candidates:
            result = self.fetch_page(source, options)
            if result.get("status") in {"attention", "captcha"}:
                blocked = blocked or result
                continue
            discovery = result.get("material_discovery")
            if isinstance(discovery, dict):
                if discovery.get("status") in {"checked", "none_declared"}:
                    return accept(discovery)
                if discovery.get("status") == "needs_attention":
                    blocked = blocked or result
                last = discovery or last
            if result.get("status") == "ok" and (discovery or {}).get("status") == "unknown":
                links = [item.get("url") for item in result.get("html_evidence", {}).get("links", [])
                         if item.get("kind") == "fulltext" and item.get("url") and item.get("url") not in {source, result.get("url")}
                         and not re.search(r"\.(?:pdf|caj)(?:$|[?#])", item["url"], re.I) and _site(item["url"]) != "cnki.net"]
                if len(set(links)) == 1 and links[0] not in candidates:
                    extra = self.fetch_page(links[0], options)
                    extra_discovery = extra.get("material_discovery")
                    if isinstance(extra_discovery, dict) and extra_discovery.get("status") in {"checked", "none_declared"}:
                        return accept(extra_discovery)
                    if extra.get("status") in {"attention", "captcha"}:
                        blocked = blocked or extra
                    last = extra_discovery or last
        if blocked is not None:
            return blocked
        return accept(last)
        return result

    def _read_material_download(self, download, descriptor):
        temporary = None
        try:
            directory = self.job_dir / "fulltext" / ".downloads"
            directory.mkdir(parents=True, exist_ok=True)
            handle, name = tempfile.mkstemp(prefix="material-", suffix=".part", dir=directory)
            os.close(handle)
            temporary = Path(name)
            self._progress("补充材料：等待文件生成及实际下载完成，保留原始格式。")
            download.save_as(str(temporary))
            if callable(getattr(download, "failure", None)) and download.failure():
                return None
            if not 0 < temporary.stat().st_size <= MAX_MATERIAL_BYTES:
                return None
            blob = temporary.read_bytes()
            filename = str(getattr(download, "suggested_filename", "") or descriptor.get("filename") or "material").replace("\\", "/").split("/")[-1]
            mime = str(descriptor.get("mime_type") or mimetypes.guess_type(filename)[0] or "application/octet-stream")
            # An error/login HTML page named as a spreadsheet/ZIP is not an
            # attachment. Unknown original formats remain original bytes;
            # downstream readers decide whether their contents are readable.
            if re.match(br"\s*(?:<!doctype\s+html|<html|<form)", blob[:300], re.I) and not filename.lower().endswith((".html", ".htm")):
                return None
            return {"status": "file", "bytes": blob, "suggested_filename": filename,
                    "mime_type": mime, "url": literature_browser.safe_url(getattr(download, "url", ""))}
        except Exception:
            return None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def complete_material(self):
        """Caller invokes only after this file and its material status save."""
        flow = self._binding.get("material_flow")
        if self._blocked or not isinstance(flow, dict) or flow.get("step") != "file_received":
            return {"closed": False}
        try:
            child_id = flow.get("child_target_id")
            if child_id:
                child = self._find_target_page(child_id)
                if child is not None:
                    child.close(run_before_unload=False)
            staged = self._material_stage_path(flow)
            if staged is not None:
                staged.unlink(missing_ok=True)
            self._binding.pop("material_flow", None)
            self._write_binding()
            self._material_results.pop(flow.get("key"), None)
            return {"closed": True}
        except Exception:
            return {"closed": False}

    def _material_stage_path(self, flow):
        key = flow.get("key")
        if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key):
            return None
        relative = "fulltext/.materials-stage/" + key + ".bin"
        if flow.get("received_path") != relative:
            return None
        candidate = self.job_dir / relative
        try:
            stage_dir = (self.job_dir / "fulltext" / ".materials-stage").resolve()
            if not stage_dir.is_relative_to(self.job_dir.resolve()) or candidate.resolve().parent != stage_dir:
                return None
        except OSError:
            return None
        return candidate

    def _retain_material_file(self, key, result):
        """Checkpoint only the actual captured artifact, before returning it."""
        relative = "fulltext/.materials-stage/" + key + ".bin"
        staged = self._material_stage_path({"key": key, "received_path": relative})
        if staged is None:
            raise ValueError("Material stage escapes this task")
        _save_pdf(staged, result["bytes"])
        filename = str(result.get("suggested_filename") or "material").replace("\\", "/").split("/")[-1]
        filename = re.sub(r"[\x00-\x1f\x7f]", "", filename)[:200] or "material"
        mime = str(result.get("mime_type") or "application/octet-stream")
        if not re.fullmatch(r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*charset=[A-Za-z0-9._-]+)?", mime):
            mime = "application/octet-stream"
        self._binding["material_flow"].update(step="file_received", received_path=relative,
            received_sha256=hashlib.sha256(result["bytes"]).hexdigest(), received_size=len(result["bytes"]),
            received_filename=filename, received_mime_type=mime)
        self._write_binding()
        self._clear_pending()
        result.update(suggested_filename=filename, mime_type=mime)
        self._material_results[key] = result
        return result

    def _restore_material_file(self, flow):
        staged = self._material_stage_path(flow)
        if staged is None or not staged.is_file() or not 0 < staged.stat().st_size <= MAX_MATERIAL_BYTES:
            return None
        blob = staged.read_bytes()
        if len(blob) != flow.get("received_size") or hashlib.sha256(blob).hexdigest() != flow.get("received_sha256"):
            return None
        return {"status": "file", "bytes": blob, "suggested_filename": flow.get("received_filename") or "material",
                "mime_type": flow.get("received_mime_type") or "application/octet-stream", "url": ""}

    def pending_material_state(self, record):
        """Read-only proof for root to match an already durably saved file.

        The coordinator must verify this digest/size against that same paper's
        saved original before acknowledging cleanup after a process restart.
        No cached link/token is exposed or replayed.
        """
        flow = self._binding.get("material_flow")
        if not isinstance(flow, dict) or flow.get("paper_hash") != _material_key(record):
            return None
        if flow.get("step") != "file_received":
            return {"status": "pending", "material_id": flow.get("material_id", "")}
        digest, size = flow.get("received_sha256"), flow.get("received_size")
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest) or not isinstance(size, int) or size <= 0:
            return None
        return {"status": "file_received", "material_id": flow.get("material_id", ""),
                "sha256": digest, "size": size, "source_key": str(record.get("source_key") or "")}

    def _direct_material(self, target: str, descriptor: dict, timeout: int = 60):
        """Fetch a witnessed public attachment URL directly, before click fallback.

        This never uses browser cookies or replays a session/ticket URL; the
        URL comes from the current article snapshot and is only accepted when
        the HTTP response is an actual file rather than an HTML/login page.
        """
        if not target or _site(target) == "cnki.net":
            return None
        host = (urlsplit(target).hostname or "").lower()
        if host in {"localhost", "127.0.0.1", "::1"} or host.endswith((".invalid", ".test", ".example")):
            return None  # offline fixtures and never a real public attachment
        try:
            request = Request(target, headers={"User-Agent": "NJU-SZU-Workbench/1.0", "Accept": "*/*"})
            with urlopen(request, timeout=max(5, min(120, timeout))) as response:
                mime = str(response.headers.get("Content-Type") or "").lower()
                if "html" in mime or "javascript" in mime:
                    return None
                declared = response.headers.get("Content-Length")
                if declared and declared.isdigit() and int(declared) > MAX_MATERIAL_BYTES:
                    return None
                blob = response.read(MAX_MATERIAL_BYTES + 1)
        except Exception:
            return None
        if not blob or len(blob) > MAX_MATERIAL_BYTES:
            return None
        if re.match(br"\s*(?:<!doctype\s+html|<html|<form)", blob[:300], re.I):
            return None
        disposition = Message()
        disposition["content-disposition"] = str(response.headers.get("content-disposition") or "")
        filename = disposition.get_filename() or descriptor.get("filename") or Path(urlsplit(target).path).name or "material"
        return {"status": "file", "bytes": blob, "suggested_filename": str(filename),
                "mime_type": mime or str(descriptor.get("mime_type") or "application/octet-stream"),
                "url": target}

    def fetch_material(self, descriptor, record, opts=None):
        """Click one currently witnessed supplementary link, exactly once.

        No descriptor URL is navigated/replayed. Ctrl+click preserves the
        article page; only the child opened by this action may be observed.
        """
        options = opts or {}
        target = _material_url(descriptor.get("url"))
        key = _url_hash(_material_key(record) + "\n" + str(descriptor.get("label") or "") + "\n" + str(descriptor.get("filename") or "") + "\n" + target)
        if key in self._material_results:
            return dict(self._material_results[key])
        deferred = self._deferred_attention(target) or self._deferred_attention(record.get("source_url"))
        if deferred:
            return deferred
        direct = self._direct_material(target, descriptor,
                                       int((options or {}).get("per_paper_timeout_sec") or 60))
        if direct is not None:
            self._material_results[key] = direct
            return dict(direct)
        listeners, downloads, children, responses = [], [], [], []
        clicked = False
        popup_error = False
        parent = None
        self._request_url = ""

        def attention(reason, message=None, snapshot=None, url=None):
            result = self._attention(reason, url or getattr(parent, "url", ""), snapshot=snapshot)
            if message:
                result["message"] = message
                self._blocked = dict(result)
            return result

        try:
            received = self._binding.get("material_flow")
            if (isinstance(received, dict) and received.get("step") == "file_received"
                and received.get("key") == key and received.get("paper_hash") == _material_key(record)):
                result = self._restore_material_file(received)
                if result is None:
                    return attention("page_error", "已收到的补充材料暂存文件未通过核验，已暂停；不会重复点击下载。")
                self._blocked = None
                self._clear_pending()
                self._material_results[key] = result
                return result
            parent = self._find_bound_page()
            self._request_url = getattr(parent, "url", "")
            if parent is None or parent.is_closed() or not target:
                return {"status": "fetch_error", "error": "补充材料的原任务页面或可核验入口不可用，未打开其他页面。"}
            parent_id = literature_browser._target_id(self._context, parent)
            flow = self._binding.get("material_flow")
            resume = isinstance(flow, dict)
            if resume and (flow.get("key") != key or flow.get("paper_hash") != _material_key(record) or flow.get("parent_target_id") != parent_id):
                return attention("page_error", "另一份补充材料仍待处理，已保留原窗口；请先继续该材料。")
            if not resume:
                if self._blocked:
                    return dict(self._blocked)
                discovery = self.capture_material_discovery(record)
                matches = [item for item in discovery.get("links", [])
                           if item.get("url") == target and item.get("label") == descriptor.get("label")]
                # The same attachment is commonly rendered twice (top and
                # bottom supplement blocks). Duplicate DOM anchors with the
                # same href+label are one material, not an ambiguity.
                if (not matches or len({item.get("url") for item in matches}) != 1
                        or discovery.get("status") not in {"checked", "unknown"}):
                    return attention("page_error", "当前同篇详情中无法唯一核对该补充材料，未点击链接。")
            self._blocked = None
            attached = set()
            seen_responses = set()
            origin_hosts = {(urlsplit(target).hostname or "").lower(), (urlsplit(parent.url).hostname or "").lower()}

            def file_response(response, page, page_id):
                try:
                    request = response.request
                    headers = response.headers or {}
                    mime = str(headers.get("content-type") or "").lower()
                    attachment = "attachment" in str(headers.get("content-disposition") or "").lower()
                    main_navigation = request.is_navigation_request() and request.frame == page.main_frame
                    pdf_response = "application/pdf" in mime
                    if (id(response) not in seen_responses and clicked
                        and (main_navigation or pdf_response)
                        and (attachment or (mime and not any(kind in mime for kind in ("html", "javascript"))))):
                        seen_responses.add(id(response))
                        responses.append((response, page_id))
                except Exception:
                    pass

            def attach(page):
                if id(page) in attached:
                    return
                attached.add(id(page))
                # Resolve while live. Download save_as may finish after the
                # transient window closes; its proof must survive that close.
                page_id = literature_browser._target_id(self._context, page)
                def got_download(download):
                    if clicked:
                        downloads.append((download, page_id))
                def got_response(response):
                    file_response(response, page, page_id)
                page.on("download", got_download)
                page.on("response", got_response)
                listeners.extend([(page, "download", got_download), (page, "response", got_response)])

            def got_popup(child):
                nonlocal popup_error
                if child in children:
                    return
                if child.opener() is not parent or children:
                    popup_error = True
                    return
                child_id = literature_browser._target_id(self._context, child)
                children.append(child)
                self._binding["material_flow"]["child_target_id"] = child_id
                self._write_binding()
                attach(child)

            def context_response(response):
                # The first response can arrive before the popup event. Only
                # this action's direct child main frame is eligible; never
                # enumerate or choose a pre-existing context page.
                try:
                    if not clicked:
                        return
                    frame = response.request.frame
                    child = frame.page
                    if child is parent or frame != child.main_frame or child.opener() is not parent:
                        return
                    got_popup(child)
                    if child in children:
                        file_response(response, child, literature_browser._target_id(self._context, child))
                except Exception:
                    pass

            attach(parent)
            parent.on("popup", got_popup)
            listeners.append((parent, "popup", got_popup))
            self._context.on("response", context_response)
            listeners.append((self._context, "response", context_response))
            if resume:
                clicked = flow.get("step") == "download_clicked"
                if not clicked:
                    return attention("page_error", "该补充材料已返回文件，等待保存状态；不会重复下载。")
                child_id = flow.get("child_target_id")
                if child_id:
                    child = self._find_target_page(child_id)
                    if child is None or child.opener() is not parent:
                        return attention("page_error", "原补充材料任务窗口已关闭或无法核对，未接管其他窗口。")
                    children.append(child)
                    attach(child)
            else:
                self._pace(parent.url)
                snapshot = parent.evaluate(_SNAPSHOT_JS)
                reason = self._reason(snapshot)
                if reason:
                    return attention(reason, snapshot=snapshot)
                refreshed = self._discovery(record, snapshot, parent.url)
                if not any(item.get("url") == target and item.get("label") == descriptor.get("label") for item in refreshed.get("links", [])):
                    return attention("page_error", "补充材料入口在等待期间变化，未点击其他链接。")
                elements = []
                for element in parent.query_selector_all("a[href]"):
                    value = element.evaluate(
                        "e => { if (typeof e.addEventListener === 'function' && /Mac/i.test(navigator.platform || '')) {"
                        " e.addEventListener('click', ev => { if (ev.ctrlKey && !ev.metaKey) { ev.preventDefault(); window.open(e.href, '_blank'); } }, {once: true, capture: true});"
                        " e.addEventListener('contextmenu', ev => { if (ev.ctrlKey && !ev.metaKey) { ev.preventDefault(); } }, {once: true, capture: true});"
                        " } return {url:e.href,label:(e.innerText||e.title||e.querySelector('img')?.alt||'').trim()}; }"
                    )
                    if element.is_visible() and value.get("url") == target and value.get("label", "")[:300] == descriptor.get("label", ""):
                        elements.append(element)
                    else:
                        element.dispose()
                if not elements:
                    return attention("page_error", "补充材料可见链接已变化，未点击。")
                # Multiple anchors with the identical href+label are duplicate
                # renderings of the same attachment; click the first one.
                element = elements[0]
                for duplicate in elements[1:]:
                    duplicate.dispose()
                self._binding["material_flow"] = {"key": key, "paper_hash": _material_key(record), "parent_target_id": parent_id, "step": "download_clicked"}
                material_id = str(descriptor.get("material_id") or "")
                if re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", material_id):
                    self._binding["material_flow"]["material_id"] = material_id
                self._write_binding()
                clicked = True
                try:
                    element.click(modifiers=["Control"], timeout=15_000, no_wait_after=True)
                finally:
                    element.dispose()
            started = self._clock()
            self._progress("补充材料：已打开本篇实际附件链接，等待下载完成；不会重复点击。")
            while self._clock() - started < MATERIAL_DOWNLOAD_TIMEOUT_MS / 1000:
                if popup_error:
                    return attention("page_error", "补充材料打开了额外或无法核对来源关系的窗口，已暂停；不会操作其他窗口。")
                while downloads:
                    download, _ = downloads.pop(0)
                    actual = str(getattr(download, "url", "") or "")
                    parsed = urlsplit(actual[5:] if actual.startswith("blob:") else actual)
                    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or not _material_host_allowed(parsed.hostname or "", origin_hosts):
                        return attention("page_error", "补充材料文件来源与本次实际链接无法核对，已暂停。")
                    result = self._read_material_download(download, descriptor)
                    if result is None:
                        return attention("page_error", "补充材料下载未完成或返回错误内容，原页面已保留。")
                    return self._retain_material_file(key, result)
                while responses:
                    response, _ = responses.pop(0)
                    response_reason = self._reason({}, int(getattr(response, "status", 0) or 0))
                    if response_reason:
                        return attention(response_reason, url=str(response.url))
                    parsed = urlsplit(str(response.url))
                    if parsed.scheme not in {"http", "https"} or not _material_host_allowed(parsed.hostname or "", origin_hosts) or parsed.username or parsed.password:
                        return attention("page_error", "补充材料响应来源无法核对，已暂停。")
                    blob = response.body()
                    if not isinstance(blob, bytes) or not 0 < len(blob) <= MAX_MATERIAL_BYTES:
                        return attention("page_error", "补充材料响应未包含完整文件，已暂停。")
                    disposition = Message()
                    disposition["content-disposition"] = str(response.headers.get("content-disposition") or "")
                    filename = disposition.get_filename() or descriptor.get("filename") or Path(parsed.path).name or "material"
                    if re.match(br"\s*(?:<!doctype\s+html|<html|<form)", blob[:300], re.I) and not str(filename).lower().endswith((".html", ".htm")):
                        return attention("page_error", "补充材料响应为错误或登录网页，未当作原始附件保存。")
                    result = {"status": "file", "bytes": blob, "suggested_filename": filename,
                              "mime_type": str(response.headers.get("content-type") or descriptor.get("mime_type") or "application/octet-stream"), "url": literature_browser.safe_url(response.url)}
                    return self._retain_material_file(key, result)
                for page in [parent] + children:
                    if not page.is_closed() and literature_browser.safe_url(page.url):
                        snapshot = page.evaluate(_SNAPSHOT_JS)
                        reason = self._reason(snapshot)
                        if reason:
                            return attention(reason, snapshot=snapshot, url=page.url)
                if not _material_identity(parent.evaluate(_SNAPSHOT_JS), record):
                    return attention("page_error", "补充材料操作后原文详情发生变化，已暂停；不会继续打开附件。")
                parent.wait_for_timeout(200)
                self._sleep(0.01)
            return attention("load_timeout", "补充材料超过3分钟未就绪，原窗口已保留；处理后继续，不会重复点击。")
        except Exception:
            return {"status": "fetch_error", "error": "补充材料任务页面或下载未能核对，原窗口已保留。"}
        finally:
            for page, event, listener in listeners:
                try:
                    page.remove_listener(event, listener)
                except Exception:
                    pass

    def _visit(self, url, opts, *, out_path=None):
        if self._blocked:
            return dict(self._blocked)
        deferred = self._deferred_attention(url)
        if deferred:
            return deferred
        safe = literature_browser.safe_url(url)
        if not safe:
            return {"status": "fetch_error", "error": "文献入口不是可访问的公开HTTP链接。", "url": ""}
        self._request_url = url
        try:
            page = self._get_page()
            timeout = max(5000, min(MAX_PAGE_TIMEOUT_MS, int(opts.get("per_paper_timeout_sec") or 120) * 1000))
            pending = self._binding.get("pending_url_hash") == _url_hash(url)
            downloads = []
            def capture_download(download):
                downloads.append(download)
            page.on("download", capture_download)
            response = None
            nav_error = None
            try:
                if not pending:
                    self._pace(url)
                    self._progress("全文获取：正在同一任务页面访问下一篇文献。")
                    try:
                        response = page.goto(url, wait_until="domcontentloaded", timeout=timeout)
                    except Exception as exc:
                        nav_error = exc
                        # Chromium aborts normal navigation when an attachment
                        # download begins. Drain only this page's event queue.
                        if "ERR_ABORTED" in str(exc) or "Download is starting" in str(exc):
                            page.wait_for_timeout(200)
                            if not downloads and getattr(self._context, "request", None) is not None:
                                for _ in range(15):
                                    if downloads:
                                        break
                                    page.wait_for_timeout(200)
                    self._record_destination(page.url or url)
                if opts.get("materials_only") and (downloads or "application/pdf" in str((getattr(response, "headers", {}) or {}).get("content-type", "")).lower()):
                    return {"status": "ok", "url": literature_browser.safe_url(page.url) or safe,
                            "material_discovery": {"status": "unknown", "reason": "only_main_pdf_page_available", "source_url": safe, "links": []}}
                for download in downloads:
                    blob = self._read_download(download, out_path)
                    if blob is not None:
                        self._clear_pending()
                        return {"status": "saved" if out_path else "pdf_page", "url": literature_browser.safe_url(page.url) or safe,
                                "bytes": blob, "size": len(blob)}
                if nav_error is not None:
                    reason = "load_timeout" if "timeout" in type(nav_error).__name__.lower() or "timeout" in str(nav_error).lower() else "page_error"
                    return self._attention(reason, safe, observed_url=page.url)
                status = int(getattr(response, "status", 0) or 0)
                if status in (401, 403, 404, 429) or status >= 500:
                    try:
                        error_snapshot = page.evaluate(_SNAPSHOT_JS)
                    except Exception:
                        error_snapshot = {}
                    if not isinstance(error_snapshot, dict):
                        error_snapshot = {}
                    return self._attention(self._reason(error_snapshot, status), safe, snapshot=error_snapshot, observed_url=page.url)
                content_type = str((getattr(response, "headers", {}) or {}).get("content-type", "")).lower()
                if "application/pdf" in content_type:
                    self._progress("全文获取：文件正在生成或下载，等待实际传输完成后再保存。")
                    try:
                        blob = response.body()
                    except Exception:
                        return self._attention("load_timeout", safe, observed_url=page.url)
                    if not isinstance(blob, bytes) or not blob.startswith(b"%PDF") or not MIN_PDF_BYTES <= len(blob) <= MAX_PDF_BYTES:
                        return {"status": "fetch_error", "error": "页面响应未通过PDF内容校验。", "url": literature_browser.safe_url(page.url) or safe}
                    if out_path is not None:
                        _save_pdf(out_path, blob)
                    self._clear_pending()
                    return {"status": "saved" if out_path else "pdf_page", "url": literature_browser.safe_url(page.url) or safe,
                            "bytes": blob, "size": len(blob)}
                snapshot = page.evaluate(_SNAPSHOT_JS)
                if not isinstance(snapshot, dict):
                    return self._attention("page_error", safe, observed_url=page.url)
                # 首次加载可能晚于 domcontentloaded 完成正文区渲染（PMC 常见）；
                # 只在“长页面但未验证正文容器”时多等一次，避免把全文误判成摘要。
                snapshot = _settle_article_snapshot(page, snapshot)
                reason = self._reason(snapshot, status)
                if reason:
                    return self._attention(reason, safe, snapshot=snapshot, observed_url=page.url)
                self._clear_pending()
                final_url = literature_browser.safe_url(page.url) or safe
                links = []
                for link in snapshot.get("links", []):
                    if not isinstance(link, dict):
                        continue
                    target = literature_browser.safe_url(urljoin(final_url, str(link.get("url") or "")))
                    if target:
                        label = str(link.get("text") or "")[:180]
                        links.append({"url": target, "text": label, "kind": "pdf" if "pdf" in (target + " " + label).lower() else "fulltext"})
                evidence = {key: snapshot.get(key) for key in (
                    "page_title", "citation_title", "citation_doi", "article_text", "article_html", "headings", "sections",
                    "container", "container_verified", "origin")}
                evidence["links"] = links
                discovery, interrupted = self._observe_materials(opts.get("record") or {}, snapshot, page.url, opts)
                if interrupted:
                    return interrupted
                return {"status": "ok", "url": final_url, "text": str(snapshot.get("text") or ""), "html_evidence": evidence,
                        "material_discovery": discovery}
            finally:
                page.remove_listener("download", capture_download)
        except Exception:
            return {"status": "fetch_error", "error": "全文浏览器连接或页面读取失败；请检查原任务页面。", "url": safe}

    def fetch_page(self, url, opts):
        result = self._visit(url, opts)
        if "material_discovery" not in result:
            result["material_discovery"] = self._material_discoveries.get(_material_key(opts.get("record") or {}),
                {"status": "unknown", "reason": "article_materials_not_observed", "source_url": literature_browser.safe_url(url), "links": []})
        return result

    def fetch_cnki(self, record, opts):
        # The source flow clicks actual official controls; it never replays a
        # cached transfer URL or alters the original candidate/search snapshot.
        from literature_cnki_fulltext import run_cnki
        result = self._deferred_attention("https://kns.cnki.net/") or run_cnki(self, record, opts)
        result.setdefault("material_discovery", self._material_discoveries.get(_material_key(record),
            {"status": "unknown", "reason": "article_materials_not_observed", "source_url": "", "links": []}))
        return result

    def _fetch_pdf_via_context_request(self, target_url, out_path):
        api_request = getattr(self._context, "request", None)
        if api_request is None:
            return None
        candidates = [target_url]
        pmc_match = re.search(r"pmc\.ncbi\.nlm\.nih\.gov/articles/(PMC[1-9]\d*)", str(target_url), re.I)
        if pmc_match:
            pmcid = pmc_match.group(1).upper()
            candidates.append(f"https://europepmc.org/backend/ptpmcrender.fcgi?accid={pmcid}&blobtype=pdf")
        for candidate in candidates:
            safe = literature_browser.safe_url(candidate)
            if not safe:
                continue
            try:
                resp = api_request.get(safe, timeout=MAX_PAGE_TIMEOUT_MS)
                if int(getattr(resp, "status", 0) or 0) != 200:
                    continue
                blob = resp.body()
                if isinstance(blob, bytes) and blob.startswith(b"%PDF") and MIN_PDF_BYTES <= len(blob) <= MAX_PDF_BYTES:
                    if out_path is not None:
                        _save_pdf(out_path, blob)
                    self._clear_pending()
                    return {"status": "saved" if out_path else "pdf_page", "url": safe, "bytes": blob, "size": len(blob)}
            except Exception:
                continue
        return None

    def fetch_pdf(self, url, out_path, opts):
        result = self._visit(url, opts, out_path=out_path)
        discovery = result.get("material_discovery") or self._material_discoveries.get(_material_key(opts.get("record") or {}))
        if result.get("status") == "ok":
            # One current-page visible PDF link may lead to the actual legal
            # artifact.  It uses the same tab and the same per-site pacing.
            # Do not guess hidden endpoints or keep trying alternative links.
            for link in result.get("html_evidence", {}).get("links", []):
                target = link.get("url")
                if link.get("kind") == "pdf" and target and target not in {url, result.get("url")}:
                    result = self._visit(target, opts, out_path=out_path)
                    break
        if result.get("status") not in {"saved", "pdf_page"} and getattr(self._context, "request", None) is not None:
            direct = self._fetch_pdf_via_context_request(result.get("url") or url, out_path)
            if direct is not None:
                if self._blocked:
                    self._blocked = None
                    self._blocked_url = ""
                result = direct
        result.setdefault("material_discovery", discovery or {"status": "unknown", "reason": "article_materials_not_observed", "source_url": literature_browser.safe_url(url), "links": []})
        if result.get("status") == "ok":
            # A visible HTML page or an enabled PDF button alone is not a PDF.
            return {"status": "html_page", "url": result.get("url", ""), "message": "该入口返回网页，尚未取得PDF。",
                    "html_evidence": result.get("html_evidence", {}), "text": result.get("text", ""), "material_discovery": result["material_discovery"]}
        return result
