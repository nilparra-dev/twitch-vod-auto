import { createHash } from "node:crypto";

import type {
  ParsedInput,
  PlaylistFormat,
  ResolveOptions,
  ResolveResult,
  TrackerProvider,
} from "./types.js";

const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const DEFAULT_TIMEOUT_MS = 12_000;

const VOD_DOMAINS = [
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
] as const;

const FORMAT_PATHS = [
  { id: "Source", path: "chunked", height: null, fps: null },
  { id: "1440p60", path: "1440p60", height: 1440, fps: 60 },
  { id: "1440p30", path: "1440p30", height: 1440, fps: 30 },
  { id: "1080p60", path: "1080p60", height: 1080, fps: 60 },
  { id: "1080p30", path: "1080p30", height: 1080, fps: 30 },
  { id: "720p60", path: "720p60", height: 720, fps: 60 },
  { id: "720p30", path: "720p30", height: 720, fps: 30 },
  { id: "480p30", path: "480p30", height: 480, fps: 30 },
  { id: "360p30", path: "360p30", height: 360, fps: 30 },
  { id: "160p30", path: "160p30", height: 160, fps: 30 },
  { id: "Audio", path: "audio_only", height: null, fps: null },
] as const;

const TRACKER_PATTERNS: ReadonlyArray<{
  provider: TrackerProvider;
  pattern: RegExp;
}> = [
  {
    provider: "twitchtracker",
    pattern: /^https?:\/\/(?:www\.)?twitchtracker\.com\/(?<channel>[^/]+)\/streams\/(?<id>\d+)\/?$/i,
  },
  {
    provider: "streamscharts",
    pattern: /^https?:\/\/(?:www\.)?streamscharts\.com\/channels\/(?<channel>[^/]+)\/streams\/(?<id>\d+)\/?$/i,
  },
  {
    provider: "sullygnome",
    pattern: /^https?:\/\/(?:www\.)?sullygnome\.com\/channel\/(?<channel>[^/]+)\/(?:[^/]+\/)?stream\/(?<id>\d+)\/?$/i,
  },
];

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

export function parseInput(rawInput: string): ParsedInput {
  const input = rawInput.trim();
  const canonical = input.match(/^video:(?<channel>\w+)_(?<id>\d+)_(?<timestamp>\d+)$/i);
  if (canonical?.groups) {
    const { channel, id, timestamp } = canonical.groups;
    if (!channel || !id || !timestamp) throw new ResolveError("Incomplete video: target.");
    return {
      kind: "hidden",
      channel,
      streamId: id,
      timestamp: Number.parseInt(timestamp, 10),
      source: "canonical",
    };
  }

  for (const { provider, pattern } of TRACKER_PATTERNS) {
    const match = input.match(pattern);
    if (match?.groups) {
      const { channel, id } = match.groups;
      if (!channel || !id) throw new ResolveError("Incomplete tracker URL.");
      return {
        kind: "tracker",
        channel: channel.toLowerCase(),
        streamId: id,
        provider,
      };
    }
  }

  const twitchUrl = input.match(/^https?:\/\/(?:www\.)?twitch\.tv\/(?:[^/]+\/)?videos\/(?<id>\d+)\/?$/i);
  const twitchVideoId = twitchUrl?.groups?.id;
  if (twitchVideoId) return { kind: "public", videoId: twitchVideoId };

  if (/^\d+$/.test(input)) {
    return input.length > 10 ? { kind: "stream-id", streamId: input } : { kind: "public", videoId: input };
  }

  throw new ResolveError(
    "Unsupported input. Use a Twitch or tracker URL, an ID, or video:channel_streamId_timestamp.",
  );
}

export function buildFullVodPath(channel: string, streamId: string, timestamp: number): string {
  const vodPath = `${channel}_${streamId}_${timestamp}`;
  const hash = createHash("sha1").update(vodPath).digest("hex").slice(0, 20);
  return `${hash}_${vodPath}`;
}

