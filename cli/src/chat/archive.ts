import { createReadStream } from "node:fs";
import { link, mkdir, open, readFile, rename, rm, stat, truncate } from "node:fs/promises";
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

async function* pages(path: string): AsyncGenerator<PageRecord> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const page = record(JSON.parse(line));
      yield {
        cursor: nullableString(page.cursor), nextCursor: nullableString(page.nextCursor),
        messages: array(page.messages).map(parseStoredMessage),
      };
    }
  } finally {
    lines.close();
    input.destroy();
  }
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
  await link(temporary, args.output);
  await rm(temporary);
}

export async function downloadChat(options: DownloadOptions): Promise<Manifest> {
  if (!/^\d+$/.test(options.vodId)) throw new ChatError("INVALID_VOD_ID", "Chat requires a numeric VOD ID, not a stream ID.");
  const output = resolve(options.output);
  if (!output.toLowerCase().endsWith(".json")) throw new ChatError("INVALID_OUTPUT", "The output must end in .json.");
  const directory = `${output}.archive`;
  await mkdir(dirname(output), { recursive: true });
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, "lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (isFsError(error, "EEXIST")) {
      throw new ChatError("ARCHIVE_LOCKED", `Archive is locked. If no downloader is running, remove ${lockPath} and retry.`);
    }
    throw error;
  }
  const manifestPath = join(directory, "manifest.json");
  const journal = join(directory, "pages.jsonl");
  let manifest: Manifest = {
    schemaVersion: 1, vodId: options.vodId, video: null, coverage: "available-replay",
    status: "partial", messageCount: 0, pageCount: 0, updatedAt: new Date().toISOString(), error: null,
  };
  let canSave = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
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
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let complete = false;
    let lastOffset = 0;
    for await (const page of pages(journal)) {
      options.signal?.throwIfAborted();
      if (complete || page.cursor !== cursor || (page.nextCursor !== null && cursors.has(page.nextCursor))) {
        throw new ChatError("INVALID_ARCHIVE", "Archive pagination chain is inconsistent.");
      }
      for (const message of page.messages) {
        if (ids.has(message.id) || message.offsetSeconds < lastOffset) throw new ChatError("INVALID_ARCHIVE", "Archive messages are duplicated or out of order.");
        ids.add(message.id);
        lastOffset = message.offsetSeconds;
      }
      if (page.nextCursor !== null) cursors.add(page.nextCursor);
      cursor = page.nextCursor;
      complete = cursor === null;
      manifest.pageCount += 1;
    }
    manifest.messageCount = ids.size;
    if (!complete) {
      options.signal?.throwIfAborted();
      manifest.video = await options.source.video(options.vodId);
      if (manifest.video && manifest.video.vodId !== options.vodId) throw new ChatError("VOD_MISMATCH", "Twitch returned metadata for another VOD.");
      if (manifest.video && manifest.video.status !== "RECORDED") {
        throw new ChatError("VOD_NOT_FINISHED", "The VOD is still recording or processing. Run this command after it has finished.");
      }
      await atomicJson(manifestPath, manifest);
      const file = await open(journal, "a");
      try {
        while (!complete) {
          options.signal?.throwIfAborted();
          const page = await options.source.page({ vodId: options.vodId, cursor, offsetSeconds: lastOffset });
          options.signal?.throwIfAborted();
          if (page.continuation === "offset" && ids.size > 0 && !page.messages.some((message) => ids.has(message.id))) {
            throw new ChatError("COVERAGE_GAP", "Time-based pagination did not overlap saved messages. Keeping a partial archive rather than skipping chat.");
          }
          if (page.nextCursor !== null && (page.nextCursor === "" || cursors.has(page.nextCursor))) {
            throw new ChatError("PAGINATION_STALLED", "Chat cursor repeated. Saved pages remain resumable.");
          }
          const messages: ChatMessage[] = [];
          for (const message of page.messages) {
            if (ids.has(message.id)) continue;
            if (message.offsetSeconds < lastOffset) throw new ChatError("OUT_OF_ORDER", "Twitch returned chat out of order. Saved pages remain resumable.");
            ids.add(message.id);
            lastOffset = message.offsetSeconds;
            messages.push(message);
          }
          if (page.nextCursor !== null && messages.length === 0) {
            throw new ChatError("PAGINATION_STALLED", "Chat pagination made no progress. Saved pages remain resumable.");
          }
          const position = (await file.stat()).size;
          try {
            await file.writeFile(`${JSON.stringify({ cursor, nextCursor: page.nextCursor, messages })}\n`);
            await file.sync();
          } catch (error) {
            await truncate(journal, position);
            throw error;
          }
          cursor = page.nextCursor;
          complete = cursor === null;
          if (cursor !== null) cursors.add(cursor);
          manifest.messageCount += messages.length;
          manifest.pageCount += 1;
          options.onProgress?.({ messages: manifest.messageCount, pages: manifest.pageCount, offsetSeconds: lastOffset });
        }
      } finally {
        await file.close();
      }
    }
    manifest.status = manifest.messageCount > 0 ? "complete" : "empty";
    manifest.updatedAt = new Date().toISOString();
    await atomicJson(manifestPath, manifest);
    await exportJson({ output, manifest, journal, ...(options.signal ? { signal: options.signal } : {}) });
    return manifest;
  } catch (error) {
    if (canSave) {
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
