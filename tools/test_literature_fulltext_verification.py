"""Run the production snapshot on offline DOM fixtures; no browser/network."""
import json
import shutil
import subprocess
import tempfile
import types
import unittest
from pathlib import Path

import literature_fulltext_browser as browser
import literature_fulltext as driver


NODE_DOM = r"""
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
class El {
  constructor(data={}) { Object.assign(this,data); this.offsetWidth=this.hidden?0:(this.width??1); this.offsetHeight=this.hidden?0:(this.height??1); this.map=this.map||{}; }
  get innerText(){return this.hidden?'':this.text||'';}
  get textContent(){return this.text||'';}
  get parentElement(){return nodes[this.parent]||null;}
  get outerHTML(){return '<article>'+this.textContent+'</article>';}
  getClientRects(){return this.hidden?[]:[{}];}
  getBoundingClientRect(){return {width:this.offsetWidth,height:this.offsetHeight,left:this.left||0,top:this.top||0,right:(this.left||0)+this.offsetWidth,bottom:(this.top||0)+this.offsetHeight};}
  querySelectorAll(selector){
    if(selector==='body *' && this.isDocument) return Object.values(nodes);
    if(selector==='*') return Object.values(nodes).filter(el=>{
      if(this.isBody) return true;
      for(let parent=el.parentElement;parent;parent=parent.parentElement) if(parent===this) return true;
      return Object.values(this.map).some(ids=>ids.includes(el.nodeKey));
    });
    return [...new Set((this.map[selector]||selector.split(',').flatMap(s=>this.map[s]||[])).map(k=>nodes[k]))];
  }
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  getAttribute(name){return this.attrs?.[name]??null;}
  hasAttribute(name){return Object.prototype.hasOwnProperty.call(this.attrs||{},name);}
  closest(selector){
    for(let el=this;el;el=el.parentElement){
      if(selector.split(',').some(part=>{
        const value=part.trim();
        if(/^[a-z]+$/i.test(value)) return (el.tagName||'').toLowerCase()===value.toLowerCase();
        const attr=value.match(/^\[([^=*]+)(\*=|=)"([^"]*)"\]$/);
        if(!attr) return false;
        const actual=el.getAttribute(attr[1]);
        return actual!==null && (attr[2]==='='?actual===attr[3]:actual.includes(attr[3]));
      })) return el;
    }
    return null;
  }
  cloneNode(){return new El({...this});}
  matches(){return false;}
}
const nodes={};
for(const [key,data] of Object.entries(input.nodes||{})) nodes[key]=new El({nodeKey:key,...data});
const document=new El({isDocument:true,map:input.map||{}, title:input.title||'', readyState:input.ready||'complete'});
document.body=new El({isBody:true,text:input.body||''});
const location=new URL(input.url);
global.innerWidth=1200;
global.innerHeight=800;
global.getComputedStyle=el=>({visibility:el.hidden?'hidden':'visible',display:el.hidden?'none':'block',opacity:'1',...el.style});
process.stdout.write(JSON.stringify(eval('('+input.script+')')()));
"""


def snapshot(**values):
    node = shutil.which('node')
    if not node:
        raise unittest.SkipTest('Node.js required for offline production JS fixtures')
    payload = {'url': 'https://kns.cnki.net/kns8s/defaultresult/index',
               'script': browser._SNAPSHOT_JS, **values}
    result = subprocess.run([node, '-e', NODE_DOM], input=json.dumps(payload),
                            text=True, encoding='utf-8', capture_output=True, check=True)
    return json.loads(result.stdout)


