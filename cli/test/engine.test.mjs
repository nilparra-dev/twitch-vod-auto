import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chooseEngine } from "../../dist/download/command.js";
import {
  estimatePlaylistBytes,
  freeDiskBytes,
  parseContentRangeTotal,
  scaleEstimatedBytes,
  selectEngine,
} from "../../dist/download/engine.js";
import { parseMediaPlaylist } from "../../dist/download/playlist.js";

const BASE = "https://d2nvs31859zcd8.cloudfront.net/vod/index.m3u8";

function context(overrides = {}) {
  return {
    requested: "auto",
    requestedMp4: true,
    keepTs: false,
    ffmpeg: true,
    installFfmpeg: false,
    initSegment: false,
    discontinuities: 0,
    estimatedBytes: null,
    freeBytes: null,
    nativeResume: false,
    hybridResume: false,
    ...overrides,
  };
}

describe("engine selection", () => {
  it("honors an explicit engine", () => {
    assert.equal(selectEngine(context({ requested: "native" })).engine, "native");
    assert.equal(selectEngine(context({ requested: "ffmpeg" })).engine, "ffmpeg");
    assert.equal(selectEngine(context({ requested: "hybrid" })).engine, "hybrid");
  });

  it("resumes a previous hybrid download before anything else", () => {
    const choice = selectEngine(context({ hybridResume: true, initSegment: true }));
    assert.equal(choice.engine, "hybrid");
    assert.match(choice.reason, /resume/);
  });

  it("resumes a previous native download", () => {
    const choice = selectEngine(context({ nativeResume: true, ffmpeg: false }));
    assert.equal(choice.engine, "native");
    assert.match(choice.reason, /resume/);
  });

  it("keeps the native engine for .ts output and --keep-ts", () => {
    assert.equal(selectEngine(context({ requestedMp4: false })).engine, "native");
    assert.equal(selectEngine(context({ keepTs: true })).engine, "native");
  });

  it("does not silently drop an MP4 when ffmpeg is missing", () => {
    const choice = selectEngine(context({ ffmpeg: false, installFfmpeg: false }));
    assert.equal(choice.engine, "native");
    assert.match(choice.reason, /ffmpeg/);
  });

  it("uses ffmpeg for fragmented MP4 and discontinued playlists", () => {
    assert.match(selectEngine(context({ initSegment: true })).reason, /fragmented/);
    const choice = selectEngine(context({ discontinuities: 3 }));
    assert.equal(choice.engine, "ffmpeg");
    assert.match(choice.reason, /3 discontinuities/);
  });

  it("falls back to ffmpeg when the disk cannot hold the segments", () => {
    const choice = selectEngine(context({ estimatedBytes: 1000, freeBytes: 500 }));
    assert.equal(choice.engine, "ffmpeg");
    assert.match(choice.reason, /disk/);
  });

  it("uses the hybrid engine when the disk check is unknown", () => {
    assert.equal(selectEngine(context()).engine, "hybrid");
    assert.equal(selectEngine(context({ estimatedBytes: 1000, freeBytes: null })).engine, "hybrid");
  });

  it("treats --install-ffmpeg as usable ffmpeg", () => {
    assert.equal(selectEngine(context({ ffmpeg: false, installFfmpeg: true })).engine, "hybrid");
  });
});

