import logging
import os
import subprocess
from pathlib import Path

log = logging.getLogger("thumbnail")


class ThumbnailGenerator:
    def __init__(self, ffmpeg_path: str = "ffmpeg"):
        self.ffmpeg = ffmpeg_path

    def _check_ffmpeg(self):
        try:
            result = subprocess.run([self.ffmpeg, "-version"], capture_output=True, text=True, timeout=10)
            return result.returncode == 0
        except Exception:
            return False

    def generate(self, video_path: str, output_path: str = None, timestamp: str = "00:00:05") -> str:
        """
        Extract a video frame for use as a YouTube thumbnail.
        The default five-second offset avoids most black intro frames.

        Args:
            video_path: path to the downloaded MP4
            output_path: optional output path; defaults to the same name with .jpg
            timestamp: position in the video (HH:MM:SS)

        Returns:
            str: generated thumbnail path, or None on failure
        """
        if not self._check_ffmpeg():
            log.warning("[Thumbnail] ffmpeg is unavailable; skipping thumbnail generation")
            return None

        if not os.path.exists(video_path):
            log.warning("[Thumbnail] Video does not exist: %s", video_path)
            return None

        if not output_path:
            output_path = str(Path(video_path).with_suffix(".jpg"))

        # Reuse an existing thumbnail.
        if os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
            log.info("[Thumbnail] Already exists: %s", output_path)
            return output_path

        cmd = [self.ffmpeg, "-ss", timestamp, "-i", video_path, "-vframes", "1", "-q:v", "2", "-y", output_path]

        log.info("[Thumbnail] Generating thumbnail: %s @ %s", os.path.basename(video_path), timestamp)
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if result.returncode == 0 and os.path.exists(output_path):
                log.info("[Thumbnail] OK: %s", output_path)
                return output_path
            else:
                log.warning("[Thumbnail] ffmpeg error: %s", result.stderr[:300])
                return None
        except Exception as e:
            log.warning("[Thumbnail] Exception: %s", e)
            return None


if __name__ == "__main__":
    import sys

    gen = ThumbnailGenerator()
    if len(sys.argv) > 1:
        print(gen.generate(sys.argv[1]))
    else:
        print("Usage: python thumbnail.py <video.mp4>")
