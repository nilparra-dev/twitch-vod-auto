import os
import unittest

os.environ.setdefault("ALLOW_RANDOM_ADMIN_PASSWORD", "1")

from fastapi.testclient import TestClient  # noqa: E402

import dashboard  # noqa: E402


class DashboardRoutingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(dashboard.app)

    def test_healthz_ok(self):
        res = self.client.get("/healthz")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "ok")

    def test_api_requires_auth(self):
        res = self.client.get("/api/me")
        self.assertEqual(res.status_code, 401)

    def test_unknown_api_route_is_404_not_spa(self):
        res = self.client.get("/api/definitely-not-a-route")
        self.assertEqual(res.status_code, 404)

    def test_spa_fallback_serves_index_or_reports_missing_build(self):
        # CI runs the backend without frontend/dist, so either a served index or
        # a missing-build response is valid here.
        res = self.client.get("/vods")
        self.assertIn(res.status_code, (200, 503))
        if res.status_code == 200:
            self.assertIn("text/html", res.headers.get("content-type", ""))

    def test_openapi_schema_disabled(self):
        # Do not expose the OpenAPI schema without authentication.
        self.assertIsNone(dashboard.app.openapi_url)
        res = self.client.get("/openapi.json")
        self.assertNotIn(b'"openapi"', res.content)
        self.assertNotIn(b'"paths"', res.content)


class LoginRateLimitTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(dashboard.app)

    def test_rate_limit_keys_on_trusted_ip_not_forwarded_for(self):
        # Rotating X-Forwarded-For must not bypass the limit. X-Real-IP is the
        # trusted address set by the proxy.
        ip = "203.0.113.77"
        last = None
        for i in range(9):
            last = self.client.post(
                "/api/login",
                data={"user": "x", "password": "y"},
                headers={"X-Real-IP": ip, "X-Forwarded-For": f"10.0.0.{i}"},
            )
        self.assertEqual(last.status_code, 429)

    def test_distinct_trusted_ip_not_limited(self):
        res = self.client.post(
            "/api/login",
            data={"user": "x", "password": "y"},
            headers={"X-Real-IP": "203.0.113.201"},
        )
        self.assertEqual(res.status_code, 401)


if __name__ == "__main__":
    unittest.main()
