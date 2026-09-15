import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { allowedMediaUrl, fetchMedia } from "../net/media.js";
import type { MediaPlaylist } from "./playlist.js";
import { createTimestampRepair } from "./timestamps.js";

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
  /** Largest allowed response for one segment or init section. */
  maxSegmentBytes?: number;
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

/**
 * Identifies a playlist so a partial download cannot be resumed with another
 * one. Hashes every segment URI, not just the first and last, so two different
 * playlists that share their length and edge segments still differ.
 */
export function fingerprintPlaylist(playlist: MediaPlaylist): string {
  const hash = createHash("sha256");
  hash.update(`segments:${playlist.segments.length}\n`);
  hash.update(`init:${playlist.initSegment ?? ""}\n`);
  for (const segment of playlist.segments) {
    hash.update(segment.uri);
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * Fingerprint written by releases before the hashed format. It only covers the
 * playlist length and edge segments. Kept so an interrupted download can still
 * resume after an upgrade; the next snapshot rewrites it in the hashed format.
 * The weaker coverage matches what those releases already accepted.
 */
function legacyFingerprintPlaylist(playlist: MediaPlaylist): string {
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

/**
 * Result of reading the resume sidecar. A state written before timestamp
 * repair, or by the earlier PTS-only repair, may have left unset timestamps in
 * the partial file, so it cannot be completed into a playable download and is
 * reported as legacy.
 */
type StoredState = { kind: "ok"; state: ResumeState } | { kind: "legacy" } | { kind: "none" };

async function readState(path: string): Promise<StoredState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { kind: "none" };
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.fingerprint === "string" &&
      typeof record.segments === "number" &&
      Number.isInteger(record.segments) &&
      typeof record.bytes === "number" &&
      Number.isFinite(record.bytes)
    ) {
      if (record.timestampRepair !== 2) return { kind: "legacy" };
      return { kind: "ok", state: { fingerprint: record.fingerprint, segments: record.segments, bytes: record.bytes } };
    }
  } catch {
    /* Missing or corrupt state means starting over. */
  }
  return { kind: "none" };
}

async function writeState(path: string, state: ResumeState): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...state, timestampRepair: 2 }));
  await rename(temporary, path);
}

interface FetchSegmentOptions {
  uri: string;
  /** Zero-based segment position, used in error messages. */
  index: number;
  fetch: typeof fetch;
  signal: AbortSignal;
  attempts: number;
  retryDelayMs: number;
  timeoutMs: number;
  maxSegmentBytes: number;
}

/**
 * Fetch one segment with retries, the muted fallback and the size limit. Used
 * by the sequential concatenation and by the per-segment directory downloader.
 */
