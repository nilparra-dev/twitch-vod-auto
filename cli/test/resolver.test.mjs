import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFullVodPath, chooseFormat, parseInput, parseMasterManifest, ResolveError } from "../../dist/resolver.js";

describe("parseInput", () => {
  it("parses public Twitch VODs", () => {
    assert.deepEqual(parseInput("https://www.twitch.tv/videos/2434567890"), {
      kind: "public",
      videoId: "2434567890",
    });
  });

  it("parses tracker URLs", () => {
    assert.deepEqual(parseInput("https://twitchtracker.com/xqc/streams/51582913581"), {
      kind: "tracker",
      provider: "twitchtracker",
      channel: "xqc",
      streamId: "51582913581",
    });
  });

  it("keeps an isolated hidden stream ID distinct", () => {
    assert.deepEqual(parseInput("51582913581"), { kind: "stream-id", streamId: "51582913581" });
  });
});

describe("hidden VOD paths", () => {
  it("matches the twitch-dlp SHA-1 path algorithm", () => {
    assert.equal(
      buildFullVodPath("xqc", "51582913581", 1721686515),
      "a2c2af40b185d99f37c5_xqc_51582913581_1721686515",
    );
  });
});

describe("HLS formats", () => {
  const manifest = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,VIDEO="chunked"
https://video.example/chunked/index-dvr.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,VIDEO="720p60"
https://video.example/720p60/index-dvr.m3u8`;

  it("parses a Twitch master manifest", () => {
    const formats = parseMasterManifest(manifest);
    assert.equal(formats.length, 2);
    assert.deepEqual(formats[0], {
      id: "chunked",
      url: "https://video.example/chunked/index-dvr.m3u8",
      height: 1080,
      fps: 60,
    });
  });

  it("selects best or a named quality", () => {
    const formats = parseMasterManifest(manifest);
    assert.equal(chooseFormat(formats).id, "chunked");
    assert.equal(chooseFormat(formats, "720p60").height, 720);
    assert.throws(() => chooseFormat(formats, "144p"), ResolveError);
  });
});
