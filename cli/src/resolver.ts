import { createHash } from "node:crypto";

import { fetchVideoMetadata, GqlClient, TWITCH_WEB_CLIENT_ID } from "./twitch/gql.js";
import {
  fetchSullyGnomeStreamTime,
  fetchStreamerVitalsStreams,
  fetchTwitTrackerStreamTime,
  type TrackerOptions,
  type TrackerStream,
} from "./twitch/trackers.js";
import type {
  HiddenSource,
  ParsedInput,
  PlaylistFormat,
  ResolveOptions,
  ResolveResult,
  TimestampReport,
  TimestampSource,
  TrackerProvider,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 12_000;
/** Seconds searched around a provided timestamp when every exact source fails. */
export const DEFAULT_TIMESTAMP_WINDOW = 120;
const TRACKER_CLOCK_TOLERANCE_SECONDS = 15 * 60;
const WINDOW_CONCURRENCY = 24;

export const VOD_DOMAINS = [
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
  // Verified aliases of the ds0h/d2nv distribution. They only help when a
  // network can reach twitch.tv but not the CloudFront hostname.
  "https://vod-secure.twitch.tv",
  "https://vod-metro.twitch.tv",
  "https://vod-pop-secure.twitch.tv",
] as const;

/** Qualities probed, in order, when looking for a VOD on a distribution. */
const QUALITY_PROBE_ORDER = ["chunked", "720p60", "480p30", "audio_only"] as const;

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
  constructor(
    message: string,
    readonly code: string = "RESOLVE_FAILED",
  ) {
    super(message);
    this.name = "ResolveError";
  }
}

