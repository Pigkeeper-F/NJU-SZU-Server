"""Offline, deterministic tests for public PubMed discovery."""
import io
import json
import sys
from pathlib import Path
import unittest
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import literature_pubmed as pubmed


def search(count, ids):
    return json.dumps({"esearchresult": {"count": str(count), "idlist": ids}}).encode()


def article(pmid="123", title="Heat <i>stress</i> in H<sub>2</sub>O", year="<Year>2020</Year>", doi="10.1234/example", pmc="PMC999"):
    return f"""<PubmedArticle><MedlineCitation><PMID>{pmid}</PMID><Article>
    <ArticleTitle>{title}</ArticleTitle><Journal><Title>Poultry Science</Title>
    <JournalIssue><PubDate>{year}</PubDate></JournalIssue></Journal>
    <AuthorList><Author><LastName>Li</LastName><ForeName>Ming</ForeName></Author>
    <Author><CollectiveName>Broiler Trial Group</CollectiveName></Author></AuthorList>
    <Abstract><AbstractText Label="RESULTS">Growth <b>decreased</b> at 35 C.</AbstractText></Abstract>
    </Article></MedlineCitation><PubmedData><ArticleIdList>
    <ArticleId IdType="pubmed">{pmid}</ArticleId><ArticleId IdType="doi">{doi}</ArticleId>
    <ArticleId IdType="pmc">{pmc}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>"""


def xml(*records):
    return ("<?xml version='1.0'?><!DOCTYPE PubmedArticleSet SYSTEM 'https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd'>"
            "<PubmedArticleSet>" + "".join(records) + "</PubmedArticleSet>").encode()


class Response(io.BytesIO):
    def __init__(self, data, url, headers=None):
        super().__init__(data)
        self.url, self.headers, self.status = url, headers or {}, 200

    def geturl(self):
        return self.url


class FakeNetwork:
    def __init__(self, *payloads):
        self.payloads, self.calls = list(payloads), []

    def open(self, request, timeout):
        self.calls.append((request.full_url, timeout))
        payload = self.payloads.pop(0)
        if isinstance(payload, Exception):
            raise payload
        if isinstance(payload, Response):
            return payload
        return Response(payload, request.full_url)


