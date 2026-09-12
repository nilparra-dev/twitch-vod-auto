import type { ReplayFile } from "./archive";

export interface RemoteFileOptions {
  url: URL;
  size: number;
  fetch?: typeof fetch;
  /** Bytes per request; read windows are served from aligned blocks. */
  blockSize?: number;
  /** Blocks kept in memory before evicting the least recently used. */
  cacheBlocks?: number;
}

/**
 * Remote chat reader backed by aligned block requests. Indexing a 4 GB archive
 * previously issued one 256 KiB request per chunk; serving the same scan from
 * 4 MB blocks cuts the request count by an order of magnitude while keeping the
 * reader interface (`slice().arrayBuffer()`) unchanged.
 *
 * Every block response is validated against the expected `Content-Range`, so a
 * changed or truncated file fails loudly instead of mixing revisions.
 */
export function createRemoteFile(options: RemoteFileOptions): ReplayFile {
  const blockSize = options.blockSize ?? 4 * 1024 * 1024;
  const maxBlocks = options.cacheBlocks ?? 8;
  const fetchFn = options.fetch ?? fetch;
  const blocks = new Map<number, Promise<Uint8Array>>();

  const loadBlock = (index: number): Promise<Uint8Array> => {
    const cached = blocks.get(index);
    if (cached) {
      // Refresh recency for the LRU order.
      blocks.delete(index);
      blocks.set(index, cached);
      return cached;
    }
    const start = index * blockSize;
    const end = Math.min(options.size, start + blockSize);
    const expectedRange = `bytes ${start}-${end - 1}/${options.size}`;
    const pending = (async () => {
      const response = await fetchFn(options.url, {
        headers: { Range: `bytes=${start}-${end - 1}` },
      });
      if (response.status !== 206 || response.headers.get("content-range") !== expectedRange) {
        throw new Error("The local chat file changed or is no longer available.");
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length !== end - start) {
        throw new Error("The local chat file changed or is no longer available.");
      }
      return buffer;
    })();
    blocks.set(index, pending);
    if (blocks.size > maxBlocks) {
      const oldest = blocks.keys().next().value;
      if (oldest !== undefined) blocks.delete(oldest);
    }
    return pending;
  };

  return {
    size: options.size,
    slice(start = 0, end = options.size) {
      return {
        arrayBuffer: async () => {
          const from = Math.max(0, start);
          const to = Math.min(end, options.size);
          if (from >= to) return new ArrayBuffer(0);
          const firstBlock = Math.floor(from / blockSize);
          const lastBlock = Math.floor((to - 1) / blockSize);
          const pieces: Uint8Array[] = [];
          let total = 0;
          for (let index = firstBlock; index <= lastBlock; index += 1) {
            const block = await loadBlock(index);
            const blockStart = index * blockSize;
            const piece = block.subarray(Math.max(from, blockStart) - blockStart, Math.min(to, blockStart + block.length) - blockStart);
            pieces.push(piece);
            total += piece.length;
          }
          const output = new Uint8Array(total);
          let offset = 0;
          for (const piece of pieces) {
            output.set(piece, offset);
            offset += piece.length;
          }
          return output.buffer;
        },
      };
    },
  };
}
