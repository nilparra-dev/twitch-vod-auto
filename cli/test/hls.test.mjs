import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DownloadError } from "../../dist/download/fetcher.js";
import { FfmpegError } from "../../dist/download/ffmpeg.js";
import { buildLocalPlaylist, downloadHls, prepareLocalPlaylist } from "../../dist/download/hls.js";

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr.setEncoding = () => {};
  }

  kill() {
    return true;
  }
}

function fakeSpawn(behaviour) {
  return (command, args) => {
    const child = new FakeProcess();
    setImmediate(() => behaviour({ command, args, child }));
    return child;
  };
}

const BASE = "https://d2nvs31859zcd8.cloudfront.net/vod/index.m3u8";
const TOOLS = { ffmpeg: "ffmpeg", ffprobe: null, version: "ffmpeg version test" };

describe("local playlist preparation", () => {
  it("rewrites every reference to an absolute allowlisted URL", () => {
    const text = [
      "#EXTM3U",
      '#EXT-X-MAP:URI="init.mp4"',
      "#EXTINF:10,",
      "0.ts",
      "#EXTINF:10,",
      "https://d2nvs31859zcd8.cloudfront.net/vod/1.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");

    const local = buildLocalPlaylist(text, BASE);

    assert.match(local, /URI="https:\/\/d2nvs31859zcd8\.cloudfront\.net\/vod\/init\.mp4"/);
    assert.match(local, /\nhttps:\/\/d2nvs31859zcd8\.cloudfront\.net\/vod\/0\.ts\n/);
    assert.match(local, /\nhttps:\/\/d2nvs31859zcd8\.cloudfront\.net\/vod\/1\.ts\n/);
    assert.match(local, /#EXT-X-ENDLIST/);
  });

  it("rejects a resource outside the media allowlist", () => {
    const text = ["#EXTM3U", "#EXTINF:10,", "https://evil.example/segment.ts"].join("\n");
    assert.throws(
      () => buildLocalPlaylist(text, BASE),
      (error) => error instanceof DownloadError && error.code === "BLOCKED_URL",
    );
  });
});

describe("unmuted fallback", () => {
  const signal = new AbortController().signal;

  it("replaces an unavailable unmuted segment with its muted sibling", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      const path = new URL(url).pathname;
      if (path.endsWith("-unmuted.ts")) return new Response(null, { status: 403 });
      if (path.endsWith("-muted.ts")) return new Response(null, { status: 206 });
      return new Response(null, { status: 200 });
    };
    const text = ["#EXTM3U", "#EXTINF:10,", "0-unmuted.ts", "#EXTINF:10,", "1.ts", "#EXT-X-ENDLIST"].join("\n");

    const local = await prepareLocalPlaylist(text, BASE, { signal, fetch });

    assert.match(local, /\/0-muted\.ts/);
    assert.match(local, /\/1\.ts/);
    assert.equal(calls.filter((call) => call.url.includes("-unmuted")).length, 1);
    assert.equal(calls.filter((call) => call.url.includes("-muted")).length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith("/1.ts")).length, 0);
  });

  it("keeps an available unmuted segment", async () => {
    const fetch = async (url) =>
      new Response(null, { status: new URL(url).pathname.endsWith("-unmuted.ts") ? 200 : 500 });
    const local = await prepareLocalPlaylist("#EXTM3U\n#EXTINF:10,\n0-unmuted.ts\n", BASE, { signal, fetch });
    assert.match(local, /0-unmuted\.ts/);
  });

  it("fails early when neither sibling exists", async () => {
    const fetch = async () => new Response(null, { status: 403 });
    await assert.rejects(
      prepareLocalPlaylist("#EXTM3U\n#EXTINF:10,\n0-unmuted.ts\n", BASE, { signal, fetch }),
      (error) => error instanceof DownloadError && error.code === "SEGMENT_UNAVAILABLE",
    );
  });
});

describe("direct HLS engine", () => {
  it("runs ffmpeg on the validated local playlist and publishes the output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitch-hls-test-"));
    try {
      const output = join(directory, "out.mp4");
      const playlistPath = join(directory, "local.m3u8");
      const updates = [];
      let captured = null;
      const spawn = fakeSpawn(async ({ args, child }) => {
        captured = { args, playlist: await readFile(playlistPath, "utf8") };
        child.stdout.emit("data", "out_time_us=1000000\ntotal_size=2048\nspeed=50x\n");
        await writeFile(args.at(-1), "remuxed");
        child.emit("close", 0);
      });

      await downloadHls({
        tools: TOOLS,
        playlistText: "#EXTM3U\n#EXTINF:10,\n0.ts\n#EXT-X-ENDLIST\n",
        playlistUrl: BASE,
        playlistPath,
        output,
        durationSeconds: 1,
        onProgress: (progress) => updates.push(progress),
        spawn,
      });

      assert.equal(await readFile(output, "utf8"), "remuxed");
      assert.equal(await exists(playlistPath), false);
      assert.deepEqual(await readdir(directory), ["out.mp4"]);
      assert.deepEqual(captured.args.slice(0, 2), ["-hide_banner", "-loglevel"]);
      assert.ok(captured.args.includes("-protocol_whitelist"));
      assert.ok(captured.args.includes("file,http,https,tcp,tls,crypto"));
      assert.equal(captured.args[captured.args.indexOf("-i") + 1], playlistPath);
      assert.match(captured.playlist, /https:\/\/d2nvs31859zcd8\.cloudfront\.net\/vod\/0\.ts/);
      assert.equal(updates.at(-1)?.percent, 100);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes the temporary output and the playlist when ffmpeg fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitch-hls-test-"));
    try {
      const output = join(directory, "out.mp4");
      const playlistPath = join(directory, "local.m3u8");
      const spawn = fakeSpawn(async ({ child }) => {
        child.stderr.emit("data", "download failed");
        child.emit("close", 1);
      });

      await assert.rejects(
        downloadHls({
          tools: TOOLS,
          playlistText: "#EXTM3U\n#EXTINF:10,\n0.ts\n#EXT-X-ENDLIST\n",
          playlistUrl: BASE,
          playlistPath,
          output,
          spawn,
        }),
        (error) => error instanceof FfmpegError && error.code === "FFMPEG_FAILED",
      );

      assert.equal(await exists(output), false);
      assert.equal(await exists(`${output}.tmp.mp4`), false);
      assert.equal(await exists(playlistPath), false);
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
