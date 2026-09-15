import { spawnSync } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stderr, stdout } from "node:process";

import { chooseFormat, DEFAULT_TIMESTAMP_WINDOW, ResolveError, resolveM3U8 } from "../resolver.js";
import { fetchMedia } from "../net/media.js";
import type { ResolveResult } from "../types.js";
import { assertAllowedMediaUrl, DownloadError, downloadPlaylist } from "./fetcher.js";
import { parseMasterPlaylist, parseMediaPlaylist, type MediaPlaylist } from "./playlist.js";

export const DOWNLOAD_HELP = `Download a Twitch VOD as a single file, without ffmpeg by default.

Usage:
  twitch-m3u8 download <URL|ID|video:...> [options]

Segments are fetched in parallel and written in order. An interrupted download
keeps a .part file and resumes when you run the same command again.

Options:
  -o, --output <file>       Output path (default downloads/<id>.ts)
  -q, --quality <name>      Quality to download; defaults to best
  --channel <channel>       Channel for a hidden stream ID
  --concurrency <n>         Parallel segment downloads (default 8, max 32)
  --force                   Overwrite an existing output or partial download
  --remux                   Convert to MP4 with ffmpeg (-c copy, no re-encode)
  --keep-ts                 Keep the intermediate .ts file after --remux
  --timestamp-window <secs> Search window for approximate timestamps (default ${DEFAULT_TIMESTAMP_WINDOW})
  --json                    Print structured JSON
  -h, --help                Show this help

Using an output path that ends in .mp4 implies --remux.

Examples:
  twitch-m3u8 download 2434567890
  twitch-m3u8 download "video:xqc_51582913581_1721686515" -q 720p60
  twitch-m3u8 download 51582913581 --channel xqc -o clip.ts
  twitch-m3u8 download "https://twitchtracker.com/xqc/streams/51582913581" -o clip.mp4`;

interface DownloadCliOptions {
  target?: string;
  output?: string;
  channel?: string;
  quality: string;
  concurrency: number;
  force: boolean;
  remux: boolean;
  keepTs: boolean;
  json: boolean;
  timestampWindow: number;
}

function parseDownloadArgs(args: string[]): DownloadCliOptions {
  const options: DownloadCliOptions = {
    quality: "best",
    concurrency: 8,
    force: false,
    remux: false,
    keepTs: false,
    json: false,
    timestampWindow: DEFAULT_TIMESTAMP_WINDOW,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-o" || arg === "--output" || arg === "-q" || arg === "--quality" || arg === "--channel") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new ResolveError(`${arg} requires a value.`, "INVALID_ARGUMENT");
      if (arg === "-o" || arg === "--output") options.output = value;
      else if (arg === "--channel") options.channel = value;
      else options.quality = value;
      index += 1;
    } else if (arg === "--concurrency") {
      const value = args[index + 1];
      const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32 || String(parsed) !== value) {
        throw new ResolveError("--concurrency requires an integer between 1 and 32.", "INVALID_ARGUMENT");
      }
      options.concurrency = parsed;
      index += 1;
    } else if (arg === "--timestamp-window") {
      const value = args[index + 1];
      const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 900 || String(parsed) !== value) {
        throw new ResolveError("--timestamp-window requires an integer between 0 and 900.", "INVALID_ARGUMENT");
      }
      options.timestampWindow = parsed;
      index += 1;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--remux") {
      options.remux = true;
    } else if (arg === "--keep-ts") {
      options.keepTs = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("-")) {
      throw new ResolveError(`Unknown download option: ${arg}`, "INVALID_ARGUMENT");
    } else if (!options.target) {
      options.target = arg;
    } else {
      throw new ResolveError(`Unexpected argument: ${arg}`, "INVALID_ARGUMENT");
    }
  }
  return options;
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  assertAllowedMediaUrl(url);
  let response: Response;
  try {
    // fetchMedia revalidates every redirect hop against the media allowlist.
    response = await fetchMedia(url, {
      signal: AbortSignal.any([AbortSignal.timeout(30_000), signal]),
    });
  } catch (error) {
    throw new ResolveError(
      error instanceof Error ? error.message : "The playlist request failed.",
      "HTTP_ERROR",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ResolveError(`The playlist returned HTTP ${response.status}.`, "HTTP_ERROR");
  }
  return response.text();
}

/**
 * Resolve the selected format to a media playlist. Resolver formats are
 * already media playlists; the master fallback only exists for safety.
 */
async function loadMediaPlaylist(url: string, signal: AbortSignal): Promise<MediaPlaylist> {
  const text = await fetchText(url, signal);
  const variants = parseMasterPlaylist(text, url);
  if (variants) {
    const variant = variants[0];
    if (!variant) throw new ResolveError("The master playlist has no variants.", "EMPTY_PLAYLIST");
    return parseMediaPlaylist(await fetchText(variant, signal), variant);
  }
  return parseMediaPlaylist(text, url);
}

function defaultOutput(result: ResolveResult, mp4: boolean): string {
  const extension = mp4 ? ".mp4" : ".ts";
  if (result.kind === "hidden") {
    const started = Math.floor(Date.parse(result.startedAt) / 1000);
    return join("downloads", `${result.channel}_${result.streamId}_${started}${extension}`);
  }
  if (result.kind === "live") {
    throw new ResolveError(
      "Downloading a live edge playlist is not supported. Use `twitch-m3u8 live <channel> --watch` to watch it, or wait for the VOD.",
      "LIVE_UNSUPPORTED",
    );
  }
  return join("downloads", `${result.videoId}${extension}`);
}

