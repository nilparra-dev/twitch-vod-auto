import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseDownloadArgs, selectOutputPaths } from "../../dist/download/command.js";
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
      JSON.stringify({ fingerprint: fingerprintPlaylist(playlist), segments: 2, bytes: 2, timestampRepair: 2 }),
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

  it("fingerprints every segment, not just the edges", () => {
    const first = playlistWith("#EXTINF:10,\na.ts\n#EXTINF:10,\nb.ts\n#EXTINF:10,\nc.ts");
    const second = playlistWith("#EXTINF:10,\na.ts\n#EXTINF:10,\nX.ts\n#EXTINF:10,\nc.ts");
    assert.equal(first.segments.length, second.segments.length);
    assert.notEqual(fingerprintPlaylist(first), fingerprintPlaylist(second));
  });

  it("refuses redirects outside the Twitch media allowlist", async () => {
    const directory = await workdir();
    const output = join(directory, "out.ts");
    const playlist = playlistWith("#EXTINF:10,\na.ts");
    const calls = [];
    await assert.rejects(
      downloadPlaylist({
        playlist,
        output,
        attempts: 1,
        retryDelayMs: 1,
        fetch: async (url) => {
          calls.push(String(url));
          return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
        },
      }),
      (error) =>
        error instanceof DownloadError &&
        error.code === "SEGMENT_FAILED" &&
        /outside Twitch/.test(error.message),
    );
    assert.equal(calls.length, 1);
  });

  it("rejects a segment larger than the configured limit", async () => {
    const directory = await workdir();
    const output = join(directory, "out.ts");
    const playlist = playlistWith("#EXTINF:10,\na.ts");
    await assert.rejects(
      downloadPlaylist({
        playlist,
        output,
        attempts: 1,
        retryDelayMs: 1,
        maxSegmentBytes: 4,
        fetch: async () => new Response("AAAAA", { status: 200 }),
      }),
      (error) => error instanceof DownloadError && error.code === "SEGMENT_TOO_LARGE",
    );
  });

  it("resumes a partial download written before the hashed fingerprint", async () => {
    const directory = await workdir();
    const output = join(directory, "out.ts");
    const playlist = playlistWith("#EXTINF:10,\na.ts\n#EXTINF:10,\nb.ts\n#EXTINF:10,\nc.ts");
    await writeFile(`${output}.part`, "AB");
    // Older releases identified the playlist by length and edge segments.
    // Existing state files must keep resuming until the next snapshot rewrites them.
    const legacyFingerprint = `${playlist.segments.length}|${playlist.initSegment ?? ""}|${
      playlist.segments[0].uri
    }|${playlist.segments.at(-1).uri}`;
    await writeFile(
      `${output}.part.json`,
      JSON.stringify({ fingerprint: legacyFingerprint, segments: 2, bytes: 2, timestampRepair: 2 }),
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
    assert.equal(await readFile(output, "utf8"), "ABC");
    assert.deepEqual(requested, ["c.ts"]);
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
    await writeFile(
      `${output}.part.json`,
      JSON.stringify({ fingerprint: "other", segments: 2, bytes: 2, timestampRepair: 2 }),
    );
    const playlist = playlistWith("#EXTINF:10,\na.ts\n#EXTINF:10,\nb.ts");
    await assert.rejects(
      downloadPlaylist({ playlist, output, fetch: async () => new Response("A", { status: 200 }) }),
      (error) => error instanceof DownloadError && error.code === "STATE_MISMATCH",
    );
  });

  it("restarts a partial download written before timestamp repair", async () => {
    const directory = await workdir();
    const output = join(directory, "out.ts");
    const playlist = playlistWith("#EXTINF:10,\na.ts\n#EXTINF:10,\nb.ts");
    await writeFile(`${output}.part`, "AB");
    await writeFile(
      `${output}.part.json`,
      JSON.stringify({ fingerprint: fingerprintPlaylist(playlist), segments: 2, bytes: 2 }),
    );
    const requested = [];
    const fakeFetch = async (url) => {
      const key = String(url).split("/").at(-1);
      requested.push(key);
      if (key === "a.ts") return new Response("A", { status: 200 });
      if (key === "b.ts") return new Response("B", { status: 200 });
      return new Response("", { status: 404 });
    };

    const result = await downloadPlaylist({ playlist, output, fetch: fakeFetch, retryDelayMs: 1 });

    assert.equal(result.resumedFrom, 0);
    assert.deepEqual(requested.sort(), ["a.ts", "b.ts"]);
    assert.equal(await readFile(output, "utf8"), "AB");
  });
});

const publicResult = {
  kind: "public",
  source: "twitch",
  videoId: "2434567890",
  masterUrl: "https://d2nvs31859zcd8.cloudfront.net/vod/master.m3u8",
  formats: [],
};

const hiddenResult = {
  kind: "hidden",
  source: "canonical",
  channel: "xqc",
  streamId: "51582913581",
  startedAt: "2024-07-22T22:15:15Z",
  canonicalTarget: "video:xqc_51582913581_1721686515",
  formats: [],
};

describe("download command output selection", () => {
  it("keeps the generated file name inside --output-dir", () => {
    const directory = join(tmpdir(), "vods");
    assert.deepEqual(selectOutputPaths(publicResult, { output: null, outputDir: directory, remux: false }), {
      requested: join(directory, "2434567890.ts"),
      tsPath: join(directory, "2434567890.ts"),
    });
  });

  it("generates an .mp4 name with --remux and keeps the .ts intermediate", () => {
    const directory = join(tmpdir(), "vods");
    assert.deepEqual(selectOutputPaths(hiddenResult, { output: null, outputDir: directory, remux: true }), {
      requested: join(directory, "xqc_51582913581_1721686515.mp4"),
      tsPath: join(directory, "xqc_51582913581_1721686515.ts"),
    });
  });

  it("prefers an explicit output path over the generated name", () => {
    const output = join(tmpdir(), "clip.mp4");
    assert.deepEqual(selectOutputPaths(publicResult, { output, outputDir: null, remux: true }), {
      requested: output,
      tsPath: join(tmpdir(), "clip.ts"),
    });
  });

  it("defaults to downloads/ under the working directory", () => {
    const { requested, tsPath } = selectOutputPaths(publicResult, { output: null, outputDir: null, remux: false });
    assert.equal(requested, resolve(join("downloads", "2434567890.ts")));
    assert.equal(tsPath, requested);
  });
});

describe("download command arguments", () => {
  it("parses --output-dir", () => {
    const options = parseDownloadArgs(["2434567890", "--output-dir", "vods"]);
    assert.equal(options.outputDir, "vods");
    assert.equal(options.output, undefined);
  });

  it("parses --ffmpeg-path", () => {
    const options = parseDownloadArgs(["2434567890", "--ffmpeg-path", "C:/tools/ffmpeg.exe"]);
    assert.equal(options.ffmpegPath, "C:/tools/ffmpeg.exe");
  });

  it("rejects --output combined with --output-dir", () => {
    assert.throws(
      () => parseDownloadArgs(["2434567890", "-o", "clip.ts", "--output-dir", "vods"]),
      (error) => error.code === "INVALID_ARGUMENT" && /cannot be combined/.test(error.message),
    );
  });

  it("requires a value for --output-dir", () => {
    assert.throws(
      () => parseDownloadArgs(["2434567890", "--output-dir"]),
      (error) => error.code === "INVALID_ARGUMENT" && /--output-dir requires a value/.test(error.message),
    );
  });
});
