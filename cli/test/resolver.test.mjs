import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildFullVodPath, chooseFormat, parseInput, parseMasterManifest, ResolveError, resolveM3U8 } from "../../dist/resolver.js";

describe("CLI metadata", () => {
  it("prints the package version", () => {
    const metadata = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const output = execFileSync(process.execPath, ["dist/cli.js", "--version"], { encoding: "utf8" });
    assert.equal(output.trim(), metadata.version);
  });
});

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

describe("public VOD resolution", () => {
  it("uses the playback token and the usher manifest", async () => {
    const requests = [];
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,VIDEO="chunked"
https://video-weaver.test.ttvnw.net/123/chunked/index-dvr.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,VIDEO="720p60"
https://video-weaver.test.ttvnw.net/123/720p60/index-dvr.m3u8`;
    const fetchImpl = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://gql.twitch.tv/gql") {
        return new Response(
          JSON.stringify({ data: { videoPlaybackAccessToken: { value: "token", signature: "sig" } } }),
          { status: 200 },
        );
      }
      if (url.startsWith("https://usher.ttvnw.net/vod/2434567890.m3u8")) {
        return new Response(master, { status: 200 });
      }
      return new Response("", { status: 404 });
    };
    const result = await resolveM3U8("https://www.twitch.tv/videos/2434567890", { fetch: fetchImpl });
    assert.equal(result.kind, "public");
    assert.equal(result.videoId, "2434567890");
    assert.deepEqual(
      result.formats.map((format) => format.id),
      ["chunked", "720p60"],
    );
    assert.match(requests[1], /[?&]sig=sig(&|$)/);
    assert.match(requests[1], /[?&]token=token(&|$)/);
  });
  it("rejects a manifest redirect outside the media allowlist", async () => {
    const requested = [];
    const fetchImpl = async (input, init) => {
      const url = String(input);
      requested.push(url);
      if (url === "https://gql.twitch.tv/gql") {
        const body = JSON.parse(init.body);
        if (body.operationName === "PlaybackAccessToken_Template") {
          return new Response(
            JSON.stringify({ data: { videoPlaybackAccessToken: { value: "token", signature: "sig" } } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: { video: null } }), { status: 200 });
      }
      if (url.startsWith("https://usher.ttvnw.net/vod/2434567890.m3u8")) {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
      }
      return new Response("", { status: 404 });
    };
    await assert.rejects(
      resolveM3U8("https://www.twitch.tv/videos/2434567890", { fetch: fetchImpl }),
      /outside Twitch/,
    );
    assert.equal(requested.some((url) => url.includes("127.0.0.1")), false);
  });
});