class SecurityVerificationTests(unittest.TestCase):
    def test_exact_official_security_route_is_verification_before_widget_loads(self):
        for url in ('https://kns.cnki.net/verify/home', 'https://kns.cnki.net/verify/home/?returnUrl=article',
                    'https://CNKI.NET/verify/home'):
            with self.subTest(url=url):
                data = snapshot(url=url, ready='loading')
                self.assertEqual(browser.FulltextBrowserFetcher._reason(data), 'verification')

    def test_route_requires_official_host_and_exact_current_path(self):
        for url in ('https://cnki.net.evil.test/verify/home', 'https://evilcnki.net/verify/home',
                    'https://publisher.test/verify/home', 'https://kns.cnki.net/verify/home/article',
                    'https://kns.cnki.net/article?next=/verify/home', 'https://kns.cnki.net/article#/verify/home'):
            with self.subTest(url=url):
                self.assertFalse(snapshot(url=url)['verification'])

    def test_standalone_visible_security_and_slider_prompts_are_detected(self):
        for prompt in ('安全验证', '请拖动滑块', '请拖动滑块完成验证', '拖动滑块完成验证'):
            with self.subTest(prompt=prompt):
                data = snapshot(body=prompt)
                self.assertEqual(browser.FulltextBrowserFetcher._reason(data), 'verification')
        data = snapshot(title='安全验证 - 中国知网', body='安全验证')
        self.assertEqual(data['verification_evidence'], ['cnki_security_title', 'cnki_security_body_visible'])
        self.assertTrue(snapshot(nodes={'alert': {'text': '安全验证'}},
                                 map={'[role="alert"]': ['alert']})['verification'])

    def test_stale_security_document_title_does_not_block_normal_result_page(self):
        for body in ('', '南京大学\n共找到 1 条结果\n热应激对蛋鸡生产性能的影响'):
            with self.subTest(body=body):
                self.assertFalse(snapshot(title='安全验证 - 中国知网', body=body)['verification'])

    def test_body_lines_do_not_turn_hidden_preloaded_security_labels_into_challenges(self):
        for prompt in ('安全验证', '请拖动滑块完成验证', 'Please verify you are human'):
            for style in ({'opacity': '0'}, {'display': 'none'}, {'visibility': 'hidden'},
                          {'contentVisibility': 'hidden'}):
                for on_parent in (False, True):
                    with self.subTest(prompt=prompt, style=style, on_parent=on_parent):
                        data = snapshot(title='检索-中国知网', body='共找到 1 条结果\n'+prompt,
                            nodes={'label': {'text': prompt, 'parent': 'shell', 'style': {} if on_parent else style},
                                   'shell': {'style': style if on_parent else {}}},
                            map={'h2': ['label']})
                        self.assertFalse(data['verification'])
                        self.assertEqual(data['verification_evidence'], [])

    def test_offscreen_or_clipped_preloaded_heading_is_not_visible_evidence(self):
        for positioning in ({'left': -500, 'width': 200}, {'left': 1300}, {'top': 900}, {'top': -200, 'height': 100}):
            with self.subTest(positioning=positioning):
                data = snapshot(body='共找到 1 条结果\n安全验证',
                    nodes={'label': {'text': '安全验证', **positioning}}, map={'h2': ['label']})
                self.assertFalse(data['verification'])
        data = snapshot(body='共找到 1 条结果\n安全验证', nodes={
            'label': {'text': '安全验证', 'parent': 'shell', 'width': 200, 'height': 100},
            'shell': {'width': 0, 'height': 0, 'style': {'overflow': 'hidden'}}}, map={'h2': ['label']})
        self.assertFalse(data['verification'])

    def test_visible_prompt_reports_specific_heading_or_body_branch(self):
        for heading in (True, False):
            with self.subTest(heading=heading):
                data = snapshot(body='共找到 1 条结果\n安全验证',
                    nodes={'label': {'text': '安全验证', 'width': 200, 'height': 80}},
                    map={'h2': ['label']} if heading else {})
                self.assertTrue(data['verification'])
                self.assertEqual(data['verification_evidence'],
                    ['cnki_security_heading_visible' if heading else 'cnki_security_body_visible'])

    def test_hidden_prompt_and_article_title_or_mentions_are_not_verification(self):
        self.assertFalse(snapshot(nodes={'hidden': {'text': '安全验证', 'hidden': True}},
                                  map={'[role="alert"]': ['hidden']})['verification'])
        for title, body in (('安全验证技术在养殖系统中的应用', '本文介绍安全验证方法及其应用。'),
                            ('安全验证', '安全验证\n本文的研究目标与结果。')):
            with self.subTest(title=title):
                data = snapshot(title=title, body=body,
                    nodes={'article': {'text': body * 100}, 'title': {'content': title}},
                    map={'#article-body': ['article'], 'meta[name="citation_title"]': ['title']})
                self.assertTrue(data['container_verified'])
                self.assertFalse(data['verification'])
        self.assertFalse(snapshot(title='安全验证技术综述', body='研究涉及安全验证和系统设计。')['verification'])

    def test_bibliographic_record_with_security_title_is_not_verification(self):
        data = snapshot(title='安全验证', body='安全验证\n摘要：一种养殖系统方法。',
                        nodes={'title': {'content': '安全验证'}}, map={'meta[name="citation_title"]': ['title']})
        self.assertFalse(data['verification'])

    def test_security_text_does_not_broaden_other_publishers(self):
        self.assertFalse(snapshot(url='https://publisher.test/article', title='安全验证', body='安全验证')['verification'])
        self.assertTrue(snapshot(url='https://publisher.test/article', body='Please verify you are human')['verification'])

    def test_empty_preloaded_captcha_shells_do_not_block_cnki_results(self):
        for selector in ('.geetest_panel', '.verifybox', '#captcha', '.captcha'):
            with self.subTest(selector=selector):
                data = snapshot(title='检索-中国知网', body='个人登录\n南京大学\n共找到 1 条结果\n热应激对蛋鸡生产性能的影响',
                                nodes={'shell': {'width': 320, 'height': 180}}, map={selector: ['shell']})
                self.assertIsNone(browser.FulltextBrowserFetcher._reason(data))
                self.assertEqual(data['verification_evidence'], [])

    def test_hidden_or_transparent_challenge_and_ancestors_do_not_block(self):
        for style in ({'display': 'none'}, {'visibility': 'hidden'}, {'visibility': 'collapse'},
                      {'opacity': '0'}, {'contentVisibility': 'hidden'}):
            for on_parent in (False, True):
                with self.subTest(style=style, on_parent=on_parent):
                    data = snapshot(nodes={
                        'shell': {'text': '请拖动滑块完成验证', 'parent': 'parent', 'style': {} if on_parent else style},
                        'parent': {'style': style if on_parent else {}}}, map={'.geetest_panel': ['shell']})
                    self.assertFalse(data['verification'])

    def test_visible_challenge_prompt_or_interactive_surface_still_blocks(self):
        data = snapshot(nodes={'shell': {'text': '请拖动滑块完成验证'}}, map={'.geetest_panel': ['shell']})
        self.assertTrue(data['verification'])
        self.assertIn('visible_challenge_widget:.geetest_panel', data['verification_evidence'])
        for surface in ('img', 'canvas', 'input:not([type="hidden"])', 'button', '[role="slider"]'):
            with self.subTest(surface=surface):
                data = snapshot(nodes={'shell': {'map': {surface: ['control']}}, 'control': {'tagName': 'IMG'}},
                                map={'#captcha': ['shell']})
                self.assertEqual(browser.FulltextBrowserFetcher._reason(data), 'verification')

    def test_visible_shell_with_only_unpainted_prompt_is_not_active_challenge(self):
        data = snapshot(body='共找到 1 条结果\n请拖动滑块完成验证', nodes={
            'shell': {'text': '请拖动滑块完成验证', 'width': 300, 'height': 100},
            'prompt': {'text': '请拖动滑块完成验证', 'parent': 'shell', 'style': {'opacity': '0'}}},
            map={'.captcha': ['shell']})
        self.assertFalse(data['verification'])

    def test_preloaded_invisible_recaptcha_frame_is_not_a_visible_challenge(self):
        for width, height in ((0, 0), (1, 1), (300, 0), (0, 150)):
            with self.subTest(width=width, height=height):
                data = snapshot(nodes={'frame': {'tagName': 'IFRAME', 'width': width, 'height': height}},
                                map={'iframe[src*="recaptcha"]': ['frame']})
                self.assertFalse(data['verification'])
        data = snapshot(nodes={'frame': {'tagName': 'IFRAME', 'width': 300, 'height': 150}},
                        map={'iframe[src*="recaptcha"]': ['frame']})
        self.assertTrue(data['verification'])

    def test_real_password_form_and_access_restrictions_remain_guarded(self):
        data = snapshot(nodes={'password': {'tagName': 'INPUT'}, 'shell': {}},
                        map={'input[type="password"]': ['password'], '.captcha': ['shell']})
        self.assertEqual(browser.FulltextBrowserFetcher._reason(data), 'login')
        self.assertEqual(browser.FulltextBrowserFetcher._reason(snapshot(body='您所在的机构未订购')), 'access_required')

    def test_attention_records_only_allowlisted_verification_evidence(self):
        fetcher = browser.FulltextBrowserFetcher.__new__(browser.FulltextBrowserFetcher)
        fetcher._binding = {}
        fetcher._request_url = 'https://kns.cnki.net/article'
        fetcher._write_binding = lambda: None
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            fetcher.job_dir = Path(directory)
            result = fetcher._attention('verification', fetcher._request_url, snapshot={'verification_evidence': [
                'cnki_verify_route', 'visible_challenge_widget:.captcha', 'cnki_verify_route',
                'https://kns.cnki.net/verify/home?token=SECRET', {'text': 'SECRET'}]})
            self.assertEqual(result['verification_evidence'], ['cnki_verify_route', 'visible_challenge_widget:.captcha'])
            self.assertEqual(fetcher._binding['verification_evidence'], result['verification_evidence'])
            log = (Path(directory) / 'fulltext' / 'download-diagnostics.jsonl').read_text(encoding='utf-8')
            self.assertNotIn('SECRET', log)
            self.assertNotIn('https://', log)
            rows = [json.loads(line) for line in log.splitlines()]
            self.assertEqual([row['source'] for row in rows], result['verification_evidence'])
            self.assertTrue(all(row['code'] == 'page_verification_detected' for row in rows))
            fetcher._clear_pending()
            self.assertNotIn('verification_evidence', fetcher._binding)

    def test_detected_challenge_pauses_immediately_with_manual_verification_message(self):
        data = snapshot(url='https://kns.cnki.net/verify/home', ready='loading')
        fetcher = browser.FulltextBrowserFetcher.__new__(browser.FulltextBrowserFetcher)
        fetcher._clock = lambda: 0
        fetcher._binding = {}
        fetcher._request_url = 'https://kns.cnki.net/article'
        fetcher._write_binding = lambda: None
        page = types.SimpleNamespace(url='https://kns.cnki.net/verify/home', evaluate=lambda _: data)
        _, result = fetcher._wait_page_ready(page)
        self.assertEqual(result['reason'], 'verification')
        self.assertIn('人工验证', result['message'])
        self.assertEqual(fetcher._binding['attention_reason'], 'verification')
        with self.assertRaises(driver.FulltextPause) as raised:
            driver._raise_page_attention(result, 'CNKI-I001', page.url)
        self.assertEqual(raised.exception.reason, 'verification')
        self.assertEqual(raised.exception.message, result['message'])


