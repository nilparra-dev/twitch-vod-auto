import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDuration, measurePlaylistDuration, mergeChannelStreams, streamTarget } from "../../dist/list.js";

const videoWithStream = {
  vodId: "2869633607",
  title: "Recent",
  createdAt: "2026-09-09T16:26:30Z",
  durationSeconds: 3600,
  status: "RECORDED",
  viewCount: 12345,
  category: "Rocket League",
  channel: "xqc",
  streamId: "320158574814",
  startedAtSeconds: 1788971185,
};

const videoWithoutStream = {
  vodId: "111",
  title: "Old",
  createdAt: "2026-09-01T10:00:00Z",
  durationSeconds: 600,
  status: "RECORDED",
  viewCount: null,
  category: null,
  channel: "xqc",
  streamId: null,
  startedAtSeconds: null,
};

const tracker = {
  source: "twitracker",
  channel: "xqc",
  streamId: "320158574814",
  internalId: null,
  startedAt: 1788971185,
  title: "Recent",
  category: "Rocket League",
  durationSeconds: 3600,
  averageViewers: 1000,
  peakViewers: 2000,
};

const hiddenStream = {
  source: "twitracker",
  channel: "xqc",
  streamId: "320999999999",
  internalId: null,
  startedAt: 1788999999,
  title: "Hidden stream",
  category: "Just Chatting",
  durationSeconds: 1200,
  averageViewers: 500,
  peakViewers: 800,
};

const streamerVitalsMatch = {
  source: "streamervitals",
  channel: "xqc",
  streamId: null,
  internalId: "1",
  startedAt: 1788971185,
  title: null,
  category: null,
  durationSeconds: null,
  averageViewers: 1111,
  peakViewers: 2222,
};

const streamerVitalsOnly = {
  source: "streamervitals",
  channel: "xqc",
  streamId: null,
  internalId: "2",
  startedAt: 1788000000,
  title: "Tracker only",
  category: null,
  durationSeconds: 900,
  averageViewers: 10,
  peakViewers: 20,
};

describe("channel stream merge", () => {
  it("merges Twitch VODs with tracker rows by stream ID and start time", () => {
    const streams = mergeChannelStreams({
      videos: [videoWithStream, videoWithoutStream],
      twitTracker: [tracker, hiddenStream],
      streamerVitals: [streamerVitalsMatch, streamerVitalsOnly],
    });
    assert.equal(streams.length, 4);

    const merged = streams.find((stream) => stream.streamId === "320158574814");
    assert.ok(merged);
    assert.deepEqual([...merged.sources].sort(), ["streamervitals", "twitch", "twitracker"]);
    assert.equal(merged.vodId, "2869633607");
    assert.equal(merged.startedAt, 1788971185);
    assert.equal(merged.averageViewers, 1000);

    const hidden = streams.find((stream) => stream.streamId === "320999999999");
    assert.ok(hidden);
    assert.equal(hidden.vodId, null);
    assert.deepEqual(hidden.sources, ["twitracker"]);

    const trackerOnly = streams.find((stream) => stream.sources.includes("streamervitals") && stream.streamId === null);
    assert.ok(trackerOnly);
    assert.equal(trackerOnly.title, "Tracker only");
  });

  it("sorts newest first and keeps tracker-only rows", () => {
    const streams = mergeChannelStreams({
      videos: [videoWithStream, videoWithoutStream],
      twitTracker: [tracker, hiddenStream],
      streamerVitals: [streamerVitalsMatch, streamerVitalsOnly],
    });
    assert.deepEqual(
      streams.map((stream) => stream.streamId ?? stream.vodId),
      ["320999999999", "320158574814", "111", null],
    );
  });

  it("builds hidden targets with the exact timestamp and falls back to VOD URLs", () => {
    assert.equal(
      streamTarget("xqc", {
        streamId: "320999999999",
        vodId: null,
        startedAt: 1788999999,
      }),
      "video:xqc_320999999999_1788999999",
    );
    assert.equal(
      streamTarget("xqc", { streamId: null, vodId: "111", startedAt: 1788256800 }),
      "https://www.twitch.tv/videos/111",
    );
    assert.equal(streamTarget("xqc", { streamId: null, vodId: null, startedAt: null }), null);
  });

  it("formats durations for the table", () => {
    assert.equal(formatDuration(8100), "2h 15m");
    assert.equal(formatDuration(3000), "50m");
    assert.equal(formatDuration(45), "45s");
    assert.equal(formatDuration(null), "-");
  });

  it("measures the exact media duration from an HLS playlist", async () => {
    const playlist = "#EXTM3U\n#EXTINF:10,\n0.ts\n#EXTINF:10,\n1.ts\n#EXTINF:8.951,\n2.ts\n#EXT-X-ENDLIST";
    const duration = await measurePlaylistDuration("https://media.example/index-dvr.m3u8", {
      fetch: async () => new Response(playlist, { status: 200 }),
    });
    assert.ok(duration !== null && Math.abs(duration - 28.951) < 1e-9);
    const missing = await measurePlaylistDuration("https://media.example/nope.m3u8", {
      fetch: async () => new Response("", { status: 403 }),
    });
    assert.equal(missing, null);
  });
});
