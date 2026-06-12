import os
import logging
import sys
import json
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv

# Carga .env automaticamente si existe
load_dotenv()

# ==========================
# Logging profesional
# ==========================

class JSONFormatter(logging.Formatter):
    def format(self, record):
        log_obj = {
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            log_obj["exception"] = self.formatException(record.exc_info)
        return json.dumps(log_obj, ensure_ascii=False)

def setup_logging(log_level: str = "INFO", log_file: str = None, use_json: bool = False):
    level = getattr(logging, log_level.upper(), logging.INFO)
    root = logging.getLogger()
    root.setLevel(level)

    if root.handlers:
        for h in root.handlers[:]:
            root.removeHandler(h)

    if use_json or os.getenv("JSON_LOGGING", "").lower() in ("true", "1", "yes"):
        fmt = JSONFormatter()
    else:
        fmt = logging.Formatter(
            "%(asctime)s | %(levelname)-8s | %(name)-20s | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S"
        )

    console = logging.StreamHandler(sys.stdout)
    console.setLevel(level)
    console.setFormatter(fmt)
    root.addHandler(console)

    if log_file:
        os.makedirs(os.path.dirname(log_file), exist_ok=True)
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(fmt)
        root.addHandler(file_handler)

    return root

# ==========================
# Helpers
# ==========================

def sanitize_filename(name: str) -> str:
    invalid = '<>:"/\\|?*'
    for ch in invalid:
        name = name.replace(ch, '_')
    return name.strip('. ')

def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)

def fmt_duration(seconds: int) -> str:
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def merge_config(global_cfg: dict, override: dict) -> dict:
    result = global_cfg.copy()
    if not override:
        return result
    for k, v in override.items():
        if isinstance(v, dict) and k in result and isinstance(result[k], dict):
            result[k] = merge_config(result[k], v)
        else:
            result[k] = v
    return result

def get_file_size_mb(path: str) -> float:
    try:
        return os.path.getsize(path) / (1024 * 1024)
    except Exception:
        return 0.0

def parse_size_to_mb(size_str: str) -> float:
    """
    Convierte strings tipo '471.32MiB', '1.2GiB', '500KiB' a megabytes.
    """
    try:
        s = size_str.strip()
        units = {"B": 1/(1024*1024), "KiB": 1/1024, "MiB": 1, "GiB": 1024, "TiB": 1024*1024,
                 "KB": 1/1000, "MB": 1, "GB": 1000, "kB": 1/1024}
        for unit, mult in sorted(units.items(), key=lambda x: -len(x[0])):
            if s.endswith(unit):
                num = float(s[:-len(unit)].strip())
                return num * mult
        return float(s) / (1024 * 1024)
    except Exception:
        return 0.0

def parse_twitch_vod_url(url: str) -> dict:
    """
    Parsea una URL de Twitch VOD y retorna dict con channel, video_id, vod_id.
    Soporta:
      - https://www.twitch.tv/videos/123456789
      - https://www.twitch.tv/channel/videos/123456789
      - video:channel_123_456 (ya es vod_id)
      - https://twitchtracker.com/channel/streams/123456
      - https://streamscharts.com/channels/channel/streams/123456
    Retorna None si no es parseable.
    """
    import re
    url = url.strip()

    # Ya es un vod_id interno
    if url.startswith("video:"):
        parts = url.split("_")
        if len(parts) >= 3:
            return {
                "vod_id": url,
                "channel": parts[0].replace("video:", ""),
                "video_id": parts[1],
                "start_time": int(parts[2]) if parts[2].isdigit() else 0,
            }
        return {"vod_id": url, "channel": "", "video_id": "", "start_time": 0}

    # URL de twitchtracker.com
    # Ej: https://twitchtracker.com/xqc/streams/51582913581
    m_tracker = re.search(r"twitchtracker\.com/([^/]+)/streams/(\d+)", url)
    if m_tracker:
        channel = m_tracker.group(1)
        video_id = m_tracker.group(2)
        try:
            vid_int = int(video_id)
            start_time = vid_int if vid_int < 10_000_000_000 else 0
        except ValueError:
            start_time = 0
        return {
            "vod_id": f"video:{channel}_{video_id}_{start_time}",
            "channel": channel,
            "video_id": video_id,
            "start_time": start_time,
            "tracker_url": url,
            "download_url": f"https://www.twitch.tv/videos/{video_id}",
        }

    # URL de streamscharts.com
    # Ej: https://streamscharts.com/channels/lirik/streams/51579711693
    m_charts = re.search(r"streamscharts\.com/channels/([^/]+)/streams/(\d+)", url)
    if m_charts:
        channel = m_charts.group(1)
        video_id = m_charts.group(2)
        try:
            start_time = int(video_id)
        except ValueError:
            start_time = 0
        return {
            "vod_id": f"video:{channel}_{video_id}_{start_time}",
            "channel": channel,
            "video_id": video_id,
            "start_time": start_time,
            "tracker_url": url,
            "download_url": f"https://www.twitch.tv/videos/{video_id}",
        }

    # URL de twitch
    m = re.search(r"twitch\.tv/(?:[^/]+/)?videos/(\d+)", url)
    if m:
        video_id = m.group(1)
        # Twitch video IDs son timestamps en segundos (aprox, siempre < 10 digitos)
        try:
            vid_int = int(video_id)
            start_time = vid_int if vid_int < 10_000_000_000 else 0
        except ValueError:
            start_time = 0
        return {
            "vod_id": f"video:manual_{video_id}_{start_time}",
            "channel": "manual",
            "video_id": video_id,
            "start_time": start_time,
            "download_url": f"https://www.twitch.tv/videos/{video_id}",
        }

    # Intentar extraer canal de URL tipo twitch.tv/channel
    m2 = re.search(r"twitch\.tv/([^/]+)", url)
    if m2:
        channel = m2.group(1)
        return {
            "vod_id": None,
            "channel": channel,
            "video_id": None,
            "start_time": 0,
        }

    return None

if __name__ == "__main__":
    log = setup_logging("DEBUG", "logs/test.log")
    log.info("Test de logging exitoso")
    print("sanitize:", sanitize_filename("video:canal_123_456?*"))
