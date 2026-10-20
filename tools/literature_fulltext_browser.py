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
import os
from pathlib import Path
import tempfile
import time
from urllib.parse import urljoin, urlsplit

import literature_browser
atomic_write_json = importlib.import_module("literature-common").atomic_write_json


DEFAULT_SITE_INTERVAL_SECONDS = 8.0
CNKI_SITE_INTERVAL_SECONDS = 10.0
MAX_PAGE_TIMEOUT_MS = 60_000
MAX_PDF_BYTES = 64 * 1024 * 1024
MIN_PDF_BYTES = 50 * 1024

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
  const fulltextAnchors = Array.from(document.querySelectorAll('.full-text-links a[href],.full-text-links-list a[href],.linkout-list a[href]')).filter(visible).slice(0,8).map(linkValue);
  const labelledAnchors = Array.from(document.querySelectorAll('a[href]')).filter(visible).map(linkValue)
    .filter(a=>/pdf|full[ -]?text|全文|阅读全文|view article/i.test(a.text+' '+a.url)).slice(0,50);
  const links = [...new Map([...fulltextAnchors,...labelledAnchors].map(a=>[a.url,a])).values()];
  const bodyText=(document.body?.innerText || '').slice(0,2000000);
  const prefix=bodyText.slice(0,5000);
  const headline=Array.from(document.querySelectorAll('h1,h2,[role="alert"]')).filter(visible).map(text).join(' ').slice(0,2000);
  const sourceApplicationError=/(?:来源应用|来源程序)(?:不正确|错误|无效)|(?:下载入口|(?:下载|来源)?链接)(?:已(?:经)?)?(?:失效|无效|错误)/i.test(headline+'\n'+prefix.slice(0,2000));
  return {
    text:bodyText,
    page_title:document.title || '',
    citation_title:meta(['citation_title','dc.title','DC.Title','og:title']) || text(Array.from(document.querySelectorAll('h1')).find(visible)),
    citation_doi:meta(['citation_doi','dc.identifier','DC.Identifier','prism.doi','article:doi']),
    article_text:articleText,article_html:articleHtml,headings,sections,links,container:selector,
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
}"""

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
        self.job_dir = Path(job_dir)
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
        context = self._connect()
        wanted = self._binding.get("target_id")
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
        """Only foreground an existing binding; never create/reopen a page."""
        try:
            page = self._find_bound_page()
            if page is None:
                return {"opened": False, "message": "原任务的全文页面已关闭，请显式继续原任务。"}
            page.bring_to_front()
            return {"opened": True, "message": "已打开原任务的全文页面，请在该页处理后检查并继续。"}
        except Exception:
            return {"opened": False, "message": "无法打开原任务的全文页面，请检查本机浏览器。"}

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
        if self._blocked:
            return {"closed": False}
        try:
            page = self._find_bound_page()
            if page is None:
                return {"closed": False}
            page.close(run_before_unload=False)
            self._page = None
            self._binding.pop("target_id", None)
            self._binding.pop("pending_url_hash", None)
            self._binding.pop("attention_reason", None)
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

    def _attention(self, reason, url, *, snapshot=None):
        safe = literature_browser.safe_url(url)
        self._binding["pending_url_hash"] = _url_hash(self._request_url)
        self._binding["attention_reason"] = reason
        self._write_binding()
        message = _MESSAGES[reason]
        if reason == "page_error" and isinstance(snapshot, dict) and snapshot.get("source_application_error"):
            message = "知网提示来源应用不正确或下载入口失效，已暂停；请从知网正常详情或检索页面核对入口后继续。"
        result = {"status": "attention", "reason": reason, "url": safe, "message": message}
        self._blocked = result
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

    def _visit(self, url, opts, *, out_path=None):
        if self._blocked:
            return dict(self._blocked)
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
                        if "ERR_ABORTED" in str(exc):
                            page.wait_for_timeout(200)
                    self._record_destination(page.url or url)
                for download in downloads:
                    blob = self._read_download(download, out_path)
                    if blob is not None:
                        self._clear_pending()
                        return {"status": "saved" if out_path else "pdf_page", "url": literature_browser.safe_url(page.url) or safe,
                                "bytes": blob, "size": len(blob)}
                if nav_error is not None:
                    reason = "load_timeout" if "timeout" in type(nav_error).__name__.lower() or "timeout" in str(nav_error).lower() else "page_error"
                    return self._attention(reason, page.url or url)
                status = int(getattr(response, "status", 0) or 0)
                if status in (401, 403, 404, 429) or status >= 500:
                    try:
                        error_snapshot = page.evaluate(_SNAPSHOT_JS)
                    except Exception:
                        error_snapshot = {}
                    if not isinstance(error_snapshot, dict):
                        error_snapshot = {}
                    return self._attention(self._reason(error_snapshot, status), page.url or url, snapshot=error_snapshot)
                content_type = str((getattr(response, "headers", {}) or {}).get("content-type", "")).lower()
                if "application/pdf" in content_type:
                    self._progress("全文获取：文件正在生成或下载，等待实际传输完成后再保存。")
                    try:
                        blob = response.body()
                    except Exception:
                        return self._attention("load_timeout", page.url or url)
                    if not isinstance(blob, bytes) or not blob.startswith(b"%PDF") or not MIN_PDF_BYTES <= len(blob) <= MAX_PDF_BYTES:
                        return {"status": "fetch_error", "error": "页面响应未通过PDF内容校验。", "url": literature_browser.safe_url(page.url) or safe}
                    if out_path is not None:
                        _save_pdf(out_path, blob)
                    self._clear_pending()
                    return {"status": "saved" if out_path else "pdf_page", "url": literature_browser.safe_url(page.url) or safe,
                            "bytes": blob, "size": len(blob)}
                snapshot = page.evaluate(_SNAPSHOT_JS)
                if not isinstance(snapshot, dict):
                    return self._attention("page_error", page.url or url)
                reason = self._reason(snapshot, status)
                if reason:
                    return self._attention(reason, page.url or url, snapshot=snapshot)
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
                return {"status": "ok", "url": final_url, "text": str(snapshot.get("text") or ""), "html_evidence": evidence}
            finally:
                page.remove_listener("download", capture_download)
        except Exception:
            return {"status": "fetch_error", "error": "全文浏览器连接或页面读取失败；请检查原任务页面。", "url": safe}

    def fetch_page(self, url, opts):
        return self._visit(url, opts)

    def fetch_pdf(self, url, out_path, opts):
        result = self._visit(url, opts, out_path=out_path)
        if result.get("status") == "ok":
            # One current-page visible PDF link may lead to the actual legal
            # artifact.  It uses the same tab and the same per-site pacing.
            # Do not guess hidden endpoints or keep trying alternative links.
            for link in result.get("html_evidence", {}).get("links", []):
                target = link.get("url")
                if link.get("kind") == "pdf" and target and target not in {url, result.get("url")}:
                    result = self._visit(target, opts, out_path=out_path)
                    break
        if result.get("status") == "ok":
            # A visible HTML page or an enabled PDF button alone is not a PDF.
            return {"status": "html_page", "url": result.get("url", ""), "message": "该入口返回网页，尚未取得PDF。",
                    "html_evidence": result.get("html_evidence", {}), "text": result.get("text", "")}
        return result
