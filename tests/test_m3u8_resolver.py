import unittest

from m3u8_resolver import M3U8ResolveError, M3U8Resolver


class FakeResponse:
    def __init__(self, *, ok=True, payload=None, text=""):
        self.ok = ok
        self._payload = payload
        self.text = text

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError("HTTP error")

    def json(self):
        return self._payload


class HiddenSession:
    def __init__(self):
        self.headers = {}

    def head(self, url, **_kwargs):
        available = "good.example" in url and any(part in url for part in ("/chunked/", "/720p60/"))
        return FakeResponse(ok=available)


class TrackerSession(HiddenSession):
    def get(self, url, **_kwargs):
        if "standardsearch" in url:
            return FakeResponse(payload=[{"itemtype": 1, "siteurl": "testchannel", "value": 42}])
        return FakeResponse(
            payload={
                "recordsFiltered": 1,
                "data": [{"streamId": 51582913581, "startDateTime": "2024-07-22T23:35:15Z"}],
            }
        )


class PublicSession:
    def __init__(self):
        self.headers = {}

    def post(self, *_args, **_kwargs):
        return FakeResponse(payload={"data": {"videoPlaybackAccessToken": {"signature": "sig", "value": "token"}}})

    def get(self, *_args, **_kwargs):
        return FakeResponse(
            text=(
                '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080,FRAME-RATE=60.000,VIDEO="chunked"\n'
                "https://video.example/chunked/index-dvr.m3u8\n"
            )
        )


class M3U8ResolverTests(unittest.TestCase):
    def test_resolves_canonical_hidden_target_and_formats(self):
        resolver = M3U8Resolver(session=HiddenSession(), vod_domains=["https://bad.example", "https://good.example"])
        result = resolver.resolve("video:testchannel_51582913581_1721691315")
        self.assertEqual(result["kind"], "hidden")
        self.assertEqual(result["channel"], "testchannel")
        self.assertEqual([item["id"] for item in result["formats"]], ["Source", "720p60"])
        self.assertIn("testchannel_51582913581_1721691315", result["formats"][0]["url"])

    def test_tracker_url_resolves_timestamp_through_sullygnome(self):
        resolver = M3U8Resolver(session=TrackerSession(), vod_domains=["https://good.example"])
        result = resolver.resolve("https://twitchtracker.com/testchannel/streams/51582913581")
        self.assertEqual(result["source"], "twitchtracker")
        self.assertEqual(result["canonical_target"], "video:testchannel_51582913581_1721691315")

    def test_isolated_hidden_stream_id_explains_missing_data(self):
        with self.assertRaisesRegex(M3U8ResolveError, "no basta"):
            M3U8Resolver(session=HiddenSession()).resolve("51582913581")

    def test_public_vod_returns_manifest_formats(self):
        result = M3U8Resolver(session=PublicSession()).resolve("https://www.twitch.tv/videos/2434567890")
        self.assertEqual(result["kind"], "public")
        self.assertEqual(result["formats"][0]["height"], 1080)
        self.assertEqual(result["formats"][0]["fps"], 60)


if __name__ == "__main__":
    unittest.main()
