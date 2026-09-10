import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalTarget, latestTarget } from "../../dist/target.js";

describe("canonical hidden target", () => {
  it("builds video:channel_streamId_startTimestamp", () => {
    assert.equal(
      canonicalTarget("dralii", "321352284122", 1788986481),
      "video:dralii_321352284122_1788986481",
    );
  });

  it("picks the newest row with a resolvable target", () => {
    const streams = [
      { streamId: null, vodId: null, startedAt: 1789000000 },
      { streamId: null, vodId: "111", startedAt: 1788990000 },
      { streamId: "320158574814", vodId: "222", startedAt: 1788971185 },
    ];
    const latest = latestTarget("xqc", streams);
    assert.ok(latest);
    assert.equal(latest.target, "https://www.twitch.tv/videos/111");
    assert.equal(latest.stream.vodId, "111");
  });

  it("prefers an exact hidden target when it is newest", () => {
    const latest = latestTarget("xqc", [{ streamId: "320999999999", vodId: null, startedAt: 1788999999 }]);
    assert.ok(latest);
    assert.equal(latest.target, "video:xqc_320999999999_1788999999");
  });

  it("returns null when no row has a target", () => {
    assert.equal(latestTarget("xqc", [{ streamId: null, vodId: null, startedAt: 1789000000 }]), null);
  });
});
