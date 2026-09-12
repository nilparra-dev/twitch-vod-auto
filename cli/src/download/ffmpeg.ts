/**
 * ffmpeg integration for the download command. The CLI keeps working without
 * ffmpeg; this module only takes over when a container conversion or a
 * verification step needs it.
 *
 * `findFfmpeg` resolves the binary from an explicit path, the
 * `TWITCH_VOD_M3U8_FFMPEG` environment variable or PATH. `runFfmpeg` supervises
 * a remux process with progress parsing and cancellation. `probeDuration`
 * checks the result with ffprobe so a bad mux does not pass as success.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const PROBE_TIMEOUT_MS = 10_000;
const DURATION_TIMEOUT_MS = 60_000;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_PROGRESS_BUFFER = 64 * 1024;

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: string = "FFMPEG_FAILED",
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

export interface FfmpegTools {
  /** Executable used to run ffmpeg. */
  ffmpeg: string;
  /** ffprobe next to ffmpeg, or on PATH; null when neither exists. */
  ffprobe: string | null;
  /** First line reported by `ffmpeg -version`. */
  version: string;
}

export interface FfmpegProgress {
  /** Media time written so far, in milliseconds. */
  outTimeMs: number | null;
  /** Muxed bytes reported by ffmpeg, when it knows them. */
  totalSizeBytes: number | null;
  /** Raw speed string, for example "95.1x". */
  speed: string | null;
}

type SpawnFunction = typeof spawn;

function probeFirstLine(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const line = (result.stdout ?? "").split(/\r?\n/)[0]?.trim() ?? "";
  return line.length > 0 ? line : null;
}

function findFfprobe(ffmpeg?: string): string | null {
  if (ffmpeg) {
    const sibling = join(dirname(ffmpeg), basename(ffmpeg).replace(/^ffmpeg/i, "ffprobe"));
    if (existsSync(sibling) && /^ffprobe version/i.test(probeFirstLine(sibling, ["-version"]) ?? "")) {
      return sibling;
    }
  }
  const onPath = probeFirstLine("ffprobe", ["-version"]);
  return onPath !== null && /^ffprobe version/i.test(onPath) ? "ffprobe" : null;
}

/**
 * Resolve the ffmpeg binary. Returns null when ffmpeg is not on PATH and no
 * explicit path was requested. An explicit path, or one from the environment,
 * must point to a working ffmpeg or the call fails with `FFMPEG_INVALID`.
 */
export function findFfmpeg(explicit?: string): FfmpegTools | null {
  const requested = explicit ?? process.env.TWITCH_VOD_M3U8_FFMPEG;
  if (requested) {
    const version = probeFirstLine(requested, ["-version"]);
    if (version === null || !/^ffmpeg version/i.test(version)) {
      throw new FfmpegError(`The ffmpeg path is not a working ffmpeg binary: ${requested}`, "FFMPEG_INVALID");
    }
    return { ffmpeg: requested, ffprobe: findFfprobe(requested), version };
  }
  const version = probeFirstLine("ffmpeg", ["-version"]);
  if (version === null || !/^ffmpeg version/i.test(version)) return null;
  return { ffmpeg: "ffmpeg", ffprobe: findFfprobe(), version };
}

/** Arguments for a stream copy. `faststart` moves the moov atom for MP4. */
export function buildRemuxArgs(input: string, output: string, faststart = false): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-y",
    "-i",
    input,
    "-c",
    "copy",
    ...(faststart ? ["-movflags", "+faststart"] : []),
    output,
  ];
}

/** Parse one `-progress` key from ffmpeg. Returns null for unrelated lines. */
export function parseProgressLine(line: string): Partial<FfmpegProgress> | null {
  const match = /^(out_time_us|out_time_ms|total_size|speed)=(.+)$/.exec(line.trim());
  if (!match) return null;
  const key = match[1];
  const value = match[2] ?? "";
  if (key === "out_time_us" || key === "out_time_ms") {
    // ffmpeg reports both keys in microseconds, despite the ms name.
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? { outTimeMs: Math.round(parsed / 1000) } : null;
  }
  if (key === "total_size") {
    const parsed = Number.parseInt(value, 10);
    return { totalSizeBytes: Number.isFinite(parsed) ? parsed : null };
  }
  return { speed: value };
}

