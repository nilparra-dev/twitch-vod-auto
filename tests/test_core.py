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


if __name__ == "__main__":
    unittest.main()
