import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseCountText,
  parseDurationText,
  parseStreamerVitalsStreams,
  parseTwitTrackerStreamTime,
  parseTwitTrackerStreams,
} from "../../dist/twitch/trackers.js";

describe("tracker parsers", () => {
  it("parses durations written in hours, minutes and seconds", () => {
    assert.equal(parseDurationText("2h 15m"), 8100);
    assert.equal(parseDurationText("50m"), 3000);
    assert.equal(parseDurationText("1h 2m 3s"), 3723);
    assert.equal(parseDurationText("45s"), 45);
    assert.equal(parseDurationText("—"), null);
    assert.equal(parseDurationText(""), null);
  });

  it("parses display counts with suffixes", () => {
    assert.equal(parseCountText("1,131"), 1131);
    assert.equal(parseCountText("3.1K"), 3100);
    assert.equal(parseCountText("2.4M"), 2_400_000);
    assert.equal(parseCountText("—"), null);
  });

  it("reads the exact start second from a twitracker stream page", () => {
    const html = `<nav><span class="sr-only">breadcrumb</span><time data-locale="en" data-title="false" datetime="2026-09-09T20:41:21.000Z">Sep 9, 2026, 20:41</time></span></nav>`;
    assert.equal(parseTwitTrackerStreamTime(html), 1788986481);
    assert.equal(parseTwitTrackerStreamTime("<html>no time</html>"), null);
  });

  it("parses the twitracker recent streams table", () => {
    const html = `<table><tbody>
      <tr data-selected="false" role="button"><td><a href="/streamers/dralii/streams/321356041690"><time datetime="2026-09-10T00:21:47.000Z">Sep 10, 2026, 00:21</time></a></td><td>50m</td><td><a href="/streamers/dralii/streams/321356041690">in the US (spotify ads)</a></td><td>Rocket League</td><td>EN</td><td>1,131</td><td>902</td><td>676</td><td>+65</td></tr>
      <tr data-selected="false" role="button"><td><a href="/streamers/dralii/streams/321352284122"><time datetime="2026-09-09T20:41:21.000Z">Sep 9, 2026, 20:41</time></a></td><td>2h 15m</td><td><a href="/streamers/dralii/streams/321352284122">giving opinion on pros = ban</a></td><td>Rocket League</td><td>EN</td><td>1,793</td><td>1,413</td><td>3.1K</td><td>+175</td></tr>
    </tbody></table>`;
    const streams = parseTwitTrackerStreams(html, "dralii");
    assert.equal(streams.length, 2);
    assert.deepEqual(streams[0], {
      source: "twitracker",
      channel: "dralii",
      streamId: "321356041690",
      internalId: null,
      startedAt: 1788999707,
      title: "in the US (spotify ads)",
      category: "Rocket League",
      durationSeconds: 3000,
      averageViewers: 902,
      peakViewers: 1131,
    });
    assert.equal(streams[1].streamId, "321352284122");
    assert.equal(streams[1].durationSeconds, 8100);
  });

  it("parses the streamervitals stream history table", () => {
    const html = `<table><tbody>
      <tr class="sv-row-link"><th scope="row" class="px-3"><a class="rounded" href="/dralii/stream/65335759"><time dateTime="2026-09-09T20:41:21.000Z">Sep 9, 2026, 8:41 PM UTC</time></a><span class="mt-0.5 block">giving opinion on pros = ban</span></th><td class="px-3">Rocket League</td><td class="px-3">2h 15m</td><td class="px-3">1,413</td><td class="px-3">1,793</td><td class="px-3">3.1K</td></tr>
    </tbody></table>`;
    const streams = parseStreamerVitalsStreams(html, "dralii");
    assert.equal(streams.length, 1);
    assert.deepEqual(streams[0], {
      source: "streamervitals",
      channel: "dralii",
      streamId: null,
      internalId: "65335759",
      startedAt: 1788986481,
      title: "giving opinion on pros = ban",
      category: "Rocket League",
      durationSeconds: 8100,
      averageViewers: 1413,
      peakViewers: 1793,
    });
  });
});
