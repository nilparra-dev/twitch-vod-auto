import requests
from bs4 import BeautifulSoup
import re
import time
import logging
import concurrent.futures
from datetime import datetime, timezone
from urllib.parse import urljoin
from utils import merge_config
from twitch_api import TwitchAPIClient

log = logging.getLogger("monitor")

class VodMonitor:
    def __init__(self, config, db):
        self.config = config
        self.db = db
        self.global_cfg = config["twitch"]["global"]
        self.channels = config["twitch"]["channels"]
        self.sources = config["monitoring"]["sources"]
        self.delay = self.global_cfg.get("request_delay_seconds", 2.5)
        self.max_retries = self.global_cfg.get("max_retries", 3)
        self.use_twitch_api = config.get("twitch_api", {}).get("enabled", True)

        self.twitch_client = None
        if self.use_twitch_api:
            try:
                self.twitch_client = TwitchAPIClient()
                if not self.twitch_client.client_id:
                    log.warning("[Monitor] TWITCH_CLIENT_ID no configurado, deshabilitando Twitch API")
                    self.twitch_client = None
            except Exception as e:
                log.warning("[Monitor] No se pudo inicializar Twitch API: %s", e)
                self.twitch_client = None

        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
            "DNT": "1",
            "Connection": "keep-alive",
        })

        # Proxy support
        proxy = config.get("proxy")
        if proxy:
            self.session.proxies.update({"http": proxy, "https": proxy})

    def _fetch(self, url: str):
        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(self.delay)
                resp = self.session.get(url, timeout=30)
                resp.raise_for_status()
                return resp.text
            except requests.exceptions.RequestException as e:
                log.warning("[fetch] intento %d/%d fallo para %s: %s", attempt, self.max_retries, url, e)
                if attempt == self.max_retries:
                    raise
                time.sleep(self.delay * attempt)
        return None

    def _parse_twitchtracker(self, channel: str):
        url = f"https://twitchtracker.com/{channel}/streams"
        log.info("[TT] Consultando %s", url)
        try:
            html = self._fetch(url)
        except Exception as e:
            log.error("[TT] Error %s: %s", channel, e)
            return []

        soup = BeautifulSoup(html, "html.parser")
        streams = []

        for row in soup.select("table#streams-table tbody tr"):
            cols = row.find_all("td")
            if len(cols) < 3:
                continue

            link_tag = cols[0].find("a", href=re.compile(rf"/{channel}/streams/\d+"))
            if not link_tag:
                continue

            href = link_tag.get("href", "")
            match = re.search(rf"/{channel}/streams/(\d+)", href)
            if not match:
                continue

            video_id = match.group(1)
            date_text = cols[1].get_text(strip=True)
            time_text = cols[2].get_text(strip=True) if len(cols) > 2 else "00:00"

            try:
                dt_str = f"{date_text} {time_text}"
                dt = datetime.strptime(dt_str, "%b %d, %Y %H:%M")
                dt = dt.replace(tzinfo=timezone.utc)
                start_timestamp = int(dt.timestamp())
            except ValueError:
                start_timestamp = self._approx_timestamp_from_video_id(video_id)

            vod_id = f"video:{channel}_{video_id}_{start_timestamp}"
            tracker_url = f"https://twitchtracker.com/{channel}/streams/{video_id}"
            streams.append({
                "vod_id": vod_id,
                "video_id": video_id,
                "source": "twitchtracker",
                "start_time": start_timestamp,
                "channel": channel,
                "tracker_url": tracker_url,
                "download_url": f"https://www.twitch.tv/videos/{video_id}",
            })

        log.info("[TT] %s -> %d streams", channel, len(streams))
        return streams

    def _parse_streamscharts(self, channel: str):
        url = f"https://streamscharts.com/channels/{channel}/streams"
        log.info("[SC] Consultando %s", url)
        try:
            html = self._fetch(url)
        except Exception as e:
            log.error("[SC] Error %s: %s", channel, e)
            return []

        soup = BeautifulSoup(html, "html.parser")
        streams = []

        for link in soup.find_all("a", href=re.compile(rf"/channels/{channel}/streams/\d+")):
            href = link.get("href", "")
            match = re.search(rf"/channels/{channel}/streams/(\d+)", href)
            if not match:
                continue

            video_id = match.group(1)
            parent = link.find_parent(["tr", "div", "li"])
            start_timestamp = self._approx_timestamp_from_video_id(video_id)
            if parent:
                text = parent.get_text(" ", strip=True)
                dt = self._extract_datetime_from_text(text)
                if dt:
                    start_timestamp = int(dt.timestamp())

            vod_id = f"video:{channel}_{video_id}_{start_timestamp}"
            tracker_url = f"https://streamscharts.com/channels/{channel}/streams/{video_id}"
            streams.append({
                "vod_id": vod_id,
                "video_id": video_id,
                "source": "streamscharts",
                "start_time": start_timestamp,
                "channel": channel,
                "tracker_url": tracker_url,
                "download_url": f"https://www.twitch.tv/videos/{video_id}",
            })

        seen = {}
        for s in streams:
            if s["video_id"] not in seen or s["source"] == "twitchtracker":
                seen[s["video_id"]] = s
        unique = list(seen.values())
        log.info("[SC] %s -> %d streams", channel, len(unique))
        return unique

    def _approx_timestamp_from_video_id(self, video_id: str) -> int:
        try:
            return int(video_id)
        except ValueError:
            return int(datetime.now(timezone.utc).timestamp())

    def _extract_datetime_from_text(self, text: str):
        patterns = [
            (r"(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})", "%Y-%m-%d %H:%M"),
            (r"(\w{3}\s+\d{1,2},?\s+\d{4})\s+(\d{1,2}:\d{2})", "%b %d, %Y %H:%M"),
            (r"(\d{2}/\d{2}/\d{4})\s+(\d{2}:\d{2})", "%d/%m/%Y %H:%M"),
        ]
        for pattern, fmt in patterns:
            m = re.search(pattern, text)
            if m:
                try:
                    dt = datetime.strptime(m.group(0), fmt)
                    return dt.replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
        return None

    def _check_twitch_api(self, channel: str):
        """Fuente primaria: Twitch API oficial."""
        if not self.twitch_client:
            return []
        try:
            vods = self.twitch_client.get_recent_archives(channel, limit=10)
            # Normalizar al formato interno
            results = []
            for v in vods:
                results.append({
                    "vod_id": v["vod_id"],
                    "video_id": v["video_id"],
                    "source": "twitch_api",
                    "start_time": v["start_time"],
                    "channel": channel,
                    "download_url": v.get("url") or f"https://www.twitch.tv/videos/{v['video_id']}",
                })
            log.info("[TwitchAPI] %s -> %d streams", channel, len(results))
            return results
        except Exception as e:
            log.error("[TwitchAPI] Error %s: %s", channel, e)
            return []

    def check_channel(self, channel_cfg: dict):
        channel = channel_cfg["name"].lower()
        all_streams = []

        # 1. Fuente primaria: Twitch API
        api_streams = self._check_twitch_api(channel)
        all_streams.extend(api_streams)

        # 2. Fallback: trackers (solo si no hay resultados de API o para complementar)
        if "twitchtracker" in self.sources:
            all_streams.extend(self._parse_twitchtracker(channel))

        if "streamscharts" in self.sources:
            all_streams.extend(self._parse_streamscharts(channel))

        # dedup final por video_id, preferir twitch_api > twitchtracker > streamscharts
        priority = {"twitch_api": 0, "twitchtracker": 1, "streamscharts": 2}
        by_id = {}
        for s in all_streams:
            vid = s["video_id"]
            current_prio = priority.get(by_id[vid]["source"], 99) if vid in by_id else 99
            new_prio = priority.get(s["source"], 99)
            if vid not in by_id or new_prio < current_prio:
                by_id[vid] = s

        new_streams = []
        for s in by_id.values():
            if not self.db.is_processed(s["vod_id"]):
                new_streams.append(s)
                self.db.add_vod(
                    s["vod_id"],
                    s["channel"],
                    s["video_id"],
                    s["source"],
                    tracker_url=s.get("tracker_url"),
                    download_url=s.get("download_url"),
                )
                self.db.increment_stat(s["channel"], "detected")

        log.info("[Monitor] %s: %d total, %d nuevos", channel, len(by_id), len(new_streams))
        return new_streams

    def check_all_channels(self):
        log.info("[Monitor] Iniciando chequeo de %d canales", len(self.channels))
        all_new = []

        parallel = self.config["app"].get("parallel_monitor", True)
        if parallel and len(self.channels) > 1:
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
                futures = {executor.submit(self.check_channel, ch): ch for ch in self.channels}
                for future in concurrent.futures.as_completed(futures):
                    try:
                        result = future.result()
                        all_new.extend(result)
                    except Exception as e:
                        log.error("[Monitor] Error en hilo: %s", e)
        else:
            for ch in self.channels:
                try:
                    result = self.check_channel(ch)
                    all_new.extend(result)
                except Exception as e:
                    log.error("[Monitor] Error chequeando %s: %s", ch["name"], e)

        log.info("[Monitor] Total nuevos streams detectados: %d", len(all_new))
        return all_new

if __name__ == "__main__":
    import json
    from db import PipelineDB
    with open("config.json", "r", encoding="utf-8") as f:
        cfg = json.load(f)
    db = PipelineDB(cfg["monitoring"]["db_path"])
    mon = VodMonitor(cfg, db)
    nuevos = mon.check_all_channels()
    for s in nuevos:
        print(s)
