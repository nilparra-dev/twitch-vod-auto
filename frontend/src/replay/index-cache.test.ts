// @vitest-environment node
import { describe, expect, it } from "vitest";
import { indexArchive } from "./archive";
import { decodeIndex, encodeIndex, loadArchive, type IndexCache, type StoredIndex } from "./index-cache";

const archiveData = {
  schemaVersion: 1,
  vodId: "1",
  video: { title: "Cached" },
  coverage: "available-replay",
  status: "complete",
  messageCount: 1,
  messages: [
    {
      id: "a",
      offsetSeconds: 0,
      text: "hi",
      createdAt: "2026-09-01T12:00:00Z",
      user: null,
      color: null,
      fragments: [{ text: "hi", emoteId: null }],
      badges: [],
    },
  ],
};
const blob = () => new Blob([JSON.stringify(archiveData)]);

class MemoryCache implements IndexCache {
  readonly values = new Map<string, StoredIndex>();

  async get(key: string): Promise<StoredIndex | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: StoredIndex): Promise<void> {
    this.values.set(key, value);
  }
}

describe("chat index cache", () => {
  it("indexes once and serves later loads from the cache", async () => {
    const cache = new MemoryCache();
    const first = await loadArchive(blob(), "local:x", () => {}, cache);
    expect(cache.values.size).toBe(1);

    const second = await loadArchive(
      blob(),
      "local:x",
      () => {
        throw new Error("indexing should have been skipped");
      },
      cache,
    );
    expect(second.info).toEqual(first.info);
    expect(second.entries).toEqual(first.entries);
  });

  it("reindexes when the stored size does not match the file", async () => {
    const cache = new MemoryCache();
    await loadArchive(blob(), "local:x", () => {}, cache);
    const stored = cache.values.get("local:x");
    if (!stored) throw new Error("cache entry missing");
    stored.size = 1;

    let indexed = false;
    await loadArchive(blob(), "local:x", () => {
      indexed = true;
    }, cache);
    expect(indexed).toBe(true);
  });

  it("ignores a cache that cannot read or store", async () => {
    const broken: IndexCache = {
      get: async () => {
        throw new Error("IndexedDB is unavailable.");
      },
      set: async () => {
        throw new Error("IndexedDB is unavailable.");
      },
    };
    const index = await loadArchive(blob(), "local:x", () => {}, broken);
    expect(index.info).toEqual({ vodId: "1", title: "Cached", count: 1, status: "complete" });
  });

  it("round trips entries and metadata through the stored form", async () => {
    const index = await indexArchive(blob());
    const restored = decodeIndex(blob(), encodeIndex(index));
    expect(restored.entries).toEqual(index.entries);
    expect(restored.info).toEqual(index.info);
  });

  it("ignores a stored index with another schema", async () => {
    const cache = new MemoryCache();
    await loadArchive(blob(), "local:x", () => {}, cache);
    const stored = cache.values.get("local:x");
    if (!stored) throw new Error("cache entry missing");
    stored.schema = 2 as unknown as 1;

    let indexed = false;
    await loadArchive(blob(), "local:x", () => {
      indexed = true;
    }, cache);
    expect(indexed).toBe(true);
  });
});
