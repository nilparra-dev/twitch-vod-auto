import { stdin, stderr, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { mapWithConcurrency } from "./concurrency.js";
import { fetchMedia } from "./net/media.js";
import { chooseFormat, DEFAULT_TIMESTAMP_WINDOW, ResolveError, resolveM3U8 } from "./resolver.js";
import { downloadCommand } from "./download/command.js";
import { fetchChannelVideos, GqlClient, type ChannelVideoNode } from "./twitch/gql.js";
import {
  fetchStreamerVitalsStreams,
  fetchTwitTrackerStreams,
  type TrackerStream,
} from "./twitch/trackers.js";
import type { PlaylistFormat } from "./types.js";
import { watchCommand } from "./watch/command.js";

export interface ChannelStream {
  streamId: string | null;
  vodId: string | null;
  startedAt: number | null;
  durationSeconds: number | null;
  title: string | null;
  category: string | null;
  averageViewers: number | null;
  peakViewers: number | null;
  sources: string[];
}

export interface ProbeOutcome {
  status: "available" | "missing";
  domain: string | null;
  reason: string | null;
  /** Exact media duration measured from the resolved HLS playlist. */
  mediaDurationSeconds?: number | null;
  formats?: PlaylistFormat[];
}

export interface ListEntry extends ChannelStream {
  index: number;
  target: string | null;
  probe?: ProbeOutcome;
}

const STREAMER_VITALS_MATCH_SECONDS = 120;

function newStream(): ChannelStream {
  return {
    streamId: null,
    vodId: null,
    startedAt: null,
    durationSeconds: null,
    title: null,
    category: null,
    averageViewers: null,
    peakViewers: null,
    sources: [],
  };
}

function addSource(stream: ChannelStream, source: string): void {
  if (!stream.sources.includes(source)) stream.sources.push(source);
}

function epochFromIso(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function enrich(stream: ChannelStream, tracker: TrackerStream, source: string): void {
  stream.startedAt ??= tracker.startedAt;
  stream.durationSeconds ??= tracker.durationSeconds;
  stream.title ??= tracker.title;
  stream.category ??= tracker.category;
  stream.averageViewers ??= tracker.averageViewers;
  stream.peakViewers ??= tracker.peakViewers;
  addSource(stream, source);
}

/**
 * Merge Twitch archive VODs with tracker stream lists. Tracker rows cover
 * streams Twitch does not list publicly (sub-only or hidden VODs). Matching is
 * by Twitch stream ID when available and by start time otherwise.
 */
export function mergeChannelStreams(input: {
  videos: ChannelVideoNode[];
  twitTracker: TrackerStream[];
  streamerVitals: TrackerStream[];
}): ChannelStream[] {
  const streams: ChannelStream[] = [];
  const byStreamId = new Map<string, ChannelStream>();

  for (const video of input.videos) {
    const stream = newStream();
    stream.vodId = video.vodId;
    stream.streamId = video.streamId;
    stream.startedAt = video.startedAtSeconds ?? epochFromIso(video.createdAt);
    stream.durationSeconds = video.durationSeconds;
    stream.title = video.title;
    stream.category = video.category;
    stream.averageViewers = null;
    stream.peakViewers = video.viewCount;
    addSource(stream, "twitch");
    streams.push(stream);
    if (stream.streamId) byStreamId.set(stream.streamId, stream);
  }

  for (const tracker of input.twitTracker) {
    const existing = tracker.streamId ? byStreamId.get(tracker.streamId) : undefined;
    if (existing) {
      existing.startedAt = tracker.startedAt;
      enrich(existing, tracker, tracker.source);
      continue;
    }
    const stream = newStream();
    stream.streamId = tracker.streamId;
    enrich(stream, tracker, tracker.source);
    streams.push(stream);
    if (stream.streamId) byStreamId.set(stream.streamId, stream);
  }

  for (const tracker of input.streamerVitals) {
    let match: ChannelStream | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const stream of streams) {
      if (stream.startedAt === null) continue;
      const diff = Math.abs(stream.startedAt - tracker.startedAt);
      if (diff <= STREAMER_VITALS_MATCH_SECONDS && diff < bestDiff) {
        match = stream;
        bestDiff = diff;
      }
    }
    if (match) {
      enrich(match, tracker, tracker.source);
      continue;
    }
    const stream = newStream();
    enrich(stream, tracker, tracker.source);
    streams.push(stream);
  }

  streams.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return streams;
}

/** Build a resolver target: exact hidden path first, VOD URL otherwise. */
export function streamTarget(channel: string, stream: ChannelStream): string | null {
  if (stream.streamId && stream.startedAt) {
    return `video:${channel}_${stream.streamId}_${stream.startedAt}`;
  }
  if (stream.vodId) return `https://www.twitch.tv/videos/${stream.vodId}`;
  return null;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "-";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}

function formatStarted(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "-";
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

/**
 * Sum the #EXTINF values of an HLS media playlist to obtain the exact media
 * duration. Tracker sites only estimate durations by sampling the live API.
 */
export async function measurePlaylistDuration(
  url: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<number | null> {
  try {
    const response = await fetchMedia(url, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const text = await response.text();
    let total = 0;
    let found = false;
    for (const match of text.matchAll(/#EXTINF:([\d.]+)/g)) {
      const value = Number.parseFloat(match[1] ?? "");
      if (Number.isFinite(value)) {
        total += value;
        found = true;
      }
    }
    return found ? total : null;
  } catch {
    return null;
  }
}

async function probeTarget(target: string, timestampWindow: number): Promise<ProbeOutcome> {
  try {
    const result = await resolveM3U8(target, { timestampWindow });
    const first = result.formats[0];
    const mediaDurationSeconds = first ? await measurePlaylistDuration(first.url) : null;
    return {
      status: "available",
      domain: first ? new URL(first.url).hostname : null,
      reason: null,
      mediaDurationSeconds,
      formats: result.formats,
    };
  } catch (error) {
    return {
      status: "missing",
      domain: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export const LIST_HELP = `List recent streams of a channel, including hidden VODs.

Usage:
  twitch-m3u8 list <channel> [options]

Streams come from Twitch's public archive and from tracker lists that expose
the exact start second, so hidden or sub-only VODs can be recovered even when
Twitch does not list them.

Options:
  --limit <n>                 Rows to show (default 15, max 2000)
  --all                       Walk every Twitch archive page
  --probe                     Check media availability and show the domain
  --target <n>                Print the canonical video: target for row n
  --download <n>              Download stream n as a single file
  --url <n>                   Print the playable URL for row n
  --watch <n>                 Open the local player for row n
  --no-open                   With --watch, do not open a browser
  -q, --quality <quality>     Quality for --download/--url (default best)
  --timestamp-window <secs>   Search window for approximate timestamps (default ${DEFAULT_TIMESTAMP_WINDOW})
  --json                      Print structured JSON
  -h, --help                  Show this help

Examples:
  twitch-m3u8 list xqc
  twitch-m3u8 list xqc --probe
  twitch-m3u8 list xqc --target 1
  twitch-m3u8 list xqc --download 1 -q 720p60
  twitch-m3u8 list xqc --url 2 --quality 720p60
  twitch-m3u8 list xqc --watch 2
  twitch-m3u8 list xqc --limit 30 --json`;

interface ListOptions {
  channel?: string;
  limit: number;
  all: boolean;
  json: boolean;
  probe: boolean;
  noOpen: boolean;
  quality: string;
  timestampWindow: number;
  urlRequested: boolean;
  urlIndex?: number;
  watchRequested: boolean;
  watchIndex?: number;
  targetRequested: boolean;
  targetIndex?: number;
  downloadRequested: boolean;
  downloadIndex?: number;
}

function requireInteger(args: string[], index: number, option: string, minimum: number, maximum: number): number {
  const value = args[index + 1];
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new ResolveError(`${option} requires an integer between ${minimum} and ${maximum}.`, "INVALID_ARGUMENT");
  }
  return parsed;
}

function parseListArgs(args: string[]): ListOptions {
  const options: ListOptions = {
    limit: 15,
    all: false,
    json: false,
    probe: false,
    noOpen: false,
    quality: "best",
    timestampWindow: DEFAULT_TIMESTAMP_WINDOW,
    urlRequested: false,
    watchRequested: false,
    targetRequested: false,
    downloadRequested: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--limit") {
      options.limit = requireInteger(args, index, arg, 1, 2000);
      index += 1;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--probe") {
      options.probe = true;
    } else if (arg === "--no-open") {
      options.noOpen = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--quality" || arg === "-q") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new ResolveError(`${arg} requires a value.`, "INVALID_ARGUMENT");
      options.quality = value;
      index += 1;
    } else if (arg === "--timestamp-window") {
      options.timestampWindow = requireInteger(args, index, arg, 0, 900);
      index += 1;
    } else if (arg === "--url" || arg === "--watch" || arg === "--target" || arg === "--download") {
      const next = args[index + 1];
      const parsed = next && /^\d+$/.test(next) ? Number.parseInt(next, 10) : undefined;
      if (parsed !== undefined) index += 1;
      if (parsed !== undefined && (parsed < 1 || parsed > 2000)) {
        throw new ResolveError(`${arg} requires a row number.`, "INVALID_ARGUMENT");
      }
      if (arg === "--url") {
        options.urlRequested = true;
        if (parsed !== undefined) options.urlIndex = parsed;
      } else if (arg === "--watch") {
        options.watchRequested = true;
        if (parsed !== undefined) options.watchIndex = parsed;
      } else if (arg === "--target") {
        options.targetRequested = true;
        if (parsed !== undefined) options.targetIndex = parsed;
      } else {
        options.downloadRequested = true;
        if (parsed !== undefined) options.downloadIndex = parsed;
      }
    } else if (arg.startsWith("-")) {
      throw new ResolveError(`Unknown list option: ${arg}`, "INVALID_ARGUMENT");
    } else if (!options.channel) {
      options.channel = arg;
    } else {
      throw new ResolveError(`Unexpected argument: ${arg}`, "INVALID_ARGUMENT");
    }
  }
  return options;
}

async function promptIndex(entries: ListEntry[]): Promise<number> {
  if (!stdin.isTTY) {
    throw new ResolveError("Provide a row number, for example --url 2.", "INVALID_ARGUMENT");
  }
  const prompt = createInterface({ input: stdin, output: stderr });
  const answer = (await prompt.question(`Stream number (1-${entries.length}): `)).trim();
  prompt.close();
  const index = Number.parseInt(answer, 10);
  if (!Number.isInteger(index) || index < 1 || index > entries.length) {
    throw new ResolveError("Invalid stream number.", "INVALID_ARGUMENT");
  }
  return index;
}

function toJson(entry: ListEntry): Record<string, unknown> {
  return {
    index: entry.index,
    streamId: entry.streamId,
    vodId: entry.vodId,
    startedAt: entry.startedAt === null ? null : new Date(entry.startedAt * 1000).toISOString(),
    durationSeconds: entry.durationSeconds,
    title: entry.title,
    category: entry.category,
    averageViewers: entry.averageViewers,
    peakViewers: entry.peakViewers,
    sources: entry.sources,
    target: entry.target,
    probe: entry.probe ?? null,
  };
}

function printTable(entries: ListEntry[], withProbe: boolean): void {
  const rows = entries.map((entry) => ({
    n: String(entry.index),
    started: formatStarted(entry.startedAt),
    duration: formatDuration(entry.durationSeconds),
    media: formatDuration(entry.probe?.mediaDurationSeconds ?? null),
    id: entry.streamId ?? entry.vodId ?? "-",
    source: entry.sources.join("+"),
    title: truncate(entry.title ?? "", 48),
    status: entry.probe?.status ?? "",
    domain: entry.probe?.domain ?? "",
  }));
  const width = (key: keyof (typeof rows)[number], header: string) =>
    Math.max(header.length, ...rows.map((row) => row[key].length));
  const columns = [
    { key: "n" as const, header: "#" },
    { key: "started" as const, header: "STARTED (UTC)" },
    { key: "duration" as const, header: "DURATION" },
    ...(withProbe ? [{ key: "media" as const, header: "MEDIA" }] : []),
    { key: "id" as const, header: "STREAM ID" },
    { key: "source" as const, header: "SOURCE" },
    { key: "title" as const, header: "TITLE" },
    ...(withProbe
      ? [
          { key: "status" as const, header: "STATUS" },
          { key: "domain" as const, header: "DOMAIN" },
        ]
      : []),
  ];
  const widths = columns.map((column) => width(column.key, column.header));
  const line = (values: string[]) =>
    values.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ").trimEnd();
  stdout.write(`${line(columns.map((column) => column.header))}\n`);
  for (const row of rows) {
    stdout.write(`${line(columns.map((column) => row[column.key]))}\n`);
  }
}

export async function listCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(`${LIST_HELP}\n`);
    return;
  }
  const options = parseListArgs(args);
  if (!options.channel) {
    throw new ResolveError("Provide a channel name. Run list --help for examples.", "INVALID_ARGUMENT");
  }
  const login = options.channel.trim().toLowerCase().replace(/^@/, "");
  if (!/^\w+$/.test(login)) throw new ResolveError(`Invalid channel name: ${options.channel}`, "INVALID_ARGUMENT");

  const client = new GqlClient({});
  const fetchLimit = options.all ? 2000 : options.limit;
  const warnings: string[] = [];
  const recordFailure = (source: string, error: unknown) => {
    warnings.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const [videos, twitTracker, streamerVitals] = await Promise.all([
    fetchChannelVideos(client, login, { limit: fetchLimit, all: options.all }).catch((error: unknown) => {
      recordFailure("Twitch archive", error);
      return [] as ChannelVideoNode[];
    }),
    fetchTwitTrackerStreams(login).catch((error: unknown) => {
      recordFailure("TwitchTracker", error);
      return [] as TrackerStream[];
    }),
    fetchStreamerVitalsStreams(login).catch((error: unknown) => {
      recordFailure("StreamerVitals", error);
      return [] as TrackerStream[];
    }),
  ]);
  if (warnings.length > 0 && !options.json) {
    for (const warning of warnings) stderr.write(`Warning: ${warning}\n`);
  }

  const merged = mergeChannelStreams({ videos, twitTracker, streamerVitals }).slice(0, options.limit);
  if (merged.length === 0) {
    throw new ResolveError(
      `No streams found for "${login}". Twitch returned no public archive and the tracker sources returned nothing.` +
        (warnings.length > 0 ? ` Source errors: ${warnings.join("; ")}.` : ""),
      "NOT_FOUND",
    );
  }
  const entries: ListEntry[] = merged.map((stream, index) => ({
    index: index + 1,
    ...stream,
    target: streamTarget(login, stream),
  }));

  if (options.targetRequested || options.downloadRequested || options.urlRequested || options.watchRequested) {
    const selected = options.targetRequested
      ? (options.targetIndex ?? (await promptIndex(entries)))
      : options.downloadRequested
        ? (options.downloadIndex ?? (await promptIndex(entries)))
        : options.urlRequested
          ? (options.urlIndex ?? (await promptIndex(entries)))
          : (options.watchIndex ?? (await promptIndex(entries)));
    const entry = entries[selected - 1];
    if (!entry?.target) {
      throw new ResolveError(
        `Row ${selected} has no resolvable target. It has no Twitch stream ID or VOD ID; pick another stream.`,
        "NOT_FOUND",
      );
    }
    if (options.targetRequested) {
      if (options.json) {
        stdout.write(`${JSON.stringify({ channel: login, stream: toJson(entry), warnings }, null, 2)}\n`);
      } else {
        stdout.write(`${entry.target}\n`);
      }
      return;
    }
    if (options.downloadRequested) {
      await downloadCommand([
        entry.target,
        "--quality",
        options.quality,
        "--timestamp-window",
        String(options.timestampWindow),
      ]);
      return;
    }
    if (options.watchRequested) {
      await watchCommand([
        entry.target,
        "--timestamp-window",
        String(options.timestampWindow),
        ...(options.noOpen ? ["--no-open"] : []),
      ]);
      return;
    }
    const result = await resolveM3U8(entry.target, { timestampWindow: options.timestampWindow });
    const format = chooseFormat(result.formats, options.quality);
    if (options.json) {
      stdout.write(
        `${JSON.stringify({ channel: login, target: entry.target, selected: format, formats: result.formats, warnings }, null, 2)}\n`,
      );
    } else {
      stdout.write(`${format.url}\n`);
    }
    return;
  }

  if (options.probe) {
    await mapWithConcurrency(entries, 3, async (entry) => {
      if (!entry.target) {
        entry.probe = { status: "missing", domain: null, reason: "No resolvable target." };
        return;
      }
      entry.probe = await probeTarget(entry.target, options.timestampWindow);
    });
  }

  if (options.json) {
    stdout.write(
      `${JSON.stringify({ channel: login, count: entries.length, streams: entries.map(toJson), warnings }, null, 2)}\n`,
    );
    return;
  }

  printTable(entries, options.probe);
  stderr.write(
    `\nDurations without --probe are tracker estimates. Use "twitch-m3u8 list ${login} --probe" for the exact media duration,\n` +
      `"--target N" for the canonical video: target, "--download N" to save the stream, "--url N" for the playable URL, or "--watch N" to open the player.\n`,
  );
}
