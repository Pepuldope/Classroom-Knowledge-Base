import unittest

import post_status


class CurlResponseTests(unittest.TestCase):
    def test_parse_curl_response_extracts_http_status_and_json_body(self):
        self.assertEqual(
            post_status._parse_curl_response('{"id":"123"}\n__STATUS__200'),
            ({"id": "123"}, 200),
        )

    def test_parse_curl_response_accepts_empty_success_body(self):
        self.assertEqual(post_status._parse_curl_response("__STATUS__204"), ({}, 204))


class AuthorizationTests(unittest.TestCase):
    def test_authorization_header_uses_discovered_token(self):
        expected = "Authorization: " + "B" + "ot " + "abc"
        self.assertEqual(post_status._authorization_header("abc"), expected)


if __name__ == "__main__":
    unittest.main()
