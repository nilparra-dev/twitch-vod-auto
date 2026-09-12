import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stderr, stdout } from "node:process";

import { chooseFormat, DEFAULT_TIMESTAMP_WINDOW, ResolveError, resolveM3U8 } from "../resolver.js";
import { fetchMedia } from "../net/media.js";
import type { ResolveResult } from "../types.js";
import { assertAllowedMediaUrl, DownloadError, downloadPlaylist } from "./fetcher.js";
import {
  FfmpegError,
  findFfmpeg,
  probeDuration,
  remuxToMp4,
  type FfmpegProgress,
  type FfmpegTools,
} from "./ffmpeg.js";
import { downloadHls } from "./hls.js";
import { downloadHybrid } from "./hybrid.js";
import { defaultCacheDir, provisionFfmpeg } from "./provision.js";
import { parseMasterPlaylist, parseMediaPlaylist, type MediaPlaylist } from "./playlist.js";

export const DOWNLOAD_HELP = `Download a Twitch VOD as a single file, without ffmpeg by default.

Usage:
  twitch-m3u8 download <URL|ID|video:...> [options]

Segments are fetched in parallel and written in order. An interrupted download
keeps a .part file and resumes when you run the same command again.

Options:
  -o, --output <file>       Output path (default downloads/<id>.ts)
  --output-dir <folder>     Folder for the generated file name (default downloads/)
  -q, --quality <name>      Quality to download; defaults to best
  --channel <channel>       Channel for a hidden stream ID
  --concurrency <n>         Parallel segment downloads (default 8, max 32)
  --engine <name>           Download engine: native (default), ffmpeg or hybrid
  --force                   Overwrite an existing output or partial download
  --remux                   Convert to MP4 with ffmpeg (-c copy, no re-encode)
  --ffmpeg-path <file>      ffmpeg binary to use (default: PATH or $TWITCH_VOD_M3U8_FFMPEG)
  --install-ffmpeg          Download a pinned LGPL ffmpeg build into the user cache
  --keep-ts                 Keep the intermediate .ts file after --remux
  --timestamp-window <secs> Search window for approximate timestamps (default ${DEFAULT_TIMESTAMP_WINDOW})
  --json                    Print structured JSON
  -h, --help                Show this help

Using an output path that ends in .mp4 implies --remux. --output and
--output-dir cannot be combined. The ffmpeg engine downloads the playlist
directly: it cannot resume, but it avoids the segment concatenation artifacts
of the native engine.

Examples:
  twitch-m3u8 download 2434567890
  twitch-m3u8 download "video:xqc_51582913581_1721686515" -q 720p60
  twitch-m3u8 download 51582913581 --channel xqc -o clip.ts
  twitch-m3u8 download 2434567890 --output-dir "D:\\VODs"
  twitch-m3u8 download "https://twitchtracker.com/xqc/streams/51582913581" -o clip.mp4`;

interface DownloadCliOptions {
  target?: string;
  output?: string;
  outputDir?: string;
  channel?: string;
  ffmpegPath?: string;
  installFfmpeg: boolean;
  quality: string;
  engine: "native" | "ffmpeg" | "hybrid";
  concurrency: number;
  force: boolean;
  remux: boolean;
  keepTs: boolean;
  json: boolean;
  timestampWindow: number;
}

