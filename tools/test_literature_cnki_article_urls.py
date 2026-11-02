"""CNKI opaque article navigation links remain distinct, never identities.

Pure local fixtures only: no browser, official page, credentials or network.
"""
import unittest
from urllib.parse import parse_qs, urlsplit

import literature_browser as browser
import literature_identity as identity
import literature_metadata as metadata


ARTICLE = "https://kns.cnki.net/kcms2/article/abstract"
LINK_A = ARTICLE + "?v=fixture-article-alpha_123"
LINK_B = ARTICLE + "?v=fixture-article-beta_456"
ABSTRACT = "Broilers were assigned to different environmental temperatures. Feed intake and growth were recorded throughout the experiment."


class CNKIArticleURLTests(unittest.TestCase):
    def test_distinct_visible_article_links_survive_result_cleanup(self):
        raw = [dict(title="Heat stress and broiler growth", result_url=LINK_A),
               dict(title="Cold exposure and lamb growth", result_url=LINK_B)]
        clean = browser._clean_results(raw, 10)
        self.assertEqual([row["result_url"] for row in clean], [LINK_A, LINK_B])
        self.assertEqual(len(clean), 2)

    def test_metadata_entry_reuses_the_exact_navigation_link(self):
        for url in (LINK_A, LINK_B):
            with self.subTest(url=url):
                self.assertEqual(metadata.public_url(url), url)
                self.assertEqual(metadata.article_urls({"source_key": "cnki", "title": "A full title", "result_url": url}), [url])

    def test_encoded_opaque_value_and_default_https_port_survive(self):
        url = "https://kns.cnki.net:443/kcms2/article/abstract?v=opaque%2Bvalue%2F123%3D#section"
        cleaned = browser.safe_url(url)
        self.assertEqual(parse_qs(urlsplit(cleaned).query), {"v": ["opaque+value/123="]})
        self.assertEqual(urlsplit(cleaned).fragment, "")
        self.assertEqual(browser.safe_url(cleaned), cleaned)

    def test_stable_identifier_links_keep_historical_v_redaction(self):
        for path in ("/detail", "/kcms2/article/abstract"):
            with self.subTest(path=path):
                url = "https://kns.cnki.net" + path + "?filename=ABC&dbname=CJFQ2026&dbcode=CJFD&v=opaque"
                query = parse_qs(urlsplit(browser.safe_url(url)).query)
                self.assertEqual(query, {"filename": ["ABC"], "dbname": ["CJFQ2026"], "dbcode": ["CJFD"]})

    def test_opaque_value_is_not_allowed_on_other_hosts_or_paths(self):
        for url in ("https://kns.cnki.net.attacker.invalid/kcms2/article/abstract?v=opaque",
                    "https://publisher.example/kcms2/article/abstract?v=opaque",
                    "https://other.cnki.net/kcms2/article/abstract?v=opaque",
                    "https://kns.cnki.net/detail?v=opaque"):
            with self.subTest(url=url):
                self.assertNotIn("opaque", browser.safe_url(url))

    def test_article_navigation_requires_https_default_port_and_no_credentials(self):
        for url in ("http://kns.cnki.net/kcms2/article/abstract?v=opaque",
                    "https://kns.cnki.net:8443/kcms2/article/abstract?v=opaque",
                    "https://user:pass@kns.cnki.net/kcms2/article/abstract?v=opaque",
                    "https://kns.cnki.net:not-a-port/kcms2/article/abstract?v=opaque"):
            with self.subTest(url=url):
                self.assertEqual(browser.safe_url(url), "")

    def test_empty_repeated_or_malformed_opaque_values_are_rejected(self):
        for query in ("v=", "v=one&v=two", "v=%20", "v=has%0Aline", "v=%3Cscript%3E", "v=" + "a" * 8193):
            with self.subTest(query=query[:40]):
                self.assertEqual(browser.safe_url(ARTICLE + "?" + query), "")

    def test_authentication_parameters_still_reject_entire_link(self):
        for key in ("token", "ticket", "session", "password", "authorization", "saml", "signature", "sid", "code", "state", "key"):
            with self.subTest(key=key):
                self.assertEqual(browser.safe_url(LINK_A + "&" + key + "=secret"), "")
        self.assertEqual(browser.safe_url("https://passport.cnki.net/login?v=opaque"), "")

    def test_v_does_not_become_a_stable_source_identifier(self):
        for url in (LINK_A, LINK_B):
            self.assertEqual(identity.source_ids({"source_key": "cnki", "result_url": url}), {})

    def test_navigation_link_and_title_alone_do_not_verify_metadata(self):
        record = {"source_key": "cnki", "title": "Heat stress and broiler growth", "result_url": LINK_A}
        observed = {"title": record["title"], "abstract": ABSTRACT, "abstract_method": "explicit_abstract_dom",
                    "abstract_selector": "#abstract", "abstract_complete": True}
        self.assertEqual(metadata.verify_snapshot(record, observed, LINK_A)["status"], "identity_mismatch")
        record.update(year=2026, authors="Li A")
        observed.update(year=2026, authors="Li A")
        verified = metadata.verify_snapshot(record, observed, LINK_A)
        self.assertEqual(verified["status"], "verified")
        self.assertEqual(verified["evidence"]["identity_match"], "title_year_authors_exact")


if __name__ == "__main__":
    unittest.main()