describe("engine estimates", () => {
  it("parses the total size of a content-range header", () => {
    assert.equal(parseContentRangeTotal("bytes 0-0/12345"), 12345);
    assert.equal(parseContentRangeTotal("bytes 10-20/300"), 300);
    assert.equal(parseContentRangeTotal("bytes 0-0/*"), null);
    assert.equal(parseContentRangeTotal("N/A"), null);
    assert.equal(parseContentRangeTotal(null), null);
  });

  it("scales the first segment size to the playlist duration", () => {
    assert.equal(scaleEstimatedBytes(8_000_000, 10, 3600), 2_880_000_000);
    assert.equal(scaleEstimatedBytes(0, 10, 3600), null);
    assert.equal(scaleEstimatedBytes(100, 0, 3600), null);
    assert.equal(scaleEstimatedBytes(100, 10, 0), null);
  });

  it("probes the first segment with a one byte range", async () => {
    const playlist = parseMediaPlaylist(
      "#EXTM3U\n#EXTINF:10,\na.ts\n#EXTINF:10,\nb.ts\n#EXT-X-ENDLIST",
      BASE,
    );
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), range: new Headers(init?.headers).get("range") });
      return new Response("", { status: 206, headers: { "content-range": "bytes 0-0/1000" } });
    };
    const estimate = await estimatePlaylistBytes({ playlist, signal: new AbortController().signal, fetch });
    assert.equal(estimate, 1000 / 10 * 20);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].range, "bytes=0-0");
  });

  it("returns null when the probe cannot answer but propagates aborts", async () => {
    const playlist = parseMediaPlaylist("#EXTM3U\n#EXTINF:10,\na.ts\n#EXT-X-ENDLIST", BASE);
    const failing = async () => {
      throw new Error("offline");
    };
    assert.equal(
      await estimatePlaylistBytes({ playlist, signal: new AbortController().signal, fetch: failing }),
      null,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      estimatePlaylistBytes({
        playlist,
        signal: controller.signal,
        fetch: async () => {
          throw new Error("aborted");
        },
      }),
      /aborted/,
    );
  });

  it("reads the free space of a real directory", async () => {
    const free = await freeDiskBytes(tmpdir());
    assert.equal(typeof free, "number");
    assert.ok(free > 0);
  });
});

const publicResult = {
  kind: "public",
  source: "twitch",
  videoId: "123",
  masterUrl: "https://d2nvs31859zcd8.cloudfront.net/vod/master.m3u8",
  formats: [],
};

function engineOptions(overrides = {}) {
  return {
    playlist: parseMediaPlaylist("#EXTM3U\n#EXTINF:10,\na.ts\n#EXT-X-ENDLIST", BASE),
    requestedMp4: true,
    keepTs: false,
    ffmpeg: true,
    installFfmpeg: false,
    explicitOutput: null,
    outputDirectory: null,
    result: publicResult,
    signal: new AbortController().signal,
    estimate: async () => null,
    freeDisk: async () => null,
    ...overrides,
  };
}

describe("auto engine glue", () => {
  it("detects a previous native partial download", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitch-engine-test-"));
    try {
      const output = join(directory, "clip.mp4");
      await writeFile(`${join(directory, "clip.ts")}.part.json`, "{}");
      const choice = await chooseEngine("auto", engineOptions({ explicitOutput: output }));
      assert.equal(choice.engine, "native");
      assert.match(choice.reason, /resume/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("detects a previous hybrid segment directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitch-engine-test-"));
    try {
      const output = join(directory, "clip.mp4");
      await mkdir(`${output}.segments`, { recursive: true });
      await writeFile(join(`${output}.segments`, "fingerprint"), "x");
      const choice = await chooseEngine("auto", engineOptions({ explicitOutput: output }));
      assert.equal(choice.engine, "hybrid");
      assert.match(choice.reason, /resume/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("probes the size and the disk only when hybrid is considered", async () => {
    let estimated = 0;
    let freeChecks = 0;
    const choice = await chooseEngine(
      "auto",
      engineOptions({
        estimate: async () => {
          estimated += 1;
          return 1000;
        },
        freeDisk: async () => {
          freeChecks += 1;
          return 100;
        },
      }),
    );
    assert.equal(choice.engine, "ffmpeg");
    assert.equal(estimated, 1);
    assert.equal(freeChecks, 1);
  });

  it("skips the probes when another rule decides first", async () => {
    const choice = await chooseEngine(
      "auto",
      engineOptions({
        playlist: parseMediaPlaylist(
          '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\na.m4s\n#EXT-X-ENDLIST',
          BASE,
        ),
        estimate: async () => {
          throw new Error("the estimate must not run");
        },
        freeDisk: async () => {
          throw new Error("the disk probe must not run");
        },
      }),
    );
    assert.equal(choice.engine, "ffmpeg");
  });
});
