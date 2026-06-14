import logging
import os
from datetime import datetime

import requests

log = logging.getLogger("twitch_api")


class TwitchAPIClient:
    """
    Cliente para la API oficial de Twitch (Helix).
    Usa Client ID + Client Secret para obtener App Access Token.
    """

    BASE_URL = "https://api.twitch.tv/helix"

    def __init__(self, client_id: str = None, client_secret: str = None):
        self.client_id = client_id or os.getenv("TWITCH_CLIENT_ID")
        self.client_secret = client_secret or os.getenv("TWITCH_CLIENT_SECRET")
        self._token = None
        self.session = requests.Session()
        self.session.headers.update({"Client-ID": self.client_id or "", "Accept": "application/json"})

    def _get_app_token(self) -> str:
        if self._token:
            return self._token
        resp = requests.post(
            "https://id.twitch.tv/oauth2/token",
            data={"client_id": self.client_id, "client_secret": self.client_secret, "grant_type": "client_credentials"},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        self._token = data["access_token"]
        self.session.headers["Authorization"] = f"Bearer {self._token}"
        log.info("[TwitchAPI] Token obtenido (expira en %ds)", data.get("expires_in", 0))
        return self._token

    def _request(self, endpoint: str, params: dict = None) -> dict:
        self._get_app_token()
        url = f"{self.BASE_URL}{endpoint}"
        resp = self.session.get(url, params=params, timeout=30)
        if resp.status_code == 401:
            # Token expirado, refrescar
            self._token = None
            self._get_app_token()
            resp = self.session.get(url, params=params, timeout=30)
        resp.raise_for_status()
        return resp.json()

    def get_user_id(self, login: str) -> str:
        """Obtiene el user_id de un canal por su login."""
        data = self._request("/users", {"login": login.lower()})
        users = data.get("data", [])
        if not users:
            raise ValueError(f"Canal no encontrado en Twitch API: {login}")
        return users[0]["id"]

    def get_videos(self, user_id: str, limit: int = 10, period: str = "month") -> list[dict]:
        """
        Obtiene videos/VODs de un canal.
        period: all, day, week, month
        type: all, upload, archive, highlight
        """
        data = self._request("/videos", {"user_id": user_id, "first": limit, "period": period, "type": "archive"})
        return data.get("data", [])

    @staticmethod
    def _created_at_to_epoch(created_at: str) -> int:
        try:
            dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            return int(dt.timestamp())
        except Exception:
            return 0

    def get_video_by_id(self, video_id: str) -> dict | None:
        """Obtiene un VOD concreto por su id. Devuelve None si no existe.

        `created_at` es la fecha real de emision del stream; `start_time` es ese
        instante en epoch UTC.
        """
        data = self._request("/videos", {"id": video_id})
        videos = data.get("data", [])
        if not videos:
            return None
        v = videos[0]
        created = v.get("created_at", "")
        return {
            "video_id": v.get("id", video_id),
            "title": v.get("title", ""),
            "created_at": created,
            "start_time": self._created_at_to_epoch(created),
            "duration_sec": self._parse_duration(v.get("duration", "0s")),
        }

    def get_recent_archives(self, login: str, limit: int = 10) -> list[dict]:
        """
        Obtiene los ultimos VODs (archives) de un canal.
        Retorna lista de dicts con: id, title, created_at, duration, url, etc.
        """
        user_id = self.get_user_id(login)
        videos = self.get_videos(user_id, limit=limit, period="month")

        results = []
        for v in videos:
            # Parsear duracion ISO 8601 (ej: "4h32m15s" o "PT4H32M15S")
            duration_raw = v.get("duration", "0s")
            duration_sec = self._parse_duration(duration_raw)

            created = v.get("created_at", "")
            try:
                dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
                start_timestamp = int(dt.timestamp())
            except Exception:
                start_timestamp = 0

            results.append(
                {
                    "vod_id": f"video:{login}_{v['id']}_{start_timestamp}",
                    "video_id": v["id"],
                    "channel": login,
                    "title": v.get("title", ""),
                    "url": v.get("url", ""),
                    "created_at": created,
                    "start_time": start_timestamp,
                    "duration_sec": duration_sec,
                    "source": "twitch_api",
                }
            )
        return results

    @staticmethod
    def _parse_duration(raw: str) -> int:
        """Convierte duracion ISO 8601 de Twitch a segundos."""
        raw = raw.upper().replace("PT", "")
        total = 0
        import re

        hours = re.search(r"(\d+)H", raw)
        minutes = re.search(r"(\d+)M", raw)
        seconds = re.search(r"(\d+)S", raw)
        if hours:
            total += int(hours.group(1)) * 3600
        if minutes:
            total += int(minutes.group(1)) * 60
        if seconds:
            total += int(seconds.group(1))
        return total


if __name__ == "__main__":
    client = TwitchAPIClient()
    if not client.client_id:
        print("TWITCH_CLIENT_ID no configurado")
        exit(1)
    login = input("Login de canal: ").strip().lower()
    try:
        vods = client.get_recent_archives(login, limit=5)
        for v in vods:
            print(f"- {v['video_id']} | {v['title']} | {v['duration_sec']}s")
    except Exception as e:
        print(f"Error: {e}")