async function fetchSegment(options: FetchSegmentOptions): Promise<Buffer> {
  const { index } = options;
  let target = options.uri;
  let triedMuted = false;
  let attempt = 0;
  let lastError: unknown;
  while (attempt < options.attempts) {
    options.signal.throwIfAborted();
    try {
      assertAllowedMediaUrl(target);
      const timeout = AbortSignal.timeout(options.timeoutMs);
      // fetchMedia validates every redirect hop before following it.
      const response = await fetchMedia(target, {
        fetch: options.fetch,
        signal: AbortSignal.any([timeout, options.signal]),
      });
      if (response.ok) {
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > options.maxSegmentBytes) {
          await response.body?.cancel();
          throw new DownloadError(
            `Segment ${index + 1} exceeds the ${Math.round(options.maxSegmentBytes / (1024 * 1024))} MB size limit.`,
            "SEGMENT_TOO_LARGE",
          );
        }
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > options.maxSegmentBytes) {
          throw new DownloadError(
            `Segment ${index + 1} exceeds the ${Math.round(options.maxSegmentBytes / (1024 * 1024))} MB size limit.`,
            "SEGMENT_TOO_LARGE",
          );
        }
        return body;
      }
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
      options.signal.throwIfAborted();
      if (error instanceof DownloadError) throw error;
      lastError = error;
    }
    if (attempt + 1 < options.attempts) {
      await delay(Math.min(8000, options.retryDelayMs * 2 ** attempt) + Math.floor(Math.random() * 50), undefined, {
        signal: options.signal,
      });
    }
    attempt += 1;
  }
  throw new DownloadError(
    `Segment ${index + 1} failed after ${options.attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    "SEGMENT_FAILED",
  );
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
  const legacyExpected = legacyFingerprintPlaylist(playlist);

  if (!options.force && (await exists(output))) {
    throw new DownloadError(
      `Output already exists: ${output}. Use --force to overwrite or choose another path.`,
      "OUTPUT_EXISTS",
    );
  }

  let startIndex = 0;
  let bytes = 0;
  let resumed = false;
  const stored = await readState(statePath);
  if (stored.kind === "legacy") {
    // Older partials can contain unset PTS/DTS values, so completing them
    // would publish a file that still breaks players. Start over instead.
    await rm(part, { force: true });
    await rm(statePath, { force: true });
  }
  const state = stored.kind === "ok" ? stored.state : null;
  if (state) {
    if (state.fingerprint !== expected && state.fingerprint !== legacyExpected) {
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
  const maxSegmentBytes = options.maxSegmentBytes ?? 256 * 1024 * 1024;
  const concurrency = Math.max(1, Math.min(32, options.concurrency ?? 8));
  const fetchOptions = {
    fetch: fetchFn,
    signal,
    attempts,
    retryDelayMs,
    timeoutMs,
    maxSegmentBytes,
  };

  const pending = new Map<number, Promise<Buffer>>();
  const file = await open(part, resumed ? "a+" : "w");
  const repairTimestamps = createTimestampRepair();
  let written = startIndex;
  try {
    if (!resumed && playlist.initSegment) {
      const init = await fetchSegment({ ...fetchOptions, uri: playlist.initSegment, index: 0 });
      repairTimestamps.repair(init);
      await file.writeFile(init);
      bytes += init.length;
    }
    let nextFetch = startIndex;
    let lastSnapshot = startIndex - 1;
    const snapshot = () => writeState(statePath, { fingerprint: expected, segments: written, bytes });

    while (written < total) {
      while (pending.size < concurrency && nextFetch < total) {
        const segment = playlist.segments[nextFetch];
        if (segment) pending.set(nextFetch, fetchSegment({ ...fetchOptions, uri: segment.uri, index: nextFetch }));
        nextFetch += 1;
      }
      const buffer = pending.get(written);
      if (!buffer) throw new DownloadError("Internal downloader error.", "INTERNAL");
      const chunk = await buffer;
      pending.delete(written);
      repairTimestamps.repair(chunk);
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

export interface SegmentDownloadOptions {
  playlist: MediaPlaylist;
  /** Directory that keeps one file per segment so a run can resume. */
  directory: string;
  concurrency?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  maxSegmentBytes?: number;
  signal?: AbortSignal;
  /** Redownload even when the directory matches the playlist. */
  force?: boolean;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface SegmentDownloadResult {
  directory: string;
  bytes: number;
  segments: number;
  /** Segments that were already on disk and were reused. */
  reused: number;
  /** File name of the init segment inside the directory, when there is one. */
  init: string | null;
}

const FINGERPRINT_FILE = "fingerprint";

/**
 * Download every segment as its own file inside `directory`, in parallel and
 * without a fixed write order. A `fingerprint` file ties the directory to one
 * playlist: a different playlist (or `force`) wipes it and starts over, and an
 * interrupted run resumes from the segments already on disk. Each file is
 * written through a `.part` sibling and renamed, so a half-written segment is
 * never reused.
 */
export async function downloadSegments(options: SegmentDownloadOptions): Promise<SegmentDownloadResult> {
  const { playlist, directory } = options;
  const total = playlist.segments.length;
  if (total === 0) throw new DownloadError("The playlist has no segments.", "EMPTY_PLAYLIST");
  const expected = fingerprintPlaylist(playlist);
  const fingerprintPath = join(directory, FINGERPRINT_FILE);
  const matches = await readFile(fingerprintPath, "utf8")
    .then((value) => value.trim() === expected)
    .catch(() => false);
  if (options.force || !matches) {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    await writeFile(`${fingerprintPath}.tmp`, `${expected}\n`);
    await rename(`${fingerprintPath}.tmp`, fingerprintPath);
  }

  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const fetchFn = options.fetch ?? fetch;
  const attempts = Math.max(1, options.attempts ?? 4);
  const retryDelayMs = options.retryDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxSegmentBytes = options.maxSegmentBytes ?? 256 * 1024 * 1024;
  const concurrency = Math.max(1, Math.min(32, options.concurrency ?? 8));
  const fetchOptions = {
    fetch: fetchFn,
    signal,
    attempts,
    retryDelayMs,
    timeoutMs,
    maxSegmentBytes,
  };

  let bytes = 0;
  let reused = 0;
  let written = 0;
  let init: string | null = null;
  const pending = new Map<number, Promise<void>>();

  const existingSize = (path: string) => stat(path).then((info) => info.size, () => null);

  try {
    if (playlist.initSegment) {
      init = "init";
      const initPath = join(directory, init);
      const size = await existingSize(initPath);
      if (size !== null) {
        bytes += size;
      } else {
        const chunk = await fetchSegment({ ...fetchOptions, uri: playlist.initSegment, index: 0 });
        await writeFile(`${initPath}.part`, chunk);
        await rename(`${initPath}.part`, initPath);
        bytes += chunk.length;
      }
    }

    const pending = new Map<number, Promise<void>>();
    const writeSegment = async (index: number): Promise<void> => {
      const segment = playlist.segments[index];
      if (!segment) return;
      const path = join(directory, `${index}.ts`);
      const size = await existingSize(path);
      if (size !== null) {
        bytes += size;
        reused += 1;
      } else {
        const chunk = await fetchSegment({ ...fetchOptions, uri: segment.uri, index });
        createTimestampRepair().repair(chunk);
        await writeFile(`${path}.part`, chunk);
        await rename(`${path}.part`, path);
        bytes += chunk.length;
      }
      written += 1;
      options.onProgress?.({ written, total, bytes, resumed: reused > 0 });
    };

    let next = 0;
    while (next < total) {
      while (pending.size < concurrency && next < total) {
        const index = next;
        next += 1;
        pending.set(
          index,
          writeSegment(index).finally(() => pending.delete(index)),
        );
      }
      await Promise.race(pending.values());
    }
    await Promise.all(pending.values());
  } catch (error) {
    controller.abort();
    await Promise.allSettled([...pending.values()]);
    throw error;
  }

  return { directory, bytes, segments: total, reused, init };
}
