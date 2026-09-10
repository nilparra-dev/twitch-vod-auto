"""Resolve Twitch VOD inputs to playable HLS playlists without downloading media.

The hidden-VOD path calculation and CDN probing follow twitch-dlp's MIT-licensed
implementation: https://github.com/DmitryScaletta/twitch-dlp
"""

import concurrent.futures
import hashlib
import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from urllib.parse import urlencode

import requests

TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"
VOD_DOMAINS = (
    "https://ds0h3roq6wcgc.cloudfront.net",
    "https://d2nvs31859zcd8.cloudfront.net",
    "https://d2aba1wr3818hz.cloudfront.net",
    "https://d3c27h4odz752x.cloudfront.net",
    "https://dgeft87wbj63p.cloudfront.net",
    "https://d1m7jfoe9zdc1j.cloudfront.net",
    "https://d3vd9lfkzbru3h.cloudfront.net",
    "https://ddacn6pr5v0tl.cloudfront.net",
    "https://d3aqoihi2n8ty8.cloudfront.net",
    "https://d3fi1amfgojobc.cloudfront.net",
    "https://d2vi6trrdongqn.cloudfront.net",
    "https://d3stzm2eumvgb4.cloudfront.net",
)
FORMATS = (
    ("Source", "chunked", None, None),
    ("1440p60", "1440p60", 1440, 60),
    ("1440p30", "1440p30", 1440, 30),
    ("1080p60", "1080p60", 1080, 60),
    ("1080p30", "1080p30", 1080, 30),
    ("720p60", "720p60", 720, 60),
    ("720p30", "720p30", 720, 30),
    ("480p30", "480p30", 480, 30),
    ("360p30", "360p30", 360, 30),
    ("160p30", "160p30", 160, 30),
    ("Audio", "audio_only", None, None),
)

CANONICAL_RE = re.compile(
    r"^video:(?P<channel>\w+)_(?P<stream_id>\d+)_(?P<timestamp>\d+)$",
    re.IGNORECASE,
)
TWITCH_VIDEO_RE = re.compile(
    r"(?:https?://(?:www\.)?twitch\.tv/(?:[^/]+/)?videos/)?(?P<id>\d+)$",
    re.IGNORECASE,
)
TRACKER_PATTERNS = (
    (
        "twitchtracker",
        re.compile(
            r"^https?://(?:www\.)?twitchtracker\.com/(?P<channel>[^/]+)/streams/(?P<id>\d+)/?$",
            re.IGNORECASE,
        ),
    ),
    (
        "streamscharts",
        re.compile(
            r"^https?://(?:www\.)?streamscharts\.com/channels/(?P<channel>[^/]+)/streams/(?P<id>\d+)/?$",
            re.IGNORECASE,
        ),
    ),
    (
        "sullygnome",
        re.compile(
            r"^https?://(?:www\.)?sullygnome\.com/channel/(?P<channel>[^/]+)/(?:[^/]+/)?stream/(?P<id>\d+)/?$",
            re.IGNORECASE,
        ),
    ),
)


class M3U8ResolveError(ValueError):
    pass


@dataclass(frozen=True)
class PlaylistFormat:
    id: str
    url: str
    height: int | None = None
    fps: int | None = None


