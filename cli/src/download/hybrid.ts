/**
 * Hybrid engine: parallel segment downloads into a temporary directory, then a
 * single ffmpeg pass over a concat list. It combines the native engine's
 * throughput and per-segment resume with ffmpeg's clean demuxing, at the cost
 * of keeping the segments on disk until the mux succeeds.
 *
 * The concat list references the segment files by name, relative to the list,
 * so no path needs escaping and ffmpeg only opens local files
 * (`-protocol_whitelist file`). The directory is removed only after the final
 * file is published; a failure keeps it so the next run reuses the segments.
 */

import { rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { runFfmpeg, type FfmpegProgress, type FfmpegTools } from "./ffmpeg.js";
import { downloadSegments, type DownloadProgress } from "./fetcher.js";
import type { MediaPlaylist } from "./playlist.js";

export interface HybridDownloadOptions {
  tools: FfmpegTools;
  playlist: MediaPlaylist;
  /** Temporary segment directory; kept on failure so a run can resume. */
  directory: string;
  output: string;
  concurrency?: number | undefined;
  durationSeconds?: number | undefined;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch | undefined;
  onSegmentsProgress?: ((progress: DownloadProgress) => void) | undefined;
  onProgress?: ((progress: FfmpegProgress & { percent: number | null }) => void) | undefined;
  spawn?: typeof import("node:child_process").spawn | undefined;
}

export interface HybridDownloadResult {
  bytes: number;
  segments: number;
  reused: number;
}

export async function downloadHybrid(options: HybridDownloadOptions): Promise<HybridDownloadResult> {
  const downloaded = await downloadSegments({
    playlist: options.playlist,
    directory: options.directory,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.onSegmentsProgress ? { onProgress: options.onSegmentsProgress } : {}),
  });

  const listPath = join(options.directory, "concat.txt");
  const lines: string[] = [];
  if (downloaded.init) lines.push(`file '${downloaded.init}'`);
  for (let index = 0; index < downloaded.segments; index += 1) lines.push(`file '${index}.ts'`);
  await writeFile(listPath, `${lines.join("\n")}\n`);

  const temporary = `${options.output}.tmp${extname(options.output) || ".mp4"}`;
  const durationMs = options.durationSeconds !== undefined ? options.durationSeconds * 1000 : null;
  try {
    await runFfmpeg({
      command: options.tools.ffmpeg,
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
        "-y",
        "-protocol_whitelist",
        "file",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        ...(/\.mp4$/i.test(options.output) ? ["-movflags", "+faststart"] : []),
        temporary,
      ],
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
  await rm(options.directory, { recursive: true, force: true });
  return { bytes: downloaded.bytes, segments: downloaded.segments, reused: downloaded.reused };
}
