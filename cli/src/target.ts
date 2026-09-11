import { stderr, stdout } from "node:process";

import { mergeChannelStreams, streamTarget, type ChannelStream } from "./list.js";
import { parseInput, ResolveError } from "./resolver.js";
import { fetchChannelVideos, GqlClient, type ChannelVideoNode } from "./twitch/gql.js";
import {
  fetchSullyGnomeStreamTime,
  fetchStreamerVitalsStreams,
  fetchTwitTrackerStreams,
  fetchTwitTrackerStreamTime,
  type TrackerStream,
} from "./twitch/trackers.js";

/** The canonical hidden-VOD target the resolver and watch commands accept. */
export function canonicalTarget(channel: string, streamId: string, startedAt: number): string {
  return `video:${channel}_${streamId}_${startedAt}`;
}

/** First resolvable target in a newest-first list of channel streams. */
export function latestTarget(
  channel: string,
  streams: ChannelStream[],
): { target: string; stream: ChannelStream } | null {
  for (const stream of streams) {
    const target = streamTarget(channel, stream);
    if (target) return { target, stream };
  }
  return null;
}

export const TARGET_HELP = `Compute the canonical hidden-VOD target for a channel or stream.

Usage:
  twitch-m3u8 target <channel> [stream-id] [options]
  twitch-m3u8 target <tracker-url>
  twitch-m3u8 id <channel> [stream-id]        Alias of target

Prints video:channel_streamId_startTimestamp, the exact target accepted by the
resolver and watch commands. Without a stream ID it uses the channel's most
recent stream. Stream start seconds come from exact tracker sources, so the
target is correct even when Twitch does not list the VOD.

Options:
  --timestamp <seconds>  Start time used when tracker sources fail
  --json                 Print structured JSON
  -h, --help             Show this help

Examples:
  twitch-m3u8 target xqc
  twitch-m3u8 target xqc STREAM_ID
  twitch-m3u8 target "https://twitchtracker.com/xqc/streams/STREAM_ID"
  twitch-m3u8 target xqc STREAM_ID --json`;

interface TargetOptions {
  input?: string;
  streamId?: string;
  timestamp?: number;
  json: boolean;
}

function parseTargetArgs(args: string[]): TargetOptions {
  const options: TargetOptions = { json: false };
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--timestamp") {
      const value = args[index + 1];
      const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
        throw new ResolveError("--timestamp requires start epoch seconds.", "INVALID_ARGUMENT");
      }
      options.timestamp = parsed;
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("-")) {
      throw new ResolveError(`Unknown target option: ${arg}`, "INVALID_ARGUMENT");
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 2) throw new ResolveError(`Unexpected argument: ${positionals[2]}`, "INVALID_ARGUMENT");
  if (positionals[0]) options.input = positionals[0];
  if (positionals[1]) options.streamId = positionals[1];
  return options;
}

function writeResult(options: TargetOptions, value: Record<string, unknown>, target: string): void {
  if (options.json) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  stdout.write(`${target}\n`);
}

async function targetFromStreamId(
  options: TargetOptions,
  channel: string,
  streamId: string,
): Promise<void> {
  if (options.timestamp !== undefined) {
    const target = canonicalTarget(channel, streamId, options.timestamp);
    writeResult(
      options,
      {
        kind: "hidden",
        channel,
        streamId,
        startedAt: new Date(options.timestamp * 1000).toISOString(),
        timestamp: { used: options.timestamp, source: "provided" },
        target,
      },
      target,
    );
    return;
  }

  const [twitTracker, sullyGnome] = await Promise.all([
    fetchTwitTrackerStreamTime(channel, streamId),
    fetchSullyGnomeStreamTime(channel, streamId),
  ]);
  const used = twitTracker ?? sullyGnome;
  const source = twitTracker !== null ? "twitracker" : "sullygnome";
  if (used === null) {
    throw new ResolveError(
      `Could not determine the start time of ${channel}/${streamId}. ` +
        `Tracker sources are blocked or missing; pass --timestamp <seconds>.`,
      "TIMESTAMP_UNAVAILABLE",
    );
  }
  const target = canonicalTarget(channel, streamId, used);
  if (!options.json && stderr.isTTY) {
    stderr.write(`Started at ${new Date(used * 1000).toISOString()} (source: ${source}).\n`);
  }
  writeResult(
    options,
    {
      kind: "hidden",
      channel,
      streamId,
      startedAt: new Date(used * 1000).toISOString(),
      timestamp: { used, source },
      target,
    },
    target,
  );
}

