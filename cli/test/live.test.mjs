import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseInput, ResolveError } from "../../dist/resolver.js";
import { parseLiveChannel } from "../../dist/live/channel.js";
import { liveCommand } from "../../dist/live/command.js";
import { stripLiveAds } from "../../dist/live/ads.js";
import { resolveLiveM3U8 } from "../../dist/live/resolver.js";
import { MediaRegistry } from "../../dist/watch/media.js";
import { startWatchServer } from "../../dist/watch/server.js";

const LIVE_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,VIDEO="chunked"
https://video-weaver.fra02.ttvnw.net/live/chunked/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,VIDEO="720p60"
https://video-weaver.fra02.ttvnw.net/live/720p60/index.m3u8`;

function liveTokenFetch(master, onRequest) {
  return async (input, init) => {
    const url = String(input);
    onRequest?.(url, init);
    if (url === "https://gql.twitch.tv/gql") {
      return new Response(
        JSON.stringify({ data: { streamPlaybackAccessToken: { value: "live-token", signature: "live-sig" } } }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://usher.ttvnw.net/api/channel/hls/")) {
      return new Response(master, { status: 200 });
    }
    return new Response("", { status: 404 });
  };
}

test("parseLiveChannel accepts logins, live: targets and channel URLs", () => {
  assert.equal(parseLiveChannel("XQC"), "xqc");
  assert.equal(parseLiveChannel("live:xqc"), "xqc");
  assert.equal(parseLiveChannel("https://www.twitch.tv/xqc"), "xqc");
  assert.equal(parseLiveChannel("https://twitch.tv/xqc/"), "xqc");
  // Query strings, fragments and trailing slashes still name the channel.
  assert.equal(parseLiveChannel("https://www.twitch.tv/xqc?foo=bar"), "xqc");
  assert.equal(parseLiveChannel("https://www.twitch.tv/xqc/#about"), "xqc");
  assert.equal(parseLiveChannel("https://twitch.tv/xqc/?foo=bar"), "xqc");
  for (const bad of [
    "",
    "a b",
    "x".repeat(26),
    "https://www.twitch.tv/videos/2434567890",
    "https://www.twitch.tv/xqc/videos/2434567890",
    "https://www.twitch.tv/xqc/clip/abc",
  ]) {
    assert.throws(() => parseLiveChannel(bad), ResolveError, `input ${bad} should be rejected`);
  }
});

test("parseInput routes live targets without changing VOD inputs", () => {
  assert.deepEqual(parseInput("live:xqc"), { kind: "live", channel: "xqc" });
  assert.deepEqual(parseInput("https://www.twitch.tv/xqc"), { kind: "live", channel: "xqc" });
  assert.deepEqual(parseInput("https://www.twitch.tv/xqc?foo=bar"), { kind: "live", channel: "xqc" });
  assert.deepEqual(parseInput("https://www.twitch.tv/videos/2434567890"), {
    kind: "public",
    videoId: "2434567890",
  });
  assert.throws(() => parseInput("xqc"), ResolveError);
});

test("resolveLiveM3U8 uses the live token and the live usher endpoint", async () => {
  const requests = [];
  const result = await resolveLiveM3U8("xqc", { fetch: liveTokenFetch(LIVE_MASTER, (url) => requests.push(url)) });
  assert.equal(result.kind, "live");
  assert.equal(result.channel, "xqc");
  assert.deepEqual(
    result.formats.map((format) => format.id),
    ["chunked", "720p60"],
  );
  const masterRequest = requests.find((url) => url.startsWith("https://usher.ttvnw.net/api/channel/hls/xqc.m3u8"));
  assert.match(masterRequest, /[?&]sig=live-sig(&|$)/);
  assert.match(masterRequest, /[?&]token=live-token(&|$)/);
});

test("resolveLiveM3U8 reports OFFLINE when the channel is not live", async () => {
  const noToken = async (input) =>
    String(input) === "https://gql.twitch.tv/gql"
      ? new Response(JSON.stringify({ data: {} }), { status: 200 })
      : new Response("", { status: 404 });
  await assert.rejects(resolveLiveM3U8("xqc", { fetch: noToken }), (error) => {
    assert.equal(error.code, "OFFLINE");
    return true;
  });
  const gone = async (input) => {
    if (String(input) === "https://gql.twitch.tv/gql") {
      return new Response(
        JSON.stringify({ data: { streamPlaybackAccessToken: { value: "t", signature: "s" } } }),
        { status: 200 },
      );
    }
    return new Response("", { status: 404 });
  };
  await assert.rejects(resolveLiveM3U8("xqc", { fetch: gone }), (error) => {
    assert.equal(error.code, "OFFLINE");
    return true;
  });
});

const MIDROLL = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-DISCONTINUITY-SEQUENCE:5
#EXTINF:8.0,
seg-100.ts
#EXTINF:8.0,
seg-101.ts
#EXT-X-DISCONTINUITY
#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-01-01T00:00:00Z",DURATION=16.0,PLANNED-DURATION=16.0
#EXTINF:8.0,
ad-1.ts
#EXTINF:8.0,
ad-2.ts
#EXT-X-CUE-IN
#EXT-X-DISCONTINUITY
#EXTINF:8.0,
seg-102.ts
#EXTINF:6.0,
seg-103.ts`;

test("stripLiveAds removes a midroll pod and repairs the counters", () => {
  const result = stripLiveAds(MIDROLL);
  assert.equal(result.removedSegments, 2);
  assert.equal(result.adPods, 1);
  for (const kept of ["seg-100.ts", "seg-101.ts", "seg-102.ts", "seg-103.ts"]) {
    assert.ok(result.text.includes(kept), `${kept} should be kept`);
  }
  assert.ok(!result.text.includes("ad-1.ts") && !result.text.includes("ad-2.ts"));
  assert.match(result.text, /#EXT-X-MEDIA-SEQUENCE:100/);
  assert.match(result.text, /#EXT-X-DISCONTINUITY-SEQUENCE:4/);
  assert.match(result.text, /#EXT-X-TARGETDURATION:8/);
  const lines = result.text.split("\n");
  assert.equal(
    lines.filter((line) => line === "#EXT-X-DISCONTINUITY").length,
    1,
    "exactly one splice should remain",
  );
  const before = lines.indexOf("seg-101.ts");
  const splice = lines.indexOf("#EXT-X-DISCONTINUITY");
  const after = lines.indexOf("seg-102.ts");
  assert.ok(before < splice && splice < after, "a single splice should join the content");
});

test("stripLiveAds handles CUE-OUT pods that open before their boundary", () => {
  const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:50
#EXTINF:4.0,
a.ts
#EXT-X-CUE-OUT:8.0
#EXT-X-DISCONTINUITY
#EXTINF:4.0,
ad-a.ts
#EXTINF:4.0,
ad-b.ts
#EXT-X-DISCONTINUITY
#EXTINF:4.0,
b.ts`;
  const result = stripLiveAds(playlist);
  assert.equal(result.removedSegments, 2);
  assert.equal(result.adPods, 1);
  assert.ok(result.text.includes("a.ts") && result.text.includes("b.ts"));
  assert.ok(!result.text.includes("ad-a.ts") && !result.text.includes("ad-b.ts"));
  assert.match(result.text, /#EXT-X-TARGETDURATION:4/);
});

test("stripLiveAds shifts the media sequence past a leading preroll", () => {
  const playlist = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:200
#EXT-X-TARGETDURATION:6
#EXT-X-DATERANGE:ID="stitched-ad-pre",CLASS="twitch-stitched-ad",START-DATE="2026-01-01T00:00:00Z",DURATION=8.0,PLANNED-DURATION=8.0
#EXTINF:4.0,
pre-1.ts
#EXTINF:4.0,
pre-2.ts
#EXT-X-CUE-IN
#EXTINF:4.0,
live-1.ts
#EXTINF:4.0,
live-2.ts`;
  const result = stripLiveAds(playlist);
  assert.equal(result.removedSegments, 2);
  assert.match(result.text, /#EXT-X-MEDIA-SEQUENCE:202/);
  assert.ok(result.text.includes("live-1.ts") && result.text.includes("live-2.ts"));
  assert.ok(!result.text.includes("pre-1.ts"));
});

test("stripLiveAds passes through masters, clean media and all-ad windows", () => {
  assert.equal(stripLiveAds(LIVE_MASTER).removedSegments, 0);
  assert.equal(stripLiveAds(LIVE_MASTER).text, LIVE_MASTER);
  const clean = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:3
#EXTINF:4.0,
seg-3.ts
#EXT-X-DISCONTINUITY
#EXTINF:4.0,
seg-4.ts`;
  const kept = stripLiveAds(clean);
  assert.equal(kept.removedSegments, 0);
  assert.equal(kept.text, clean);
  const allAds = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-DATERANGE:ID="stitched-ad-only",CLASS="twitch-stitched-ad",START-DATE="2026-01-01T00:00:00Z"
#EXTINF:4.0,
ad-only.ts`;
  const failed = stripLiveAds(allAds);
  assert.equal(failed.removedSegments, 0);
  assert.equal(failed.text, allAds);
  assert.throws(() => stripLiveAds("<html>not a playlist</html>"));
});

test("MediaRegistry evicts the oldest entries in live mode instead of failing", () => {
  const live = new MediaRegistry("/live/", { evictOldest: true });
  for (let i = 0; i < 100_002; i += 1) {
    live.register(`https://video-weaver.fra02.ttvnw.net/live/seg-${i}.ts`);
  }
  assert.ok(live.resources.size <= 100_001);
  const strict = new MediaRegistry("/vod/");
  assert.throws(() => {
    for (let i = 0; i < 100_002; i += 1) {
      strict.register(`https://video-weaver.fra02.ttvnw.net/live/seg-${i}.ts`);
    }
  }, /Playlist resource limit reached/);
});