class M3U8Resolver:
    def __init__(self, session=None, vod_domains=None, timeout: int = 12):
        self.session = session or requests.Session()
        self.vod_domains = tuple(vod_domains or VOD_DOMAINS)
        self.timeout = timeout
        self.session.headers.update({"User-Agent": "twitch-vod-auto/1.0"})

    def resolve(self, raw_input: str) -> dict:
        value = (raw_input or "").strip()
        if not value:
            raise M3U8ResolveError("Enter an ID, URL, or video:... target.")

        canonical = CANONICAL_RE.fullmatch(value)
        if canonical:
            return self._resolve_hidden(
                canonical.group("channel"),
                canonical.group("stream_id"),
                int(canonical.group("timestamp")),
                source="canonical",
            )

        for provider, pattern in TRACKER_PATTERNS:
            match = pattern.fullmatch(value)
            if match:
                channel = match.group("channel").lower()
                stream_id = match.group("id")
                timestamp = self._find_stream_timestamp(channel, stream_id)
                return self._resolve_hidden(channel, stream_id, timestamp, source=provider)

        public_vod = TWITCH_VIDEO_RE.fullmatch(value)
        if public_vod:
            video_id = public_vod.group("id")
            if len(video_id) > 10:
                raise M3U8ResolveError(
                    "A hidden stream ID is not enough on its own. Paste a TwitchTracker, "
                    "Streams Charts, or SullyGnome URL, or use video:channel_streamId_timestamp."
                )
            return self._resolve_public(video_id)

        raise M3U8ResolveError(
            "Unsupported input. Use a Twitch or tracker URL, a public VOD ID, or video:channel_streamId_timestamp."
        )

    @staticmethod
    def _full_vod_path(channel: str, stream_id: str, timestamp: int) -> tuple[str, str]:
        vod_path = f"{channel}_{stream_id}_{timestamp}"
        path_hash = hashlib.sha1(vod_path.encode()).hexdigest()[:20]
        return vod_path, f"{path_hash}_{vod_path}"

    def _url_exists(self, url: str) -> bool:
        try:
            response = self.session.head(url, timeout=self.timeout, allow_redirects=True)
            return response.ok
        except requests.RequestException:
            return False

    def _resolve_hidden(self, channel: str, stream_id: str, timestamp: int, source: str) -> dict:
        if timestamp <= 0:
            raise M3U8ResolveError("The stream start time is invalid.")

        vod_path, full_vod_path = self._full_vod_path(channel, stream_id, timestamp)

        def source_url(domain: str) -> tuple[str, bool]:
            url = f"{domain}/{full_vod_path}/chunked/index-dvr.m3u8"
            return domain, self._url_exists(url)

        with concurrent.futures.ThreadPoolExecutor(max_workers=len(self.vod_domains)) as executor:
            domain_results = list(executor.map(source_url, self.vod_domains))

        domain = next((item[0] for item in domain_results if item[1]), None)
        if not domain:
            raise M3U8ResolveError(
                "The VOD was not found on known Twitch CDN domains. It may have expired, "
                "been deleted, or have a different start time."
            )

        def probe_format(item) -> PlaylistFormat | None:
            label, path, height, fps = item
            url = f"{domain}/{full_vod_path}/{path}/index-dvr.m3u8"
            if self._url_exists(url):
                return PlaylistFormat(label, url, height, fps)
            return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=len(FORMATS)) as executor:
            formats = [item for item in executor.map(probe_format, FORMATS) if item]

        return {
            "kind": "hidden",
            "source": source,
            "channel": channel,
            "stream_id": stream_id,
            "video_id": None,
            "started_at": datetime.fromtimestamp(timestamp, tz=UTC).isoformat(),
            "canonical_target": f"video:{vod_path}",
            "formats": [asdict(item) for item in formats],
        }

    def _find_stream_timestamp(self, channel: str, stream_id: str) -> int:
        """Find stream metadata through SullyGnome, as twitch-dlp does first."""
        try:
            response = self.session.get(f"https://sullygnome.com/api/standardsearch/{channel}", timeout=self.timeout)
            response.raise_for_status()
            channel_item = next(
                (
                    item
                    for item in response.json()
                    if item.get("itemtype") == 1 and str(item.get("siteurl", "")).lower() == channel.lower()
                ),
                None,
            )
            if not channel_item:
                raise M3U8ResolveError(f'Channel "{channel}" was not found on SullyGnome.')

            channel_id = int(channel_item["value"])
            start = 0
            page = 1
            while True:
                url = (
                    "https://sullygnome.com/api/tables/channeltables/streams/"
                    f"365/{channel_id}/%20/{page}/1/desc/{start}/100"
                )
                response = self.session.get(url, timeout=self.timeout)
                response.raise_for_status()
                payload = response.json()
                stream = next(
                    (item for item in payload.get("data", []) if str(item.get("streamId")) == stream_id),
                    None,
                )
                if stream:
                    return self._parse_timestamp(stream["startDateTime"])

                start += 100
                page += 1
                if start >= int(payload.get("recordsFiltered", 0)):
                    break
        except M3U8ResolveError:
            raise
        except (KeyError, TypeError, ValueError, requests.RequestException) as exc:
            raise M3U8ResolveError(f"Could not retrieve the stream start time: {exc}") from exc

        raise M3U8ResolveError(
            "The stream was not found in SullyGnome's one-year history. Try a video:channel_streamId_timestamp target."
        )

    @staticmethod
    def _parse_timestamp(value: str) -> int:
        normalized = str(value).strip().replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return int(parsed.timestamp())

    def _resolve_public(self, video_id: str) -> dict:
        query = """query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isLive) { value signature } videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isVod) { value signature } }"""
        try:
            response = self.session.post(
                "https://gql.twitch.tv/gql",
                json={
                    "operationName": "PlaybackAccessToken_Template",
                    "query": query,
                    "variables": {
                        "isLive": False,
                        "login": "",
                        "isVod": True,
                        "vodID": video_id,
                        "playerType": "site",
                        "platform": "web",
                    },
                },
                headers={"Client-ID": TWITCH_WEB_CLIENT_ID},
                timeout=self.timeout,
            )
            response.raise_for_status()
            token = response.json().get("data", {}).get("videoPlaybackAccessToken")
            if not token:
                raise M3U8ResolveError("Twitch did not grant playback access to this VOD.")

            params = urlencode(
                {
                    "allow_source": "true",
                    "allow_audio_only": "true",
                    "allow_spectre": "true",
                    "include_unavailable": "true",
                    "player": "twitchweb",
                    "playlist_include_framerate": "true",
                    "sig": token["signature"],
                    "supported_codecs": "av1,h265,h264",
                    "token": token["value"],
                }
            )
            manifest_url = f"https://usher.ttvnw.net/vod/{video_id}.m3u8?{params}"
            manifest = self.session.get(manifest_url, timeout=self.timeout)
            manifest.raise_for_status()
            formats = self._parse_master_manifest(manifest.text)
            if not formats:
                raise M3U8ResolveError("Twitch returned a manifest with no playable qualities.")
            return {
                "kind": "public",
                "source": "twitch",
                "channel": None,
                "stream_id": None,
                "video_id": video_id,
                "started_at": None,
                "canonical_target": None,
                "master_url": manifest_url,
                "formats": [asdict(item) for item in formats],
            }
        except M3U8ResolveError:
            raise
        except (KeyError, TypeError, requests.RequestException) as exc:
            raise M3U8ResolveError(f"Could not resolve the Twitch VOD: {exc}") from exc

    @staticmethod
    def _parse_master_manifest(manifest: str) -> list[PlaylistFormat]:
        formats = []
        pending = None
        for raw_line in manifest.splitlines():
            line = raw_line.strip()
            if line.startswith("#EXT-X-STREAM-INF:"):
                height_match = re.search(r"RESOLUTION=\d+x(\d+)", line)
                fps_match = re.search(r"FRAME-RATE=([\d.]+)", line)
                name_match = re.search(r'VIDEO="([^"]+)"', line)
                pending = {
                    "id": name_match.group(1) if name_match else "HLS",
                    "height": int(height_match.group(1)) if height_match else None,
                    "fps": round(float(fps_match.group(1))) if fps_match else None,
                }
            elif pending and line and not line.startswith("#"):
                formats.append(PlaylistFormat(url=line, **pending))
                pending = None
        return formats