class DownloadStateTests(unittest.TestCase):
    def test_cnki_download_center_does_not_mark_normal_results_pending(self):
        data = snapshot(title='检索-中国知网',
            body='读者服务\n下载中心\n共找到 1 条结果\n热应激对蛋鸡生产性能的影响',
            nodes={'footer': {'tagName': 'FOOTER'},
                   'link': {'tagName': 'A', 'text': '下载中心', 'parent': 'footer'}})
        self.assertFalse(data['download_pending'])
        self.assertEqual(data['file_progress'], [])
        self.assertFalse(browser._page_loading(data))
        self.assertFalse(snapshot(body='下载中心')['download_pending'])

    def test_hidden_transparent_and_offscreen_preloaded_download_status_is_ignored(self):
        for hidden in ({'hidden': True}, {'style': {'opacity': '0'}},
                       {'style': {'display': 'none'}}, {'style': {'visibility': 'hidden'}},
                       {'style': {'contentVisibility': 'hidden'}}, {'left': -500, 'width': 200}):
            for on_parent in (False, True):
                with self.subTest(hidden=hidden, on_parent=on_parent):
                    data = snapshot(body='共找到 1 条结果\n正在生成PDF，请稍候', nodes={
                        'shell': {'text': '正在生成PDF，请稍候', **(hidden if on_parent else {})},
                        'prompt': {'text': '正在生成PDF，请稍候', 'parent': 'shell',
                                   **({'left': hidden['left']} if on_parent and 'left' in hidden else {}),
                                   **({} if on_parent else hidden)}})
                    self.assertFalse(data['download_pending'])

    def test_visible_download_messages_still_wait(self):
        for status in ('下载中...', '正在下载，请稍候', '文件正在生成', '正在生成PDF，请稍候',
                       'Preparing your file', 'Generating PDF...', 'Downloading file: 15%'):
            with self.subTest(status=status):
                data = snapshot(body='共找到 1 条结果\n'+status,
                                nodes={'prompt': {'text': status}})
                self.assertTrue(data['download_pending'])
                self.assertTrue(browser._page_loading(data))

    def test_article_and_template_download_instructions_are_not_pending_status(self):
        for tag in ('ARTICLE', 'NAV', 'FOOTER', 'TEMPLATE', 'SCRIPT', 'STYLE', 'NOSCRIPT'):
            with self.subTest(tag=tag):
                data = snapshot(body='帮助文档\n正在下载，请稍候', nodes={
                    'section': {'tagName': tag},
                    'prompt': {'tagName': tag if tag in ('TEMPLATE', 'SCRIPT', 'STYLE', 'NOSCRIPT') else 'P',
                               'text': '正在下载，请稍候', 'parent': 'section'}})
                self.assertFalse(data['download_pending'])

    def test_visible_download_progress_is_pending_and_in_stability_signature(self):
        for attrs in ({'aria-label': 'PDF download', 'aria-valuenow': '25', 'aria-valuemax': '100'},
                      {'aria-label': '文件生成进度'}):
            with self.subTest(attrs=attrs):
                data = snapshot(nodes={'progress': {'attrs': attrs}}, map={'[role="progressbar"]': ['progress']})
                self.assertTrue(data['download_pending'])
                self.assertEqual(data['file_progress'], [[attrs.get('aria-valuenow'), attrs.get('aria-valuemax')]])
        data = snapshot(nodes={'shell': {'attrs': {'class': 'download-dialog'}},
                               'progress': {'parent': 'shell', 'attrs': {'aria-valuenow': '40'}}},
                        map={'[role="progressbar"]': ['progress']})
        self.assertTrue(data['download_pending'])
        self.assertEqual(data['file_progress'], [['40', None]])

    def test_hidden_download_progress_does_not_affect_pending_or_stability(self):
        for hidden in ({'hidden': True}, {'style': {'opacity': '0'}}, {'left': 1500}):
            for on_parent in (False, True):
                with self.subTest(hidden=hidden, on_parent=on_parent):
                    data = snapshot(nodes={'shell': {**(hidden if on_parent else {})},
                        'progress': {'parent': 'shell', 'attrs': {'aria-label': 'PDF download', 'aria-valuenow': '25'},
                                     **({'left': hidden['left']} if on_parent and 'left' in hidden else {}),
                                     **({} if on_parent else hidden)}},
                        map={'[role="progressbar"]': ['progress']})
                    self.assertFalse(data['download_pending'])
                    self.assertEqual(data['file_progress'], [])

    def test_reading_progress_is_not_a_download_even_inside_download_named_reader(self):
        data = snapshot(nodes={'shell': {'attrs': {'class': 'download-reader'}},
            'progress': {'parent': 'shell', 'attrs': {'aria-label': 'Reading progress 阅读进度', 'aria-valuenow': '25'}}},
            map={'[role="progressbar"]': ['progress']})
        self.assertFalse(data['download_pending'])
        self.assertEqual(data['file_progress'], [])

    def test_completed_download_progress_is_not_pending(self):
        data = snapshot(nodes={'progress': {'attrs': {'aria-label': 'PDF download',
                            'aria-valuenow': '100', 'aria-valuemax': '100'}}},
                        map={'[role="progressbar"]': ['progress']})
        self.assertFalse(data['download_pending'])
        self.assertEqual(data['file_progress'], [['100', '100']])


if __name__ == '__main__':
    unittest.main()
