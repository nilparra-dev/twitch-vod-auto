import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, readFile, rename, rm, stat, truncate, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { array, ChatError, nullableString, number, parseStoredMessage, record, string, type ChatMessage, type VideoMetadata } from "./model.js";
import type { ChatSource } from "./twitch.js";

interface PageRecord {
  cursor: string | null;
  nextCursor: string | null;
  messages: ChatMessage[];
}

interface Manifest {
  schemaVersion: 1;
  vodId: string;
  video: VideoMetadata | null;
  coverage: "available-replay";
  status: "partial" | "complete" | "empty" | "unavailable" | "failed";
  messageCount: number;
  pageCount: number;
  updatedAt: string;
  error: { code: string; message: string } | null;
}

/**
 * Internal resume state for `pages.jsonl`. It is not part of the exported chat
 * JSON; the player only reads the final output.
 */
interface Checkpoint {
  schemaVersion: 1;
  /** Committed length of pages.jsonl covered by this state. */
  journalBytes: number;
  pageCount: number;
  messageCount: number;
  /** Cursor for the next request; null once the replay is complete. */
  cursor: string | null;
  complete: boolean;
  lastOffsetSeconds: number;
  /** Newest message IDs, oldest first, for overlap and duplicate checks. */
  recentIds: string[];
  updatedAt: string;
}

/** Bounds resume memory. Ordering checks still catch older duplicates. */
const RECENT_ID_LIMIT = 5000;
/** Bounds cursor-loop detection; older repeats surface as out-of-order data. */
const RECENT_CURSOR_LIMIT = 128;

interface ResumeState {
  pageCount: number;
  messageCount: number;
  cursor: string | null;
  complete: boolean;
  lastOffset: number;
  recentIds: Set<string>;
  cursors: Set<string>;
}

function emptyResumeState(): ResumeState {
  return {
    pageCount: 0,
    messageCount: 0,
    cursor: null,
    complete: false,
    lastOffset: 0,
    recentIds: new Set(),
    cursors: new Set(),
  };
}

