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
        # En CI el backend corre sin `frontend/dist` (se compila aparte / en
        # Docker), así que aceptamos 200 (index servido) o 503 (sin build).
        res = self.client.get("/vods")
        self.assertIn(res.status_code, (200, 503))
        if res.status_code == 200:
            self.assertIn("text/html", res.headers.get("content-type", ""))


if __name__ == "__main__":
    unittest.main()
