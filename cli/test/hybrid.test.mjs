import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FfmpegError } from "../../dist/download/ffmpeg.js";
import { downloadHybrid } from "../../dist/download/hybrid.js";
import { parseMediaPlaylist } from "../../dist/download/playlist.js";

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

function chunkFetch(chunks) {
  return async (url) => {
    const key = String(url).split("/").at(-1);
    return key in chunks ? new Response(chunks[key], { status: 200 }) : new Response("", { status: 404 });
  };
}

async function workdir() {
  return mkdtemp(join(tmpdir(), "twitch-hybrid-test-"));
}

describe("hybrid engine", () => {
  it("downloads in parallel and muxes the concat list in order", async () => {
    const directory = await workdir();
    try {
      const output = join(directory, "out.mp4");
      const segmentsDirectory = join(directory, "out.segments");
      const playlist = parseMediaPlaylist(
        "#EXTM3U\n#EXTINF:10,\na.ts\n#EXTINF:10,\nb.ts\n#EXT-X-ENDLIST",
        BASE,
      );
      let concat = null;
      let args = null;
      const spawn = fakeSpawn(async ({ args: childArgs, child }) => {
        args = childArgs;
        concat = await readFile(childArgs[childArgs.indexOf("-i") + 1], "utf8");
        child.stdout.emit("data", "out_time_us=1000000\ntotal_size=100\nspeed=10x\n");
        await writeFile(childArgs.at(-1), "muxed");
        child.emit("close", 0);
      });

      const result = await downloadHybrid({
        tools: TOOLS,
        playlist,
        directory: segmentsDirectory,
        output,
        durationSeconds: 1,
        fetch: chunkFetch({ "a.ts": "A", "b.ts": "B" }),
        spawn,
      });

      assert.equal(await readFile(output, "utf8"), "muxed");
      assert.equal(concat, "file '0.ts'\nfile '1.ts'\n");
      assert.deepEqual(args.slice(args.indexOf("-f"), args.indexOf("-f") + 4), ["-f", "concat", "-safe", "0"]);
      assert.ok(args.includes("-protocol_whitelist"));
      assert.equal(await exists(segmentsDirectory), false);
      assert.equal(result.segments, 2);
      assert.equal(result.reused, 0);
      assert.equal(result.bytes, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lists the init segment before the media segments", async () => {
    const directory = await workdir();
    try {
      const output = join(directory, "out.mp4");
      const playlist = parseMediaPlaylist(
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\na.m4s\n#EXT-X-ENDLIST',
        BASE,
      );
      let concat = null;
      const spawn = fakeSpawn(async ({ args, child }) => {
        concat = await readFile(args[args.indexOf("-i") + 1], "utf8");
        await writeFile(args.at(-1), "muxed");
        child.emit("close", 0);
      });

      await downloadHybrid({
        tools: TOOLS,
        playlist,
        directory: join(directory, "out.segments"),
        output,
        fetch: chunkFetch({ "init.mp4": "INIT", "a.m4s": "A" }),
        spawn,
      });

      assert.equal(concat, "file 'init'\nfile '0.ts'\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the downloaded segments when the mux fails", async () => {
    const directory = await workdir();
    try {
      const output = join(directory, "out.mp4");
      const segmentsDirectory = join(directory, "out.segments");
      const playlist = parseMediaPlaylist("#EXTM3U\n#EXTINF:10,\na.ts\n#EXT-X-ENDLIST", BASE);
      const spawn = fakeSpawn(async ({ child }) => {
        child.stderr.emit("data", "concat failed");
        child.emit("close", 1);
      });

      await assert.rejects(
        downloadHybrid({
          tools: TOOLS,
          playlist,
          directory: segmentsDirectory,
          output,
          fetch: chunkFetch({ "a.ts": "A" }),
          spawn,
        }),
        (error) => error instanceof FfmpegError && error.code === "FFMPEG_FAILED",
      );

      assert.equal(await exists(output), false);
      assert.equal(await exists(join(segmentsDirectory, "0.ts")), true);
      assert.deepEqual(await readdir(directory).then((entries) => entries.sort()), ["out.segments"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
