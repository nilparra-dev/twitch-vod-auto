import {
  number,
  parseStoredMessage,
  record,
  string,
  type ChatMessage,
} from "../../../cli/src/chat/model";

export type { ChatMessage } from "../../../cli/src/chat/model";
export interface ReplayFile {
  size: number;
  slice(start?: number, end?: number): Pick<Blob, "arrayBuffer">;
}
export interface ArchiveInfo {
  vodId: string;
  title: string;
  count: number;
  status: "complete" | "empty" | "partial";
}
interface Entry {
  start: number;
  end: number;
  time: number;
}
export interface ArchiveIndex {
  file: ReplayFile;
  entries: Entry[];
  info: ArchiveInfo;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const whitespace = (byte: number) => byte === 32 || byte === 10 || byte === 13 || byte === 9;

// Scan the JSON structurally as UTF-8 bytes. Keep only one message in memory and
// index its byte range; multibyte text must not shift subsequent file offsets.
export async function indexArchive(
  file: ReplayFile,
  progress: (percent: number) => void = () => {},
): Promise<ArchiveIndex> {
  const entries: Entry[] = [];
  const ids = new Set<string>();
  const metadata: number[] = [];
  let message: number[] = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let token: number[] = [];
  let lastString = "";
  let key = "";
  let insideMessages = false;
  let foundMessages = false;
  let messageStart = -1;
  let arrayState: "first" | "value" | "separator" = "first";
  const chunkSize = 256 * 1024;
  if (file.size > 4 * 1024 ** 3)
    throw new Error("Chat files larger than 4 GB are not supported yet.");
  for (let base = 0; base < file.size; base += chunkSize) {
    const chunk = new Uint8Array(await file.slice(base, base + chunkSize).arrayBuffer());
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const byte = chunk[offset];
      const position = base + offset;
      if (!insideMessages) metadata.push(byte);
      else if (messageStart >= 0) message.push(byte);
      if (metadata.length > 1024 * 1024 || message.length > 1024 * 1024)
        throw new Error("Chat metadata or a message exceeds the 1 MB limit.");
      if (quoted) {
        if (depth === 1) token.push(byte);
        if (escaped) escaped = false;
        else if (byte === 92) escaped = true;
        else if (byte === 34) {
          quoted = false;
          if (depth === 1) lastString = string(JSON.parse(decoder.decode(new Uint8Array(token))));
        }
        continue;
      }
      if (insideMessages && depth === 2 && messageStart < 0) {
        if (whitespace(byte)) continue;
        if (byte === 93) {
          if (arrayState === "value") throw new Error("Invalid trailing comma in chat messages.");
          insideMessages = false;
          depth -= 1;
          metadata.push(byte);
          continue;
        }
        if (arrayState === "separator") {
          if (byte !== 44) throw new Error("Expected a comma between chat messages.");
          arrayState = "value";
          continue;
        }
        if (byte !== 123) throw new Error("Each chat message must be an object.");
        messageStart = position;
        message = [byte];
      }
      if (byte === 34) {
        quoted = true;
        token = [byte];
      } else if (byte === 58 && depth === 1) {
        key = lastString;
      } else if (byte === 123 || byte === 91) {
        if (depth === 1 && byte === 91 && key === "messages") {
          if (foundMessages) throw new Error("Duplicate messages array.");
          insideMessages = true;
          foundMessages = true;
        }
        depth += 1;
      } else if (byte === 125 || byte === 93) {
        depth -= 1;
        if (insideMessages && depth === 2 && messageStart >= 0) {
          const parsed = parseStoredMessage(JSON.parse(decoder.decode(new Uint8Array(message))));
          if (ids.has(parsed.id)) throw new Error("Chat contains duplicate message IDs.");
          const previous = entries[entries.length - 1];
          if (previous && parsed.offsetSeconds < previous.time)
            throw new Error("Chat messages are not in chronological order.");
          ids.add(parsed.id);
          entries.push({ start: messageStart, end: position + 1, time: parsed.offsetSeconds });
          if (entries.length > 2_000_000)
            throw new Error("This chat exceeds the two million message limit.");
          messageStart = -1;
          message = [];
          arrayState = "separator";
        }
      }
    }
    progress(Math.min(100, Math.floor(((base + chunk.length) / file.size) * 100)));
  }
  if (!foundMessages || insideMessages || quoted || depth !== 0)
    throw new Error(
      "Chat JSON is incomplete or has no messages array. Select the exported chat.json file.",
    );
  const root = record(JSON.parse(decoder.decode(new Uint8Array(metadata))));
  if (root.schemaVersion !== 1 || root.coverage !== "available-replay")
    throw new Error("Unsupported chat format. Use the JSON exported by twitch-m3u8 chat.");
  if (root.status !== "complete" && root.status !== "empty" && root.status !== "partial")
    throw new Error("This file does not contain a playable chat archive.");
  if (number(root.messageCount) !== entries.length)
    throw new Error("Chat message count does not match the file. The export may be incomplete.");
  const video = root.video === null ? null : record(root.video);
  return {
    file,
    entries,
    info: {
      vodId: string(root.vodId),
      title: video === null ? `VOD ${string(root.vodId)}` : string(video.title),
      count: entries.length,
      status: root.status,
    },
  };
}

export function upperBound(entries: readonly { time: number }[], time: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

async function readEntries(
  index: ArchiveIndex,
  start: number,
  end: number,
): Promise<ChatMessage[]> {
  if (start === end) return [];
  const first = index.entries[start];
  const last = index.entries[end - 1];
  const bytes = new Uint8Array(await index.file.slice(first.start, last.end).arrayBuffer());
  return index.entries
    .slice(start, end)
    .map((entry) =>
      parseStoredMessage(
        JSON.parse(
          decoder.decode(bytes.subarray(entry.start - first.start, entry.end - first.start)),
        ),
      ),
    );
}

export async function readWindow(
  index: ArchiveIndex,
  time: number,
  limit = 80,
): Promise<ChatMessage[]> {
  if (!Number.isFinite(time) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid replay window.");
  const end = upperBound(index.entries, time);
  return readEntries(index, Math.max(0, end - limit), end);
}

export async function searchArchive(
  index: ArchiveIndex,
  query: string,
  cancelled: () => boolean,
): Promise<ChatMessage[]> {
  const text = query.trim().toLocaleLowerCase();
  if (!text) return [];
  const matches: ChatMessage[] = [];
  const batchSize = 80;
  // Read batches in order but keep a few range reads in flight, so a remote
  // archive is not scanned one HTTP request at a time.
  const lookahead = 4;
  const pending: Array<Promise<ChatMessage[]>> = [];
  let next = 0;
  const fill = () => {
    while (pending.length < lookahead && next < index.entries.length) {
      const start = next;
      next += batchSize;
      const end = Math.min(start + batchSize, index.entries.length);
      pending.push(readEntries(index, start, end));
    }
  };
  fill();
  while (pending.length > 0 && matches.length < 100) {
    if (cancelled()) return [];
    const batch = pending.shift();
    fill();
    if (!batch) break;
    for (const message of await batch) {
      if (cancelled()) return [];
      if (
        `${message.user?.displayName ?? ""} ${message.user?.login ?? ""} ${message.text}`
          .toLocaleLowerCase()
          .includes(text)
      )
        matches.push(message);
      if (matches.length === 100) break;
    }
  }
  return matches;
}
