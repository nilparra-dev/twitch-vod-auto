import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DownloadError, downloadPlaylist, fingerprintPlaylist } from "../../dist/download/fetcher.js";
import { parseMasterPlaylist, parseMediaPlaylist } from "../../dist/download/playlist.js";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workdir() {
  const directory = await mkdtemp(join(tmpdir(), "twitch-download-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

const exists = (path) => stat(path).then(() => true, () => false);

const playlistWith = (lines) =>
  parseMediaPlaylist(`#EXTM3U\n#EXT-X-TARGETDURATION:13\n${lines}\n#EXT-X-ENDLIST`, "https://d2nvs31859zcd8.cloudfront.net/vod/index.m3u8");

describe("playlist parsing", () => {
  it("parses segments, durations and the init segment", () => {
    const playlist = parseMediaPlaylist(
      `#EXTM3U
#EXT-X-TARGETDURATION:13
#EXT-X-MAP:URI="init.mp4"
#EXTINF:10.000,
0.ts
#EXTINF:8.951,
1.ts
#EXT-X-ENDLIST`,
      "https://d2nvs31859zcd8.cloudfront.net/vod/index.m3u8",
    );
    assert.equal(playlist.endList, true);
    assert.equal(playlist.initSegment, "https://d2nvs31859zcd8.cloudfront.net/vod/init.mp4");
    assert.equal(playlist.totalDurationSeconds, 18.951);
    assert.deepEqual(
      playlist.segments.map((segment) => segment.uri),
      [
        "https://d2nvs31859zcd8.cloudfront.net/vod/0.ts",
        "https://d2nvs31859zcd8.cloudfront.net/vod/1.ts",
      ],
    );
  });

  it("detects master playlists and resolves variant URLs", () => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
720p60/index-dvr.m3u8`;
    assert.deepEqual(parseMasterPlaylist(master, "https://cdn.example/vod/master.m3u8"), [
      "https://cdn.example/vod/720p60/index-dvr.m3u8",
    ]);
    assert.equal(parseMasterPlaylist("#EXTM3U\n#EXTINF:10,\na.ts", "https://cdn.example/a.m3u8"), null);
  });
});

describe("segment downloader", () => {
  it("downloads segments in order and publishes the output atomically", async () => {
    const directory = await workdir();
    const output = join(directory, "out.ts");
    const playlist = playlistWith("#EXTINF:10,\na.ts\n#EXTINF:10,\nb.ts\n#EXTINF:5.5,\nc.ts");
    const chunks = { "a.ts": "A", "b.ts": "BB", "c.ts": "CCC" };
    const fakeFetch = async (url) => {
      const key = String(url).split("/").at(-1);
      return key in chunks ? new Response(chunks[key], { status: 200 }) : new Response("", { status: 404 });
    };
    const result = await downloadPlaylist({ playlist, output, fetch: fakeFetch, retryDelayMs: 1 });
    assert.equal(result.segments, 3);
    assert.equal(result.bytes, 6);
    assert.equal(await readFile(output, "utf8"), "ABBCCC");
    assert.equal(await exists(`${output}.part`), false);
    assert.equal(await exists(`${output}.part.json`), false);
  });

  it("writes the init segment before the media segments", async () => {
    const directory = await workdir();
    const output = join(directory, "out.ts");
    const playlist = parseMediaPlaylist(
      `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:10,
a.m4s
#EXT-X-ENDLIST`,
      "https://d2nvs31859zcd8.cloudfront.net/vod/index.m3u8",
    );
    const fakeFetch = async (url) => {
      const key = String(url).split("/").at(-1);
      if (key === "init.mp4") return new Response("INIT", { status: 200 });
      if (key === "a.m4s") return new Response("AAA", { status: 200 });
      return new Response("", { status: 404 });
    };
    await downloadPlaylist({ playlist, output, fetch: fakeFetch, retryDelayMs: 1 });
    assert.equal(await readFile(output, "utf8"), "INITAAA");
  });

  it("retries transient failures", async () => {
    const directory = await workdir();
    const output = join(directory, "out.ts");
    const playlist = playlistWith("#EXTINF:10,\na.ts\n#EXTINF:10,\nb.ts");
    let failures = 1;
    const fakeFetch = async (url) => {
      const key = String(url).split("/").at(-1);
      if (key === "b.ts" && failures > 0) {
        failures -= 1;
        return new Response("", { status: 503 });
      }
      if (key === "a.ts") return new Response("A", { status: 200 });
      if (key === "b.ts") return new Response("B", { status: 200 });
      return new Response("", { status: 404 });
    };
    const result = await downloadPlaylist({
      playlist,
      output,
      fetch: fakeFetch,
      attempts: 3,
      retryDelayMs: 1,
    });
    assert.equal(result.bytes, 2);
    assert.equal(await readFile(output, "utf8"), "AB");
  });

  it("falls back to the muted segment when the unmuted one is missing", async () => {
    const directory = await workdir();
    const output = join(directory, "out.ts");
    const playlist = playlistWith("#EXTINF:10,\nlong_name_0-unmuted.ts");
    const fakeFetch = async (url) => {
      if (String(url).endsWith("-unmuted.ts")) return new Response("", { status: 403 });
      if (String(url).endsWith("-muted.ts")) return new Response("MUTED", { status: 200 });
      return new Response("", { status: 404 });
    };
    await downloadPlaylist({ playlist, output, fetch: fakeFetch, retryDelayMs: 1 });
    assert.equal(await readFile(output, "utf8"), "MUTED");
  });

  it("refuses segments outside Twitch media servers", async () => {
    const directory = await workdir();
    const output = join(directory, "out.ts");
    const playlist = parseMediaPlaylist(
      "#EXTM3U\n#EXTINF:10,\nhttps://evil.example/segment.ts\n#EXT-X-ENDLIST",
      "https://d2nvs31859zcd8.cloudfront.net/vod/index.m3u8",
    );
    await assert.rejects(
      downloadPlaylist({
        playlist,
        output,
        fetch: async () => new Response("X", { status: 200 }),
        retryDelayMs: 1,
      }),
      (error) => error instanceof DownloadError && error.code === "BLOCKED_URL",
    );
  });

  it("resumes a partial download and only fetches the missing segments", async () => {
    const directory = await workdir();
    const output = join(directory, "out.ts");
    const playlist = playlistWith("#EXTINF:10,\na.ts\n#EXTINF:10,\nb.ts\n#EXTINF:10,\nc.ts");
    await writeFile(`${output}.part`, "AB");
    await writeFile(
      `${output}.part.json`,
      JSON.stringify({ fingerprint: fingerprintPlaylist(playlist), segments: 2, bytes: 2 }),
    );
    const requested = [];
    const fakeFetch = async (url) => {
      const key = String(url).split("/").at(-1);
      requested.push(key);
      if (key === "c.ts") return new Response("C", { status: 200 });
      return new Response("", { status: 404 });
    };
    const result = await downloadPlaylist({ playlist, output, fetch: fakeFetch, retryDelayMs: 1 });
    assert.equal(result.resumedFrom, 2);
    assert.equal(result.segments, 3);
    assert.deepEqual(requested, ["c.ts"]);
    assert.equal(await readFile(output, "utf8"), "ABC");
  });

  it("refuses to overwrite an existing output without force", async () => {
    const directory = await workdir();
    const output = join(directory, "out.ts");
    await writeFile(output, "already here");
    const playlist = playlistWith("#EXTINF:10,\na.ts");
    await assert.rejects(
      downloadPlaylist({ playlist, output, fetch: async () => new Response("A", { status: 200 }) }),
      (error) => error instanceof DownloadError && error.code === "OUTPUT_EXISTS",
    );
  });

  it("refuses to resume a part file that belongs to another playlist", async () => {
    const directory = await workdir();
    const output = join(directory, "out.ts");
    await writeFile(`${output}.part`, "AB");
    await writeFile(`${output}.part.json`, JSON.stringify({ fingerprint: "other", segments: 2, bytes: 2 }));
    const playlist = playlistWith("#EXTINF:10,\na.ts\n#EXTINF:10,\nb.ts");
    await assert.rejects(
      downloadPlaylist({ playlist, output, fetch: async () => new Response("A", { status: 200 }) }),
      (error) => error instanceof DownloadError && error.code === "STATE_MISMATCH",
    );
  });
});