async function liveFixture(t, { fetch, mode = "live", extra = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "live-test-"));
  await writeFile(join(directory, "replay.html"), "<!doctype html><title>Live</title>");
  const server = await startWatchServer({
    assets: directory,
    mode,
    input: "xqc",
    ...(fetch ? { fetch } : {}),
    ...extra,
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...server, api: new URL("api/", server.url).href };
}

async function ready(server, wants = (state) => state.state === "ready") {
  for (let i = 0; i < 200; i += 1) {
    const state = await (await fetch(server.api + "session")).json();
    if (wants(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Session did not settle");
}

const LIVE_MEDIA_WITH_ADS = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:10
#EXTINF:4.0,
seg10.ts
#EXT-X-DISCONTINUITY
#EXT-X-DATERANGE:ID="stitched-ad-x",CLASS="twitch-stitched-ad",START-DATE="2026-01-01T00:00:00Z",DURATION=4.0,PLANNED-DURATION=4.0
#EXTINF:4.0,
ad10.ts
#EXT-X-CUE-IN
#EXT-X-DISCONTINUITY
#EXTINF:4.0,
seg11.ts`;

test("live watch filters stitched ads through the local player", async (t) => {
  const singleVariant = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,VIDEO="360p30"
https://video-weaver.fra02.ttvnw.net/ch/360p30/index.m3u8`;
  const server = await liveFixture(t, {
    fetch: async (input) => {
        const url = String(input);
        if (url === "https://gql.twitch.tv/gql") {
          return new Response(
            JSON.stringify({ data: { streamPlaybackAccessToken: { value: "t", signature: "s" } } }),
            { status: 200 },
          );
        }
        if (url.startsWith("https://usher.ttvnw.net/api/channel/hls/")) {
          return new Response(singleVariant, { status: 200 });
        }
        if (url === "https://video-weaver.fra02.ttvnw.net/ch/360p30/index.m3u8") {
          return new Response(LIVE_MEDIA_WITH_ADS, { status: 200 });
        }
        return new Response("bytes", { status: 200 });
    },
  });
  const session = await ready(server);
  assert.equal(session.source, "live");
  assert.match(session.title, /xqc/);
  assert.equal(session.chat.kind, "unavailable");
  // Live formats point at the variant media playlists, so the ad filter
  // applies to the first proxied fetch. Segment names never leave the
  // server: the player only sees local media URLs without credentials.
  const filtered = await (await fetch(new URL(session.formats[0].url, server.origin))).text();
  assert.ok(!filtered.includes("sig="), "playback credentials stay on the server");
  assert.ok(!filtered.includes("ad10"), "the stitched ad should be removed");
  assert.match(filtered, /#EXT-X-MEDIA-SEQUENCE:10/);
  const segments = filtered.split("\n").filter((line) => line.startsWith("/"));
  assert.equal(segments.length, 2);
  const bytes = await fetch(new URL(segments[0], server.origin));
  assert.equal(bytes.status, 200);
  assert.equal(await bytes.text(), "bytes");
});

test("live watch refreshes expired tokens and keeps playing", async (t) => {
  let masterCalls = 0;
  const variant = (version) => `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,VIDEO="360p30"
https://video-weaver.fra02.ttvnw.net/ch/${version}/index.m3u8`;
  const server = await liveFixture(t, {
    fetch: async (input) => {
      const url = String(input);
      if (url === "https://gql.twitch.tv/gql") {
        return new Response(
          JSON.stringify({ data: { streamPlaybackAccessToken: { value: "t", signature: "s" } } }),
          { status: 200 },
        );
      }
      if (url.startsWith("https://usher.ttvnw.net/api/channel/hls/")) {
        masterCalls += 1;
        return new Response(variant(masterCalls <= 1 ? "v1" : "v2"), { status: 200 });
      }
      if (url === "https://video-weaver.fra02.ttvnw.net/ch/v1/index.m3u8") {
        return new Response("", { status: 401 });
      }
      if (url === "https://video-weaver.fra02.ttvnw.net/ch/v2/index.m3u8") {
        return new Response("#EXTM3U\n#EXTINF:4.0,\nok.ts\n", { status: 200 });
      }
      return new Response("bytes", { status: 200 });
    },
  });
  const first = await ready(server);
  // The expired variant answers 401, so the server refreshes the token in
  // the background and the polling player picks up the new revision.
  const expired = await fetch(new URL(first.formats[0].url, server.origin));
  assert.equal(expired.status, 502);
  const second = await ready(server, (state) => state.state === "ready" && state.revision !== first.revision);
  assert.ok(second.formats[0].url !== first.formats[0].url, "refresh should register fresh URLs");
  const fresh = await fetch(new URL(second.formats[0].url, server.origin));
  assert.equal(fresh.status, 200);
  // The recovered playlist is rewritten to local URLs; its single segment
  // proves the refreshed token resolves a working variant.
  const recovered = await fresh.text();
  assert.ok(recovered.includes("#EXTINF"));
  assert.equal(
    recovered.split("\n").filter((line) => line.startsWith("/")).length,
    1,
  );
});

test("live command rejects player-only and url-only flag combinations", async () => {
  await assert.rejects(liveCommand(["xqc", "--with-ads"]), /--watch/);
  await assert.rejects(liveCommand(["xqc", "--port", "8080"]), /--watch/);
  await assert.rejects(liveCommand(["xqc", "--no-open"]), /--watch/);
  await assert.rejects(liveCommand(["xqc", "--watch", "--json"]), /--watch/);
  await assert.rejects(liveCommand(["xqc", "--watch", "--all"]), /--watch/);
  await assert.rejects(liveCommand(["xqc", "--watch", "--copy"]), /--watch/);
  await assert.rejects(liveCommand(["xqc", "--watch", "--open"]), /--watch/);
});

test("live watch keeps the ready session when a token refresh fails transiently", async (t) => {
  let masterCalls = 0;
  const server = await liveFixture(t, {
    fetch: async (input) => {
      const url = String(input);
      if (url === "https://gql.twitch.tv/gql") {
        return new Response(
          JSON.stringify({ data: { streamPlaybackAccessToken: { value: "t", signature: "s" } } }),
          { status: 200 },
        );
      }
      if (url.startsWith("https://usher.ttvnw.net/api/channel/hls/")) {
        masterCalls += 1;
        // First resolve succeeds; the background refresh fails transiently.
        if (masterCalls > 1) return new Response("", { status: 500 });
        return new Response(
          `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,VIDEO="360p30"\nhttps://video-weaver.fra02.ttvnw.net/ch/v1/index.m3u8`,
          { status: 200 },
        );
      }
      if (url === "https://video-weaver.fra02.ttvnw.net/ch/v1/index.m3u8") {
        return new Response("", { status: 401 });
      }
      return new Response("bytes", { status: 200 });
    },
  });
  const first = await ready(server);
  const expired = await fetch(new URL(first.formats[0].url, server.origin));
  assert.equal(expired.status, 502);
  // Give the background refresh a chance to fail. The ready session must be
  // preserved with the same revision so playback state is not clobbered.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const kept = await (await fetch(server.api + "session")).json();
  assert.equal(kept.state, "ready");
  assert.equal(kept.revision, first.revision);
  assert.equal(kept.source, "live");
});