class PubMedTests(unittest.TestCase):
    def setUp(self):
        pubmed._last_request = None
        self.now, self.sleeps = 10.0, []

    def clock(self):
        return self.now

    def sleep(self, delay):
        self.sleeps.append(delay)
        self.now += delay

    def run_query(self, network, **kwargs):
        return pubmed.run('broiler "heat stress"', opener=network, sleep=self.sleep, clock=self.clock, **kwargs)

    def test_legitimate_zero_no_fetch(self):
        network = FakeNetwork(search(0, []))
        result = self.run_query(network)
        self.assertEqual(result["status"], "no_results")
        self.assertEqual(len(network.calls), 1)
        self.assertEqual(result["results"], [])

    def test_multiple_ids_order_and_actual_metadata(self):
        network = FakeNetwork(search(2, ["123", "456"]), xml(article(pmid="456"), article()))
        result = self.run_query(network)
        self.assertEqual(result["status"], "ok", result)
        records = result["results"]
        self.assertEqual([r["pmid"] for r in records], ["123", "456"])
        self.assertEqual(records[0]["title"], "Heat stress in H2O")
        self.assertEqual(records[0]["authors"], "Li Ming; Broiler Trial Group")
        self.assertEqual(records[0]["year"], 2020)
        self.assertEqual(records[0]["doi"], "10.1234/example")
        self.assertEqual(records[0]["pmcid"], "PMC999")
        self.assertIn("PMC999", records[0]["fulltext_links"][0]["url"])
        self.assertEqual(records[0]["snippet"], "RESULTS: Growth decreased at 35 C.")
        self.assertNotIn("abstract", records[0])
        self.assertEqual(records[0]["evidence_level"], "search_result_snippet")
        self.assertEqual(result["transport"], "ncbi_eutilities")
        self.assertEqual(len(self.sleeps), 1)
        self.assertAlmostEqual(self.sleeps[0], 0.35)

    def test_medline_date_and_unknown_year(self):
        network = FakeNetwork(search(4, ["123", "456", "789", "999"]), xml(
            article(year="<MedlineDate>2021 Summer</MedlineDate>"),
            article(pmid="456", year="<MedlineDate>2020 Dec-2021 Jan</MedlineDate>"),
            article(pmid="789", year=""),
            article(pmid="999", year="<MedlineDate>1999-00 Winter</MedlineDate>")))
        result = self.run_query(network)
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual([row["year"] for row in result["results"]], [2021, None, None, None])
        self.assertEqual(result["results"][1]["year_status"], "unknown")

    def test_pubmed_book_metadata_and_reported_article_date(self):
        book = '''<PubmedBookArticle><BookDocument><PMID>456</PMID>
        <ArticleTitle>Heat effects chapter</ArticleTitle><Book><BookTitle>Animal research</BookTitle>
        <PubDate><Year>2018</Year></PubDate></Book><AuthorList><Author><LastName>Xu</LastName>
        <Initials>J</Initials></Author></AuthorList></BookDocument><PubmedBookData><ArticleIdList>
        <ArticleId IdType="pubmed">456</ArticleId></ArticleIdList></PubmedBookData></PubmedBookArticle>'''
        paper = article(year="").replace("</Article>", "<ArticleDate DateType='Electronic'><Year>2022</Year></ArticleDate></Article>")
        result = self.run_query(FakeNetwork(search(2, ["123", "456"]), xml(paper, book)))
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual([r["year"] for r in result["results"]], [2022, 2018])
        self.assertEqual(result["results"][1]["authors"], "Xu J")
        self.assertEqual(result["results"][1]["venue"], "Animal research")

    def test_missing_doi_pmc_not_invented(self):
        network = FakeNetwork(search(1, ["123"]), xml(article(doi="invalid", pmc="invalid")))
        result = self.run_query(network)
        self.assertEqual(result["results"][0]["fulltext_links"], [])

    def test_publication_year_filter_and_parameter_encoding(self):
        network = FakeNetwork(search(1, ["123"]), xml(article()))
        query = '肉鸡 AND ("heat stress" OR 35°C) & # + [Title/Abstract]'
        result = pubmed.run(query, 1, 2010, 2025, opener=network, sleep=self.sleep, clock=self.clock)
        self.assertEqual(result["status"], "ok", result)
        params = parse_qs(urlsplit(network.calls[0][0]).query)
        self.assertEqual(params["term"], [query])
        self.assertEqual(params["datetype"], ["pdat"])
        self.assertEqual(params["mindate"], ["2010/01/01"])
        self.assertEqual(params["maxdate"], ["2025/12/31"])
        self.assertEqual(params["retmax"], ["1"])
        self.assertNotIn("api_key", params)
        self.assertEqual(result["applied_filters"], ["query", "publicationYearFrom", "publicationYearTo"])
        self.assertEqual(result["filter_details"]["publication_year"]["scope"], "publication_not_experiment")
        self.assertIn("2010:2025[dp]", parse_qs(urlsplit(result["url"]).query)["term"][0])

    def test_invalid_json_error_html_and_empty_response_are_not_zero(self):
        for payload in (b"<html>Sign in</html>", b"{}", b"", b"[1,2]", b'{"error":"bad query"}',
                        b'{"esearchresult":{"count":"0","idlist":[],"errorlist":{"fieldnotfound":["xx"]}}}'):
            with self.subTest(payload=payload):
                result = self.run_query(FakeNetwork(payload))
                self.assertEqual(result["status"], "error", result)
                self.assertEqual(result["results"], [])

    def test_bad_count_or_inconsistent_ids_not_zero(self):
        for payload in (search(3, []), search(0, ["123"]), search(2, ["123", "123"]),
                        search(1, ["javascript:x"]), search(1, [123]), search(-1, [])):
            with self.subTest(payload=payload):
                self.assertEqual(self.run_query(FakeNetwork(payload))["status"], "error")

    def test_bad_xml_or_mismatched_pmids_not_success(self):
        samples = (b"<html>Blocked</html>", b"<PubmedArticleSet>", b"<PubmedArticleSet/>",
                   xml(article(pmid="456")), xml(article(), article()),
                   xml(article(title="")), xml(article()).replace(b'IdType="pubmed">123', b'IdType="pubmed">456'),
                   b'<!DOCTYPE PubmedArticleSet [<!ENTITY x "expanded">]><PubmedArticleSet/>')
        for payload in samples:
            with self.subTest(payload=payload):
                result = self.run_query(FakeNetwork(search(1, ["123"]), payload))
                self.assertEqual(result["status"], "error", result)

    def test_http_429_and_network_errors_do_not_leak(self):
        samples = (HTTPError("https://secret.test/?token=secret", 429, "token=secret", {}, None),
                   HTTPError("https://secret.test/?token=secret", 500, "token=secret", {}, None),
                   URLError("proxy https://user:secret@proxy/"), RuntimeError("token=secret"))
        for error in samples:
            with self.subTest(error=type(error).__name__):
                result = self.run_query(FakeNetwork(error))
                self.assertEqual(result["status"], "error")
                self.assertNotIn("secret", json.dumps(result))
        self.assertIn("429", self.run_query(FakeNetwork(samples[0]))["message"])

    def test_response_limit_and_external_final_url(self):
        for response in (b" " * 65,
                         Response(b"{}", pubmed.BASE + "esearch.fcgi", {"Content-Length": "99999"}),
                         Response(b"{}", "https://evil.example/"),
                         Response(b"{}", pubmed.BASE + "esearch.fcgi", {"Content-Encoding": "gzip"})):
            with self.subTest(response=type(response).__name__):
                result = self.run_query(FakeNetwork(response), max_response_bytes=64)
                self.assertEqual(result["status"], "error", result)

    def test_redirects_only_fixed_official_https_endpoints(self):
        valid = pubmed.BASE + "efetch.fcgi?db=pubmed"
        self.assertTrue(pubmed._official_api_url(valid))
        for url in ("http://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
                    "https://eutils.ncbi.nlm.nih.gov.evil.test/entrez/eutils/efetch.fcgi",
                    "https://user:password@eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
                    "https://eutils.ncbi.nlm.nih.gov:444/entrez/eutils/efetch.fcgi",
                    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/../../bad"):
            self.assertFalse(pubmed._official_api_url(url))

    def test_invalid_configuration_makes_no_request(self):
        for kwargs in ({"limit": 11}, {"limit": True}, {"year_from": 2025, "year_to": 2020},
                       {"year_from": "2020"}, {"year_to": False}, {"page_index": -1},
                       {"page_index": True}, {"page_index": 1000}):
            network = FakeNetwork()
            result = self.run_query(network, **kwargs)
            self.assertEqual(result["status"], "error", result)
            self.assertEqual(network.calls, [])

    def test_offset_pages_keep_actual_total_and_last_partial_page(self):
        network = FakeNetwork(search(12, ["111", "222"]), xml(article(pmid="111"), article(pmid="222")))
        result = self.run_query(network, page_index=1)
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(result["page_index"], 1)
        self.assertEqual(result["total_count"], 12)
        self.assertFalse(result["has_next"])
        params = parse_qs(urlsplit(network.calls[0][0]).query)
        self.assertEqual(params["retstart"], ["10"])
        self.assertEqual([row["pmid"] for row in result["results"]], ["111", "222"])

    def test_full_page_and_confirmed_end_beyond_count(self):
        ids = [str(number) for number in range(1, 11)]
        result = self.run_query(FakeNetwork(search(30, ids), xml(*(article(pmid=pmid) for pmid in ids))), page_index=1)
        self.assertTrue(result["has_next"])
        end = self.run_query(FakeNetwork(search(12, [])), page_index=2)
        self.assertEqual(end["status"], "ok")
        self.assertEqual(end["results"], [])
        self.assertFalse(end["has_next"])

    def test_later_offset_inconsistent_ids_is_not_silent_end(self):
        result = self.run_query(FakeNetwork(search(30, [])), page_index=1)
        self.assertEqual(result["status"], "error")
        self.assertIsNone(result["has_next"])


if __name__ == "__main__":
    unittest.main()