export function parseMasterManifest(manifest: string): PlaylistFormat[] {
  const formats: PlaylistFormat[] = [];
  let pending: Omit<PlaylistFormat, "url"> | null = null;

  for (const rawLine of manifest.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const height = line.match(/RESOLUTION=\d+x(\d+)/)?.[1];
      const fps = line.match(/FRAME-RATE=([\d.]+)/)?.[1];
      const name = line.match(/VIDEO="([^"]+)"/)?.[1];
      pending = {
        id: name ?? "HLS",
        height: height ? Number.parseInt(height, 10) : null,
        fps: fps ? Math.round(Number.parseFloat(fps)) : null,
      };
    } else if (pending && line && !line.startsWith("#")) {
      formats.push({ ...pending, url: line });
      pending = null;
    }
  }
  return formats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function urlExists(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await request(url, { method: "HEAD", redirect: "follow" }, timeoutMs);
    return response.ok;
  } catch {
    return false;
  }
}

async function findStreamTimestamp(channel: string, streamId: string, timeoutMs: number): Promise<number> {
  let response = await request(
    `https://sullygnome.com/api/standardsearch/${encodeURIComponent(channel)}`,
    {},
    timeoutMs,
  );
  if (!response.ok) throw new ResolveError(`SullyGnome returned HTTP ${response.status}.`);
  const search: unknown = await response.json();
  if (!Array.isArray(search)) throw new ResolveError("SullyGnome returned an unexpected response.");

  const channelItem = search.find(
    (item) =>
      isRecord(item) &&
      item.itemtype === 1 &&
      getString(item, "siteurl")?.toLowerCase() === channel.toLowerCase(),
  );
  if (!isRecord(channelItem) || typeof channelItem.value !== "number") {
    throw new ResolveError(`Channel "${channel}" was not found on SullyGnome.`);
  }

  let start = 0;
  let page = 1;
  while (true) {
    const url = `https://sullygnome.com/api/tables/channeltables/streams/365/${channelItem.value}/%20/${page}/1/desc/${start}/100`;
    response = await request(url, {}, timeoutMs);
    if (!response.ok) throw new ResolveError(`SullyGnome returned HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new ResolveError("SullyGnome returned an unexpected stream history response.");
    }

    const stream = payload.data.find(
      (item) => isRecord(item) && String(item.streamId) === streamId,
    );
    if (isRecord(stream)) {
      const startedAt = getString(stream, "startDateTime");
      if (!startedAt) throw new ResolveError("The stream has no start time.");
      const timestamp = Math.floor(Date.parse(startedAt) / 1000);
      if (!Number.isFinite(timestamp) || timestamp <= 0) throw new ResolveError("The stream start time is invalid.");
      return timestamp;
    }

    const total = typeof payload.recordsFiltered === "number" ? payload.recordsFiltered : 0;
    start += 100;
    page += 1;
    if (start >= total) break;
  }

  throw new ResolveError(
    "The stream was not found in the one-year history. Use video:channel_streamId_timestamp if you know the exact start time.",
  );
}

async function resolveHidden(
  channel: string,
  streamId: string,
  timestamp: number,
  source: TrackerProvider | "canonical" | "stream-id",
  timeoutMs: number,
): Promise<ResolveResult> {
  const fullPath = buildFullVodPath(channel, streamId, timestamp);
  const domainChecks = await Promise.all(
    VOD_DOMAINS.map(async (domain) => ({
      domain,
      available: await urlExists(`${domain}/${fullPath}/chunked/index-dvr.m3u8`, timeoutMs),
    })),
  );
  const domain = domainChecks.find((item) => item.available)?.domain;
  if (!domain) {
    throw new ResolveError(
      "The VOD was not found on known Twitch CDN domains. It may have expired, been deleted, or have a different start time.",
    );
  }

  const checks = await Promise.all(
    FORMAT_PATHS.map(async (format): Promise<PlaylistFormat | null> => {
      const url = `${domain}/${fullPath}/${format.path}/index-dvr.m3u8`;
      return (await urlExists(url, timeoutMs))
        ? { id: format.id, url, height: format.height, fps: format.fps }
        : null;
    }),
  );
  const formats = checks.filter((format): format is PlaylistFormat => format !== null);
  if (formats.length === 0) throw new ResolveError("The VOD path exists, but no playable quality was found.");

  return {
    kind: "hidden",
    source,
    channel,
    streamId,
    startedAt: new Date(timestamp * 1000).toISOString(),
    canonicalTarget: `video:${channel}_${streamId}_${timestamp}`,
    formats,
  };
}

async function resolvePublic(videoId: string, timeoutMs: number): Promise<ResolveResult> {
  const query = `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature } videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature } }`;
  const tokenResponse = await request(
    "https://gql.twitch.tv/gql",
    {
      method: "POST",
      headers: { "Client-ID": TWITCH_WEB_CLIENT_ID, "Content-Type": "application/json" },
      body: JSON.stringify({
        operationName: "PlaybackAccessToken_Template",
        query,
        variables: { isLive: false, login: "", isVod: true, vodID: videoId, playerType: "site", platform: "web" },
      }),
    },
    timeoutMs,
  );
  if (!tokenResponse.ok) throw new ResolveError(`Twitch returned HTTP ${tokenResponse.status}.`);
  const tokenPayload: unknown = await tokenResponse.json();
  if (!isRecord(tokenPayload) || !isRecord(tokenPayload.data)) {
    throw new ResolveError("Twitch did not return a playback token.");
  }
  const token = tokenPayload.data.videoPlaybackAccessToken;
  if (!isRecord(token)) throw new ResolveError("Twitch did not grant playback access to this VOD.");
  const signature = getString(token, "signature");
  const value = getString(token, "value");
  if (!signature || !value) throw new ResolveError("The playback token is incomplete.");

  const params = new URLSearchParams({
    allow_source: "true",
    allow_audio_only: "true",
    allow_spectre: "true",
    include_unavailable: "true",
    player: "twitchweb",
    playlist_include_framerate: "true",
    sig: signature,
    supported_codecs: "av1,h265,h264",
    token: value,
  });
  const masterUrl = `https://usher.ttvnw.net/vod/${videoId}.m3u8?${params}`;
  const manifestResponse = await request(masterUrl, {}, timeoutMs);
  if (!manifestResponse.ok) throw new ResolveError(`The manifest returned HTTP ${manifestResponse.status}.`);
  const formats = parseMasterManifest(await manifestResponse.text());
  if (formats.length === 0) throw new ResolveError("The manifest contains no playable qualities.");
  return { kind: "public", source: "twitch", videoId, masterUrl, formats };
}