async function targetFromChannel(options: TargetOptions, channel: string): Promise<void> {
  const client = new GqlClient({});
  const warnings: string[] = [];
  const recordFailure = (source: string, error: unknown) => {
    warnings.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const [videos, twitTracker, streamerVitals] = await Promise.all([
    fetchChannelVideos(client, channel, { limit: 5 }).catch((error: unknown) => {
      recordFailure("Twitch archive", error);
      return [] as ChannelVideoNode[];
    }),
    fetchTwitTrackerStreams(channel).catch((error: unknown) => {
      recordFailure("TwitchTracker", error);
      return [] as TrackerStream[];
    }),
    fetchStreamerVitalsStreams(channel).catch((error: unknown) => {
      recordFailure("StreamerVitals", error);
      return [] as TrackerStream[];
    }),
  ]);
  if (warnings.length > 0 && !options.json) {
    for (const warning of warnings) stderr.write(`Warning: ${warning}\n`);
  }
  const merged = mergeChannelStreams({ videos, twitTracker, streamerVitals });
  const latest = latestTarget(channel, merged);
  if (!latest) {
    throw new ResolveError(
      `No stream with a resolvable target was found for "${channel}". Twitch returned no public archive and the tracker sources returned nothing.` +
        (warnings.length > 0 ? ` Source errors: ${warnings.join("; ")}.` : ""),
      "NOT_FOUND",
    );
  }
  const { target, stream } = latest;
  writeResult(
    options,
    {
      kind: stream.streamId ? "hidden" : "public",
      channel,
      streamId: stream.streamId,
      vodId: stream.vodId,
      startedAt: stream.startedAt === null ? null : new Date(stream.startedAt * 1000).toISOString(),
      durationSeconds: stream.durationSeconds,
      title: stream.title,
      sources: stream.sources,
      target,
      warnings,
    },
    target,
  );
}

export async function targetCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(`${TARGET_HELP}\n`);
    return;
  }
  const options = parseTargetArgs(args);
  if (!options.input) {
    throw new ResolveError("Provide a channel, stream ID, or tracker URL. Run target --help for examples.", "INVALID_ARGUMENT");
  }

  const looksLikeTarget = /^(?:https?:|video:|\d+$)/i.test(options.input);
  if (!looksLikeTarget) {
    const channel = options.input.toLowerCase().replace(/^@/, "");
    if (!/^\w+$/.test(channel)) throw new ResolveError(`Invalid channel name: ${options.input}`, "INVALID_ARGUMENT");
    if (options.streamId) {
      if (!/^\d+$/.test(options.streamId)) {
        throw new ResolveError(`Invalid stream ID: ${options.streamId}`, "INVALID_ARGUMENT");
      }
      await targetFromStreamId(options, channel, options.streamId);
      return;
    }
    await targetFromChannel(options, channel);
    return;
  }

  const parsed = parseInput(options.input);
  switch (parsed.kind) {
    case "hidden": {
      await targetFromStreamId(options, parsed.channel, parsed.streamId);
      return;
    }
    case "tracker": {
      await targetFromStreamId(options, parsed.channel, parsed.streamId);
      return;
    }
    case "stream-id": {
      throw new ResolveError(
        "Put the channel first: target <channel> <stream-id>.",
        "CHANNEL_REQUIRED",
      );
    }
    case "public": {
      const target = `https://www.twitch.tv/videos/${parsed.videoId}`;
      writeResult(options, { kind: "public", videoId: parsed.videoId, target }, target);
      return;
    }
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
}