function rememberRecent<T>(set: Set<T>, value: T, limit: number): void {
  set.add(value);
  if (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

export interface DownloadOptions {
  vodId: string;
  output: string;
  source: ChatSource;
  signal?: AbortSignal;
  onProgress?: (progress: { messages: number; pages: number; offsetSeconds: number }) => void;
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Remove a lock left behind by a crashed downloader. Only a lock whose recorded
 * PID is gone on this host counts as stale; anything else stays locked.
 */
async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const lock = parsed as Record<string, unknown>;
    if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid) || lock.pid <= 0) return false;
    if (lock.host !== hostname()) return false;
    try {
      process.kill(lock.pid, 0);
      return false;
    } catch (error) {
      if (!isFsError(error, "ESRCH")) return false;
      await rm(lockPath, { force: true });
      return true;
    }
  } catch {
    return false;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w");
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

function storedVideo(value: unknown): VideoMetadata | null {
  if (value === null) return null;
  const video = record(value);
  const stream = video.stream === null ? null : record(video.stream);
  return {
    vodId: string(video.vodId), title: string(video.title), createdAt: string(video.createdAt),
    durationSeconds: number(video.durationSeconds), status: string(video.status), channel: nullableString(video.channel),
    stream: stream === null ? null : {
      channel: string(stream.channel), streamId: string(stream.streamId), startedAtSeconds: number(stream.startedAtSeconds),
    },
  };
}

function parsePage(line: string): PageRecord {
  const page = record(JSON.parse(line));
  return {
    cursor: nullableString(page.cursor),
    nextCursor: nullableString(page.nextCursor),
    messages: array(page.messages).map(parseStoredMessage),
  };
}

async function* pagesFrom(path: string, start: number): AsyncGenerator<PageRecord> {
  const input = createReadStream(path, { encoding: "utf8", start });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      yield parsePage(line);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function pages(path: string): AsyncGenerator<PageRecord> {
  return pagesFrom(path, 0);
}

// A newline commits one whole page. After an interrupted append, discard only
// the uncommitted tail; malformed committed data is an error, never silently lost.
async function recoverTail(path: string): Promise<void> {
  const file = await open(path, "r+").catch((error: unknown) => {
    if (!isFsError(error, "ENOENT")) throw error;
    return open(path, "wx+");
  });
  try {
    let position = (await file.stat()).size;
    const buffer = Buffer.alloc(64 * 1024);
    while (position > 0) {
      const start = Math.max(0, position - buffer.length);
      const { bytesRead } = await file.read(buffer, 0, position - start, start);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (newline >= 0) {
        await file.truncate(start + newline + 1);
        return;
      }
      position = start;
    }
    await file.truncate(0);
  } finally {
    await file.close();
  }
}

function parseCheckpoint(value: unknown): Checkpoint | null {
  try {
    const data = record(value);
    const { journalBytes, pageCount, messageCount, cursor, complete, lastOffsetSeconds, recentIds } = data;
    if (
      data.schemaVersion !== 1 ||
      typeof journalBytes !== "number" || !Number.isSafeInteger(journalBytes) || journalBytes < 0 ||
      typeof pageCount !== "number" || !Number.isSafeInteger(pageCount) || pageCount < 0 ||
      typeof messageCount !== "number" || !Number.isSafeInteger(messageCount) || messageCount < 0 ||
      (cursor !== null && typeof cursor !== "string") ||
      typeof complete !== "boolean" ||
      typeof lastOffsetSeconds !== "number" || !Number.isFinite(lastOffsetSeconds) || lastOffsetSeconds < 0 ||
      !Array.isArray(recentIds) || recentIds.some((id) => typeof id !== "string")
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      journalBytes,
      pageCount,
      messageCount,
      cursor,
      complete,
      lastOffsetSeconds,
      recentIds,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function readCheckpoint(path: string): Promise<Checkpoint | null> {
  try {
    return parseCheckpoint(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

async function fileSize(path: string): Promise<number> {
  return stat(path).then(
    (info) => info.size,
    () => 0,
  );
}

async function saveCheckpoint(path: string, state: ResumeState, journalBytes: number): Promise<void> {
  const checkpoint: Checkpoint = {
    schemaVersion: 1,
    journalBytes,
    pageCount: state.pageCount,
    messageCount: state.messageCount,
    cursor: state.cursor,
    complete: state.complete,
    lastOffsetSeconds: state.lastOffset,
    recentIds: [...state.recentIds],
    updatedAt: new Date().toISOString(),
  };
  await atomicJson(path, checkpoint);
}

/**
 * Validate and apply one committed page to the resume state. Used when
 * scanning a legacy journal and when catching up pages committed after the
 * checkpoint, so both paths enforce the same invariants.
 */
function applyPage(state: ResumeState, page: PageRecord): void {
  if (state.complete || page.cursor !== state.cursor || (page.nextCursor !== null && state.cursors.has(page.nextCursor))) {
    throw new ChatError("INVALID_ARCHIVE", "Archive pagination chain is inconsistent.");
  }
  for (const message of page.messages) {
    if (state.recentIds.has(message.id) || message.offsetSeconds < state.lastOffset) {
      throw new ChatError("INVALID_ARCHIVE", "Archive messages are duplicated or out of order.");
    }
    rememberRecent(state.recentIds, message.id, RECENT_ID_LIMIT);
    state.lastOffset = message.offsetSeconds;
  }
  if (page.nextCursor !== null) rememberRecent(state.cursors, page.nextCursor, RECENT_CURSOR_LIMIT);
  state.cursor = page.nextCursor;
  state.complete = state.cursor === null;
  state.pageCount += 1;
  state.messageCount += page.messages.length;
}

/** Rebuild resume state by reading the whole journal. Legacy archives only. */
async function scanJournal(journal: string, signal?: AbortSignal): Promise<ResumeState> {
  const state = emptyResumeState();
  for await (const page of pages(journal)) {
    signal?.throwIfAborted();
    applyPage(state, page);
  }
  return state;
}

/**
 * Rebuild resume state from the checkpoint plus any pages committed after it.
 * Returns null when the checkpoint cannot describe the journal and a full scan
 * is required.
 */
async function resumeFromCheckpoint(
  checkpoint: Checkpoint,
  journal: string,
  signal?: AbortSignal,
): Promise<ResumeState | null> {
  const journalBytes = await fileSize(journal);
  if (journalBytes < checkpoint.journalBytes) return null;
  const state: ResumeState = {
    pageCount: checkpoint.pageCount,
    messageCount: checkpoint.messageCount,
    cursor: checkpoint.cursor,
    complete: checkpoint.complete,
    lastOffset: checkpoint.lastOffsetSeconds,
    recentIds: new Set(checkpoint.recentIds.slice(-RECENT_ID_LIMIT)),
    cursors: new Set(checkpoint.cursor === null ? [] : [checkpoint.cursor]),
  };
  if (journalBytes > checkpoint.journalBytes) {
    for await (const page of pagesFrom(journal, checkpoint.journalBytes)) {
      signal?.throwIfAborted();
      applyPage(state, page);
    }
  }
  return state;
}

async function exportJson(args: { output: string; manifest: Manifest; journal: string; signal?: AbortSignal }): Promise<void> {
  const temporary = `${args.output}.tmp`;
  const file = await open(temporary, "w");
  try {
    const header = JSON.stringify(args.manifest);
    await file.writeFile(`${header.slice(0, -1)},"messages":[\n`);
    let first = true;
    for await (const page of pages(args.journal)) {
      args.signal?.throwIfAborted();
      if (page.messages.length > 0) {
        await file.writeFile(`${first ? "" : ",\n"}${page.messages.map((message) => JSON.stringify(message)).join(",\n")}`);
        first = false;
      }
    }
    await file.writeFile("\n]}\n");
    await file.sync();
  } finally {
    await file.close();
  }
  // Publish atomically without replacing a file another process may have created.
  try {
    await link(temporary, args.output);
  } catch (error) {
    if (
      !isFsError(error, "EPERM") &&
      !isFsError(error, "ENOSYS") &&
      !isFsError(error, "EXDEV") &&
      !isFsError(error, "EACCES")
    )
      throw error;
    // Some filesystems cannot create hard links. COPYFILE_EXCL keeps the
    // no-overwrite guarantee without a hard link.
    await copyFile(temporary, args.output, constants.COPYFILE_EXCL);
  }
  await rm(temporary, { force: true });
}

export async function downloadChat(options: DownloadOptions): Promise<Manifest> {
  if (!/^\d+$/.test(options.vodId)) throw new ChatError("INVALID_VOD_ID", "Chat requires a numeric VOD ID, not a stream ID.");
  const output = resolve(options.output);
  if (!output.toLowerCase().endsWith(".json")) throw new ChatError("INVALID_OUTPUT", "The output must end in .json.");
  const directory = `${output}.archive`;
  await mkdir(dirname(output), { recursive: true });
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, "lock");
  let lock: FileHandle | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lock = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (!isFsError(error, "EEXIST")) throw error;
      if (attempt === 0 && (await removeStaleLock(lockPath))) continue;
      throw new ChatError("ARCHIVE_LOCKED", `Archive is locked. If no downloader is running, remove ${lockPath} and retry.`);
    }
  }
  if (!lock) {
    throw new ChatError("ARCHIVE_LOCKED", `Archive is locked. If no downloader is running, remove ${lockPath} and retry.`);
  }
  const manifestPath = join(directory, "manifest.json");
  const checkpointPath = join(directory, "checkpoint.json");
  const journal = join(directory, "pages.jsonl");
  let manifest: Manifest = {
    schemaVersion: 1, vodId: options.vodId, video: null, coverage: "available-replay",
    status: "partial", messageCount: 0, pageCount: 0, updatedAt: new Date().toISOString(), error: null,
  };
  let state = emptyResumeState();
  let canSave = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
    let existing = false;
    try {
      const stored = record(JSON.parse(await readFile(manifestPath, "utf8")));
      if (stored.schemaVersion !== 1 || stored.vodId !== options.vodId || stored.coverage !== "available-replay") {
        throw new ChatError("ARCHIVE_MISMATCH", "This archive belongs to a different VOD or schema version. Choose another output.");
      }
      manifest.video = storedVideo(stored.video);
      if (manifest.video && manifest.video.vodId !== options.vodId) throw new ChatError("ARCHIVE_MISMATCH", "Stored video identity does not match this archive.");
      existing = true;
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error;
    }
    try {
      await stat(output);
      throw new ChatError("OUTPUT_EXISTS", "Output already exists. Use the saved JSON, or choose another filename. Existing files are never overwritten.");
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error;
    }
    if (!existing) {
      try {
        if ((await stat(journal)).size > 0) throw new ChatError("ARCHIVE_MISMATCH", "Journal has no manifest. Choose another output.");
      } catch (error) {
        if (!isFsError(error, "ENOENT")) throw error;
      }
      await atomicJson(manifestPath, manifest);
    }
    canSave = true;
    await recoverTail(journal);
    const checkpoint = await readCheckpoint(checkpointPath);
    state =
      (checkpoint ? await resumeFromCheckpoint(checkpoint, journal, options.signal) : null) ??
      (await scanJournal(journal, options.signal));
    await saveCheckpoint(checkpointPath, state, await fileSize(journal));
    manifest.pageCount = state.pageCount;
    manifest.messageCount = state.messageCount;
    if (!state.complete) {
      options.signal?.throwIfAborted();
      manifest.video = await options.source.video(options.vodId);
      if (manifest.video && manifest.video.vodId !== options.vodId) throw new ChatError("VOD_MISMATCH", "Twitch returned metadata for another VOD.");
      if (manifest.video && manifest.video.status !== "RECORDED") {
        throw new ChatError("VOD_NOT_FINISHED", "The VOD is still recording or processing. Run this command after it has finished.");
      }
      await atomicJson(manifestPath, manifest);
      const file = await open(journal, "a");
      try {
        while (!state.complete) {
          options.signal?.throwIfAborted();
          const page = await options.source.page({ vodId: options.vodId, cursor: state.cursor, offsetSeconds: state.lastOffset });
          options.signal?.throwIfAborted();
          if (page.continuation === "offset" && state.recentIds.size > 0 && !page.messages.some((message) => state.recentIds.has(message.id))) {
            throw new ChatError("COVERAGE_GAP", "Time-based pagination did not overlap saved messages. Keeping a partial archive rather than skipping chat.");
          }
          if (page.nextCursor !== null && (page.nextCursor === "" || state.cursors.has(page.nextCursor))) {
            throw new ChatError("PAGINATION_STALLED", "Chat cursor repeated. Saved pages remain resumable.");
          }
          const messages: ChatMessage[] = [];
          for (const message of page.messages) {
            if (state.recentIds.has(message.id)) continue;
            if (message.offsetSeconds < state.lastOffset) throw new ChatError("OUT_OF_ORDER", "Twitch returned chat out of order. Saved pages remain resumable.");
            rememberRecent(state.recentIds, message.id, RECENT_ID_LIMIT);
            state.lastOffset = message.offsetSeconds;
            messages.push(message);
          }
          if (page.nextCursor !== null && messages.length === 0) {
            throw new ChatError("PAGINATION_STALLED", "Chat pagination made no progress. Saved pages remain resumable.");
          }
          const position = (await file.stat()).size;
          try {
            await file.writeFile(`${JSON.stringify({ cursor: state.cursor, nextCursor: page.nextCursor, messages })}\n`);
            await file.sync();
          } catch (error) {
            await truncate(journal, position);
            throw error;
          }
          state.cursor = page.nextCursor;
          state.complete = state.cursor === null;
          if (state.cursor !== null) rememberRecent(state.cursors, state.cursor, RECENT_CURSOR_LIMIT);
          state.pageCount += 1;
          state.messageCount += messages.length;
          manifest.pageCount = state.pageCount;
          manifest.messageCount = state.messageCount;
          await saveCheckpoint(checkpointPath, state, (await file.stat()).size);
          options.onProgress?.({ messages: state.messageCount, pages: state.pageCount, offsetSeconds: state.lastOffset });
        }
      } finally {
        await file.close();
      }
    }
    manifest.status = state.messageCount > 0 ? "complete" : "empty";
    manifest.updatedAt = new Date().toISOString();
    await atomicJson(manifestPath, manifest);
    await exportJson({ output, manifest, journal, ...(options.signal ? { signal: options.signal } : {}) });
    return manifest;
  } catch (error) {
    if (canSave) {
      manifest.pageCount = state.pageCount;
      manifest.messageCount = state.messageCount;
      const code = error instanceof ChatError ? error.code : options.signal?.aborted ? "CANCELLED" : "IO_ERROR";
      manifest.status = manifest.pageCount > 0 ? "partial" : code === "CHAT_UNAVAILABLE" ? "unavailable" : "failed";
      manifest.error = { code, message: error instanceof Error ? error.message : String(error) };
      manifest.updatedAt = new Date().toISOString();
      await atomicJson(manifestPath, manifest).catch(() => undefined);
    }
    throw error;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
