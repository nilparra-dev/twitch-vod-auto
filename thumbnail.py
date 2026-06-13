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
        Extrae un frame del video para usar como thumbnail de YouTube.
        Por defecto toma el frame a los 5 segundos (evita pantallas de inicio negras).

        Args:
            video_path: ruta al MP4 descargado
            output_path: ruta de salida opcional (default: mismo nombre .jpg)
            timestamp: momento del video a capturar (HH:MM:SS)

        Returns:
            str: ruta del thumbnail generado, o None si fallo
        """
        if not self._check_ffmpeg():
            log.warning("[Thumbnail] ffmpeg no disponible, omitiendo thumbnail")
            return None

        if not os.path.exists(video_path):
            log.warning("[Thumbnail] Video no existe: %s", video_path)
            return None

        if not output_path:
            output_path = str(Path(video_path).with_suffix(".jpg"))

        # Evita regenerar
        if os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
            log.info("[Thumbnail] Ya existe: %s", output_path)
            return output_path

        cmd = [self.ffmpeg, "-ss", timestamp, "-i", video_path, "-vframes", "1", "-q:v", "2", "-y", output_path]

        log.info("[Thumbnail] Generando thumbnail: %s @ %s", os.path.basename(video_path), timestamp)
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if result.returncode == 0 and os.path.exists(output_path):
                log.info("[Thumbnail] OK: %s", output_path)
                return output_path
            else:
                log.warning("[Thumbnail] ffmpeg error: %s", result.stderr[:300])
                return None
        except Exception as e:
            log.warning("[Thumbnail] Excepcion: %s", e)
            return None


if __name__ == "__main__":
    import sys

    gen = ThumbnailGenerator()
    if len(sys.argv) > 1:
        print(gen.generate(sys.argv[1]))
    else:
        print("Uso: python thumbnail.py <video.mp4>")
