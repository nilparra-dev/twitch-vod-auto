import os
import tempfile
import unittest
from pathlib import Path

import progress
from auto_pipeline import AutoPipeline
from db import PipelineDB
from download_vod import (
    _channel_twitch_config,
    _dir_contents_for_log,
    _find_download_result,
    _fragment_bases,
    _fragment_count,
    _video_id_from_internal_vod_id,
)
from progress import DownloadProgress
from utils import parse_twitch_vod_url
from youtube_uploader import YouTubeUploader


class UrlParsingTests(unittest.TestCase):
    def test_twitchtracker_url_preserves_tracker_and_download_url(self):
        parsed = parse_twitch_vod_url("https://twitchtracker.com/example/streams/123456789")

        self.assertEqual(parsed["vod_id"], "video:example_123456789_123456789")
        self.assertEqual(parsed["channel"], "example")
        self.assertEqual(parsed["video_id"], "123456789")
        self.assertEqual(parsed["tracker_url"], "https://twitchtracker.com/example/streams/123456789")
        self.assertEqual(parsed["download_url"], "https://www.twitch.tv/videos/123456789")

    def test_twitch_video_url_has_download_url(self):
        parsed = parse_twitch_vod_url("https://www.twitch.tv/videos/987654321")

        self.assertEqual(parsed["video_id"], "987654321")
        self.assertEqual(parsed["download_url"], "https://www.twitch.tv/videos/987654321")