interface ProbeContext {
  timeoutMs: number;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

/** Domains that recently served a channel, most recent first. */
const domainMemory = new Map<string, string[]>();

function rememberDomain(channel: string, domain: string): void {
  const key = channel.toLowerCase();
  const remembered = domainMemory.get(key) ?? [];
  domainMemory.set(key, [domain, ...remembered.filter((item) => item !== domain)].slice(0, 4));
}

export function orderedVodDomains(channel?: string): string[] {
  const remembered = channel ? (domainMemory.get(channel.toLowerCase()) ?? []) : [];
  return [...new Set([...remembered, ...VOD_DOMAINS])];
}

export function parseInput(rawInput: string): ParsedInput {
  const input = rawInput.trim();
  const canonical = input.match(/^video:(?<channel>\w+)_(?<id>\d+)_(?<timestamp>\d+)$/i);
  if (canonical?.groups) {
    const { channel, id, timestamp } = canonical.groups;
    if (!channel || !id || !timestamp) throw new ResolveError("Incomplete video: target.", "INVALID_INPUT");
    return {
      kind: "hidden",
      channel: channel.toLowerCase(),
      streamId: id,
      timestamp: Number.parseInt(timestamp, 10),
      source: "canonical",
    };
  }

  for (const { provider, pattern } of TRACKER_PATTERNS) {
    const match = input.match(pattern);
    if (match?.groups) {
      const { channel, id } = match.groups;
      if (!channel || !id) throw new ResolveError("Incomplete tracker URL.", "INVALID_INPUT");
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
    "INVALID_INPUT",
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

function createContext(options: ResolveOptions): ProbeContext {
  const context: ProbeContext = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetch: options.fetch ?? fetch,
  };
  return options.signal ? { ...context, signal: options.signal } : context;
}

function trackerOptions(ctx: ProbeContext): TrackerOptions {
  const options: TrackerOptions = { fetch: ctx.fetch, timeoutMs: ctx.timeoutMs };
  return ctx.signal ? { ...options, signal: ctx.signal } : options;
}

async function request(url: string, init: RequestInit, ctx: ProbeContext): Promise<Response> {
  const timeout = AbortSignal.timeout(ctx.timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
  return ctx.fetch(url, { ...init, signal });
}

/**
 * Probe one media URL. HEAD is the cheap default; GET with a byte range covers
 * servers that reject HEAD. A 403 or 404 is a definitive negative: Twitch's
 * CloudFront returns 403 for paths that are not stored on that distribution.
 */
async function urlExists(url: string, ctx: ProbeContext): Promise<boolean> {
  try {
    const response = await request(url, { method: "HEAD", redirect: "follow" }, ctx);
    if (response.ok) return true;
    if (response.status !== 405 && response.status !== 501) return false;
    await response.body?.cancel();
  } catch (error) {
    ctx.signal?.throwIfAborted();
  }
  try {
    const response = await request(url, { headers: { Range: "bytes=0-0" }, redirect: "follow" }, ctx);
    const ok = response.ok;
    await response.body?.cancel();
    return ok;
  } catch (error) {
    ctx.signal?.throwIfAborted();
    return false;
  }
}

interface DomainMatch {
  domain: string;
  quality: string;
}

/**
 * Find which distribution stores this path. `chunked` (Source) is checked
 * first; when it is absent the other representative qualities are probed so a
 * VOD without the source quality is still discovered.
 */
async function findDomain(fullPath: string, channel: string | undefined, ctx: ProbeContext): Promise<DomainMatch | null> {
  const domains = orderedVodDomains(channel);
  for (const quality of QUALITY_PROBE_ORDER) {
    const checks = await Promise.all(
      domains.map(async (domain) => ({
        domain,
        available: await urlExists(`${domain}/${fullPath}/${quality}/index-dvr.m3u8`, ctx),
      })),
    );
    const match = checks.find((item) => item.available);
    if (match) return { domain: match.domain, quality };
  }
  return null;
}

async function probeFormats(domain: string, fullPath: string, ctx: ProbeContext): Promise<PlaylistFormat[]> {
  const checks = await Promise.all(
    FORMAT_PATHS.map(async (format): Promise<PlaylistFormat | null> => {
      const url = `${domain}/${fullPath}/${format.path}/index-dvr.m3u8`;
      return (await urlExists(url, ctx))
        ? { id: format.id, url, height: format.height, fps: format.fps }
        : null;
    }),
  );
  return checks.filter((format): format is PlaylistFormat => format !== null);
}

async function resolveAtTimestamp(
  channel: string,
  streamId: string,
  timestamp: number,
  source: HiddenSource,
  report: TimestampReport,
  ctx: ProbeContext,
): Promise<ResolveResult | null> {
  if (!Number.isInteger(timestamp) || timestamp <= 0) return null;
  const fullPath = buildFullVodPath(channel, streamId, timestamp);
  const match = await findDomain(fullPath, channel, ctx);
  if (!match) return null;
  rememberDomain(channel, match.domain);
  const formats = await probeFormats(match.domain, fullPath, ctx);
  if (formats.length === 0) {
    throw new ResolveError("The VOD path exists, but no playable quality was found.", "NOT_FOUND");
  }
  return {
    kind: "hidden",
    source,
    channel,
    streamId,
    startedAt: new Date(timestamp * 1000).toISOString(),
    canonicalTarget: `video:${channel}_${streamId}_${timestamp}`,
    formats,
    timestamp: report,
  };
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item === undefined) continue;
      await run(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Last resort when no exact timestamp is available: enumerate the seconds
 * around an approximate timestamp, closest first, across the known
 * distributions. Only the Source quality is checked, and the search stops at
 * the first hit.
 */
async function searchTimestampWindow(
  channel: string,
  streamId: string,
  anchor: number,
  windowSeconds: number,
  ctx: ProbeContext,
): Promise<{ seconds: number; domain: string } | null> {
  const domains = orderedVodDomains(channel);
  const deltas: number[] = [0];
  for (let step = 1; step <= windowSeconds; step += 1) deltas.push(step, -step);
  const pairs: Array<{ delta: number; domain: string }> = [];
  for (const delta of deltas) {
    for (const domain of domains) pairs.push({ delta, domain });
  }
  let hit: { seconds: number; domain: string } | null = null;
  await mapWithConcurrency(pairs, WINDOW_CONCURRENCY, async ({ delta, domain }) => {
    if (hit !== null || ctx.signal?.aborted) return;
    const seconds = anchor + delta;
    if (seconds <= 0) return;
    const fullPath = buildFullVodPath(channel, streamId, seconds);
    if (await urlExists(`${domain}/${fullPath}/chunked/index-dvr.m3u8`, ctx)) {
      if (hit === null) hit = { seconds, domain };
    }
  });
  return hit;
}

function nearestStream(streams: TrackerStream[], anchor: number, toleranceSeconds: number): TrackerStream | null {
  let best: TrackerStream | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const stream of streams) {
    const diff = Math.abs(stream.startedAt - anchor);
    if (diff <= toleranceSeconds && diff < bestDiff) {
      best = stream;
      bestDiff = diff;
    }
  }
  return best;
}

interface HiddenTarget {
  channel: string;
  streamId: string;
  provided?: number;
  source: HiddenSource;
  options: ResolveOptions;
  ctx: ProbeContext;
}

async function resolveHiddenTarget(target: HiddenTarget): Promise<ResolveResult> {
  const { channel, streamId, provided, source, options, ctx } = target;
  const requested = provided ?? null;

  // 1. The timestamp supplied by the caller is the cheapest thing to try.
  if (provided !== undefined) {
    const result = await resolveAtTimestamp(
      channel,
      streamId,
      provided,
      source,
      { requested, used: provided, adjusted: false, source: "provided" },
      ctx,
    );
    if (result) return result;
  }

  // 2. Exact tracker timestamps: twitracker and SullyGnome expose seconds.
  const [twitTracker, sullyGnome] = await Promise.all([
    fetchTwitTrackerStreamTime(channel, streamId, trackerOptions(ctx)),
    fetchSullyGnomeStreamTime(channel, streamId, trackerOptions(ctx)),
  ]).catch(() => [null, null] as Array<number | null>);

  const candidates: Array<{ seconds: number; source: TimestampSource }> = [];
  if (twitTracker !== null) candidates.push({ seconds: twitTracker, source: "twitracker" });
  if (sullyGnome !== null) candidates.push({ seconds: sullyGnome, source: "sullygnome" });
  for (const candidate of candidates) {
    if (candidate.seconds === provided) continue;
    const result = await resolveAtTimestamp(
      channel,
      streamId,
      candidate.seconds,
      source,
      { requested, used: candidate.seconds, adjusted: provided !== undefined, source: candidate.source },
      ctx,
    );
    if (result) return result;
  }

  if (provided !== undefined) {
    // 3. Match the nearest stream on a tracker list. Those pages expose the
    // exact start second and cover channels Twitch does not archive publicly.
    const streams = await fetchStreamerVitalsStreams(channel, trackerOptions(ctx)).catch(() => [] as TrackerStream[]);
    const nearest = nearestStream(streams, provided, TRACKER_CLOCK_TOLERANCE_SECONDS);
    if (nearest && nearest.startedAt !== provided) {
      const result = await resolveAtTimestamp(
        channel,
        streamId,
        nearest.startedAt,
        source,
        { requested, used: nearest.startedAt, adjusted: true, source: "streamervitals" },
        ctx,
      );
      if (result) return result;
    }

    // 4. Bounded second-by-second search around the approximate timestamp.
    const window = options.timestampWindow ?? DEFAULT_TIMESTAMP_WINDOW;
    if (window > 0) {
      const found = await searchTimestampWindow(channel, streamId, provided, window, ctx);
      if (found) {
        const result = await resolveAtTimestamp(
          channel,
          streamId,
          found.seconds,
          source,
          { requested, used: found.seconds, adjusted: true, source: "window" },
          ctx,
        );
        if (result) return result;
      }
    }
  }

  if (provided === undefined) {
    throw new ResolveError(
      `Could not determine the start time of ${channel}/${streamId}. Tracker lookups failed or are blocked; ` +
        `use "video:${channel}_${streamId}_<start-epoch-seconds>".`,
      "TIMESTAMP_UNAVAILABLE",
    );
  }
  const window = options.timestampWindow ?? DEFAULT_TIMESTAMP_WINDOW;
  throw new ResolveError(
    `The VOD was not found on any known Twitch distribution, even after checking exact tracker timestamps` +
      `${window > 0 ? ` and a ±${window}s window` : ""}. It may have been deleted, expired, or its media was never stored.`,
    "NOT_FOUND",
  );
}

async function resolvePublicManifest(videoId: string, ctx: ProbeContext): Promise<ResolveResult> {
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
    ctx,
  );
  if (!tokenResponse.ok) throw new ResolveError(`Twitch returned HTTP ${tokenResponse.status}.`, "HTTP_ERROR");
  const tokenPayload: unknown = await tokenResponse.json();
  if (!isRecord(tokenPayload) || !isRecord(tokenPayload.data)) {
    throw new ResolveError("Twitch did not return a playback token.", "NOT_FOUND");
  }
  const token = tokenPayload.data.videoPlaybackAccessToken;
  if (!isRecord(token)) throw new ResolveError("Twitch did not grant playback access to this VOD.", "ACCESS_DENIED");
  const signature = getString(token, "signature");
  const value = getString(token, "value");
  if (!signature || !value) throw new ResolveError("The playback token is incomplete.", "NOT_FOUND");

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
  const manifestResponse = await request(masterUrl, {}, ctx);
  if (!manifestResponse.ok) throw new ResolveError(`The manifest returned HTTP ${manifestResponse.status}.`, "HTTP_ERROR");
  const formats = parseMasterManifest(await manifestResponse.text());
  if (formats.length === 0) throw new ResolveError("The manifest contains no playable qualities.", "NOT_FOUND");
  return { kind: "public", source: "twitch", videoId, masterUrl, formats };
}

/**
 * Playback token denied? Restricted VODs may still expose metadata with the
 * exact hidden path. Probe that path without requiring authentication.
 */
async function resolveFromVodMetadata(videoId: string, ctx: ProbeContext): Promise<ResolveResult | null> {
  const client = new GqlClient({
    fetch: ctx.fetch,
    timeoutMs: ctx.timeoutMs,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const video = await fetchVideoMetadata(client, videoId);
  if (!video?.channel || !video.streamId || video.startedAtSeconds === null) return null;
  const result = await resolveAtTimestamp(
    video.channel,
    video.streamId,
    video.startedAtSeconds,
    "vod-id",
    { requested: video.startedAtSeconds, used: video.startedAtSeconds, adjusted: false, source: "provided" },
    ctx,
  );
  if (result?.kind !== "hidden") return null;
  return { ...result, vodId: videoId };
}

async function resolvePublic(videoId: string, ctx: ProbeContext): Promise<ResolveResult> {
  try {
    return await resolvePublicManifest(videoId, ctx);
  } catch (error) {
    ctx.signal?.throwIfAborted();
    const fallback = await resolveFromVodMetadata(videoId, ctx).catch(() => null);
    if (fallback) return fallback;
    throw error;
  }
}

export async function resolveM3U8(rawInput: string, options: ResolveOptions = {}): Promise<ResolveResult> {
  const input = parseInput(rawInput);
  const ctx = createContext(options);
  switch (input.kind) {
    case "public":
      return resolvePublic(input.videoId, ctx);
    case "hidden":
      return resolveHiddenTarget({
        channel: input.channel,
        streamId: input.streamId,
        provided: input.timestamp,
        source: input.source,
        options,
        ctx,
      });
    case "tracker":
      return resolveHiddenTarget({
        channel: input.channel,
        streamId: input.streamId,
        source: input.provider,
        options,
        ctx,
      });
    case "stream-id": {
      const channel = options.channel?.trim().toLowerCase();
      if (!channel) {
        throw new ResolveError(
          "A hidden stream ID needs its channel. Add --channel CHANNEL or paste a tracker URL.",
          "CHANNEL_REQUIRED",
        );
      }
      return resolveHiddenTarget({ channel, streamId: input.streamId, source: "stream-id", options, ctx });
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
      "QUALITY_UNAVAILABLE",
    );
  }
  return selected;
}
