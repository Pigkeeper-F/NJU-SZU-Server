"""Pure offline full-text proof regressions; no browser or network use."""
from __future__ import annotations

import copy
import unittest

from literature_fulltext_evidence import (
    EVIDENCE_VERSION, assess_html, content_sha256,
    revalidate_saved_html, verified_saved_html,
)

TITLE = "Effects of temperature on growth performance in broiler chickens"
DOI = "10.1234/example.5678"


def body_fixture(headings=None):
    headings = headings or ["Introduction", "Materials and methods", "Results", "Discussion"]
    sections = []
    for i, heading in enumerate(headings):
        text = (f"Section {i} describes the poultry temperature experiment and measured growth response. " * 5).strip()
        sections.append({"heading": heading, "text": text})
    text = "\n\n".join(f"{s['heading']}\n{s['text']}" for s in sections)
    evidence = {"origin": "dom_article_region", "container_verified": True,
                "container": "article .body", "page_title": TITLE,
                "citation_title": TITLE, "citation_doi": DOI,
                "article_text": text, "sections": sections}
    return text, evidence


class EvidenceTests(unittest.TestCase):
    def test_publisher_fulltext_with_body_identity_and_sections(self):
        text, evidence = body_fixture()
        self.assertEqual(assess_html(text, "https://publisher.example/articles/paper", evidence, TITLE, DOI)[0], "fulltext")

    def test_length_alone_never_proves_fulltext(self):
        text = ("Abstract\nA description of an experiment, with keywords and citations.\n" * 80)
        self.assertGreater(len(text), 2000)
        self.assertEqual(assess_html(text)[0], "abstract")
        self.assertNotEqual(assess_html("large page " * 1000)[0], "fulltext")

    def test_pubmed_and_scopus_metadata_even_with_fake_body_evidence(self):
        text, evidence = body_fixture()
        for url in ("https://pubmed.ncbi.nlm.nih.gov/33925609/", "https://www.scopus.com/pages/publications/105001", "https://www.scopus.com/record/display.uri?eid=example"):
            with self.subTest(url=url):
                self.assertEqual(assess_html(text * 4, url, evidence, TITLE, DOI)[0], "abstract")

    def test_long_real_failure_sample_shapes_remain_abstract(self):
        pubmed = "Title & authors\nAbstract\nHeat stress affects production.\nFigures\nSimilar articles\nReferences\n" + ("A reference about methods and results. DOI 10.1234/ref\n" * 100)
        scopus = "Scopus Logo\nView PDF\nFull text\nAbstract\n" + ("Experiment results and methods in a long abstract. " * 90) + "\nFunding details\nCorresponding authors"
        self.assertEqual(assess_html(pubmed, "https://pubmed.ncbi.nlm.nih.gov/33925609/")[0], "abstract")
        self.assertEqual(assess_html(scopus, "https://www.scopus.com/pages/publications/105001")[0], "abstract")

    def test_cnki_and_wanfang_metadata_not_source_blanket_ban(self):
        text, evidence = body_fixture(["引言", "材料与方法", "结果", "讨论"])
        for url in ("https://kns.cnki.net/kcms2/article/abstract", "https://d.wanfangdata.com.cn/periodical/example"):
            with self.subTest(url=url):
                self.assertEqual(assess_html("摘要\n" + text, url)[0], "abstract")
                self.assertEqual(assess_html(text, url, evidence, TITLE, DOI)[0], "fulltext")

    def test_explicit_errors_login_and_limits_override_body(self):
        text, evidence = body_fixture()
        for error in ("404 Page not found", "非常抱歉，您所访问的页面不存在或已被删除！", "Too many requests", "操作过于频繁", "Sign in to view this article", "请先登录", "安全验证", "Access denied", "Error code 524 A timeout occurred"):
            with self.subTest(error=error):
                self.assertEqual(assess_html(error + "\n" + text, evidence=evidence, expected_title=TITLE, expected_doi=DOI)[0], "unavailable")

    def test_nav_login_is_not_an_access_block(self):
        text, evidence = body_fixture()
        self.assertEqual(assess_html("Log in\nInstitutional access\n" + text, evidence=evidence, expected_title=TITLE, expected_doi=DOI)[0], "fulltext")

    def test_generic_article_or_main_not_sufficient(self):
        text, evidence = body_fixture()
        for change in ({"container_verified": False}, {"origin": "page_text"}, {"container_verified": "true"}):
            bad = {**evidence, **change}
            self.assertNotEqual(assess_html(text, evidence=bad, expected_title=TITLE, expected_doi=DOI)[0], "fulltext")

    def test_identity_doi_mismatch_cannot_be_overridden_by_title(self):
        text, evidence = body_fixture()
        evidence["citation_doi"] = "10.9999/other.paper"
        self.assertEqual(assess_html(text, evidence=evidence, expected_title=TITLE, expected_doi=DOI)[0], "unavailable")

    def test_title_matching_allows_punctuation_and_site_suffix(self):
        text, evidence = body_fixture()
        evidence["citation_doi"] = ""
        evidence["citation_title"] = TITLE.upper() + " | Example Journal"
        self.assertEqual(assess_html(text, evidence=evidence, expected_title=TITLE)[0], "fulltext")
        evidence["citation_title"] = "Effects of temperature"
        self.assertNotEqual(assess_html(text, evidence=evidence, expected_title=TITLE)[0], "fulltext")

    def test_identity_required_no_target_no_fulltext(self):
        text, evidence = body_fixture()
        self.assertNotEqual(assess_html(text, evidence=evidence)[0], "fulltext")

    def test_metadata_doi_url_normalized(self):
        text, evidence = body_fixture()
        evidence["citation_doi"] = "https://doi.org/10.1234/EXAMPLE.5678"
        self.assertEqual(assess_html(text, evidence=evidence, expected_doi=DOI)[0], "fulltext")

    def test_abstract_references_and_navigation_not_body_sections(self):
        for headings in (["Abstract", "References", "Similar articles"], ["Contents", "Funding details", "Author information"]):
            text, evidence = body_fixture(headings)
            self.assertNotEqual(assess_html(text, evidence=evidence, expected_title=TITLE)[0], "fulltext")

    def test_heading_list_without_section_prose_not_proof(self):
        text, evidence = body_fixture()
        evidence["sections"] = [{"heading": s["heading"], "text": ""} for s in evidence["sections"]]
        self.assertNotEqual(assess_html(text, evidence=evidence, expected_title=TITLE)[0], "fulltext")

    def test_foreign_section_text_not_proof(self):
        text, evidence = body_fixture()
        for section in evidence["sections"]:
            section["text"] = "Unrelated text that was not captured from this body region. " * 10
        self.assertNotEqual(assess_html(text, evidence=evidence, expected_title=TITLE)[0], "fulltext")

    def test_review_without_methods_supported(self):
        text, evidence = body_fixture(["Introduction", "Heat stress and oxidative pathways", "Dietary polyphenols", "Conclusions"])
        self.assertEqual(assess_html(text, evidence=evidence, expected_title=TITLE)[0], "fulltext")

    def test_numbered_headings_supported(self):
        text, evidence = body_fixture(["1. Introduction", "2. Materials and methods", "3. Results", "4. Discussion"])
        self.assertEqual(assess_html(text, evidence=evidence, expected_title=TITLE)[0], "fulltext")

    def test_current_saved_cache_verified_with_exact_digest(self):
        text, evidence = body_fixture()
        evidence.pop("article_text")
        item = {"title": TITLE, "doi": DOI, "source_url": "https://publisher.example/article/1", "evidence_version": EVIDENCE_VERSION,
                "content_sha256": content_sha256(text), "html_evidence": evidence}
        self.assertTrue(verified_saved_html(item, text)[0])
        self.assertEqual(revalidate_saved_html(item, text)[0], "fulltext")
        self.assertFalse(verified_saved_html(item, text + "\n")[0])
        bad = copy.deepcopy(item)
        bad["evidence_version"] = "older"
        self.assertFalse(verified_saved_html(bad, text)[0])

    def test_old_cache_kept_conservative_even_real_looking_sections(self):
        text, evidence = body_fixture()
        item = {"status": "fetched_html", "title": TITLE, "doi": DOI, "source_url": "https://publisher.example/article/1", "html_evidence": evidence}
        before = copy.deepcopy(item)
        self.assertEqual(revalidate_saved_html(item, text)[0], "unavailable")
        self.assertEqual(item, before)
        for url in ("https://pubmed.ncbi.nlm.nih.gov/33925609/", "https://kns.cnki.net/kcms2/article/abstract"):
            item["source_url"] = url
            self.assertEqual(revalidate_saved_html(item, text)[0], "abstract")

    def test_saved_errors_unavailable_and_no_mutation(self):
        item = {"status": "fetched_html", "source_url": "https://kns.cnki.net/kcms2/article/abstract"}
        original = copy.deepcopy(item)
        self.assertEqual(revalidate_saved_html(item, "404 Page not found")[0], "unavailable")
        self.assertEqual(item, original)

    def test_cnki_source_application_errors_override_body_and_downgrade_saved_cache(self):
        body, evidence = body_fixture()
        for error in ("来源应用不正确(01)", "来源应用不正确（01）", "来源应用错误", "下载入口已失效", "链接已失效"):
            with self.subTest(error=error):
                text = error + "\n摘要\n" + body
                verdict, reason = assess_html(text, "https://kns.cnki.net/kcms2/article/abstract", evidence, TITLE, DOI)
                self.assertEqual(verdict, "unavailable")
                self.assertIn("来源应用不正确或下载入口失效", reason)
                self.assertNotIn("登录", reason)
                self.assertNotIn("限流", reason)
                for version in (None, EVIDENCE_VERSION):
                    item = {"status": "fetched_html", "title": TITLE, "doi": DOI,
                            "source_url": "https://kns.cnki.net/kcms2/article/abstract",
                            "evidence_version": version, "content_sha256": content_sha256(text),
                            "html_evidence": evidence}
                    original = copy.deepcopy(item)
                    self.assertFalse(verified_saved_html(item, text)[0])
                    self.assertEqual(revalidate_saved_html(item, text), (verdict, reason))
                    self.assertEqual(item, original)


if __name__ == "__main__":
    unittest.main()
