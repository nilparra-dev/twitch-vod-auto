import logging
import os
from datetime import datetime

import requests

log = logging.getLogger("twitch_api")


class TwitchAPIClient:
    """
    Client for the official Twitch Helix API.
    Uses a client ID and secret to obtain an app access token.
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
        log.info("[TwitchAPI] Token acquired; expires in %ds", data.get("expires_in", 0))
        return self._token

    def _request(self, endpoint: str, params: dict = None) -> dict:
        self._get_app_token()
        url = f"{self.BASE_URL}{endpoint}"
        resp = self.session.get(url, params=params, timeout=30)
        if resp.status_code == 401:
            # Refresh an expired token once.
            self._token = None
            self._get_app_token()
            resp = self.session.get(url, params=params, timeout=30)
        resp.raise_for_status()
        return resp.json()

    def get_user_id(self, login: str) -> str:
        """Return the user ID for a channel login."""
        data = self._request("/users", {"login": login.lower()})
        users = data.get("data", [])
        if not users:
            raise ValueError(f"Channel not found in the Twitch API: {login}")
        return users[0]["id"]

    def get_videos(self, user_id: str, limit: int = 10, period: str = "month") -> list[dict]:
        """
        Return videos and VODs for a channel.
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
        """Return one VOD by ID, or None when it does not exist.

        `created_at` is the original broadcast time. `start_time` contains the
        same instant as a UTC Unix timestamp.
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
        Return the latest archived VODs for a channel.
        """
        user_id = self.get_user_id(login)
        videos = self.get_videos(user_id, limit=limit, period="month")

        results = []
        for v in videos:
            # Parse Twitch's duration format, such as 4h32m15s or PT4H32M15S.
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
        """Convert a Twitch duration to seconds."""
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
        print("TWITCH_CLIENT_ID is not configured")
        exit(1)
    login = input("Channel login: ").strip().lower()
    try:
        vods = client.get_recent_archives(login, limit=5)
        for v in vods:
            print(f"- {v['video_id']} | {v['title']} | {v['duration_sec']}s")
    except Exception as e:
        print(f"Error: {e}")
