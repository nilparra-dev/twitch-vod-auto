// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRemoteFile } from "./remote-file";

function bytes(length: number): Uint8Array {
  return new Uint8Array(Array.from({ length }, (_, index) => index % 256));
}

function blockServer(data: Uint8Array) {
  const ranges: string[] = [];
  const fetch = async (_input: URL | RequestInfo, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("range") ?? "";
    ranges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) return new Response("", { status: 400 });
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (end >= data.length || start > end) return new Response("", { status: 416 });
    return new Response(data.slice(start, end + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${data.length}` },
    });
  };
  return { ranges, fetch };
}

describe("remote file blocks", () => {
  it("serves slices from aligned blocks and reuses them", async () => {
    const data = bytes(1000);
    const server = blockServer(data);
    const file = createRemoteFile({
      url: new URL("http://localhost/chat"),
      size: data.length,
      fetch: server.fetch,
      blockSize: 100,
      cacheBlocks: 4,
    });

    expect([...new Uint8Array(await file.slice(0, 50).arrayBuffer())]).toEqual([...data.slice(0, 50)]);
    expect([...new Uint8Array(await file.slice(80, 130).arrayBuffer())]).toEqual([...data.slice(80, 130)]);
    expect([...new Uint8Array(await file.slice(20, 40).arrayBuffer())]).toEqual([...data.slice(20, 40)]);
    expect(server.ranges).toEqual(["bytes=0-99", "bytes=100-199"]);
  });

  it("evicts the least recently used block", async () => {
    const data = bytes(300);
    const server = blockServer(data);
    const file = createRemoteFile({
      url: new URL("http://localhost/chat"),
      size: 300,
      fetch: server.fetch,
      blockSize: 100,
      cacheBlocks: 1,
    });
    await file.slice(0, 10).arrayBuffer();
    await file.slice(100, 110).arrayBuffer();
    await file.slice(0, 10).arrayBuffer();
    expect(server.ranges).toEqual(["bytes=0-99", "bytes=100-199", "bytes=0-99"]);
  });

  it("rejects a response that does not match the expected range", async () => {
    const file = createRemoteFile({
      url: new URL("http://localhost/chat"),
      size: 100,
      blockSize: 100,
      fetch: async () =>
        new Response(new Uint8Array(100), {
          status: 206,
          headers: { "content-range": "bytes 0-99/200" },
        }),
    });
    await expect(file.slice(0, 10).arrayBuffer()).rejects.toThrow(/changed or is no longer available/);
  });
});