export async function resolveM3U8(rawInput: string, options: ResolveOptions = {}): Promise<ResolveResult> {
  const input = parseInput(rawInput);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (input.kind) {
    case "public":
      return resolvePublic(input.videoId, timeoutMs);
    case "hidden":
      return resolveHidden(input.channel, input.streamId, input.timestamp, input.source, timeoutMs);
    case "tracker": {
      const timestamp = await findStreamTimestamp(input.channel, input.streamId, timeoutMs);
      return resolveHidden(input.channel, input.streamId, timestamp, input.provider, timeoutMs);
    }
    case "stream-id": {
      const channel = options.channel?.trim().toLowerCase();
      if (!channel) {
        throw new ResolveError(
          "A hidden stream ID needs its channel. Add --channel CHANNEL or paste a tracker URL.",
        );
      }
      const timestamp = await findStreamTimestamp(channel, input.streamId, timeoutMs);
      return resolveHidden(channel, input.streamId, timestamp, "stream-id", timeoutMs);
    }
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}

export function chooseFormat(formats: PlaylistFormat[], requested = "best"): PlaylistFormat {
  const normalized = requested.toLowerCase();
  const selected =
    normalized === "best"
      ? formats[0]
      : formats.find((format) => format.id.toLowerCase() === normalized);
  if (!selected) {
    throw new ResolveError(
      `Quality "${requested}" is unavailable. Available options: ${formats.map((format) => format.id).join(", ")}.`,
    );
  }
  return selected;
}
