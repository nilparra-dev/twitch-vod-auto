import { indexArchive, type ArchiveIndex, type ArchiveInfo, type ReplayFile } from "./archive";

/**
 * Persistent chat index. Indexing a multi-gigabyte archive is the most
 * expensive thing the player does, and the result only depends on the file
 * bytes, so it is kept between sessions keyed by file identity (name, size and
 * modification time locally; URL, revision and size remotely).
 */
export interface StoredIndex {
  schema: 1;
  size: number;
  info: ArchiveInfo;
  /** Flattened `[start, end, time]` triples, in file order. */
  entries: Float64Array;
}

export interface IndexCache {
  get(key: string): Promise<StoredIndex | null>;
  set(key: string, value: StoredIndex): Promise<void>;
}

export function encodeIndex(index: ArchiveIndex): StoredIndex {
  const entries = new Float64Array(index.entries.length * 3);
  index.entries.forEach((entry, position) => {
    entries[position * 3] = entry.start;
    entries[position * 3 + 1] = entry.end;
    entries[position * 3 + 2] = entry.time;
  });
  return { schema: 1, size: index.file.size, info: index.info, entries };
}

export function decodeIndex(file: ReplayFile, stored: StoredIndex): ArchiveIndex {
  const entries = [];
  for (let position = 0; position + 2 < stored.entries.length; position += 3) {
    entries.push({
      start: stored.entries[position] ?? 0,
      end: stored.entries[position + 1] ?? 0,
      time: stored.entries[position + 2] ?? 0,
    });
  }
  return { file, entries, info: stored.info };
}

/**
 * Return the cached index when it describes the same file, or index the file
 * and store the result. Cache failures never block playback: a broken or
 * unavailable store degrades to indexing.
 */
export async function loadArchive(
  file: ReplayFile,
  identity: string,
  progress: (percent: number) => void,
  cache?: IndexCache,
): Promise<ArchiveIndex> {
  const stored = cache ? await cache.get(identity).catch(() => null) : null;
  if (stored && stored.schema === 1 && stored.size === file.size) return decodeIndex(file, stored);
  const index = await indexArchive(file, progress);
  if (cache) await cache.set(identity, encodeIndex(index)).catch(() => undefined);
  return index;
}

const DB_NAME = "twitch-vod-m3u8-replay";
const STORE_NAME = "chat-index";
const MAX_ENTRIES = 3;

interface StoredRecord extends StoredIndex {
  key: string;
  savedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB is unavailable."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

/**
 * IndexedDB cache with a small bound: only the most recent archives are kept,
 * so a shared machine does not accumulate indexes forever.
 */
export function createIndexedDbCache(): IndexCache {
  let database: Promise<IDBDatabase> | null = null;
  const connection = () => (database ??= openDatabase());
  const store = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await connection();
    return requestResult(work(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)));
  };
  return {
    async get(key) {
      const record = await store<StoredRecord | undefined>("readonly", (objectStore) => objectStore.get(key) as IDBRequest<StoredRecord | undefined>);
      return record && record.schema === 1 ? record : null;
    },
    async set(key, value) {
      await store<IDBValidKey>("readwrite", (objectStore) => objectStore.put({ ...value, key, savedAt: Date.now() }));
      const all = await store<StoredRecord[]>("readonly", (objectStore) => objectStore.getAll() as IDBRequest<StoredRecord[]>);
      if (all.length <= MAX_ENTRIES) return;
      const oldest = all.sort((left, right) => left.savedAt - right.savedAt).slice(0, all.length - MAX_ENTRIES);
      for (const record of oldest) {
        await store<undefined>("readwrite", (objectStore) => objectStore.delete(record.key) as IDBRequest<undefined>);
      }
    },
  };
}
