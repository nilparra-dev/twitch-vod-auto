import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRemuxArgs,
  FfmpegError,
  findFfmpeg,
  parseFfprobeDuration,
  parseProgressLine,
  remuxToMp4,
  runFfmpeg,
} from "../../dist/download/ffmpeg.js";

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
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

/** Spawn factory that runs `behaviour` with a fake child process. */
function fakeSpawn(behaviour) {
  return (command, args) => {
    const child = new FakeProcess();
    setImmediate(() => behaviour({ command, args, child }));
    return child;
  };
}

describe("ffmpeg arguments", () => {
  it("builds a stream-copy remux with progress on stdout", () => {
    const args = buildRemuxArgs("in.ts", "out.ts");
    assert.deepEqual(args.slice(0, 7), ["-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"]);
    assert.deepEqual(args.slice(-5), ["-i", "in.ts", "-c", "copy", "out.ts"]);
  });

  it("adds faststart for MP4 outputs only when requested", () => {
    assert.deepEqual(buildRemuxArgs("in.ts", "out.mp4", true).slice(-3), ["-movflags", "+faststart", "out.mp4"]);
    assert.equal(buildRemuxArgs("in.ts", "out.mp4").includes("-movflags"), false);
  });
});

describe("ffmpeg progress", () => {
  it("reads media time, size and speed from progress keys", () => {
    assert.deepEqual(parseProgressLine("out_time_ms=1500000"), { outTimeMs: 1500 });
    assert.deepEqual(parseProgressLine("out_time_us=2000000"), { outTimeMs: 2000 });
    assert.deepEqual(parseProgressLine("total_size=N/A"), { totalSizeBytes: null });
    assert.deepEqual(parseProgressLine("total_size=4096"), { totalSizeBytes: 4096 });
    assert.deepEqual(parseProgressLine("speed=95.1x"), { speed: "95.1x" });
    assert.equal(parseProgressLine("frame=100"), null);
  });

  it("reports progress from a real child process", async () => {
    const updates = [];
    await runFfmpeg({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('out_time_us=1500000\\ntotal_size=2048\\nspeed=95x\\nprogress=end\\n')",
      ],
      onProgress: (progress) => updates.push(progress),
    });
    assert.ok(updates.some((update) => update.outTimeMs === 1500));
    assert.ok(updates.some((update) => update.totalSizeBytes === 2048));
    assert.ok(updates.some((update) => update.speed === "95x"));
  });

  it("surfaces the stderr tail when the process fails", async () => {
    await assert.rejects(
      runFfmpeg({
        command: process.execPath,
        args: ["-e", "console.error('boom detail'); process.exit(3)"],
      }),
      (error) =>
        error instanceof FfmpegError && error.code === "FFMPEG_FAILED" && /boom detail/.test(error.message),
    );
  });

  it("kills the child when the signal aborts", async () => {
    const controller = new AbortController();
    const running = runFfmpeg({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(
      running,
      (error) => error instanceof FfmpegError && error.code === "FFMPEG_CANCELLED",
    );
  });
});

describe("remux", () => {
  it("publishes the output only after the process succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitch-ffmpeg-test-"));
    try {
      const input = join(directory, "in.ts");
      const output = join(directory, "out.mp4");
      await writeFile(input, "source");
      const updates = [];
      const spawn = fakeSpawn(async ({ args, child }) => {
        child.stdout.emit("data", "out_time_us=1000000\ntotal_size=1024\nspeed=50x\n");
        await writeFile(args.at(-1), "remuxed");
        child.emit("close", 0);
      });

      await remuxToMp4({
        tools: { ffmpeg: "ffmpeg", ffprobe: null, version: "ffmpeg version test" },
        input,
        output,
        durationSeconds: 1,
        onProgress: (progress) => updates.push(progress),
        spawn,
      });

      assert.equal(await readFile(output, "utf8"), "remuxed");
      assert.equal(await exists(`${output}.tmp.mp4`), false);
      assert.equal(updates.at(-1)?.percent, 100);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes the temporary file when the process fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitch-ffmpeg-test-"));
    try {
      const input = join(directory, "in.ts");
      const output = join(directory, "out.mp4");
      await writeFile(input, "source");
      const spawn = fakeSpawn(async ({ child }) => {
        child.stderr.emit("data", "conversion failed");
        child.emit("close", 1);
      });

      await assert.rejects(
        remuxToMp4({
          tools: { ffmpeg: "ffmpeg", ffprobe: null, version: "ffmpeg version test" },
          input,
          output,
          spawn,
        }),
        (error) => error instanceof FfmpegError && error.code === "FFMPEG_FAILED",
      );

      assert.equal(await exists(output), false);
      assert.equal(await exists(`${output}.tmp.mp4`), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("ffmpeg discovery", () => {
  it("rejects an explicit path that is not ffmpeg", () => {
    assert.throws(
      () => findFfmpeg(process.execPath),
      (error) => error instanceof FfmpegError && error.code === "FFMPEG_INVALID",
    );
  });

  it("returns null when ffmpeg is not on PATH", () => {
    const savedPath = process.env.PATH;
    const savedOverride = process.env.TWITCH_VOD_M3U8_FFMPEG;
    delete process.env.TWITCH_VOD_M3U8_FFMPEG;
    process.env.PATH = join(tmpdir(), "twitch-ffmpeg-empty-path");
    try {
      assert.equal(findFfmpeg(), null);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedOverride !== undefined) process.env.TWITCH_VOD_M3U8_FFMPEG = savedOverride;
    }
  });
});

describe("ffprobe duration", () => {
  it("parses the plain text output", () => {
    assert.equal(parseFfprobeDuration("8069.233\n"), 8069.233);
    assert.equal(parseFfprobeDuration("N/A"), null);
    assert.equal(parseFfprobeDuration(""), null);
    assert.equal(parseFfprobeDuration("0"), null);
  });
});