class DownloadConfigTests(unittest.TestCase):
    def test_channel_twitch_config_merges_global_and_channel_auth(self):
        cfg = {
            "twitch": {
                "global": {"cookies_file": "global.txt", "cookies_browser": "chrome"},
                "channels": [
                    {"name": "alpha", "cookies_file": "alpha.txt", "cookies_browser": None},
                ],
            }
        }

        self.assertEqual(_channel_twitch_config(cfg, "alpha")["cookies_file"], "alpha.txt")
        self.assertEqual(_channel_twitch_config(cfg, "alpha")["cookies_browser"], "chrome")
        self.assertEqual(_channel_twitch_config(cfg, "missing")["cookies_file"], "global.txt")

    def test_video_id_from_internal_vod_id(self):
        self.assertEqual(
            _video_id_from_internal_vod_id("video:channel_name_123456_1700000000"),
            "123456",
        )
        self.assertEqual(_video_id_from_internal_vod_id("not-internal"), "")

    def test_find_download_result_accepts_alternate_twitch_dlp_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            expected = folder / "trk511___315752637035.mp4"
            actual = folder / "trk511___315752637035-315752637035.mp4"
            with open(actual, "wb") as f:
                f.seek(2 * 1024 * 1024)
                f.write(b"\0")

            self.assertEqual(_find_download_result(expected, "315752637035"), actual)

    def test_dir_contents_for_log_uses_file_variable(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "vod.mp4"
            path.write_bytes(b"abc")

            self.assertEqual(_dir_contents_for_log(Path(tmp)), ["vod.mp4 (0MB)"])

    def test_dir_contents_for_log_prioritizes_current_video_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / "zenrll_316913855460.mp4.part-Frag1").write_bytes(b"abc")
            (folder / "trk511___315752637035.mp4.part-Frag1").write_bytes(b"abc")

            contents = _dir_contents_for_log(folder, video_id="315752637035", output_stem="trk511___315752637035")

            self.assertEqual(contents, ["trk511___315752637035.mp4.part-Frag1 (0MB)"])

    def test_fragment_bases_groups_twitch_dlp_fragments(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            expected = folder / "zenrll_316913855460.mp4"
            for idx in (1, 2, 3):
                (folder / f"zenrll_316913855460.mp4.part-Frag{idx}").write_bytes(b"abc")

            self.assertEqual(_fragment_bases(expected, "316913855460"), [expected])
            self.assertEqual(_fragment_count(expected), 3)


class PipelineDBTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = PipelineDB(os.path.join(self.tmp.name, "pipeline.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_force_enqueue_resets_failed_queue_row(self):
        item = {
            "vod_id": "video:test_123_1700000000",
            "channel": "test",
            "video_id": "123",
            "source": "manual",
            "start_time": 1700000000,
            "tracker_url": "https://twitchtracker.com/test/streams/123",
            "download_url": "https://www.twitch.tv/videos/123",
        }
        self.db.enqueue(item)
        self.assertEqual(self.db.dequeue()["vod_id"], item["vod_id"])
        self.db.mark_queue_status(item["vod_id"], "failed", error="boom")

        self.db.enqueue(item, force=True)
        queued = self.db.dequeue()

        self.assertEqual(queued["status"], "queued")
        self.assertEqual(queued["attempts"], 0)
        self.assertIsNone(queued["error"])
        self.assertEqual(queued["tracker_url"], item["tracker_url"])
        self.assertEqual(queued["download_url"], item["download_url"])

    def test_case_insensitive_channel_filter_and_search_count(self):
        self.db.add_vod("video:Alpha_1_1", "Alpha", "1", "manual")
        self.db.add_vod("video:beta_2_2", "beta", "2", "manual")

        self.assertEqual(len(self.db.get_vods(channel="alpha")), 1)
        self.assertEqual(self.db.count_vods(channel="ALPHA"), 1)
        self.assertEqual(self.db.count_vods(search="beta"), 1)


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_progress_file = progress.PROGRESS_FILE
        progress.PROGRESS_FILE = os.path.join(self.tmp.name, "download_progress.json")

    def tearDown(self):
        progress.PROGRESS_FILE = self.old_progress_file
        self.tmp.cleanup()

    def test_progress_write_update_complete_and_clear(self):
        DownloadProgress.start("vod1", "channel", "123")
        DownloadProgress.update("vod1", percent=42.42, speed="<fast>", status="encoding")

        item = DownloadProgress.get("vod1")
        self.assertEqual(item["status"], "encoding")
        self.assertEqual(item["percent"], 42.4)
        self.assertEqual(item["speed"], "<fast>")

        DownloadProgress.complete("vod1", file_size_mb=12.34)
        self.assertEqual(DownloadProgress.get("vod1")["status"], "completed")

        DownloadProgress.clear("vod1")
        self.assertIsNone(DownloadProgress.get("vod1"))


class YouTubeUploaderTests(unittest.TestCase):
    def test_chunk_size_is_clamped_and_aligned(self):
        self.assertEqual(YouTubeUploader._chunk_size_bytes(64), 64 * 1024 * 1024)
        self.assertEqual(YouTubeUploader._chunk_size_bytes(0), 1 * 1024 * 1024)
        self.assertEqual(YouTubeUploader._chunk_size_bytes(999), 256 * 1024 * 1024)

    def test_invalid_grant_detection(self):
        exc = RuntimeError("invalid_grant: Token has been expired or revoked.")

        self.assertTrue(YouTubeUploader._is_invalid_grant(exc))
        self.assertFalse(YouTubeUploader._is_invalid_grant(RuntimeError("temporarily unavailable")))


class AutoPipelineFileHandlingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pipeline = AutoPipeline.__new__(AutoPipeline)
        self.pipeline.config = {"download": {"output_folder": self.tmp.name}}

    def tearDown(self):
        self.tmp.cleanup()

    def _make_video(self, name: str):
        path = Path(self.tmp.name) / name
        with open(path, "wb") as f:
            f.seek(11 * 1024 * 1024)
            f.write(b"\0")
        return path

    def test_find_existing_download_by_video_id(self):
        existing = self._make_video("zenrll_316944858596.mp4")

        found = self.pipeline._find_existing_download("manual_316944858596.mp4", "316944858596")

        self.assertEqual(Path(found), existing)

    def test_cleanup_uploaded_media_removes_related_files(self):
        uploaded = self._make_video("manual_316944858596.mp4")
        related = self._make_video("zenrll_316944858596.mp4")
        thumb = Path(self.tmp.name) / "zenrll_316944858596.jpg"
        thumb.write_bytes(b"jpg")

        self.pipeline._cleanup_local_media(str(uploaded), "316944858596", include_related=True)

        self.assertFalse(uploaded.exists())
        self.assertFalse(related.exists())
        self.assertFalse(thumb.exists())


class CredentialsStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def _make_credentials():
        from google.oauth2.credentials import Credentials

        return Credentials(
            token="access-token",
            refresh_token="refresh-token",
            token_uri="https://oauth2.googleapis.com/token",
            client_id="client-id",
            client_secret="client-secret",
            scopes=["https://www.googleapis.com/auth/youtube.upload"],
        )

    def test_missing_file_returns_none(self):
        from credentials_store import load_credentials

        self.assertIsNone(load_credentials(os.path.join(self.tmp.name, "nope.json")))

    def test_json_roundtrip(self):
        import json

        from credentials_store import load_credentials, save_credentials

        path = os.path.join(self.tmp.name, "cred.json")
        save_credentials(self._make_credentials(), path)

        # New credentials use JSON rather than pickle.
        with open(path, encoding="utf-8") as fh:
            self.assertIn("refresh_token", json.load(fh))

        loaded = load_credentials(path)
        self.assertEqual(loaded.refresh_token, "refresh-token")
        self.assertEqual(loaded.client_id, "client-id")

    def test_reads_legacy_pickle(self):
        import pickle

        from credentials_store import load_credentials

        path = os.path.join(self.tmp.name, "legacy.pkl")
        with open(path, "wb") as fh:
            pickle.dump(self._make_credentials(), fh)

        loaded = load_credentials(path)
        self.assertEqual(loaded.refresh_token, "refresh-token")

    def test_saves_in_place_when_rename_busy(self):
        """os.replace fails with EBUSY on a single-file bind mount.

        save_credentials must fall back to an in-place write and leave readable
        credentials without a temporary file.
        """
        import errno
        import json
        from unittest import mock

        import credentials_store
        from credentials_store import load_credentials, save_credentials

        path = os.path.join(self.tmp.name, "youtube_credentials.pkl")

        def busy_replace(src, dst):
            raise OSError(errno.EBUSY, "Device or resource busy")

        with mock.patch.object(credentials_store.os, "replace", side_effect=busy_replace):
            save_credentials(self._make_credentials(), path)

        with open(path, encoding="utf-8") as fh:
            self.assertIn("refresh_token", json.load(fh))
        self.assertFalse(os.path.exists(f"{path}.tmp"))

        loaded = load_credentials(path)
        self.assertEqual(loaded.refresh_token, "refresh-token")


class TwitchApiVideoLookupTests(unittest.TestCase):
    @staticmethod
    def _client(request_impl):
        from twitch_api import TwitchAPIClient

        client = TwitchAPIClient.__new__(TwitchAPIClient)
        client._request = request_impl
        return client

    def test_get_video_by_id_parses_created_at(self):
        from datetime import datetime

        def fake_request(endpoint, params):
            self.assertEqual(endpoint, "/videos")
            self.assertEqual(params, {"id": "12345"})
            return {"data": [{"id": "12345", "title": "T", "created_at": "2024-03-10T18:30:00Z", "duration": "2h5m"}]}

        info = self._client(fake_request).get_video_by_id("12345")

        self.assertEqual(info["video_id"], "12345")
        self.assertEqual(info["created_at"], "2024-03-10T18:30:00Z")
        expected = int(datetime.fromisoformat("2024-03-10T18:30:00+00:00").timestamp())
        self.assertEqual(info["start_time"], expected)

    def test_get_video_by_id_returns_none_when_missing(self):
        self.assertIsNone(self._client(lambda endpoint, params: {"data": []}).get_video_by_id("nope"))


class AutoPipelineStreamDateTests(unittest.TestCase):
    @staticmethod
    def _pipeline(twitch_client=None):
        from auto_pipeline import AutoPipeline

        p = AutoPipeline.__new__(AutoPipeline)
        p.twitch_client = twitch_client
        return p

    def test_uses_valid_start_time_without_api(self):
        from datetime import UTC, datetime

        ts = int(datetime(2024, 5, 1, tzinfo=UTC).timestamp())

        class BoomClient:
            def get_video_by_id(self, video_id):
                raise AssertionError("must not call the API with a valid start_time")

        dt = self._pipeline(BoomClient())._resolve_stream_date({"start_time": ts, "video_id": "1"})

        self.assertEqual((dt.year, dt.month, dt.day), (2024, 5, 1))

    def test_resolves_via_api_when_start_time_invalid(self):
        from datetime import UTC, datetime

        class FakeClient:
            def get_video_by_id(self, video_id):
                return {
                    "start_time": int(datetime(2023, 1, 15, tzinfo=UTC).timestamp()),
                    "created_at": "2023-01-15T00:00:00Z",
                }

        dt = self._pipeline(FakeClient())._resolve_stream_date({"start_time": 0, "video_id": "987654321"})

        self.assertEqual((dt.year, dt.month, dt.day), (2023, 1, 15))

    def test_falls_back_to_now_without_client(self):
        from datetime import UTC, datetime

        dt = self._pipeline(None)._resolve_stream_date({"start_time": 0, "video_id": "1"})

        self.assertEqual(dt.date(), datetime.now(UTC).date())


class YouTubeRequestBodyTests(unittest.TestCase):
    def test_includes_recording_date_when_provided(self):
        from datetime import UTC, datetime

        body, part = YouTubeUploader._build_request_body(
            title="T",
            description="D",
            tags=["a"],
            category_id="20",
            privacy_status="private",
            made_for_kids=False,
            default_language=None,
            recording_date=datetime(2024, 3, 10, 18, 30, tzinfo=UTC),
        )

        self.assertEqual(body["recordingDetails"]["recordingDate"], "2024-03-10T18:30:00Z")
        self.assertIn("recordingDetails", part.split(","))
        self.assertIn("snippet", part.split(","))

    def test_omits_recording_date_when_none(self):
        body, part = YouTubeUploader._build_request_body(
            title="T",
            description="D",
            tags=None,
            category_id="20",
            privacy_status="private",
            made_for_kids=False,
            default_language=None,
            recording_date=None,
        )

        self.assertNotIn("recordingDetails", body)
        self.assertNotIn("recordingDetails", part.split(","))


if __name__ == "__main__":
    unittest.main()