describe("hidden VOD resolution chain", () => {
  const channel = "somechannel";
  const streamId = "999999999999";

  const cdnResponse = (status) => new Response("", { status });
  const isCdn = (url) => url.includes(".cloudfront.net") || url.includes(".twitch.tv") || url.includes("ttvnw.net");

  it("finds a VOD whose Source quality is missing by probing other qualities", async () => {
    const timestamp = 2000;
    const domain = "https://d2vi6trrdongqn.cloudfront.net";
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url.startsWith(domain) && url.includes(`_${channel}_${streamId}_${timestamp}/720p60/index-dvr.m3u8`)) {
        return cdnResponse(200);
      }
      if (isCdn(url)) return cdnResponse(403);
      return cdnResponse(404);
    };
    const result = await resolveM3U8(`video:${channel}_${streamId}_${timestamp}`, {
      fetch: fetchImpl,
      timestampWindow: 0,
    });
    assert.equal(result.kind, "hidden");
    assert.ok(result.formats.some((format) => format.id === "720p60"));
  });

  it("uses an exact tracker timestamp when the provided one is wrong", async () => {
    const provided = 1000;
    const exact = 1093;
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url === `https://twitracker.com/streamers/${channel}/streams/${streamId}`) {
        return new Response(`<nav><time datetime="${new Date(exact * 1000).toISOString()}">x</time></nav>`, {
          status: 200,
        });
      }
      if (url.includes(`_${channel}_${streamId}_${exact}/`)) {
        return cdnResponse(url.includes("/chunked/index-dvr.m3u8") ? 200 : 403);
      }
      if (isCdn(url)) return cdnResponse(403);
      return cdnResponse(404);
    };
    const result = await resolveM3U8(`video:${channel}_${streamId}_${provided}`, {
      fetch: fetchImpl,
      timestampWindow: 0,
    });
    assert.equal(result.kind, "hidden");
    assert.deepEqual(result.timestamp, {
      requested: provided,
      used: exact,
      adjusted: true,
      source: "twitracker",
    });
    assert.equal(result.startedAt, new Date(exact * 1000).toISOString());
  });

  it("finds the exact second through a bounded timestamp window", async () => {
    const provided = 2000;
    const found = 2081;
    const domain = "https://d1m7jfoe9zdc1j.cloudfront.net";
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url.startsWith(domain) && url.includes(`_${channel}_${streamId}_${found}/chunked/index-dvr.m3u8`)) {
        return cdnResponse(200);
      }
      if (isCdn(url)) return cdnResponse(403);
      return cdnResponse(404);
    };
    const result = await resolveM3U8(`video:${channel}_${streamId}_${provided}`, {
      fetch: fetchImpl,
      timestampWindow: 90,
    });
    assert.equal(result.kind, "hidden");
    assert.equal(result.timestamp?.used, found);
    assert.equal(result.timestamp?.source, "window");
    assert.equal(result.timestamp?.adjusted, true);
  });

  it("resolves a bare stream ID through the tracker timestamp chain", async () => {
    const exact = 1093;
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url === `https://twitracker.com/streamers/${channel}/streams/${streamId}`) {
        return new Response(`<time datetime="${new Date(exact * 1000).toISOString()}">x</time>`, { status: 200 });
      }
      if (url.includes(`_${channel}_${streamId}_${exact}/`)) {
        return cdnResponse(url.includes("/chunked/index-dvr.m3u8") ? 200 : 403);
      }
      if (isCdn(url)) return cdnResponse(403);
      return cdnResponse(404);
    };
    const result = await resolveM3U8(streamId, { channel, fetch: fetchImpl, timestampWindow: 0 });
    assert.equal(result.kind, "hidden");
    assert.equal(result.timestamp?.used, exact);
    assert.equal(result.timestamp?.source, "twitracker");
  });

  it("follows a probe redirect only to another allowed media host", async () => {
    const timestamp = 3000;
    const from = "https://d2nvs31859zcd8.cloudfront.net";
    const to = "https://d2vi6trrdongqn.cloudfront.net";
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url.startsWith(from) && url.includes(`_${channel}_${streamId}_${timestamp}/chunked/index-dvr.m3u8`)) {
        return new Response(null, { status: 302, headers: { location: url.replace(from, to) } });
      }
      if (url.startsWith(to) && url.includes(`_${channel}_${streamId}_${timestamp}/chunked/index-dvr.m3u8`)) {
        return cdnResponse(200);
      }
      if (isCdn(url)) return cdnResponse(403);
      return cdnResponse(404);
    };
    const result = await resolveM3U8(`video:${channel}_${streamId}_${timestamp}`, {
      fetch: fetchImpl,
      timestampWindow: 0,
    });
    assert.equal(result.kind, "hidden");
    assert.ok(result.formats.some((format) => format.id === "Source"));
  });

  it("rejects a probe redirect that leaves Twitch's media hosts", async () => {
    const timestamp = 4000;
    const domain = "https://d2nvs31859zcd8.cloudfront.net";
    const requested = [];
    const fetchImpl = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith(domain))
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
      if (isCdn(url)) return cdnResponse(403);
      return cdnResponse(404);
    };
    await assert.rejects(
      resolveM3U8(`video:${channel}_${streamId}_${timestamp}`, { fetch: fetchImpl, timestampWindow: 0 }),
      (error) => error instanceof ResolveError && error.code === "NOT_FOUND",
    );
    assert.equal(requested.some((url) => url.includes("127.0.0.1")), false);
  });

  it("reports a clear error when no timestamp source answers", async () => {
    const fetchImpl = async (input) => {
      const url = String(input);
      if (isCdn(url)) return cdnResponse(403);
      return cdnResponse(404);
    };
    await assert.rejects(
      resolveM3U8(streamId, { channel, fetch: fetchImpl, timestampWindow: 0 }),
      (error) => error instanceof ResolveError && error.code === "TIMESTAMP_UNAVAILABLE",
    );
  });
});
