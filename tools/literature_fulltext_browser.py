"""Sequential full-text access in one task-owned persistent browser tab.

The browser profile belongs to the researcher.  This module only disconnects
its CDP client, never closes that browser or borrows unrelated existing tabs.
The driver may close this task's page after its verified artifact is saved.
Visible login, verification and access problems are returned to the driver.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
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
MAX_PAGE_TIMEOUT_MS = 120_000
MATERIAL_DOWNLOAD_TIMEOUT_MS = 180_000
PAGE_IDLE_SECONDS = 120.0
PAGE_ACTIVITY_SECONDS = 600.0
PAGE_STABLE_SECONDS = 3.0
MAX_PDF_BYTES = 64 * 1024 * 1024
MIN_PDF_BYTES = 50 * 1024
MAX_MATERIAL_BYTES = 256 * 1024 * 1024


def _signed_pdf_expired(url):
    """Read an observed AWS expiry only; never construct or log a signed URL."""
    try:
        values = {key.casefold(): value[0] for key, value in parse_qs(urlsplit(url).query).items() if value}
        created = datetime.strptime(values["x-amz-date"], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        lifetime = int(values["x-amz-expires"])
        return 0 < lifetime <= 604800 and time.time() >= created.timestamp() + lifetime
    except (KeyError, TypeError, ValueError, OverflowError):
        return False

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

_VERIFICATION_SELECTORS = (
    'iframe[src*="captcha"]', 'iframe[src*="recaptcha"]',
    '.geetest_panel', '.verifybox', '#captcha', '.captcha',
)


def sanitize_verification_evidence(value):
    """Accept fixed detector codes only; never persist challenge URLs or text."""
    if not isinstance(value, list):
        return []
    allowed = {"cnki_verify_route", "cnki_security_prompt", "verification_prompt",
               "cnki_security_title", "cnki_security_heading_visible", "cnki_security_body_visible"}
    allowed.update("visible_challenge_widget:" + selector for selector in _VERIFICATION_SELECTORS)
    return list(dict.fromkeys(item for item in value if isinstance(item, str) and item in allowed))


_PAINTED_VISIBLE_FUNCTION_JS = r"""e=>{
  const visible=e=>!!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)
    && getComputedStyle(e).display!=='none' && getComputedStyle(e).visibility!=='hidden';
    if(!visible(e)) return false;
    const rect=e.getBoundingClientRect?.();
    if(rect && (rect.width<=0 || rect.height<=0)) return false;
    const viewportWidth=globalThis.innerWidth || document.documentElement?.clientWidth;
    const viewportHeight=globalThis.innerHeight || document.documentElement?.clientHeight;
    if(rect && ((viewportWidth && (rect.right<=0 || rect.left>=viewportWidth))
      || (viewportHeight && (rect.bottom<=0 || rect.top>=viewportHeight)))) return false;
    for(let node=e;node;node=node.parentElement){
      const style=getComputedStyle(node);
      if(node.hidden || style.display==='none' || /^(hidden|collapse)$/.test(style.visibility)
        || (style.opacity!=='' && Number(style.opacity)===0) || style.contentVisibility==='hidden') return false;
      if(node!==e && rect && /^(hidden|clip|scroll|auto)$/.test(style.overflow||'')){
        const clip=node.getBoundingClientRect?.();
        if(clip && (rect.right<=clip.left || rect.left>=clip.right || rect.bottom<=clip.top || rect.top>=clip.bottom)) return false;
      }
    }
    return true;
}"""

# The metadata reader embeds this same function so its second snapshot cannot
# classify an inactive captcha shell differently from the full-text driver.
_VERIFICATION_FUNCTION_JS = r"""(options = {}) => {
  const text=e=>(e?.innerText || '').trim();
  // Publishers preload captcha containers on ordinary result/article pages.
  // A laid-out shell alone is not an active challenge. Check its painted
  // ancestors and require a visible prompt or an actual challenge surface.
  const challengeVisible=(__PAINTED_VISIBLE_FUNCTION__);
  // innerText can still contain offscreen/transparent preloaded challenge
  // labels. A standalone line in the whole body is not visible evidence.
  // Require a short rendered element and ignore containers whose matching
  // text actually comes from an unpainted descendant.
  let promptNodes;
  const promptElements=()=>promptNodes || (promptNodes=[document.body,...document.querySelectorAll('body *')].filter(Boolean));
  const visiblePrompt=(e,match)=>{
    const value=text(e);
    if(!value || value.length>500 || !match(value) || !challengeVisible(e)) return false;
    return !Array.from(e.querySelectorAll('*')).some(child=>{
      const childText=text(child);
      return childText && match(childText) && !challengeVisible(child);
    });
  };
  // CNKI's official verification route blocks even before the widget loads.
  // A stale document.title alone on a normal result page does not establish
  // a challenge; record it only when a rendered security prompt corroborates it.
  const cnkiPage=/^https?:$/.test(location.protocol) && /(?:^|\.)cnki\.net$/i.test(location.hostname);
  const cnkiVerifyRoute=cnkiPage && /^\/verify\/home\/?$/i.test(location.pathname);
  const securityPrompt=value=>/^(?:安全验证(?:\s*[-—|·]\s*(?:中国知网|知网|CNKI))?|(?:请)?拖动.{0,12}(?:滑块|验证).{0,12})[。！!：:]?$/i.test(value.trim());
  const cnkiPromptEligible=cnkiPage && !options.articleText && !options.citationTitle;
  const cnkiHeadingPrompt=cnkiPromptEligible && Array.from(document.querySelectorAll('h1,h2,[role="alert"]')).some(e=>visiblePrompt(e,securityPrompt));
  const cnkiBodyPrompt=cnkiPromptEligible && !cnkiHeadingPrompt && promptElements().some(e=>visiblePrompt(e,securityPrompt));
  const cnkiSecurityTitle=(cnkiHeadingPrompt || cnkiBodyPrompt) && securityPrompt(document.title || '');
  const challengePrompt=/人机验证|滑动验证|请完成(?:安全)?验证|访问验证|拖动.{0,12}滑块|验证.{0,12}(?:继续|访问)|verify you are human|are you a robot|security verification/i;
  const challengeSurface=e=>{
    if(!challengeVisible(e)) return false;
    if(String(e.tagName||'').toLowerCase()==='iframe'){
      // Invisible reCAPTCHA frames can remain in the page after completion.
      const r=e.getBoundingClientRect?.();
      if(r && (r.width<20 || r.height<20)) return false;
    }
    return true;
  };
  const activeChallengeSelector=__CHALLENGE_SELECTORS__.find(sel=>Array.from(document.querySelectorAll(sel)).some(e=>{
    if(!challengeVisible(e)) return false;
    if(String(e.tagName||'').toLowerCase()==='iframe') return challengeSurface(e);
    if(visiblePrompt(e,value=>challengePrompt.test(value))
      || Array.from(e.querySelectorAll('*')).some(child=>visiblePrompt(child,value=>challengePrompt.test(value)))) return true;
    return Array.from(e.querySelectorAll('iframe,img,canvas,input:not([type="hidden"]),button,[role="button"],[role="slider"]')).some(challengeSurface);
  }));
  const genericPrompt=value=>/人机验证|滑动验证|请完成验证|访问验证|unusual traffic|verify you are human|are you a robot/i.test(value);
  const verificationPrompt=genericPrompt(text(document.body).slice(0,2000)) && promptElements().some(e=>visiblePrompt(e,genericPrompt));
  const evidence=[cnkiVerifyRoute?'cnki_verify_route':'',cnkiSecurityTitle?'cnki_security_title':'',
    cnkiHeadingPrompt?'cnki_security_heading_visible':'',cnkiBodyPrompt?'cnki_security_body_visible':'',
    activeChallengeSelector?'visible_challenge_widget:'+activeChallengeSelector:'',verificationPrompt?'verification_prompt':''].filter(Boolean);
  return {verification:evidence.length>0,verification_evidence:evidence};
}""".replace("__CHALLENGE_SELECTORS__", json.dumps(_VERIFICATION_SELECTORS)).replace("__PAINTED_VISIBLE_FUNCTION__", _PAINTED_VISIBLE_FUNCTION_JS)


_DOWNLOAD_STATE_FUNCTION_JS = r"""() => {
  const painted=(__PAINTED_VISIBLE_FUNCTION__);
  const text=e=>(e?.innerText || '').trim();
  // CNKI's static footer contains "下载中心". It is not "下载中".
  // A pending status must be a rendered short message, not a substring in
  // the whole page, a preloaded dialog, or a statement in article/help text.
  const pendingText=value=>/^(?:PDF\s*[:：]?\s*)?(?:文件正在生成|正在生成(?:文件|全文|PDF)|正在(?:下载|传输)(?:文件|全文|PDF)?|下载中|preparing your (?:file|download)|generating (?:your )?(?:file|pdf)|download in progress|downloading(?: (?:your )?(?:file|pdf))?)(?=$|[\s.。…，,！!：:\d(（])/i.test(value.trim());
  const pendingPrompt=e=>{
    const value=text(e);
    if(!value || value.length>300 || !pendingText(value) || !painted(e)
      || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(e.tagName||'')
      || e.closest('article,nav,footer,[role="navigation"]')) return false;
    return !Array.from(e.querySelectorAll('*')).some(child=>pendingText(text(child) || child.textContent || '') && !painted(child));
  };
  const textPending=[document.body,...document.querySelectorAll('body *')].filter(Boolean).some(pendingPrompt);
  const progress=Array.from(document.querySelectorAll('[role="progressbar"]')).filter(e=>{
    if(!painted(e)) return false;
    const label=[e.getAttribute('aria-label'),e.getAttribute('title'),text(e)].join(' ');
    if(/reading|阅读/i.test(label)) return false;
    if(!/download|generat|prepar|下载|生成|准备文件/i.test(label)
      && !e.closest('[id*="download"],[class*="download"],[id*="generat"],[class*="generat"]')) return false;
    return true;
  });
  const pendingProgress=progress.some(e=>{
    const now=Number(e.getAttribute('aria-valuenow')), max=Number(e.getAttribute('aria-valuemax')||100);
    return !e.hasAttribute('aria-valuenow') || (Number.isFinite(now) && now<max);
  });
  return {download_pending:textPending || pendingProgress,
    file_progress:progress.map(e=>[e.getAttribute('aria-valuenow'),e.getAttribute('aria-valuemax')])};
}""".replace("__PAINTED_VISIBLE_FUNCTION__", _PAINTED_VISIBLE_FUNCTION_JS)

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
  const labelledAnchors = Array.from(document.querySelectorAll('a[href]')).filter(visible).filter(a=>{
    const raw=(a.getAttribute('href')||'').trim();
    const label=(text(a)||a.getAttribute('aria-label')||a.title||a.querySelector('img')?.alt||'').trim();
    if(raw.startsWith('#') || /^(?:skip(?:\s+to)?\b|back to top|返回顶部|跳到|跳转到)/i.test(label)) return false;
    try {
      const target=new URL(a.href);
      if(target.origin===location.origin && target.pathname===location.pathname && target.search===location.search) return false;
      const actualPdf=/\.pdf(?:$|\/)|\/(?:pdf|pdfplus)(?:\/|$)/i.test(target.pathname);
      return !materialUrls.has(a.href)&&!supplementalUrl(a.href)
        && (/\bpdf\b|full[ -]?text|全文|阅读全文|view article/i.test(label) || actualPdf);
    } catch(_){return false;}
  }).map(linkValue).slice(0,50);
  const metaPdfUrls = [meta(['citation_pdf_url']), ...Array.from(document.querySelectorAll('link[rel="alternate"][type="application/pdf"][href]')).map(e=>e.href)]
    .filter(u=>u&&!materialUrls.has(u)&&!supplementalUrl(u)).map(url=>({url,text:'PDF'}));
  const citationDoi=meta(['citation_doi','dc.identifier','DC.Identifier','prism.doi','article:doi']);
  const citationTitle=meta(['citation_title','dc.title','DC.Title','og:title']) || text(Array.from(document.querySelectorAll('h1')).find(visible));
  const pdfControls=Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible)
    .filter(e=>/^(?:pdf(?:\s*(?:download|下载))?|download\s*pdf)$/i.test((text(e)||e.getAttribute('aria-label')||'').trim()));
  // A PDF reader can expose its actual download anchor in a closed PDF menu.
  // Accept only that observed same-origin URL carrying the page's own DOI.
  const readerPdfAnchors=citationDoi&&pdfControls.length?Array.from(document.querySelectorAll('a[href]')).filter(a=>{
    const label=(text(a)||a.getAttribute('aria-label')||a.title||'').trim();
    if(!/^(?:pdf\b|download\s*pdf\b|PDF下载|下载PDF)/i.test(label) || (a.getAttribute('href')||'').trim().startsWith('#')) return false;
    try {const u=new URL(a.href);return u.origin===location.origin && /\/(?:e?pdf|pdfplus)\//i.test(u.pathname)
      && !(u.pathname===location.pathname && u.search===location.search && u.hash)
      && decodeURIComponent(u.href).toLowerCase().includes(citationDoi.toLowerCase());} catch(_){return false;}
  }).map(a=>{const u=new URL(a.href);u.hash='';return {url:u.href,text:'PDF'};}):[];
  const links = [...new Map([...readerPdfAnchors,...metaPdfUrls,...fulltextAnchors,...labelledAnchors].map(a=>[a.url,a])).values()];
  const bodyText=(document.body?.innerText || '').slice(0,2000000);
  const prefix=bodyText.slice(0,5000);
  const headline=Array.from(document.querySelectorAll('h1,h2,[role="alert"]')).filter(visible).map(text).join(' ').slice(0,2000);
  const sourceApplicationError=/(?:来源应用|来源程序)(?:不正确|错误|无效)|(?:下载入口|(?:下载|来源)?链接)(?:已(?:经)?)?(?:失效|无效|错误)/i.test(headline+'\n'+prefix.slice(0,2000));
  const verificationState=(__VERIFICATION_FUNCTION__)({articleText,citationTitle:meta(['citation_title','dc.title','DC.Title'])});
  const downloadState=(__DOWNLOAD_STATE_FUNCTION__)();
  return {
    text:bodyText,
    page_title:document.title || '',
    citation_title:citationTitle,
    citation_doi:citationDoi,
    ready_state:document.readyState,
    reader_ready:!!(citationDoi && pdfControls.length && readerPdfAnchors.length),
    bibliographic_ready:!!(citationTitle && (fulltextAnchors.length || Array.from(document.querySelectorAll('.abstract,#abstract,#enc-abstract,[itemprop="abstract"]')).some(e=>visible(e)&&text(e).length>=80))),
    loading_pending:Array.from(document.querySelectorAll('main[aria-busy="true"],article[aria-busy="true"],main [aria-busy="true"],article [aria-busy="true"],main .loading,article .loading,main .skeleton,article .skeleton,[role="main"][aria-busy="true"]')).some(visible),
    article_text:articleText,article_html:articleHtml,headings,sections,links,materials,container:selector,
    container_verified:!!chosen && articleText.length>=800 && (explicit || structural.length>=2),
    origin:'dom_article_region',
    verification:verificationState.verification,
    verification_evidence:verificationState.verification_evidence,
    rate_limited:/too many requests|请求过于频繁|访问过于频繁|操作过于频繁|访问频率|rate limit|retry later/i.test(prefix.slice(0,2000)),
    source_application_error:sourceApplicationError,
    page_error:sourceApplicationError || /^(?:\s*(?:404|page not found|not found|页面不存在|页面错误))\b/i.test(headline)
      || /您所访问的页面不存在|页面不存在或已被删除|requested page (?:does not exist|could not be found)/i.test(prefix.slice(0,2000)),
    login:Array.from(document.querySelectorAll('input[type="password"]')).some(visible)
      || /请先登录|请登录后|登录后方可|sign in to access|log in to access|please sign in|please log in/i.test(prefix.slice(0,2000)),
    access_required:/您所在的机构未订购|没有访问权限|无访问权限|不在授权范围|机构没有订购|your institution does not have|institutional access is required|not entitled|subscription required|you do not have access|not authorized to access/i.test(prefix.slice(0,2500)),
    download_pending:downloadState.download_pending,
    file_progress:downloadState.file_progress
  };
}""".replace("__MATERIALS_FUNCTION__", _MATERIALS_FUNCTION_JS).replace("__VERIFICATION_FUNCTION__", _VERIFICATION_FUNCTION_JS).replace("__DOWNLOAD_STATE_FUNCTION__", _DOWNLOAD_STATE_FUNCTION_JS)


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


def _page_loading(snapshot):
    if not isinstance(snapshot, dict):
        return False
    if snapshot.get("loading_pending") or snapshot.get("download_pending"):
        return True
    state = snapshot.get("ready_state")
    # DOMContentLoaded can leave publishers at interactive while adverts or
    # analytics keep loading. Semantic article/PDF content may already be
    # usable; explicit article/download loading always takes precedence.
    return state not in (None, "complete") and not (state == "interactive" and _snapshot_has_content(snapshot))


def _snapshot_signature(snapshot, url=""):
    """Relevant progress only: an animated spinner/advert is not progress."""
    value = snapshot if isinstance(snapshot, dict) else {}
    return (url, value.get("ready_state"), value.get("citation_title"), value.get("citation_doi"),
        len(str(value.get("article_text") or "")),
        tuple((str(h.get("text") or "")) for h in value.get("headings", []) if isinstance(h, dict)),
        tuple(str(link.get("url") or "") for link in value.get("links", []) if isinstance(link, dict)),
        tuple(str(link.get("url") or "") for link in (value.get("materials") or {}).get("links", []) if isinstance(link, dict)),
        repr(value.get("file_progress")), bool(value.get("reader_ready")))


def _snapshot_has_content(snapshot):
    pdf_links = [link for link in snapshot.get("links", []) if isinstance(link, dict)
        and re.search(r"\bpdf\b|PDF下载|下载PDF", str(link.get("text") or link.get("label") or ""), re.I)
        and (re.search(r"\.pdf(?:[?#]|$)|/(?:_?e?pdf|pdfplus)(?:/|$)", str(link.get("url") or ""), re.I)
             or re.fullmatch(r"(?:PDF|Download\s+PDF|View\s+PDF|PDF\s*下载|下载\s*PDF)",
                             str(link.get("text") or link.get("label") or "").strip(), re.I))]
    return bool(snapshot.get("container_verified") or snapshot.get("reader_ready") or snapshot.get("bibliographic_ready")
        or ((snapshot.get("citation_title") or snapshot.get("citation_doi")) and pdf_links)
        or (snapshot.get("citation_title") and len(str(snapshot.get("text") or "")) >= 160
            and len(str(snapshot.get("article_text") or "")) >= 80))


def _snapshot_usable(snapshot):
    if not isinstance(snapshot, dict) or _page_loading(snapshot):
        return False
    # Legacy/offline adapters without lifecycle fields retain their contract.
    return "ready_state" not in snapshot or _snapshot_has_content(snapshot)


class _WaitBudget:
    """Bound an active operation by relevant idle time and total activity."""
    def __init__(self, clock, *, idle=PAGE_IDLE_SECONDS, total=PAGE_ACTIVITY_SECONDS):
        self.clock, self.idle, self.total = clock, idle, total
        self.started = self.changed = clock()
        self.signature = None

    def observe(self, signature):
        if signature != self.signature:
            self.signature, self.changed = signature, self.clock()

    def expired(self):
        now = self.clock()
        return now - self.changed >= self.idle or now - self.started >= self.total

    def stable(self):
        return self.clock() - self.changed >= PAGE_STABLE_SECONDS


_FILE_SUFFIX = re.compile(r"\.(?:pdf|docx?|xlsx?|pptx?|csv|tsv|zip|rar|7z|gz|tgz|txt|xml|json|png|jpe?g|tiff?|r|rds|sav|dta)$", re.I)


def _file_like_url(url: str) -> bool:
    try:
        path = unquote(urlsplit(str(url or "")).path)
    except (ValueError, TypeError):
        return False
    # Publishers often put the filename in a middle segment, e.g.
    # /file/Data_Sheet_1.PDF/551993_supplementary.../1
    return any(_FILE_SUFFIX.search(segment) for segment in path.split("/") if segment)


def _material_file_score(discovery: object) -> int:
    if not isinstance(discovery, dict):
        return 0
    score = 0
    for link in discovery.get("links") or []:
        if not isinstance(link, dict):
            continue
        if _file_like_url(str(link.get("url") or "")):
            score += 1
    return score


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
    "page_not_ready": "页面或文件尚未就绪，已保留原窗口和已有材料；未判为缺失，稍后可显式重新检查。",
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
        self._request_url = ""
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

    def open_current(self, paper_id=None):
        """Show the exact retained task window without navigation or adoption.

        A pending CNKI popup may be the window needing the researcher's help,
        even before its origin or artifact is accepted for automatic fetching.
        Its persisted opener witness allows showing it, never treating it as
        downloaded content or changing the active task-page binding.
        """
        try:
            binding = self._binding
            if paper_id is not None:
                deferred = binding.get("deferred_papers", {}).get(paper_id)
                if not isinstance(deferred, dict) or not isinstance(deferred.get("binding"), dict):
                    return {"opened": False, "message": "该文献没有已记录的待处理窗口；未打开其他页面。"}
                binding = deferred["binding"]
            elif not binding.get("target_id"):
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
            self._last_deferred_site = _site(str(url or ""))
            return dict(cached, deferred_site=True,
                        message="该站点本批次仍待登录、验证或权限处理，已跳过当前材料；原页面保留，未重复访问。")
        self._last_deferred_site = ""
        return None

    def defer_paper(self, *, reason="", url="", paper_id=None):
        """Retain this paper's exact windows and release the task for another.

        Skipping is a caller policy, never an access workaround. A login,
        challenge, subscription or rate limit also suppresses fresh requests
        to that actual destination for this fetcher instance. Bad links and
        timeouts apply only to this paper. No page is closed or adopted here.
        """
        self._request_url = ""
        blocked = dict(self._blocked or {})
        shared_site = getattr(self, "_last_deferred_site", "") if not blocked else ""
        if shared_site and isinstance(paper_id, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", paper_id):
            entries = self._binding.setdefault("deferred_papers", {})
            source = next((entry for entry in entries.values()
                           if isinstance(entry, dict) and entry.get("site") == shared_site
                           and isinstance(entry.get("binding"), dict) and entry["binding"].get("target_id")), None)
            if source:
                entries[paper_id] = {**source, "paper_id": paper_id,
                    "shared_from": source.get("shared_from") or source.get("paper_id"),
                    "deferred_at": self._clock()}
                for key in ("target_id", "pending_url_hash", "attention_reason", "cnki_flow", "material_flow", "pdf_cleanup_target_ids", "pdf_click_pending", "pdf_click_state", "pdf_parent_fallback"):
                    self._binding.pop(key, None)
                self._page = None
                self._blocked = None
                self._blocked_url = ""
                self._last_deferred_site = ""
                self._write_binding()
                return {"deferred": True, "reason": str(reason), "shared_from": entries[paper_id]["shared_from"]}
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
                    ("target_id", "pending_url_hash", "attention_reason", "cnki_flow", "material_flow", "pdf_cleanup_target_ids", "pdf_click_pending", "pdf_click_state", "pdf_parent_fallback")
                    if key in self._binding}
        self._binding["last_deferred_paper"] = {
            "reason": why, "url": result["url"], "site": destination,
            "deferred_at": self._clock(), "binding": retained,
        }
        if isinstance(paper_id, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", paper_id):
            record = {**self._binding["last_deferred_paper"], "paper_id": paper_id}
            deferred = self._binding.setdefault("deferred_papers", {})
            if not isinstance(deferred, dict):
                raise ValueError("待处理窗口记录无法核验")
            deferred[paper_id] = record
        for key in retained:
            self._binding.pop(key, None)
        self._write_binding()
        self._page = None
        self._blocked = None
        self._blocked_url = ""
        self._progress("全文获取：暂未取得的页面已保留，继续尝试可访问入口。")
        return {"deferred": True, "reason": why, "url": result["url"]}

    def resume_deferred(self, paper_id):
        """An explicit retry may rebind only this paper's retained task page."""
        self._request_url = ""
        entry = self._binding.get("deferred_papers", {}).get(paper_id)
        if not isinstance(entry, dict) or not isinstance(entry.get("binding"), dict):
            return {"restored": False}
        retained = entry["binding"]
        shared = bool(entry.get("shared_from")) or any(
            key != paper_id and isinstance(other, dict) and other.get("binding", {}).get("target_id") == retained.get("target_id")
            for key, other in self._binding.get("deferred_papers", {}).items())
        for key in ("target_id", "pending_url_hash", "attention_reason", "cnki_flow", "material_flow", "pdf_cleanup_target_ids", "pdf_click_pending", "pdf_click_state", "pdf_parent_fallback"):
            self._binding.pop(key, None)
        # Login cookies are shared by this task's browser. A page held for
        # other papers remains untouched; retry this paper in a new task tab.
        self._binding.update({key: value for key, value in ({} if shared else retained).items()
                              if key in {"target_id", "pending_url_hash", "attention_reason", "cnki_flow", "material_flow", "pdf_cleanup_target_ids", "pdf_click_pending", "pdf_click_state", "pdf_parent_fallback"}})
        self._page = None
        self._blocked = None
        self._blocked_url = ""
        self._last_deferred_site = ""
        self._deferred_sites.pop(str(entry.get("site") or ""), None)
        self._write_binding()
        return {"restored": bool(self._binding.get("target_id")), "shared": shared}

    def clear_deferred(self, paper_id):
        entries = self._binding.get("deferred_papers")
        if isinstance(entries, dict) and paper_id in entries:
            old = entries.pop(paper_id)
            if self._binding.get("last_deferred_paper", {}).get("binding") == old.get("binding"):
                self._binding.pop("last_deferred_paper", None)
            self._write_binding()

    def close(self):
        cm, self._runtime_cm = self._runtime_cm, None
        self._context, self._page = None, None
        if cm is not None:
            try:
                cm.__exit__(None, None, None)
            except Exception:
                pass

    def _close_task_binding(self, binding):
        """Close exact owned pages only; never navigate or create a page."""
        auth = {"login", "verification", "access_required"}
        if binding.get("attention_reason") in auth | {"page_not_ready"} or binding.get("material_flow") or binding.get("pdf_click_pending"):
            return {"closed": False}
        flow = binding.get("cnki_flow") or {}
        if isinstance(flow, dict) and flow.get("pending_popup"):
            witness = flow["pending_popup"]
            adopted = isinstance(witness, dict) and witness.get("adopted") is True and witness.get("target_id") == binding.get("target_id")
            received_side = (isinstance(witness, dict) and flow.get("file_verified") is True
                and witness.get("opener_verified") is True and witness.get("owner_target_id") == binding.get("target_id")
                and witness.get("target_id") == flow.get("cleanup_target_id"))
            if not (adopted or received_side):
                return {"closed": False}
        wanted = binding.get("target_id")
        if not wanted:
            return {"closed": True}
        try:
            ids = [wanted]
            cleanup_id = flow.get("cleanup_target_id") if isinstance(flow, dict) else None
            if cleanup_id and cleanup_id != wanted:
                ids.append(cleanup_id)
            cleanup_ids = flow.get("cleanup_target_ids", []) if isinstance(flow, dict) else []
            pdf_cleanup = binding.get("pdf_cleanup_target_ids", [])
            if not isinstance(pdf_cleanup, list) or len(pdf_cleanup) > 3 or any(not isinstance(value, str) or not value or len(value) > 200 for value in pdf_cleanup):
                return {"closed": False}
            cleanup_ids = cleanup_ids + pdf_cleanup if isinstance(cleanup_ids, list) else cleanup_ids
            if not isinstance(cleanup_ids, list) or len(cleanup_ids) > 3 or any(not isinstance(value, str) or not value or len(value) > 200 for value in cleanup_ids):
                return {"closed": False}
            ids = list(dict.fromkeys(ids + cleanup_ids))
            pages = []
            for target_id in ids:
                page = self._find_target_page(target_id)
                if page is not None and not page.is_closed():
                    snapshot = page.evaluate(_SNAPSHOT_JS)
                    if not isinstance(snapshot, dict) or _page_loading(snapshot) or any(snapshot.get(key) for key in
                            ("login", "verification", "access_required", "download_pending")):
                        return {"closed": False}
                    pages.append(page)
            for page in pages:
                try:
                    page.close(run_before_unload=False)
                except Exception:
                    return {"closed": False, "close_failed": True}
            return {"closed": True}
        except Exception:
            return {"closed": False}

    def close_deferred(self, paper_id):
        """Release a skipped paper's old page, preserving shared access pages."""
        entries = self._binding.get("deferred_papers", {})
        entry = entries.get(paper_id) if isinstance(entries, dict) else None
        if not isinstance(entry, dict) or not isinstance(entry.get("binding"), dict):
            return {"closed": True}
        if entry.get("reason") in {"login", "verification", "access_required", "page_not_ready"} or entry.get("shared_from"):
            return {"closed": False}
        wanted = entry["binding"].get("target_id")
        if any(key != paper_id and isinstance(other, dict) and other.get("binding", {}).get("target_id") == wanted
               for key, other in entries.items()) or (wanted and self._binding.get("target_id") == wanted):
            return {"closed": False}
        return self._close_task_binding(entry["binding"])

    def complete_paper(self, *, skipped=False):
        """Caller has durably saved the file/status or recorded a non-auth skip."""
        reason = (self._blocked or {}).get("reason") or self._binding.get("attention_reason")
        if (reason and not skipped) or reason in {"login", "verification", "access_required", "material_cleanup", "page_not_ready"} or str(reason or "").startswith("local_"):
            return {"closed": False}
        wanted = self._binding.get("target_id")
        if not wanted:
            return {"closed": False}
        held = [entry for entry in self._binding.get("deferred_papers", {}).values()
                if isinstance(entry, dict) and wanted and entry.get("binding", {}).get("target_id") == wanted]
        if len(held) > 1 or any(entry.get("shared_from") for entry in held):
            return {"closed": False}
        result = self._close_task_binding(self._binding)
        if result.get("closed"):
            self._page = None
            self._blocked, self._blocked_url = None, ""
            self._binding.pop("target_id", None)
            self._binding.pop("pending_url_hash", None)
            self._binding.pop("attention_reason", None)
            self._binding.pop("cnki_flow", None)
            self._binding.pop("pdf_cleanup_target_ids", None)
            self._binding.pop("pdf_parent_fallback", None)
            self._write_binding()
            self._progress("全文获取：文件已保存或缺口已记录，已关闭本任务的文献页面。")
        elif result.get("close_failed"):
            self._progress("全文获取：文件已保存或缺口已记录，但本任务窗口未全部关闭；清理记录已保留，请核对后手动关闭。")
        return result

    def _progress(self, message):
        if self.on_progress:
            self.on_progress(message)

    def _wait_tick(self, page):
        before = self._clock()
        page.wait_for_timeout(200)  # Pump downloads and popups, not Python sleep alone.
        if self._clock() - before < 0.05:
            self._sleep(0.2)  # Deterministic injected clocks; real Playwright already waited.

    def _wait_page_ready(self, page, snapshot=None, *, status=0, downloads=None):
        budget = _WaitBudget(self._clock)
        reported = False
        while True:
            try:
                if not isinstance(snapshot, dict):
                    snapshot = page.evaluate(_SNAPSHOT_JS)
                reason = self._reason(snapshot or {}, status)
                if reason:
                    return snapshot, self._attention(reason, self._request_url or page.url,
                                                      snapshot=snapshot, observed_url=page.url)
                if downloads:
                    return snapshot, None
                budget.observe(_snapshot_signature(snapshot, page.url))
                if _snapshot_usable(snapshot) and ("ready_state" not in snapshot or budget.stable()):
                    return snapshot, None
            except Exception:
                snapshot = None  # Redirects may temporarily destroy the execution context.
            if budget.expired():
                return snapshot, self._attention("page_not_ready", self._request_url or page.url, observed_url=page.url)
            if not reported:
                self._progress("全文获取：等待文章、PDF入口及补材区域加载稳定；有进展将继续等待，未就绪页面不会关闭。")
                reported = True
            self._wait_tick(page)
            snapshot = None

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
        # A read-only article inspection must not replace the durable hash
        # of a PDF control already clicked and still awaiting its file. That
        # hash prevents a later resume from clicking/downloading it twice.
        if not (self._binding.get("pdf_click_pending") and self._binding.get("pending_url_hash")):
            self._binding["pending_url_hash"] = _url_hash(self._request_url or url)
        self._binding["attention_reason"] = reason
        verification_evidence = []
        if reason == "verification" and isinstance(snapshot, dict):
            verification_evidence = sanitize_verification_evidence(snapshot.get("verification_evidence"))
        if verification_evidence:
            self._binding["verification_evidence"] = verification_evidence
        else:
            self._binding.pop("verification_evidence", None)
        if reason == "verification" and getattr(self, "job_dir", None):
            for evidence in verification_evidence or ["verification_unspecified"]:
                self._pdf_diagnostic("page_verification_detected", source=evidence)
        self._write_binding()
        message = _MESSAGES[reason]
        if reason == "page_error" and isinstance(snapshot, dict) and snapshot.get("source_application_error"):
            message = "知网提示来源应用不正确或下载入口失效，已暂停；请从知网正常详情或检索页面核对入口后继续。"
        result = {"status": "attention", "reason": reason, "url": safe, "message": message}
        if verification_evidence:
            result["verification_evidence"] = verification_evidence
        self._blocked = result
        self._blocked_url = str(observed_url or url or "")
        return result

    def _clear_pending(self):
        if "pending_url_hash" in self._binding:
            self._binding.pop("pending_url_hash", None)
            self._binding.pop("attention_reason", None)
            self._binding.pop("verification_evidence", None)
            self._binding.pop("pdf_click_pending", None)
            self._binding.pop("pdf_click_state", None)
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

    def _pdf_diagnostic(self, code, **facts):
        """Local branch evidence without URLs, page text, cookies or tickets."""
        allowed = {"status", "mime", "bytes", "pdf_magic", "html_shell", "source", "opener",
                   "closed", "download_count", "error_class", "via", "frame_available", "stage", "dispatched"}
        entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "code": code,
                 "request_sha256": _url_hash(getattr(self, "_request_url", ""))}
        entry.update({key: (value[:100] if isinstance(value, str) else value)
                      for key, value in facts.items() if key in allowed and isinstance(value, (str, bool, int, type(None)))})
        try:
            path = self.job_dir / "fulltext" / "download-diagnostics.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            pass  # Diagnostics must not change the file acquisition outcome.

    def _response_reason(self, page, status):
        """Give an owned 401/403 page a bounded chance to reveal its captcha."""
        snapshot = {}
        if status not in {401, 403, 429}:
            return self._reason(snapshot, status)
        started = self._clock()
        while True:
            try:
                snapshot = page.evaluate(_SNAPSHOT_JS)
                if any(snapshot.get(key) for key in ("verification", "login", "rate_limited", "access_required", "page_error")):
                    return self._reason(snapshot, status)
            except Exception:
                pass
            if self._clock() - started >= 2 or page.is_closed():
                return self._reason(snapshot, status)
            self._wait_tick(page)

    def _recover_inline_pdf(self, page, response, out_path, referrer, *, observed_native_resume=False, record=None):
        """Save one observed native PDF preview whose CDP body is a shell.

        Chromium can expose a 601-byte HTML viewer body for a genuine PDF
        response. Only the already clicked, owned PDF document qualifies; a
        login/error or a still-generating page never reaches this request.
        """
        started = False
        try:
            # Exact observed wire URL remains in memory; signed CDN query
            # parameters must not be stripped for the request or serialized.
            if observed_native_resume:
                resumed = self._retained_native_pdf_entry(record or {}, expected_url=self._request_url)
                if resumed is None or resumed["page"] is not page:
                    return None
                target, referrer = resumed["native_url"], resumed["referrer"]
                original_status, original_mime = 0, "application/pdf"  # No invented historical HTTP status.
            else:
                target = _material_url(response.url)
                original_status = int(getattr(response, "status", 0) or 0)
                original_mime = str((response.headers or {}).get("content-type", "")).lower()
            if (not target or literature_browser._AUTH_PATH.search(urlsplit(target).path)
                    or "application/pdf" not in original_mime
                    or page.is_closed() or _material_url(page.url) != target
                    or page.evaluate("() => document.contentType") != "application/pdf"):
                return None
            snapshot = page.evaluate(_SNAPSHOT_JS)
            reason = self._reason(snapshot, original_status)
            if reason:
                return self._attention(reason, target, snapshot=snapshot, observed_url=page.url)
            if _page_loading(snapshot):
                return None  # The surrounding activity budget keeps waiting.
            if _signed_pdf_expired(target):
                self._pdf_diagnostic("native_pdf_link_expired", source="observed_native_document")
                result = self._attention("page_not_ready", self._request_url or referrer, observed_url=page.url)
                result["message"] = "本篇 PDF 的临时下载链接已过期；已保留原页面，请明确重试以从原文献页重新获取下载链接。"
                return result
            if observed_native_resume:
                self._pdf_diagnostic("native_pdf_resume", source="owned_native_document", mime="application/pdf")
            else:
                self._pdf_diagnostic("native_pdf_recovery", status=original_status, mime="application/pdf")
            self._progress("全文获取：浏览器已打开本篇 PDF 预览，正在保存实际 PDF 文件。")
            # Keep this in the browser channel. A separate API client can receive
            # an HTML interstitial for the exact URL already displaying a PDF.
            # The same-origin download attribute changes only browser handling,
            # never the observed URL, signature, cookies or access controls.
            started = True
            token = "literature-save-" + str(time.time_ns())
            page.evaluate("""({target, token}) => {
                const a = document.createElement('a'); a.id = token;
                a.href = target; a.download = 'fulltext.pdf'; a.textContent = 'Save PDF';
                a.style.cssText = 'position:fixed;top:4px;left:4px;z-index:2147483647;background:white;color:black;padding:8px';
                document.body.appendChild(a);
            }""", {"target": target, "token": token})
            try:
                self._binding["pdf_click_pending"] = True
                self._binding.setdefault("pending_url_hash", _url_hash(self._request_url or target))
                self._write_binding()
                if hasattr(page, "bring_to_front"):
                    page.bring_to_front()
                with page.expect_download(timeout=MATERIAL_DOWNLOAD_TIMEOUT_MS) as captured:
                    page.locator("#" + token).click(timeout=5000, no_wait_after=True)
                self._pdf_diagnostic("native_pdf_browser_download", source="owned_native_document", via="download_attribute")
                blob = self._read_download(captured.value, out_path)
            finally:
                try:
                    page.evaluate("token => document.getElementById(token)?.remove()", token)
                except Exception:
                    pass
            if blob is None:
                return self._attention("page_not_ready", target, observed_url=page.url)
            self._clear_pending()
            public_url = literature_browser.safe_url(target) or literature_browser.safe_url(self._request_url) or literature_browser.safe_url(referrer)
            return {"status": "saved" if out_path else "pdf_page", "url": public_url,
                    "bytes": blob, "size": len(blob), "acquisition_method": "observed_native_pdf"}
        except Exception as error:
            if not started:
                return None
            self._pdf_diagnostic("native_pdf_recovery_pending", error_class=type(error).__name__)
            return self._attention("page_not_ready", target, observed_url=getattr(page, "url", ""))

    def _wait_inline_pdf(self, page, response, out_path, referrer, downloads):
        """Keep a real native PDF navigation alive while its document settles."""
        budget = _WaitBudget(self._clock)
        while True:
            if downloads:
                blob = self._read_download(downloads[0], out_path)
                if blob is not None:
                    self._clear_pending()
                    return {"status": "saved" if out_path else "pdf_page", "url": literature_browser.safe_url(self._request_url),
                            "bytes": blob, "size": len(blob)}
            recovered = self._recover_inline_pdf(page, response, out_path, referrer)
            if recovered is not None:
                return recovered
            try:
                snapshot = page.evaluate(_SNAPSHOT_JS)
                reason = self._reason(snapshot)
                if reason:
                    return self._attention(reason, self._request_url, snapshot=snapshot, observed_url=page.url)
                budget.observe(_snapshot_signature(snapshot, page.url))
            except Exception:
                pass
            if budget.expired():
                return self._attention("page_not_ready", self._request_url, observed_url=page.url)
            self._wait_tick(page)

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
                self._pdf_diagnostic("download_invalid_size", bytes=file.stat().st_size)
                return None
            blob = file.read_bytes()
            if not blob.startswith(b"%PDF") or len(blob) < MIN_PDF_BYTES:
                self._pdf_diagnostic("download_invalid_body", bytes=len(blob), pdf_magic=blob.startswith(b"%PDF"))
                return None
            if out_path is not None:
                _save_pdf(out_path, blob)
            return blob
        except Exception as error:
            self._pdf_diagnostic("download_artifact_pending", error_class=type(error).__name__)
            return None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def _discovery(self, record, snapshot, url):
        result = {"status": "unknown", "reason": "article_materials_not_observed",
                  "source_url": literature_browser.safe_url(url), "links": []}
        if _page_loading(snapshot):
            result.update(status="needs_attention", reason="page_not_ready")
            return result
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
        if not isinstance(raw, dict):
            return result
        if raw.get("complete") is not True and not (raw.get("region_found") is True and raw.get("links")):
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
            if not filename or not Path(filename).suffix:
                # The real file URL often renders as an empty-label anchor
                # (Frontiers: public-pages-files-.../Data_Sheet_1.PDF/.../1).
                for segment in reversed([unquote(part) for part in urlsplit(target).path.split("/") if part]):
                    if re.search(r"\.(?:pdf|docx?|xlsx?|pptx?|csv|tsv|zip|rar|7z|gz|tgz|txt|xml|json|png|jpe?g|tiff?|r|rds|sav|dta)$", segment, re.I):
                        filename = segment[:200]
                        break
            if not label or re.match(r"^https?://", label):
                label = filename or "supplementary material"
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
        elif not links and raw.get("region_found") is not True and (
                "ready_state" not in snapshot or snapshot.get("container_verified")):
            # The article body was fully inspected and no supplementary region
            # or labelled link exists. Report this as an observation, not as
            # “unknown”: otherwise every paper without supplements stays
            # forever unverified and blocks the completeness report.
            result.update(status="none_found", reason="article_page_has_no_visible_supplementary_region")
        elif not links and snapshot.get("reader_ready"):
            result["reason"] = "only_main_pdf_page_available"
        return result

    def _observe_materials(self, record, snapshot, url, opts=None):
        result = self._discovery(record, snapshot, url)
        if result.get("reason") == "page_not_ready":
            return result, self._attention("page_not_ready", url, snapshot=snapshot)
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
        self._request_url = str((record.get("materials_url") or record.get("source_url") or "")
                                if isinstance(record, dict) else "")
        try:
            page = self._find_bound_page()
            if page is None or page.is_closed():
                return {"status": "unknown", "reason": "original_article_page_unavailable", "source_url": "", "links": []}
            if not self._request_url:
                self._request_url = str(page.url or "")
            if urlsplit(str(page.url or "")).scheme not in {"http", "https"}:
                # ensure_ready() creates an owned about:blank target. It is
                # not an article loading attempt: let inspect_materials visit
                # the recorded article entry instead of waiting on this blank.
                return {"status": "unknown", "reason": "article_page_not_opened", "source_url": "", "links": []}
            try:
                if page.evaluate("() => document.contentType") == "application/pdf":
                    return {"status": "unknown", "reason": "only_main_pdf_page_available",
                            "source_url": literature_browser.safe_url(page.url), "links": []}
            except Exception:
                pass
            snapshot = page.evaluate(_SNAPSHOT_JS)
            if not isinstance(snapshot, dict):
                raise ValueError("No article snapshot")
            snapshot, pending = self._wait_page_ready(page, snapshot)
            if pending:
                return {"status": "needs_attention", "reason": pending["reason"], "source_url": pending.get("url", ""), "links": []}
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
        if options.get("replenish_materials") and options.get("main_pdf_first"):
            resumed = self._retained_native_pdf_entry(record)
            if resumed is not None:
                return {"status": "ok", "main_pdf_ready": True,
                    "main_pdf_links": [{"url": resumed["entry_url"], "kind": "pdf", "label": "PDF"}],
                    "material_discovery": self._discovery(record, resumed["proof"], resumed["referrer"])}
            fallback = self._owned_parent_pdf(record)
            if fallback is not None:
                return fallback
        current = self.capture_material_discovery(record)
        if self._blocked:
            return dict(self._blocked, material_discovery=current)

        main_pdf_links = []

        def accept(discovery, *, main_pdf_ready=False):
            # The outer MaterialCollection.observe() processes this final
            # discovery exactly once. Intermediate pages must not trigger a
            # supplement download before the publisher page is inspected.
            result = {"status": "ok", "material_discovery": discovery}
            if options.get("replenish_materials"):
                result["main_pdf_links"] = main_pdf_links
                if main_pdf_ready:
                    result["main_pdf_ready"] = True
            return result

        def collect_main_pdf(proof):
            if not options.get("replenish_materials") or not _material_identity(proof, record):
                return
            for link in proof.get("links") or []:
                if not isinstance(link, dict):
                    continue
                target = literature_browser.safe_url(link.get("url"))
                label = str(link.get("text") or link.get("label") or "")
                if (target and (link.get("kind") == "pdf" or re.search(r"\.pdf(?:$|[?#])|/(?:e?pdf)(?:/|$)", target, re.I))
                        and not re.search(r"supplement|supporting|additional|附件|补充", label, re.I)
                        and all(item["url"] != target for item in main_pdf_links)):
                    main_pdf_links.append({"url": target, "kind": "pdf", "label": label[:180]})

        if options.get("replenish_materials") and options.get("main_pdf_first"):
            page = self._find_bound_page()
            if page is not None and not page.is_closed():
                proof = page.evaluate(_SNAPSHOT_JS)
                if not self._reason(proof) and _snapshot_usable(proof):
                    collect_main_pdf(proof)
                    if main_pdf_links and current.get("status") != "needs_attention":
                        # Keep this verified reader as the click context. The
                        # caller saves its missing main PDF before resuming
                        # ordinary supplementary discovery on other entries.
                        return accept(current, main_pdf_ready=True)

        candidates: list[str] = []
        raw_links = [article_url] + [str(item.get("url") or "") for item in (record.get("fulltext_links") or [])
                                     if isinstance(item, dict)]
        for source in raw_links:
            safe = literature_browser.safe_url(source)
            if (safe and safe not in candidates
                    and not re.search(r"\.(?:pdf|caj)(?:$|[?#])", safe, re.I)
                    and _site(safe) != "cnki.net"):
                candidates.append(safe)
        if not candidates and re.search(r"\.(?:pdf|caj)(?:$|[?#])", article_url, re.I):
            return accept({"status": "unknown", "reason": "only_main_pdf_page_available",
                           "source_url": literature_browser.safe_url(article_url), "links": []})
        best = current
        best_score = _material_file_score(current)
        best_status = str(current.get("status") or "")
        options["materials_only"] = True
        options["on_material_discovery"] = None
        blocked = None
        seen_urls = set()
        for source in candidates:
            if source in seen_urls:
                continue
            seen_urls.add(source)
            result = self.fetch_page(source, options)
            if result.get("status") in {"attention", "captcha"}:
                blocked = blocked or result
                continue
            proof = result.get("html_evidence") or {}
            # These links are observed in the same identified article page,
            # not guessed PDF paths or persisted session tickets.
            collect_main_pdf(proof)
            discovery = result.get("material_discovery")
            if (options.get("replenish_materials") and options.get("main_pdf_first") and main_pdf_links
                    and isinstance(discovery, dict) and discovery.get("status") != "needs_attention"
                    and not self._blocked):
                return accept(discovery, main_pdf_ready=True)
            if isinstance(discovery, dict):
                if (discovery.get("reason") == "only_main_pdf_page_available"
                        and best_status not in {"checked", "none_declared", "none_found"}):
                    best = discovery
                status = str(discovery.get("status") or "")
                score = _material_file_score(discovery)
                if (status in {"checked", "none_declared"}
                        and (best_status not in {"checked", "none_declared"} or score > best_score)):
                    best, best_score, best_status = discovery, score, status
                elif (status == "none_found" and proof.get("container_verified") is True
                        and _material_identity(proof, record)
                        and best_status not in {"checked", "none_declared", "none_found"}):
                    # A verified same-paper body was inspected; retain that
                    # observation above an unknown gateway/reader result. It
                    # cannot override an actual attachment or an access gate.
                    best, best_score, best_status = discovery, score, status
                if status == "needs_attention":
                    blocked = blocked or result
        if blocked is not None and (options.get("replenish_materials") or best_status not in {"checked", "none_declared"}):
            return blocked
        return accept(best)
        return result

    def _retained_native_pdf_entry(self, record, *, expected_url=None):
        """Prove a solved, retained native PDF belongs to the pending click."""
        if self._blocked or not self._binding.get("pdf_click_pending"):
            return None
        pending = self._binding.get("pending_url_hash")
        if not pending or (expected_url is not None and _url_hash(expected_url) != pending):
            return None
        page = self._find_bound_page()
        parent_ids = self._binding.get("pdf_cleanup_target_ids", [])
        if page is None or page.is_closed() or not isinstance(parent_ids, list) or not 1 <= len(parent_ids) <= 3:
            return None
        try:
            native = _material_url(page.url)
            if not native or literature_browser._AUTH_PATH.search(urlsplit(native).path) or page.evaluate("() => document.contentType") != "application/pdf":
                return None
            snapshot = page.evaluate(_SNAPSHOT_JS)
            if (self._reason(snapshot) or snapshot.get("ready_state") not in {"interactive", "complete"}
                    or snapshot.get("loading_pending") or snapshot.get("download_pending")):
                return None
            for target_id in parent_ids:
                parent = self._find_target_page(target_id)
                if parent is None or parent is page or parent.is_closed():
                    continue
                proof = parent.evaluate(_SNAPSHOT_JS)
                if self._reason(proof) or not _snapshot_usable(proof) or not _material_identity(proof, record):
                    continue
                for link in proof.get("links", []):
                    entry = literature_browser.safe_url(link.get("url")) if isinstance(link, dict) else ""
                    label = str(link.get("text") or link.get("label") or "") if isinstance(link, dict) else ""
                    if (entry and _url_hash(entry) == pending and re.search(r"\bPDF\b|PDF下载|下载PDF", label, re.I)
                            and _material_host_allowed(urlsplit(native).hostname or "", {urlsplit(entry).hostname or "", urlsplit(parent.url).hostname or ""})):
                        return {"page": page, "native_url": native, "entry_url": entry, "referrer": parent.url,
                                "proof": proof, "parent": parent, "parent_id": target_id}
        except Exception:
            pass
        return None

    def _refresh_expired_native_pdf(self, resumed, out_path, opts):
        """One explicitly requested actual parent click, retaining the old PDF."""
        entry = resumed["entry_url"]
        key = (_material_key(opts.get("record") or {}), _url_hash(entry))
        attempts = getattr(self, "_expired_pdf_refreshes", set())
        self._request_url = entry
        if (not opts.get("refresh_expired_pdf") or key in attempts
                or (out_path is not None and Path(out_path).exists())):
            result = self._attention("page_not_ready", entry, observed_url=resumed["page"].url)
            result["message"] = "本篇 PDF 的临时下载链接已过期；原页面已保留，需要明确重试，已有文件不会重复下载。"
            return result
        attempts.add(key)
        self._expired_pdf_refreshes = attempts
        parent_id = resumed["parent_id"]
        child_id = self._binding.get("target_id")
        cleanup = list(dict.fromkeys([value for value in self._binding.get("pdf_cleanup_target_ids", [])
                                      if value != parent_id] + [child_id]))
        if not child_id or len(cleanup) > 3:
            return self._attention("page_not_ready", entry, observed_url=resumed["page"].url)
        audit = self._binding.setdefault("pdf_parent_fallback", {})
        audit["expired_native"] = {key: self._binding.get(key) for key in
                                  ("target_id", "pending_url_hash", "attention_reason", "pdf_click_pending")}
        audit["expiry_refreshed_at"] = datetime.now(timezone.utc).isoformat()
        self._binding.update(target_id=parent_id, pdf_cleanup_target_ids=cleanup)
        for field in ("pending_url_hash", "attention_reason", "pdf_click_pending"):
            self._binding.pop(field, None)
        self._write_binding()  # Old ownership and click audit survive a disconnect.
        self._page = resumed["parent"]
        self._pdf_diagnostic("expired_pdf_parent_refresh", source="owned_same_paper_parent")
        self._progress("全文获取：临时 PDF 链接已过期，正在从本篇原页面重新点击下载一次。")
        result = self._click_current_pdf(entry, out_path, opts)
        # Never fall through to a URL replay if the actual control changed.
        return result if result is not None else self._attention("page_not_ready", entry, observed_url=self._page.url)

    def _owned_parent_pdf(self, record):
        """Use a recorded detail parent when its opened reader is inert.

        Inspect only this binding's already owned pages. Never replay the
        pending reader URL or discard its click evidence to retry it.
        """
        if self._blocked or not self._binding.get("pdf_click_pending"):
            return None
        child = self._find_bound_page()
        parent_ids = self._binding.get("pdf_cleanup_target_ids", [])
        if child is None or child.is_closed() or not isinstance(parent_ids, list) or not 1 <= len(parent_ids) <= 3:
            return None
        try:
            current = child.evaluate(_SNAPSHOT_JS)
            if (self._reason(current) or current.get("ready_state") != "complete"
                    or _page_loading(current) or _snapshot_usable(current)):
                return None
            candidates = []
            wanted_doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", str(record.get("doi") or "").strip(), flags=re.I).casefold()
            for target_id in parent_ids:
                parent = self._find_target_page(target_id)
                if parent is None or parent is child or parent.is_closed():
                    continue
                proof = parent.evaluate(_SNAPSHOT_JS)
                if self._reason(proof) or not _snapshot_usable(proof) or not _material_identity(proof, record):
                    continue
                for link in proof.get("links", []):
                    target = literature_browser.safe_url(link.get("url")) if isinstance(link, dict) else ""
                    label = str(link.get("text") or link.get("label") or "") if isinstance(link, dict) else ""
                    if (target and re.search(r"\.pdf(?:[?#]|$)|/(?:pdf|pdfplus)(?:/|$)", target, re.I)
                            and re.search(r"\bPDF\b|PDF下载|下载PDF", label, re.I)
                            and (not wanted_doi or wanted_doi in unquote(target).casefold())
                            and not re.search(r"supplement|supporting|additional|chapter|附件|补充|章节", label, re.I)
                            and _url_hash(target) != self._binding.get("pending_url_hash")):
                        candidates.append((parent, proof, target, label, target_id))
            if not candidates or len({item[2] for item in candidates}) != 1:
                return None
            parent, proof, target, label, parent_id = candidates[0]
            child_id = self._binding.get("target_id")
            cleanup = list(dict.fromkeys([value for value in parent_ids if value != parent_id] + [child_id]))
            if len(cleanup) > 3:
                return None
            self._binding.setdefault("pdf_parent_fallback", {key: self._binding.get(key) for key in
                ("target_id", "pending_url_hash", "attention_reason", "pdf_click_pending")})
            self._binding.update(target_id=parent_id, pdf_cleanup_target_ids=cleanup)
            self._write_binding()
            self._page = parent
            return {"status": "ok", "main_pdf_ready": True,
                "main_pdf_links": [{"url": target, "kind": "pdf", "label": label[:180]}],
                "material_discovery": self._discovery(record, proof, parent.url)}
        except Exception:
            return None

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

        No descriptor URL is navigated/replayed. An owned normal popup preserves the
        article page; only the child opened by this action may be observed.
        """
        options = opts or {}
        target = _material_url(descriptor.get("url"))
        if target and not _file_like_url(target):
            # The descriptor may be a landing/fragment URL. Use the same
            # attachment's real file URL from the latest page snapshot.
            discovery = self._material_discoveries.get(_material_key(record)) or {}
            for link in discovery.get("links") or []:
                if not isinstance(link, dict):
                    continue
                if (link.get("label") == descriptor.get("label")
                        or link.get("filename") == descriptor.get("filename")) and _file_like_url(str(link.get("url") or "")):
                    target = _material_url(link.get("url"))
                    break
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

            def attach(page, page_id=None):
                if id(page) in attached:
                    return
                attached.add(id(page))
                # Resolve while live. Download save_as may finish after the
                # transient window closes; its proof must survive that close.
                page_id = page_id or literature_browser._target_id(self._context, page)
                def got_download(download):
                    if clicked:
                        downloads.append((download, page_id))
                def got_response(response):
                    file_response(response, page, page_id)
                page.on("download", got_download)
                page.on("response", got_response)
                listeners.extend([(page, "download", got_download), (page, "response", got_response)])

            def got_popup(child, *, parent_event=False):
                nonlocal popup_error
                if child in children:
                    return
                opener = child.opener()
                if (opener is not parent and not (parent_event and opener is None)) or children:
                    popup_error = True
                    return
                children.append(child)
                try:
                    child_id = literature_browser._target_id(self._context, child)
                except Exception as error:
                    # A normal parent popup proves origin even when its direct
                    # attachment target disappears before CDP can attach.
                    self._pdf_diagnostic("material_popup_target_transient", source="parent_event" if parent_event else "context_response",
                        error_class=type(error).__name__, closed=child.is_closed())
                    return
                self._binding["material_flow"]["child_target_id"] = child_id
                self._write_binding()
                attach(child, child_id)

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
            def parent_popup(child):
                got_popup(child, parent_event=True)
            parent.on("popup", parent_popup)
            listeners.append((parent, "popup", parent_popup))
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
                    value = element.evaluate("e => ({url:e.href,label:(e.innerText||e.title||e.querySelector('img')?.alt||'').trim()})")
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
                previous_target = element.evaluate("e => { const previous=e.getAttribute('target'); e.setAttribute('target','_blank'); return previous; }")
                try:
                    if hasattr(parent, "bring_to_front"):
                        parent.bring_to_front()
                    element.click(modifiers=[], timeout=15_000, no_wait_after=True)
                finally:
                    try:
                        element.evaluate("(e, previous) => { if(previous===null) e.removeAttribute('target'); else e.setAttribute('target',previous); }", previous_target)
                    except Exception:
                        pass
                    element.dispose()
            budget = _WaitBudget(self._clock)
            self._progress("补充材料：已打开本篇实际附件链接，等待下载完成；不会重复点击。")
            while True:
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
                    try:
                        blob = response.body()
                    except Exception:
                        return attention("page_not_ready", "补充材料传输尚未完成，保留原窗口；稍后可显式检查，不重复点击。")
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
                observed, parent_snapshot = [], None
                for page in [parent] + children:
                    if not page.is_closed() and literature_browser.safe_url(page.url):
                        try:
                            snapshot = page.evaluate(_SNAPSHOT_JS)
                        except Exception:
                            continue  # A still-navigating context is not an invalid file.
                        observed.append(_snapshot_signature(snapshot, page.url))
                        if page is parent:
                            parent_snapshot = snapshot
                        reason = self._reason(snapshot)
                        if reason:
                            return attention(reason, snapshot=snapshot, url=page.url)
                budget.observe(tuple(observed))
                if parent_snapshot and _snapshot_usable(parent_snapshot) and not _material_identity(parent_snapshot, record):
                    return attention("page_error", "补充材料操作后原文详情发生变化，已暂停；不会继续打开附件。")
                if budget.expired():
                    return attention("page_not_ready", "补充材料暂未就绪，原窗口和点击记录已保留；稍后显式检查，不会重复点击。")
                self._wait_tick(parent)
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
            source_page_url = page.url
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
                if nav_error is not None and not any(token in (type(nav_error).__name__ + " " + str(nav_error)).lower()
                                                     for token in ("timeout", "err_aborted", "download is starting")):
                    return self._attention("page_error", safe, observed_url=page.url)
                status = int(getattr(response, "status", 0) or 0)
                if status in (401, 403, 404, 429) or status >= 500:
                    try:
                        error_snapshot = page.evaluate(_SNAPSHOT_JS)
                    except Exception:
                        error_snapshot = {}
                    if not isinstance(error_snapshot, dict):
                        error_snapshot = {}
                    return self._attention(self._response_reason(page, status), safe, snapshot=error_snapshot, observed_url=page.url)
                content_type = str((getattr(response, "headers", {}) or {}).get("content-type", "")).lower()
                if "application/pdf" in content_type:
                    self._progress("全文获取：文件正在生成或下载，等待实际传输完成后再保存。")
                    try:
                        blob = response.body()
                    except Exception:
                        return self._attention("page_not_ready", safe, observed_url=page.url)
                    if not isinstance(blob, bytes) or not blob.startswith(b"%PDF") or not MIN_PDF_BYTES <= len(blob) <= MAX_PDF_BYTES:
                        self._pdf_diagnostic("navigation_pdf_invalid_body", status=status, mime="application/pdf",
                            bytes=len(blob) if isinstance(blob, bytes) else 0,
                            html_shell=isinstance(blob, bytes) and bool(re.match(br"\s*(?:<!doctype|<html)", blob, re.I)))
                        try:
                            snapshot = page.evaluate(_SNAPSHOT_JS)
                        except Exception:
                            snapshot = {}
                        if isinstance(snapshot, dict) and "ready_state" in snapshot:
                            return self._wait_inline_pdf(page, response, out_path, source_page_url, downloads)
                        return {"status": "fetch_error", "error": "页面响应未通过PDF内容校验。", "url": literature_browser.safe_url(page.url) or safe}
                    if out_path is not None:
                        _save_pdf(out_path, blob)
                    self._clear_pending()
                    return {"status": "saved" if out_path else "pdf_page", "url": literature_browser.safe_url(page.url) or safe,
                            "bytes": blob, "size": len(blob)}
                # A navigation timeout does not prove failure: SPA content or
                # a real download may already have become usable in this tab.
                snapshot, pending_result = self._wait_page_ready(page, status=status, downloads=downloads)
                if pending_result:
                    return pending_result
                for download in downloads:
                    blob = self._read_download(download, out_path)
                    if blob is not None:
                        self._clear_pending()
                        return {"status": "saved" if out_path else "pdf_page", "url": literature_browser.safe_url(page.url) or safe,
                                "bytes": blob, "size": len(blob)}
                # Legacy adapters keep their one-off body-render retry.
                if "ready_state" not in snapshot:
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

    def _dismiss_sciencedirect_recommendations(self, page, record):
        """Close only the identified article recommendation advertisement."""
        parsed = urlsplit(page.url)
        if not ((parsed.hostname or "").lower() in {"www.sciencedirect.com", "sciencedirect.com"}
                and parsed.path.startswith("/science/article/")):
            return
        proof = page.evaluate(_SNAPSHOT_JS)
        if self._reason(proof) or not _material_identity(proof, record):
            return
        for modal in page.query_selector_all(".js-react-modal .modal-content"):
            try:
                text = modal.inner_text()
                if (not modal.is_visible() or "ADVERTISEMENT" not in text.upper()
                        or "other users also viewed these articles" not in text.casefold()
                        or re.search(r"sign\s*in|log\s*in|captcha|verif(?:y|ication)|authentication|验证码|登录|验证|付费", text, re.I)):
                    continue
                controls = []
                for control in modal.query_selector_all('button,[role="button"],a[aria-label]'):
                    label = control.evaluate("e => (e.getAttribute('aria-label') || e.innerText || '').trim()")
                    if control.is_visible() and re.fullmatch(r"close\s+window", label, re.I):
                        controls.append(control)
                    else:
                        control.dispose()
                if len(controls) != 1:
                    for control in controls:
                        control.dispose()
                    continue
                try:
                    page.bring_to_front()
                    controls[0].click(timeout=5000, no_wait_after=True)
                    modal.wait_for_element_state("hidden", timeout=5000)
                    self._pdf_diagnostic("recommendation_modal_closed", source="sciencedirect_article")
                finally:
                    controls[0].dispose()
                return
            finally:
                modal.dispose()

    def _retry_original_detail_pdf(self, url, out_path, opts):
        """Allow an explicit retry from an owned original article, not a replay."""
        if (not opts.get("refresh_expired_pdf") or not self._binding.get("pdf_click_pending")
                or self._binding.get("pending_url_hash") != _url_hash(url)
                or (out_path is not None and Path(out_path).exists())):
            return False
        page = self._find_bound_page()
        if page is None or page.is_closed():
            return False
        parsed = urlsplit(page.url)
        if ((parsed.hostname or "").lower() not in {"www.sciencedirect.com", "sciencedirect.com"}
                or not parsed.path.startswith("/science/article/")):
            return False
        proof = page.evaluate(_SNAPSHOT_JS)
        if (self._reason(proof) or not _snapshot_usable(proof) or not _material_identity(proof, opts.get("record") or {})
                or not any(isinstance(link, dict) and _url_hash(link.get("url") or "") == _url_hash(url)
                           and re.search(r"\bPDF\b", str(link.get("text") or link.get("label") or ""), re.I)
                           for link in proof.get("links", []))):
            return False
        state = self._binding.get("pdf_click_state") or {}
        proven_failed = (state.get("phase") == "failed_before_dispatch" and state.get("target_id") == self._binding.get("target_id")
                         and state.get("page_sha256") == _url_hash(page.url))
        cleanup = self._binding.get("pdf_cleanup_target_ids", [])
        if not proven_failed:
            if not isinstance(cleanup, list) or not 1 <= len(cleanup) <= 3:
                return False
            for target_id in cleanup:
                child = self._find_target_page(target_id)
                if child is None or child.is_closed() or not _signed_pdf_expired(child.url):
                    return False
                snapshot = child.evaluate(_SNAPSHOT_JS)
                if (child.evaluate("() => document.contentType") != "application/pdf" or self._reason(snapshot)
                        or snapshot.get("loading_pending") or snapshot.get("download_pending")
                        or snapshot.get("ready_state") not in {"interactive", "complete"}):
                    return False
        key = (self._binding.get("target_id"), _url_hash(url))
        attempts = getattr(self, "_original_pdf_retries", set())
        if key in attempts:
            return False
        attempts.add(key)
        self._original_pdf_retries = attempts
        self._binding.setdefault("pdf_parent_fallback", {})["explicit_retry"] = {
            "target_id": key[0], "pending_url_hash": self._binding.get("pending_url_hash"),
            "previous_click_state": state, "at": datetime.now(timezone.utc).isoformat(),
            "evidence": "failed_before_dispatch" if proven_failed else "owned_expired_native_pages"}
        for field in ("pending_url_hash", "attention_reason", "pdf_click_pending", "pdf_click_state"):
            self._binding.pop(field, None)
        self._write_binding()
        self._request_url = url
        self._pdf_diagnostic("explicit_retry_from_original_detail", source="owned_same_paper_parent")
        return True

    def _click_current_pdf(self, url, out_path, opts):
        """Follow one observed same-paper PDF control with its browser context.

        A publisher reader's PDF dropdown can require the actual click and its
        referrer. Navigating to the href or replaying it through HTTP is not
        equivalent. No endpoint is synthesized and no unrelated tab is used.
        """
        page = self._find_bound_page()
        record = opts.get("record") or {}
        safe = literature_browser.safe_url(url)
        if (page is None or page.is_closed() or not safe or not record
                or self._blocked or _site(url) == "cnki.net"
                or self._binding.get("pending_url_hash") == _url_hash(url)):
            return None
        listeners, downloads, responses, children, inline_responses = [], [], [], [], []
        clicked, unexpected_popup, click_stage = False, False, "article_preflight"
        source_page_url = page.url
        try:
            if hasattr(page, "bring_to_front"):
                page.bring_to_front()
            snapshot = page.evaluate(_SNAPSHOT_JS)
            if self._reason(snapshot) or not _snapshot_usable(snapshot) or not _material_identity(snapshot, record):
                return None
            click_stage = "recommendation_modal"
            self._dismiss_sciencedirect_recommendations(page, record)
            snapshot = page.evaluate(_SNAPSHOT_JS)
            if self._reason(snapshot) or not _snapshot_usable(snapshot) or not _material_identity(snapshot, record):
                return None
            if not any(link.get("url") == safe and re.search(r"pdf", str(link.get("text") or ""), re.I)
                       for link in snapshot.get("links", []) if isinstance(link, dict)):
                return None

            attached = set()
            def attach(owner):
                if id(owner) in attached:
                    return
                attached.add(id(owner))
                def got_download(download):
                    if clicked:
                        downloads.append(download)
                def got_response(response):
                    try:
                        request = response.request
                        if clicked and request.is_navigation_request() and request.frame == owner.main_frame:
                            responses.append(response)
                    except Exception:
                        pass
                owner.on("download", got_download)
                owner.on("response", got_response)
                listeners.extend([(owner, "download", got_download), (owner, "response", got_response)])

            def popup(child, *, parent_event=False):
                nonlocal unexpected_popup
                if child in children:
                    return
                opener = child.opener()
                if (opener is not page and not (parent_event and opener is None)) or children:
                    self._pdf_diagnostic("popup_rejected", source="parent_event" if parent_event else "context_response",
                        opener="none" if opener is None else "other", download_count=len(downloads))
                    unexpected_popup = True
                    return
                children.append(child)
                attach(child)
                try:
                    child_id = literature_browser._target_id(self._context, child)
                except Exception as error:
                    # A direct attachment popup can disappear before CDP can
                    # create its session. Parent's popup event still proves
                    # where it came from; keep the parent/download listener.
                    self._pdf_diagnostic("popup_target_transient", source="parent_event" if parent_event else "context_response",
                        error_class=type(error).__name__, closed=child.is_closed())
                    return
                old_id = literature_browser._target_id(self._context, page)
                self._binding["pdf_cleanup_target_ids"] = list(dict.fromkeys(
                    self._binding.get("pdf_cleanup_target_ids", []) + [old_id]))
                self._page = child
                self._binding["target_id"] = child_id
                self._write_binding()

            def from_observed_click(response):
                try:
                    request = response.request
                    for _ in range(9):
                        observed = _material_url(request.url)
                        parsed = urlsplit(observed)
                        if (not observed or literature_browser._AUTH_PATH.search(parsed.path)
                                or re.search(r"(?:^|\.)(?:login|auth|sso|passport)(?:\.|$)", parsed.hostname or "", re.I)):
                            return False
                        if observed == safe:
                            return True
                        request = request.redirected_from
                        if request is None:
                            return False
                except Exception:
                    pass
                return False

            def context_response(response):
                # A popup may send its PDF response before the popup event.
                try:
                    if (clicked and "application/pdf" in str((response.headers or {}).get("content-type", "")).lower()
                            and from_observed_click(response)):
                        # CDP native-PDF navigation can emit its first response
                        # before a Page/frame exists. Associate it only after
                        # our exact owned popup/document is confirmed below.
                        inline_responses.append(response)
                    child = response.request.frame.page
                    if clicked and child is not page and child.opener() is page and response.request.frame == child.main_frame:
                        popup(child)
                        if child in children:
                            responses.append(response)
                except Exception:
                    pass

            attach(page)
            def parent_popup(child):
                popup(child, parent_event=True)
            page.on("popup", parent_popup)
            self._context.on("response", context_response)
            listeners.extend([(page, "popup", parent_popup), (self._context, "response", context_response)])
            def begin_click():
                nonlocal clicked
                if not clicked:
                    self._pace(safe)
                    self._request_url = safe
                    # Durable before the first click: a restart inspects the
                    # exact retained page instead of clicking a second time.
                    self._binding.update(pending_url_hash=_url_hash(safe), attention_reason="page_not_ready", pdf_click_pending=True)
                    self._write_binding()
                    clicked = True

            def perform_click(element, stage):
                nonlocal click_stage
                click_stage = stage
                begin_click()
                token = "literatureClick" + str(time.time_ns())
                page.evaluate("""token => {
                    const listener = () => { window[token].seen = true; };
                    window[token] = {seen:false, listener}; document.addEventListener('click', listener, true);
                }""", token)
                state = {"phase": "prepared", "stage": stage, "target_id": self._binding.get("target_id"),
                         "page_sha256": _url_hash(page.url)}
                self._binding["pdf_click_state"] = state
                self._write_binding()
                try:
                    element.click(timeout=15_000, no_wait_after=True)
                    state["phase"] = "dispatched"
                    self._binding["pdf_click_state"] = state
                    self._write_binding()
                    self._pdf_diagnostic("pdf_click_dispatched", stage=stage, dispatched=True)
                except Exception as error:
                    dispatched = None
                    try:
                        dispatched = page.evaluate("token => window[token]?.seen ?? null", token)
                    except Exception:
                        pass
                    if (dispatched is False and not downloads and not responses and not inline_responses and not children
                            and page.url == source_page_url and self._binding.get("target_id") == state["target_id"]):
                        state["phase"] = "failed_before_dispatch"
                    else:
                        state["phase"] = "dispatched" if dispatched else "uncertain"
                    self._binding["pdf_click_state"] = state
                    self._write_binding()
                    self._pdf_diagnostic("pdf_click_exception", stage=stage, dispatched=dispatched, error_class=type(error).__name__)
                    raise
                finally:
                    try:
                        page.evaluate("token => { if(window[token]) document.removeEventListener('click',window[token].listener,true); delete window[token]; }", token)
                    except Exception:
                        pass

            def anchors():
                found = []
                for element in page.query_selector_all("a[href]"):
                    href = element.evaluate("e => { const u = new URL(e.href); u.hash = ''; return u.href; }")
                    if href == safe and element.is_visible():
                        found.append(element)
                    else:
                        element.dispose()
                return found

            elements = anchors()
            if not elements and snapshot.get("reader_ready"):
                controls = []
                for element in page.query_selector_all('button,[role="button"]'):
                    label = element.evaluate("e => (e.innerText || e.getAttribute('aria-label') || '').trim()")
                    if element.is_visible() and re.fullmatch(r"(?:PDF(?:\s*(?:download|下载))?|download\s*PDF)", label, re.I):
                        controls.append(element)
                    else:
                        element.dispose()
                if len(controls) != 1:
                    for element in controls:
                        element.dispose()
                    return None
                try:
                    perform_click(controls[0], "pdf_menu")
                finally:
                    controls[0].dispose()
                # Only reveal the already observed PDF anchor. Never force a
                # hidden element click or select EPUB/chapter/supplement items.
                budget = _WaitBudget(self._clock, idle=10, total=10)
                while not elements and not downloads:
                    current = page.evaluate(_SNAPSHOT_JS)
                    reason = self._reason(current)
                    if reason:
                        return self._attention(reason, safe, snapshot=current, observed_url=page.url)
                    if not _material_identity(current, record):
                        return self._attention("page_error", safe, observed_url=page.url)
                    elements = anchors()
                    if budget.expired():
                        return self._attention("page_not_ready", safe, observed_url=page.url)
                    if not elements:
                        self._wait_tick(page)
            if not elements and not downloads:
                return self._attention("page_not_ready", safe, observed_url=page.url) if clicked else None
            # Two copies of precisely the same href are one download control.
            element = elements[0] if elements else None
            for duplicate in elements[1:]:
                duplicate.dispose()

            if element is not None and not downloads:
                try:
                    perform_click(element, "pdf_anchor")
                finally:
                    element.dispose()
            elif element is not None:
                element.dispose()
            self._progress("全文获取：已点击本篇实际 PDF 下载入口，等待文件完成；不会重复点击。")
            budget = _WaitBudget(self._clock)
            while True:
                active = children[-1] if children else page
                if unexpected_popup:
                    self._pdf_diagnostic("unexpected_popup", download_count=len(downloads))
                    return self._attention("page_error", safe, observed_url=active.url)
                if downloads:
                    blob = self._read_download(downloads[0], out_path)
                    if blob is None:
                        return self._attention("page_not_ready", safe, observed_url=active.url)
                    self._clear_pending()
                    return {"status": "saved" if out_path else "pdf_page", "url": safe,
                            "bytes": blob, "size": len(blob), "acquisition_method": "observed_pdf_click"}
                while responses:
                    response = responses.pop(0)
                    status = int(getattr(response, "status", 0) or 0)
                    reason = self._response_reason(active, status)
                    if reason:
                        self._pdf_diagnostic("pdf_response_http_error", status=status)
                        return self._attention(reason, safe, observed_url=active.url)
                    if "application/pdf" not in str((response.headers or {}).get("content-type", "")).lower():
                        continue
                    try:
                        blob = response.body()
                    except Exception:
                        return self._attention("page_not_ready", safe, observed_url=active.url)
                    if not isinstance(blob, bytes) or not blob.startswith(b"%PDF") or not MIN_PDF_BYTES <= len(blob) <= MAX_PDF_BYTES:
                        html_shell = isinstance(blob, bytes) and bool(re.match(br"\s*(?:<!doctype|<html)", blob, re.I))
                        self._pdf_diagnostic("pdf_response_invalid_body", status=status, mime="application/pdf",
                            bytes=len(blob) if isinstance(blob, bytes) else 0, pdf_magic=False, html_shell=html_shell)
                        recovered = self._recover_inline_pdf(active, response, out_path, source_page_url)
                        if recovered is not None:
                            return recovered
                        # The native document may still be initializing. Keep
                        # this exact observed response inside the current wait
                        # budget; a preview shell is not a server 404.
                        if response not in inline_responses:
                            inline_responses.append(response)
                        continue
                    if out_path is not None:
                        _save_pdf(out_path, blob)
                    self._clear_pending()
                    return {"status": "saved" if out_path else "pdf_page", "url": safe,
                            "bytes": blob, "size": len(blob), "acquisition_method": "observed_pdf_click"}
                observed, ready_reader = [], None
                for response in inline_responses:
                    recovered = self._recover_inline_pdf(active, response, out_path, source_page_url)
                    if recovered is not None:
                        return recovered
                for owner in [page] + children:
                    if owner.is_closed():
                        continue
                    try:
                        current = owner.evaluate(_SNAPSHOT_JS)
                    except Exception:
                        continue
                    reason = self._reason(current)
                    if reason:
                        self._pdf_diagnostic("pdf_dom_attention", source=reason)
                        return self._attention(reason, safe, snapshot=current, observed_url=owner.url)
                    observed.append(_snapshot_signature(current, owner.url))
                    if (owner is active and (owner is not page or owner.url != source_page_url)
                            and current.get("reader_ready") and _snapshot_usable(current)
                            and _material_identity(current, record)):
                        links = []
                        for link in current.get("links", []):
                            target = literature_browser.safe_url(link.get("url")) if isinstance(link, dict) else ""
                            if (target and target != safe and re.search(r"pdf", str(link.get("text") or ""), re.I)
                                    and re.search(r"\.pdf(?:[?#]|$)|/(?:e?pdf|pdfplus)(?:/|$)", target, re.I)):
                                links.append({"url": target, "text": str(link.get("text") or "PDF"), "kind": "pdf"})
                        if links:
                            ready_reader = {"status": "ok", "url": literature_browser.safe_url(owner.url),
                                "text": str(current.get("text") or ""),
                                "html_evidence": {"citation_title": current.get("citation_title"),
                                    "citation_doi": current.get("citation_doi"), "links": links},
                                "acquisition_method": "observed_pdf_reader"}
                budget.observe(tuple(observed))
                if ready_reader is not None and budget.stable():
                    # View PDF may only open an entitled same-paper reader.
                    # That click is complete, but no file has been obtained:
                    # hand its actual PDF menu back to fetch_pdf for one final
                    # download click, retaining both owned pages for cleanup.
                    self._clear_pending()
                    return ready_reader
                if budget.expired():
                    return self._attention("page_not_ready", safe, observed_url=active.url)
                self._wait_tick(active if not active.is_closed() else page)
        except Exception as error:
            self._pdf_diagnostic("pdf_click_flow_exception", stage=click_stage, error_class=type(error).__name__)
            # Once clicked, retain the original page. Do not retry the href by
            # goto or HTTP; the first download may still be generating.
            if clicked:
                return self._attention("page_not_ready", safe, observed_url=getattr(self._page, "url", ""))
            return None
        finally:
            for owner, event, listener in listeners:
                try:
                    owner.remove_listener(event, listener)
                except Exception:
                    pass

    def fetch_pdf(self, url, out_path, opts):
        result = None
        self._retry_original_detail_pdf(url, out_path, opts)
        if self._binding.get("pdf_click_pending") and self._binding.get("pending_url_hash") == _url_hash(url):
            retained = self._find_bound_page()
            if retained is None or retained.is_closed():
                # The original click might have delivered a file while the
                # driver was disconnected. An absent target is not permission
                # to click again or open an unbound replacement page.
                self._request_url = url
                return self._attention("page_not_ready", url)
            resumed = self._retained_native_pdf_entry(opts.get("record") or {}, expected_url=url)
            if resumed is not None:
                self._request_url = url
                if _signed_pdf_expired(resumed["native_url"]):
                    result = self._refresh_expired_native_pdf(resumed, out_path, opts)
                else:
                    result = self._recover_inline_pdf(retained, None, out_path, resumed["referrer"],
                        observed_native_resume=True, record=opts.get("record") or {})
                if result is not None and result.get("status") != "ok":
                    result["material_discovery"] = self._discovery(opts.get("record") or {}, resumed["proof"], resumed["referrer"])
                    return result
        if result is None:
            result = self._click_current_pdf(url, out_path, opts)
        if result is None:
            result = self._visit(url, opts, out_path=out_path)
        discovery = result.get("material_discovery") or self._material_discoveries.get(_material_key(opts.get("record") or {}))
        if result.get("status") == "ok":
            # One current-page visible PDF link may lead to the actual legal
            # artifact.  It uses the same tab and the same per-site pacing.
            # Do not guess hidden endpoints or keep trying alternative links.
            for link in result.get("html_evidence", {}).get("links", []):
                target = link.get("url")
                if link.get("kind") == "pdf" and target and target not in {url, result.get("url")}:
                    clicked = self._click_current_pdf(target, out_path, opts)
                    result = clicked if clicked is not None else self._visit(target, opts, out_path=out_path)
                    break
        if result.get("status") not in {"saved", "pdf_page", "attention", "captcha"} and getattr(self._context, "request", None) is not None:
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
