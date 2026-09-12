/**
 * Download engine selection. `--engine auto` keeps the requested container and
 * only decides how an MP4 is produced, using data known before any media is
 * downloaded: the playlist structure, a first-segment size probe, free disk
 * space and the resume state. The decision is a pure function so it can be
 * tested as a matrix and reported with its reason.
 */

import { statfs } from "node:fs/promises";

import { fetchMedia } from "../net/media.js";
import type { MediaPlaylist } from "./playlist.js";

export type DownloadEngine = "native" | "ffmpeg" | "hybrid";

export interface EngineContext {
  /** Engine requested on the command line; "auto" runs the policy. */
  requested: "auto" | DownloadEngine;
  /** The user named an .mp4 output or passed --remux. */
  requestedMp4: boolean;
  keepTs: boolean;
  /** ffmpeg is on PATH (or the explicit path/env points at a working binary). */
  ffmpeg: boolean;
  /** --install-ffmpeg allows the CLI to fetch ffmpeg. */
  installFfmpeg: boolean;
  initSegment: boolean;
  discontinuities: number;
  estimatedBytes: number | null;
  freeBytes: number | null;
  nativeResume: boolean;
  hybridResume: boolean;
}

export interface EngineChoice {
  engine: DownloadEngine;
  reason: string;
}

/** The hybrid engine needs room for the segment directory plus the output. */
const HYBRID_DISK_FACTOR = 2.1;

export function selectEngine(context: EngineContext): EngineChoice {
  if (context.requested !== "auto") {
    return { engine: context.requested, reason: `selected with --engine ${context.requested}` };
  }
  if (context.hybridResume) {
    return { engine: "hybrid", reason: "a previous hybrid download can resume" };
  }
  if (context.nativeResume) {
    return { engine: "native", reason: "a previous native download can resume" };
  }
  if (context.keepTs) {
    return { engine: "native", reason: "--keep-ts keeps the intermediate .ts" };
  }
  if (!context.requestedMp4) {
    return { engine: "native", reason: "no MP4 conversion requested" };
  }
  if (!context.ffmpeg && !context.installFfmpeg) {
    return { engine: "native", reason: "MP4 needs ffmpeg" };
  }
  if (context.initSegment) {
    return { engine: "ffmpeg", reason: "the playlist uses fragmented MP4" };
  }
  if (context.discontinuities > 0) {
    return { engine: "ffmpeg", reason: `the playlist has ${context.discontinuities} discontinuities` };
  }
  if (
    context.estimatedBytes !== null &&
    context.freeBytes !== null &&
    context.freeBytes < context.estimatedBytes * HYBRID_DISK_FACTOR
  ) {
    return { engine: "ffmpeg", reason: "not enough free disk space for a parallel segment directory" };
  }
  return { engine: "hybrid", reason: "parallel segments with an ffmpeg concat" };
}

/** Total size reported by a `Content-Range` response header. */
export function parseContentRangeTotal(header: string | null): number | null {
  const match = /^bytes \d+-\d+\/(\d+)$/.exec(header ?? "");
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/** Scale the first segment's size to the whole playlist. */
export function scaleEstimatedBytes(
  firstBytes: number,
  firstDurationSeconds: number,
  totalDurationSeconds: number,
): number | null {
  if (!(firstBytes > 0) || !(firstDurationSeconds > 0) || !(totalDurationSeconds > 0)) return null;
  return Math.ceil((firstBytes / firstDurationSeconds) * totalDurationSeconds);
}

/**
 * One small range request gives the first segment's full size, which is enough
 * to estimate the archive size. Failures return null: an estimate must never
 * block a download, but an abort still propagates.
 */
export async function estimatePlaylistBytes(options: {
  playlist: MediaPlaylist;
  signal: AbortSignal;
  fetch?: typeof fetch | undefined;
}): Promise<number | null> {
  const first = options.playlist.segments[0];
  if (!first) return null;
  try {
    const response = await fetchMedia(first.uri, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      signal: options.signal,
      range: "bytes=0-0",
    });
    await response.body?.cancel();
    if (!response.ok) return null;
    return scaleEstimatedBytes(
      parseContentRangeTotal(response.headers.get("content-range")) ?? 0,
      first.durationSeconds,
      options.playlist.totalDurationSeconds,
    );
  } catch (error) {
    if (options.signal.aborted) throw error;
    return null;
  }
}

export async function freeDiskBytes(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}
