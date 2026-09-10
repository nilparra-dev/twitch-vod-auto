import { open, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { allowedMediaUrl } from "../watch/media.js";
import type { MediaPlaylist } from "./playlist.js";

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly code: string = "DOWNLOAD_FAILED",
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

export interface DownloadProgress {
  written: number;
  total: number;
  bytes: number;
  resumed: boolean;
}

export interface DownloadOptions {
  playlist: MediaPlaylist;
  /** Final .ts path. A `<output>.part` file and its state sidecar are used while downloading. */
  output: string;
  concurrency?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  force?: boolean;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadResult {
  output: string;
  bytes: number;
  segments: number;
  /** Number of segments that were already written when the download resumed. */
  resumedFrom: number;
}

interface ResumeState {
  fingerprint: string;
  segments: number;
  bytes: number;
}

/** Identifies a playlist so a partial download cannot be resumed with another one. */
export function fingerprintPlaylist(playlist: MediaPlaylist): string {
  const first = playlist.segments[0]?.uri ?? "";
  const last = playlist.segments.at(-1)?.uri ?? "";
  return `${playlist.segments.length}|${playlist.initSegment ?? ""}|${first}|${last}`;
}

/**
 * Reject playlist entries that do not point at Twitch's media servers, the
 * same policy the local player proxy applies. The playlist itself comes from a
 * resolved Twitch URL, but its segment lines are still untrusted input.
 */
export function assertAllowedMediaUrl(url: string): void {
  try {
    allowedMediaUrl(url);
  } catch {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* Keep the raw value in the message. */
    }
    throw new DownloadError(`The playlist references a resource outside Twitch's media servers: ${host}`, "BLOCKED_URL");
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function readState(path: string): Promise<ResumeState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.fingerprint === "string" &&
      typeof record.segments === "number" &&
      Number.isInteger(record.segments) &&
      typeof record.bytes === "number" &&
      Number.isFinite(record.bytes)
    ) {
      return { fingerprint: record.fingerprint, segments: record.segments, bytes: record.bytes };
    }
  } catch {
    /* Missing or corrupt state means starting over. */
  }
  return null;
}

async function writeState(path: string, state: ResumeState): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(state));
  await rename(temporary, path);
}

/**
 * Download every segment and concatenate them, in order, into `output`.
 * Segments are fetched in parallel and written sequentially, so memory stays
 * bounded by the concurrency window. Interrupted downloads keep the `.part`
 * file plus a small state sidecar and resume on the next run.
 */
export async function downloadPlaylist(options: DownloadOptions): Promise<DownloadResult> {
  const { playlist, output } = options;
  const part = `${output}.part`;
  const statePath = `${part}.json`;
  const total = playlist.segments.length;
  if (total === 0) throw new DownloadError("The playlist has no segments.", "EMPTY_PLAYLIST");
  const expected = fingerprintPlaylist(playlist);

  if (!options.force && (await exists(output))) {
    throw new DownloadError(
      `Output already exists: ${output}. Use --force to overwrite or choose another path.`,
      "OUTPUT_EXISTS",
    );
  }

  let startIndex = 0;
  let bytes = 0;
  let resumed = false;
  const state = await readState(statePath);
  if (state) {
    if (state.fingerprint !== expected) {
      throw new DownloadError(
        `A partial download for a different playlist exists at ${part}. Remove it or use --force.`,
        "STATE_MISMATCH",
      );
    }
    const size = await stat(part).then(
      (info) => info.size,
      () => null,
    );
    if (size !== null && size >= state.bytes) {
      if (size > state.bytes) await truncate(part, state.bytes);
      startIndex = Math.min(state.segments, total);
      bytes = state.bytes;
      // Resuming appends: opening "r+" would write from position 0 and
      // overwrite what was already downloaded.
      resumed = bytes > 0;
    } else {
      await rm(part, { force: true });
      await rm(statePath, { force: true });
    }
  } else if (!options.force && (await exists(part))) {
    throw new DownloadError(
      `A partial download already exists at ${part}. Remove it or use --force.`,
      "PARTIAL_EXISTS",
    );
  }

  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const fetchFn = options.fetch ?? fetch;
  const attempts = Math.max(1, options.attempts ?? 4);
  const retryDelayMs = options.retryDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const concurrency = Math.max(1, Math.min(32, options.concurrency ?? 8));

  async function fetchSegment(uri: string, index: number): Promise<Buffer> {
    let target = uri;
    let triedMuted = false;
    let attempt = 0;
    let lastError: unknown;
    while (attempt < attempts) {
      signal.throwIfAborted();
      try {
        assertAllowedMediaUrl(target);
        const timeout = AbortSignal.timeout(timeoutMs);
        const response = await fetchFn(target, { signal: AbortSignal.any([timeout, signal]) });
        if (response.ok) return Buffer.from(await response.arrayBuffer());
        const status = response.status;
        await response.body?.cancel();
        // Archived playlists can keep an unavailable unmuted name while the
        // matching muted segment is still served with the same timing.
        if ((status === 403 || status === 404) && !triedMuted && target.endsWith("-unmuted.ts")) {
          triedMuted = true;
          target = target.replace(/-unmuted\.ts$/, "-muted.ts");
          continue;
        }
        if (status !== 429 && status < 500) {
          throw new DownloadError(`Segment ${index + 1} returned HTTP ${status}.`, "SEGMENT_HTTP_ERROR");
        }
        lastError = new Error(`HTTP ${status}`);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof DownloadError) throw error;
        lastError = error;
      }
      if (attempt + 1 < attempts) {
        await delay(Math.min(8000, retryDelayMs * 2 ** attempt) + Math.floor(Math.random() * 50), undefined, {
          signal,
        });
      }
      attempt += 1;
    }
    throw new DownloadError(
      `Segment ${index + 1} failed after ${attempts} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      "SEGMENT_FAILED",
    );
  }

  const pending = new Map<number, Promise<Buffer>>();
  const file = await open(part, resumed ? "a+" : "w");
  let written = startIndex;
  try {
    if (!resumed && playlist.initSegment) {
      const init = await fetchSegment(playlist.initSegment, 0);
      await file.writeFile(init);
      bytes += init.length;
    }
    let nextFetch = startIndex;
    let lastSnapshot = startIndex - 1;
    const snapshot = () => writeState(statePath, { fingerprint: expected, segments: written, bytes });

    while (written < total) {
      while (pending.size < concurrency && nextFetch < total) {
        const segment = playlist.segments[nextFetch];
        if (segment) pending.set(nextFetch, fetchSegment(segment.uri, nextFetch));
        nextFetch += 1;
      }
      const buffer = pending.get(written);
      if (!buffer) throw new DownloadError("Internal downloader error.", "INTERNAL");
      const chunk = await buffer;
      pending.delete(written);
      await file.writeFile(chunk);
      bytes += chunk.length;
      written += 1;
      if (written - lastSnapshot >= 10 || written === total) {
        await snapshot();
        lastSnapshot = written;
      }
      options.onProgress?.({ written, total, bytes, resumed });
    }
    await file.sync();
    await snapshot();
    await file.close();
  } catch (error) {
    controller.abort();
    await Promise.allSettled([...pending.values()]);
    await writeState(statePath, { fingerprint: expected, segments: written, bytes }).catch(() => undefined);
    await file.close().catch(() => undefined);
    throw error;
  }

  if (options.force) await rm(output, { force: true });
  await rename(part, output);
  await rm(statePath, { force: true });
  return { output, bytes, segments: written, resumedFrom: startIndex };
}