async function remuxToMp4(input: string, output: string): Promise<void> {
  const temporary = `${output}.tmp.mp4`;
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-c", "copy", temporary],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    await rm(temporary, { force: true });
    const detail = (result.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" ");
    throw new ResolveError(`ffmpeg could not remux the file${detail ? `: ${detail}` : "."}`, "REMUX_FAILED");
  }
  await rm(output, { force: true });
  await rename(temporary, output);
}

function assertFfmpeg(): void {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    throw new ResolveError(
      "ffmpeg was not found. Install ffmpeg or download as .ts (drop --remux).",
      "FFMPEG_MISSING",
    );
  }
}

export async function downloadCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(`${DOWNLOAD_HELP}\n`);
    return;
  }
  const options = parseDownloadArgs(args);
  if (!options.target) {
    throw new ResolveError("Provide a URL, ID, or video: target. Run download --help for examples.", "INVALID_ARGUMENT");
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const started = Date.now();
    const requestedOutput = options.output ? resolve(options.output) : null;
    const remux = options.remux || (requestedOutput?.toLowerCase().endsWith(".mp4") ?? false);
    if (remux && requestedOutput && !requestedOutput.toLowerCase().endsWith(".mp4")) {
      throw new ResolveError("--remux requires an output path ending in .mp4.", "INVALID_ARGUMENT");
    }
    // Fail before downloading gigabytes when ffmpeg is required but missing.
    if (remux) assertFfmpeg();
    const result = await resolveM3U8(options.target, {
      timestampWindow: options.timestampWindow,
      signal: controller.signal,
      ...(options.channel ? { channel: options.channel } : {}),
    });
    if (result.kind === "live") {
      throw new ResolveError(
        "Downloading a live edge playlist is not supported. Use `twitch-m3u8 live <channel> --watch` to watch it, or wait for the VOD.",
        "LIVE_UNSUPPORTED",
      );
    }
    const format = chooseFormat(result.formats, options.quality);
    const requested = requestedOutput ?? resolve(defaultOutput(result, remux));
    const tsPath = remux ? requested.replace(/\.mp4$/i, ".ts") : requested;

    if (stderr.isTTY) {
      stderr.write(`Resolving ${result.kind === "hidden" ? result.canonicalTarget : `VOD ${result.videoId}`} (${format.id})...\n`);
    }
    const playlist = await loadMediaPlaylist(format.url, controller.signal);
    if (!playlist.endList) {
      stderr.write("Warning: the playlist has no ENDLIST; this VOD may still be recording.\n");
    }
    await mkdir(dirname(tsPath), { recursive: true });
    if (stderr.isTTY && playlist.segments.length > 0) {
      stderr.write(`Downloading ${playlist.segments.length} segments to ${tsPath}...\n`);
    }

    let lastLine = 0;
    const downloaded = await downloadPlaylist({
      playlist,
      output: tsPath,
      concurrency: options.concurrency,
      force: options.force,
      signal: controller.signal,
      onProgress: ({ written, total, bytes }) => {
        if (!stderr.isTTY) return;
        const now = Date.now();
        if (now - lastLine < 1000 && written < total) return;
        lastLine = now;
        const megaBytes = bytes / (1024 * 1024);
        const elapsed = Math.max((now - started) / 1000, 0.001);
        const percent = String(Math.floor((written / total) * 100)).padStart(3, " ");
        stderr.write(
          `\r${percent}% · ${written}/${total} segments · ${megaBytes.toFixed(1)} MB · ${(megaBytes / elapsed).toFixed(1)} MB/s`,
        );
      },
    });
    if (stderr.isTTY && playlist.segments.length > 0) stderr.write("\n");

    let finalPath = tsPath;
    let remuxed = false;
    if (remux) {
      await remuxToMp4(tsPath, requested);
      finalPath = requested;
      remuxed = true;
      if (!options.keepTs) await rm(tsPath, { force: true });
    }
    const seconds = (Date.now() - started) / 1000;
    if (options.json) {
      stdout.write(
        `${JSON.stringify({
          output: finalPath,
          bytes: downloaded.bytes,
          segments: downloaded.segments,
          durationSeconds: playlist.totalDurationSeconds,
          resumedFrom: downloaded.resumedFrom,
          seconds,
          remuxed,
        })}\n`,
      );
    } else {
      stdout.write(`${finalPath}\n`);
      if (stderr.isTTY) {
        stderr.write(
          `Saved ${downloaded.segments} segments (${(downloaded.bytes / (1024 * 1024)).toFixed(1)} MB) in ${seconds.toFixed(1)}s` +
            `${downloaded.resumedFrom > 0 ? ` (resumed from segment ${downloaded.resumedFrom})` : ""}.\n`,
        );
      }
    }
  } catch (error) {
    const aborted = controller.signal.aborted;
    const message = aborted
      ? "Download interrupted. Run the same command to resume."
      : error instanceof Error
        ? error.message
        : String(error);
    const code = error instanceof DownloadError || error instanceof ResolveError ? error.code : "ERROR";
    process.exitCode = aborted ? 130 : 1;
    if (options.json) stdout.write(`${JSON.stringify({ status: "error", error: { code, message } })}\n`);
    else stderr.write(`Error: ${message}\n`);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
