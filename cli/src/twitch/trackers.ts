const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface TrackerOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TrackerStream {
  source: "twitracker" | "streamervitals";
  channel: string;
  /** Twitch stream ID when the source exposes it. */
  streamId: string | null;
  /** Internal page ID used by the source when it has one. */
  internalId: string | null;
  startedAt: number;
  title: string | null;
  category: string | null;
  durationSeconds: number | null;
  averageViewers: number | null;
  peakViewers: number | null;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function cellTexts(row: string): string[] {
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) =>
    decodeEntities(stripTags(match[1] ?? "")).replace(/\s+/g, " ").trim(),
  );
}

/** Parse strings such as "2h 15m", "50m" or "1h 2m 3s" into seconds. */
export function parseDurationText(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (!text || text === "-" || text === "—") return null;
  const match = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(text);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

/** Parse display counts such as "1,131", "3.1K" or "2.4M" into numbers. */
export function parseCountText(value: string): number | null {
  const text = value.trim().replaceAll(",", "");
  if (!text || text === "-" || text === "—") return null;
  const match = /^(\d+(?:\.\d+)?)\s*([KkMm])?$/.exec(text);
  if (!match?.[1]) return null;
  const base = Number.parseFloat(match[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]?.toLowerCase();
  if (suffix === "k") return Math.round(base * 1_000);
  if (suffix === "m") return Math.round(base * 1_000_000);
  return Math.round(base);
}

async function fetchText(url: string, options: TrackerOptions): Promise<string | null> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 12_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    const response = await (options.fetch ?? fetch)(url, {
      headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
      redirect: "follow",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return await response.text();
  } catch (error) {
    options.signal?.throwIfAborted();
    return null;
  }
}

async function fetchJson(url: string, options: TrackerOptions): Promise<unknown | null> {
  const text = await fetchText(url, options);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoToEpoch(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / 1000);
}

/**
 * Read the exact start second from a twitracker.com stream page. The page
 * embeds `datetime="2026-09-09T20:41:21.000Z"` in its header.
 */
export function parseTwitTrackerStreamTime(html: string): number | null {
  const match = html.match(/<time[^>]*\sdatetime="([^"]+)"/i);
  if (!match?.[1]) return null;
  return isoToEpoch(match[1]);
}

/** Parse the recent-streams table of a twitracker.com channel page. */
export function parseTwitTrackerStreams(html: string, channel: string): TrackerStream[] {
  const streams: TrackerStream[] = [];
  for (const row of html.split(/<tr[\s>]/i).slice(1)) {
    const link = row.match(/href="\/streamers\/([^/"]+)\/streams\/(\d+)"/i);
    const time = row.match(/<time[^>]*\sdatetime="([^"]+)"/i);
    if (!link?.[2] || !time?.[1]) continue;
    const startedAt = isoToEpoch(time[1]);
    if (startedAt === null) continue;
    const cells = cellTexts(row);
    streams.push({
      source: "twitracker",
      channel,
      streamId: link[2],
      internalId: null,
      startedAt,
      title: cells[2] || null,
      category: cells[3] || null,
      durationSeconds: parseDurationText(cells[1] ?? ""),
      averageViewers: parseCountText(cells[6] ?? ""),
      peakViewers: parseCountText(cells[5] ?? ""),
    });
  }
  return streams;
}

/** Parse the stream history table of a streamervitals.com channel page. */
export function parseStreamerVitalsStreams(html: string, channel: string): TrackerStream[] {
  const streams: TrackerStream[] = [];
  const linkPattern = new RegExp(`href="/${escapeRegExp(channel)}/stream/(\\d+)"`, "i");
  for (const row of html.split(/<tr[\s>]/i).slice(1)) {
    if (!row.includes("sv-row-link")) continue;
    const link = row.match(linkPattern);
    const time = row.match(/dateTime="([^"]+)"/i);
    if (!link?.[1] || !time?.[1]) continue;
    const startedAt = isoToEpoch(time[1]);
    if (startedAt === null) continue;
    const title = row.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
    const cells = cellTexts(row);
    streams.push({
      source: "streamervitals",
      channel,
      streamId: null,
      internalId: link[1],
      startedAt,
      title: title?.[1] ? decodeEntities(stripTags(title[1])).replace(/\s+/g, " ").trim() : null,
      category: cells[0] || null,
      durationSeconds: parseDurationText(cells[1] ?? ""),
      averageViewers: parseCountText(cells[2] ?? ""),
      peakViewers: parseCountText(cells[3] ?? ""),
    });
  }
  return streams;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function fetchTwitTrackerStreams(channel: string, options: TrackerOptions = {}): Promise<TrackerStream[]> {
  return fetchText(`https://twitracker.com/streamers/${encodeURIComponent(channel.toLowerCase())}`, options).then(
    (html) => (html === null ? [] : parseTwitTrackerStreams(html, channel.toLowerCase())),
  );
}

export async function fetchTwitTrackerStreamTime(
  channel: string,
  streamId: string,
  options: TrackerOptions = {},
): Promise<number | null> {
  const html = await fetchText(
    `https://twitracker.com/streamers/${encodeURIComponent(channel.toLowerCase())}/streams/${encodeURIComponent(streamId)}`,
    options,
  );
  return html === null ? null : parseTwitTrackerStreamTime(html);
}

export function fetchStreamerVitalsStreams(channel: string, options: TrackerOptions = {}): Promise<TrackerStream[]> {
  return fetchText(`https://streamervitals.com/${encodeURIComponent(channel.toLowerCase())}/streams`, options).then(
    (html) => (html === null ? [] : parseStreamerVitalsStreams(html, channel.toLowerCase())),
  );
}

export interface SullyGnomeMatch {
  startedAt: number;
  title: string | null;
}

/**
 * Resolve a stream start time through SullyGnome. Its API is sometimes behind a
 * Cloudflare challenge from datacenter networks, so every failure is a null
 * result and callers fall back to other sources.
 */
export async function fetchSullyGnomeStreamTime(
  channel: string,
  streamId: string,
  options: TrackerOptions = {},
): Promise<number | null> {
  const search = await fetchJson(
    `https://sullygnome.com/api/standardsearch/${encodeURIComponent(channel.toLowerCase())}`,
    options,
  );
  if (!Array.isArray(search)) return null;
  const channelItem = search.find(
    (item) =>
      isRecord(item) &&
      item.itemtype === 1 &&
      typeof item.siteurl === "string" &&
      item.siteurl.toLowerCase() === channel.toLowerCase(),
  );
  if (!isRecord(channelItem) || typeof channelItem.value !== "number") return null;

  let start = 0;
  let page = 1;
  while (page <= 50) {
    const payload = await fetchJson(
      `https://sullygnome.com/api/tables/channeltables/streams/365/${channelItem.value}/%20/${page}/1/desc/${start}/100`,
      options,
    );
    if (!isRecord(payload) || !Array.isArray(payload.data)) return null;
    const stream = payload.data.find((item) => isRecord(item) && String(item.streamId) === streamId);
    if (isRecord(stream)) {
      const startedAt = typeof stream.startDateTime === "string" ? isoToEpoch(stream.startDateTime) : null;
      return startedAt;
    }
    const total = typeof payload.recordsFiltered === "number" ? payload.recordsFiltered : 0;
    start += 100;
    page += 1;
    if (start >= total) break;
  }
  return null;
}