export interface RunFfmpegOptions {
  command: string;
  args: string[];
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: FfmpegProgress) => void) | undefined;
  /** Process factory, overridable for tests. */
  spawn?: SpawnFunction | undefined;
}

/**
 * Run ffmpeg to completion. Progress lines arrive on stdout; the last stderr
 * lines are kept for the error message. Aborting the signal kills the child.
 */
export async function runFfmpeg(options: RunFfmpegOptions): Promise<void> {
  options.signal?.throwIfAborted();
  const spawnFn = options.spawn ?? spawn;
  const progress: FfmpegProgress = { outTimeMs: null, totalSizeBytes: null, speed: null };
  let stdout = "";
  let stderr = "";
  let cancelled = false;
  const child = spawnFn(options.command, options.args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const onAbort = () => {
    cancelled = true;
    child.kill();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    let newline = stdout.indexOf("\n");
    while (newline !== -1) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      const update = parseProgressLine(line);
      if (update) {
        Object.assign(progress, update);
        options.onProgress?.({ ...progress });
      }
      newline = stdout.indexOf("\n");
    }
    // A malformed producer must not grow the buffer forever.
    if (stdout.length > MAX_PROGRESS_BUFFER) stdout = stdout.slice(-1024);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > MAX_STDERR_BYTES) stderr = stderr.slice(-MAX_STDERR_BYTES);
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", (error: Error) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (cancelled || options.signal?.aborted) {
        reject(new FfmpegError("ffmpeg was cancelled.", "FFMPEG_CANCELLED"));
        return;
      }
      reject(new FfmpegError(`Could not run ${options.command}: ${error.message}`, "FFMPEG_FAILED"));
    });
    child.once("close", (code: number | null) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (cancelled || options.signal?.aborted) {
        reject(new FfmpegError("ffmpeg was cancelled.", "FFMPEG_CANCELLED"));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" ");
      reject(
        new FfmpegError(
          `ffmpeg exited with code ${code}${detail ? `: ${detail}` : "."}`,
          "FFMPEG_FAILED",
        ),
      );
    });
  });
}

export interface RemuxOptions {
  tools: FfmpegTools;
  input: string;
  output: string;
  signal?: AbortSignal | undefined;
  /** Playlist duration, used to report progress as a percentage. */
  durationSeconds?: number | undefined;
  onProgress?: ((progress: FfmpegProgress & { percent: number | null }) => void) | undefined;
  spawn?: SpawnFunction | undefined;
}

/**
 * Stream copy `input` into `output` through a temporary file. The final name
 * appears only after ffmpeg succeeds; a failure removes the partial remux and
 * leaves the source untouched.
 */
export async function remuxToMp4(options: RemuxOptions): Promise<void> {
  const temporary = `${options.output}.tmp.mp4`;
  const durationMs = options.durationSeconds !== undefined ? options.durationSeconds * 1000 : null;
  try {
    await runFfmpeg({
      command: options.tools.ffmpeg,
      args: buildRemuxArgs(options.input, temporary, /\.mp4$/i.test(options.output)),
      signal: options.signal,
      spawn: options.spawn,
      onProgress: (progress) => {
        if (!options.onProgress) return;
        const percent =
          durationMs !== null && durationMs > 0 && progress.outTimeMs !== null
            ? Math.max(0, Math.min(100, Math.floor((progress.outTimeMs / durationMs) * 100)))
            : null;
        options.onProgress({ ...progress, percent });
      },
    });
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await rm(options.output, { force: true });
  await rename(temporary, options.output);
}

/** Parse the plain text written by `ffprobe -of default=nw=1:nk=1`. */
export function parseFfprobeDuration(text: string): number | null {
  const value = Number.parseFloat(text.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Read a media duration with ffprobe; null when ffprobe cannot answer. */
export function probeDuration(ffprobe: string, file: string): number | null {
  const result = spawnSync(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8", timeout: DURATION_TIMEOUT_MS, windowsHide: true },
  );
  if (result.error || result.status !== 0) return null;
  return parseFfprobeDuration(result.stdout ?? "");
}