export function parseDownloadArgs(args: string[]): DownloadCliOptions {
  const options: DownloadCliOptions = {
    quality: "best",
    engine: "native",
    concurrency: 8,
    force: false,
    remux: false,
    keepTs: false,
    json: false,
    installFfmpeg: false,
    timestampWindow: DEFAULT_TIMESTAMP_WINDOW,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (
      arg === "-o" ||
      arg === "--output" ||
      arg === "--output-dir" ||
      arg === "-q" ||
      arg === "--quality" ||
      arg === "--channel" ||
      arg === "--ffmpeg-path"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new ResolveError(`${arg} requires a value.`, "INVALID_ARGUMENT");
      if (arg === "-o" || arg === "--output") options.output = value;
      else if (arg === "--output-dir") options.outputDir = value;
      else if (arg === "--channel") options.channel = value;
      else if (arg === "--ffmpeg-path") options.ffmpegPath = value;
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
    } else if (arg === "--engine") {
      const value = args[index + 1];
      if (value !== "native" && value !== "ffmpeg" && value !== "hybrid") {
        throw new ResolveError("--engine must be native, ffmpeg or hybrid.", "INVALID_ARGUMENT");
      }
      options.engine = value;
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
    } else if (arg === "--install-ffmpeg") {
      options.installFfmpeg = true;
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
  if (options.output && options.outputDir) {
    throw new ResolveError("--output and --output-dir cannot be combined.", "INVALID_ARGUMENT");
  }
  return options;
}

/**
 * Where the download goes. An explicit `--output` path wins; otherwise the
 * file name is generated from the VOD identity and placed in `--output-dir` or
 * in `downloads/`. The intermediate `.ts` path only differs when remuxing.
 */
export interface OutputSelection {
  /** Resolved path from --output, or null to generate the file name. */
  output: string | null;
  /** Resolved directory from --output-dir, or null for the default downloads/ folder. */
  outputDir: string | null;
  /** True when the result is remuxed to MP4, which changes the generated extension. */
  remux: boolean;
}

export function selectOutputPaths(
  result: ResolveResult,
  selection: OutputSelection,
): { requested: string; tsPath: string } {
  const generatedName = defaultFileName(result, selection.remux);
  const requested =
    selection.output ??
    (selection.outputDir
      ? join(selection.outputDir, generatedName)
      : resolve(join("downloads", generatedName)));
  return { requested, tsPath: selection.remux ? requested.replace(/\.mp4$/i, ".ts") : requested };
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
interface MediaPlaylistSource {
  playlist: MediaPlaylist;
  text: string;
  baseUrl: string;
}

async function loadMediaPlaylist(url: string, signal: AbortSignal): Promise<MediaPlaylistSource> {
  const text = await fetchText(url, signal);
  const variants = parseMasterPlaylist(text, url);
  if (variants) {
    const variant = variants[0];
    if (!variant) throw new ResolveError("The master playlist has no variants.", "EMPTY_PLAYLIST");
    const variantText = await fetchText(variant, signal);
    return { playlist: parseMediaPlaylist(variantText, variant), text: variantText, baseUrl: variant };
  }
  return { playlist: parseMediaPlaylist(text, url), text, baseUrl: url };
}

/**
 * File name generated from the resolved VOD identity. The caller decides the
 * directory: `downloads/` by default, or the directory from `--output-dir`.
 */
function defaultFileName(result: ResolveResult, mp4: boolean): string {
  const extension = mp4 ? ".mp4" : ".ts";
  if (result.kind === "hidden") {
    const started = Math.floor(Date.parse(result.startedAt) / 1000);
    return `${result.channel}_${result.streamId}_${started}${extension}`;
  }
  return `${result.videoId}${extension}`;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function resolveFfmpegTools(options: DownloadCliOptions, signal: AbortSignal): Promise<FfmpegTools> {
  const tools = findFfmpeg(options.ffmpegPath);
  if (tools) return tools;
  if (options.installFfmpeg) {
    if (stderr.isTTY) stderr.write("Fetching a pinned LGPL ffmpeg build (one time)...\n");
    let lastLine = 0;
    try {
      return await provisionFfmpeg({
        signal,
        onStart: (release) => {
          stderr.write(`  ${release.url}\n  SHA-256: ${release.sha256}\n  Cache: ${defaultCacheDir()}\n`);
        },
        onProgress: ({ receivedBytes, totalBytes }) => {
          if (!stderr.isTTY) return;
          const now = Date.now();
          if (now - lastLine < 500) return;
          lastLine = now;
          const received = (receivedBytes / 1048576).toFixed(1);
          const total = totalBytes === null ? "" : `/${(totalBytes / 1048576).toFixed(1)}`;
          stderr.write(`\rDownloading ffmpeg ${received}${total} MB`);
        },
      });
    } finally {
      if (stderr.isTTY) stderr.write("\n");
    }
  }
  throw new ResolveError(
    "ffmpeg was not found. Install it, pass --ffmpeg-path <file>, or re-run with --install-ffmpeg.\n" +
      "  Windows: winget install --id Gyan.FFmpeg -e\n" +
      "  macOS:   brew install ffmpeg\n" +
      "  Linux:   sudo apt install ffmpeg",
    "FFMPEG_MISSING",
  );
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
  let phase: "download" | "remux" | "hls" = "download";
  try {
    const started = Date.now();
    const explicitOutput = options.output ? resolve(options.output) : null;
    const outputDirectory = options.outputDir ? resolve(options.outputDir) : null;
    const engine = options.engine;
    const wantsMp4 = options.remux || (explicitOutput?.toLowerCase().endsWith(".mp4") ?? false);
    if (engine === "native" && wantsMp4 && explicitOutput && !explicitOutput.toLowerCase().endsWith(".mp4")) {
      throw new ResolveError("--remux requires an output path ending in .mp4.", "INVALID_ARGUMENT");
    }
    if ((engine === "ffmpeg" || engine === "hybrid") && options.remux && explicitOutput && !explicitOutput.toLowerCase().endsWith(".mp4")) {
      throw new ResolveError("--engine ffmpeg writes the container directly; drop --remux or use an .mp4 output.", "INVALID_ARGUMENT");
    }
    const nativeRemux = engine === "native" && wantsMp4;
    // The ffmpeg-backed engines default to MP4, since converting is what they are for.
    const mp4Name = wantsMp4 || (engine !== "native" && explicitOutput === null);
    const needsFfmpeg = engine !== "native" || nativeRemux;
    // Fail before downloading gigabytes when ffmpeg is required but missing.
    const tools = needsFfmpeg ? await resolveFfmpegTools(options, controller.signal) : null;
    const result = await resolveM3U8(options.target, {
      timestampWindow: options.timestampWindow,
      signal: controller.signal,
      ...(options.channel ? { channel: options.channel } : {}),
    });
    const format = chooseFormat(result.formats, options.quality);
    const { requested, tsPath } = selectOutputPaths(result, {
      output: explicitOutput,
      outputDir: outputDirectory,
      remux: mp4Name,
    });

    if (stderr.isTTY) {
      stderr.write(`Resolving ${result.kind === "hidden" ? result.canonicalTarget : `VOD ${result.videoId}`} (${format.id})...\n`);
    }
    const source = await loadMediaPlaylist(format.url, controller.signal);
    const playlist = source.playlist;
    if (!playlist.endList) {
      stderr.write("Warning: the playlist has no ENDLIST; this VOD may still be recording.\n");
    }
    let finalPath = tsPath;
    let remuxed = false;
    let verified: boolean | null = null;
    let bytes = 0;
    let segments = playlist.segments.length;
    let resumedFrom = 0;

    if (engine === "ffmpeg" && tools) {
      phase = "hls";
      if (!options.force && (await exists(requested))) {
        throw new DownloadError(
          `Output already exists: ${requested}. Use --force to overwrite or choose another path.`,
          "OUTPUT_EXISTS",
        );
      }
      await mkdir(dirname(requested), { recursive: true });
      if (stderr.isTTY) {
        stderr.write(`Downloading ${segments} segments with ffmpeg to ${requested}...\n`);
      }
      let lastLine = 0;
      await downloadHls({
        tools,
        playlistText: source.text,
        playlistUrl: source.baseUrl,
        playlistPath: `${requested}.playlist.m3u8`,
        output: requested,
        durationSeconds: playlist.totalDurationSeconds,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.totalSizeBytes !== null) bytes = progress.totalSizeBytes;
          if (!stderr.isTTY) return;
          const now = Date.now();
          if (now - lastLine < 1000 && progress.percent !== 100) return;
          lastLine = now;
          const size = progress.totalSizeBytes === null ? "" : ` · ${(progress.totalSizeBytes / 1048576).toFixed(0)} MB`;
          stderr.write(`\rDownloading ${progress.percent ?? 0}%${size}${progress.speed ? ` · ${progress.speed}` : ""}`);
        },
      });
      if (stderr.isTTY) stderr.write("\n");
      finalPath = requested;
    } else if (engine === "hybrid" && tools) {
      if (!options.force && (await exists(requested))) {
        throw new DownloadError(
          `Output already exists: ${requested}. Use --force to overwrite or choose another path.`,
          "OUTPUT_EXISTS",
        );
      }
      const segmentDirectory = `${requested}.segments`;
      if (stderr.isTTY) {
        stderr.write(`Downloading ${segments} segments to ${segmentDirectory} (parallel)...\n`);
      }
      let lastLine = 0;
      const hybrid = await downloadHybrid({
        tools,
        playlist,
        directory: segmentDirectory,
        output: requested,
        concurrency: options.concurrency,
        durationSeconds: playlist.totalDurationSeconds,
        signal: controller.signal,
        onSegmentsProgress: ({ written, total, bytes: writtenBytes }) => {
          if (!stderr.isTTY) return;
          const now = Date.now();
          if (now - lastLine < 1000 && written < total) return;
          lastLine = now;
          const megaBytes = writtenBytes / (1024 * 1024);
          const percent = String(Math.floor((written / total) * 100)).padStart(3, " ");
          stderr.write(`\r${percent}% · ${written}/${total} segments · ${megaBytes.toFixed(1)} MB`);
        },
        onProgress: (progress) => {
          if (!stderr.isTTY) return;
          const now = Date.now();
          if (now - lastLine < 1000 && progress.percent !== 100) return;
          lastLine = now;
          const size = progress.totalSizeBytes === null ? "" : ` · ${(progress.totalSizeBytes / 1048576).toFixed(0)} MB`;
          stderr.write(`\rMuxing ${progress.percent ?? 0}%${size}${progress.speed ? ` · ${progress.speed}` : ""}`);
        },
      });
      if (stderr.isTTY) stderr.write("\n");
      bytes = hybrid.bytes;
      segments = hybrid.segments;
      resumedFrom = hybrid.reused;
      finalPath = requested;
    } else {
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
        onProgress: ({ written, total, bytes: writtenBytes }) => {
          if (!stderr.isTTY) return;
          const now = Date.now();
          if (now - lastLine < 1000 && written < total) return;
          lastLine = now;
          const megaBytes = writtenBytes / (1024 * 1024);
          const elapsed = Math.max((now - started) / 1000, 0.001);
          const percent = String(Math.floor((written / total) * 100)).padStart(3, " ");
          stderr.write(
            `\r${percent}% · ${written}/${total} segments · ${megaBytes.toFixed(1)} MB · ${(megaBytes / elapsed).toFixed(1)} MB/s`,
          );
        },
      });
      if (stderr.isTTY && playlist.segments.length > 0) stderr.write("\n");
      bytes = downloaded.bytes;
      segments = downloaded.segments;
      resumedFrom = downloaded.resumedFrom;

      if (nativeRemux && tools) {
        phase = "remux";
        if (stderr.isTTY) stderr.write(`Remuxing to ${requested} (stream copy)...\n`);
        let lastRemuxLine = 0;
        await remuxToMp4({
          tools,
          input: tsPath,
          output: requested,
          signal: controller.signal,
          durationSeconds: playlist.totalDurationSeconds,
          onProgress: (progress) => {
            if (!stderr.isTTY) return;
            const now = Date.now();
            if (now - lastRemuxLine < 1000 && progress.percent !== 100) return;
            lastRemuxLine = now;
            const size = progress.totalSizeBytes === null ? "" : ` · ${(progress.totalSizeBytes / 1048576).toFixed(0)} MB`;
            stderr.write(`\rRemuxing ${progress.percent ?? 0}%${size}${progress.speed ? ` · ${progress.speed}` : ""}`);
          },
        });
        if (stderr.isTTY) stderr.write("\n");
        finalPath = requested;
        remuxed = true;
        if (!options.keepTs) await rm(tsPath, { force: true });
      }
    }

    // The playlist duration is the reference; a mismatch means the output
    // dropped or added media, so surface it instead of reporting success.
    if (tools && (engine !== "native" || nativeRemux)) {
      const expectedSeconds = playlist.totalDurationSeconds;
      const actualSeconds = tools.ffprobe ? probeDuration(tools.ffprobe, finalPath) : null;
      if (actualSeconds !== null) {
        verified = Math.abs(actualSeconds - expectedSeconds) <= Math.max(2, expectedSeconds * 0.01);
        if (!verified && stderr.isTTY) {
          stderr.write(
            `Warning: the output duration (${actualSeconds.toFixed(1)}s) differs from the playlist (${expectedSeconds.toFixed(1)}s).\n`,
          );
        }
      }
    }

    const seconds = (Date.now() - started) / 1000;
    if (options.json) {
      stdout.write(
        `${JSON.stringify({
          output: finalPath,
          bytes,
          segments,
          durationSeconds: playlist.totalDurationSeconds,
          resumedFrom,
          seconds,
          engine,
          remuxed,
          verified,
        })}\n`,
      );
    } else {
      stdout.write(`${finalPath}\n`);
      if (stderr.isTTY) {
        stderr.write(
          `Saved ${segments} segments (${(bytes / (1024 * 1024)).toFixed(1)} MB) in ${seconds.toFixed(1)}s` +
            `${resumedFrom > 0 ? ` (resumed from segment ${resumedFrom})` : ""}.\n`,
        );
      }
    }
  } catch (error) {
    const aborted = controller.signal.aborted;
    const message = aborted
      ? phase === "remux"
        ? "Remux interrupted. The downloaded .ts file was kept; run the command again with --force to retry."
        : phase === "hls"
          ? "Download interrupted. The ffmpeg engine starts over on the next run."
          : "Download interrupted. Run the same command to resume."
      : error instanceof Error
        ? error.message
        : String(error);
    const code =
      error instanceof DownloadError || error instanceof ResolveError || error instanceof FfmpegError
        ? error.code
        : "ERROR";
    process.exitCode = aborted ? 130 : 1;
    if (options.json) stdout.write(`${JSON.stringify({ status: "error", error: { code, message } })}\n`);
    else stderr.write(`Error: ${message}\n`);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
