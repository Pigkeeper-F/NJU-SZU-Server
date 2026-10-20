"""CNKI query encoding/resume fixtures; no live browser, network or credentials."""
from contextlib import contextmanager
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import unquote, urlencode, urlsplit

import literature_browser as adapter
from test_literature_browser import Context, Page, snapshot


QUERY = 'broiler "heat stress"'
ROWS = [{"title": f"CNKI broiler heat study {i}", "authors": "A Author", "year": "2024",
         "venue": "Poultry Science", "result_url": f"https://kns.cnki.net/detail?filename=TEST{i}"}
        for i in range(10)]


def decode_cnki_kw(url):
    """Model a percent-only URI decoder: literal '+' stays literal '+' in input."""
    for pair in urlsplit(url).query.split("&"):
        key, _, value = pair.partition("=")
        if unquote(key) == "kw":
            return unquote(value)
    return ""


class CnkiPage(Page):
    def goto(self, url, **kwargs):
        self.url = url
        self.navigations.append(url)
        self.dom = snapshot(queries=[decode_cnki_kw(url)], results=copy.deepcopy(ROWS), resultContainer=True)


class CnkiContext(Context):
    def new_page(self):
        page = CnkiPage(f"cnki-target-{len(self.pages) + 1}", self.initial_dom)
        self.pages.append(page)
        return page


class CnkiEncodingTests(unittest.TestCase):
    def test_navigation_round_trips_spaces_quotes_true_plus_and_chinese(self):
        for query in (QUERY, 'broiler + "heat stress"', 'C++ 热应激 "生长 性能"', 'A+B'):
            with self.subTest(query=query):
                page = CnkiPage("target", snapshot())
                self.assertTrue(adapter._navigate_search(page, "cnki", query, None, None))
                raw_kw = next(pair.partition("=")[2] for pair in urlsplit(page.url).query.split("&") if pair.startswith("kw="))
                self.assertNotIn("+", raw_kw, "CNKI must not receive form-encoded spaces")
                if " " in query:
                    self.assertIn("%20", raw_kw)
                if "+" in query:
                    self.assertIn("%2B", raw_kw)
                self.assertEqual(page.dom["queries"], [query])
                self.assertTrue(adapter._matches_query(page.dom, page.url, "cnki", query))

    def test_visible_wrong_plus_query_is_not_overruled_by_url_or_prior_proof(self):
        wrong = snapshot(queries=['broiler+"heat+stress"'], results=ROWS, resultContainer=True)
        page = CnkiPage("target", wrong)
        page.url = adapter.SOURCES["cnki"][1] + "?" + urlencode({"kw": QUERY, "korder": "SU"})
        self.assertEqual(decode_cnki_kw(page.url), 'broiler+"heat+stress"')
        self.assertFalse(adapter._matches_query(wrong, page.url, "cnki", QUERY))
        self.assertFalse(adapter._query_consistent(wrong, page, "cnki", QUERY, submitted=True, trusted=True))
        # A real '+' has scientific query meaning; never normalize it to a space.
        self.assertFalse(adapter._matches_query(snapshot(queries=['broiler "heat stress"']), page.url, "cnki", 'broiler+"heat+stress"'))

    def test_resume_corrects_old_wrong_encoded_page_using_original_task_and_target(self):
        with tempfile.TemporaryDirectory() as temp:
            job = Path(temp)
            original_files = {
                "run_config.json": json.dumps({"sources": ["cnki"], "query": QUERY}).encode("utf-8"),
                "candidates.json": json.dumps({"count": 40, "records": [{"candidate_id": f"OLD-{i}"} for i in range(40)]}).encode("utf-8"),
                "discovery-state.json": b'{"pending_source":"cnki","batch_index":1,"deferred_sources":["web-of-science"]}',
            }
            for name, content in original_files.items():
                (job / name).write_bytes(content)
            context = CnkiContext(snapshot())
            page = context.new_page()
            page.url = adapter.SOURCES["cnki"][1] + "?" + urlencode({"kw": QUERY, "korder": "SU"})
            page.dom = snapshot(queries=[decode_cnki_kw(page.url)], results=ROWS, resultContainer=True)
            adapter._save_binding(job, "cnki", page.target)

            @contextmanager
            def runtime():
                yield context

            with patch.object(adapter, "_runtime", runtime):
                result = adapter.run("cnki", QUERY, True, 10, job_dir=job)
            self.assertEqual((result["status"], len(result["results"])), ("ok", 10))
            self.assertEqual(page.dom["queries"], [QUERY])
            self.assertEqual(len(page.navigations), 1)
            self.assertIn("%20", page.navigations[0])
            self.assertEqual(len(context.pages), 1, "Continue must reuse the task's bound official target")
            binding = json.loads((job / "browser-tabs.json").read_text(encoding="utf-8"))["cnki"]
            self.assertEqual(binding["target_id"], page.target)
            self.assertEqual(binding["query_hash"], hashlib.sha256(QUERY.encode("utf-8")).hexdigest())
            for name, content in original_files.items():
                self.assertEqual((job / name).read_bytes(), content)

    def test_still_wrong_visible_query_stays_attention_without_reading_records(self):
        with tempfile.TemporaryDirectory() as temp:
            job = Path(temp)
            context = CnkiContext(snapshot())
            page = context.new_page()
            page.url = adapter.SOURCES["cnki"][1] + "?" + urlencode({"kw": QUERY})
            page.dom = snapshot(queries=['broiler+"heat+stress"'], results=ROWS, resultContainer=True)
            adapter._save_binding(job, "cnki", page.target)

            @contextmanager
            def runtime():
                yield context

            with patch.object(adapter, "_runtime", runtime), patch.object(adapter, "_navigate_search", return_value=True):
                result = adapter.run("cnki", QUERY, True, 10, job_dir=job)
            self.assertEqual((result["status"], result["reason"]), ("attention", "results_unrecognized"))
            self.assertEqual(result["results"], [])


if __name__ == "__main__":
    unittest.main()
