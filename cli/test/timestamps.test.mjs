import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadPlaylist } from "../../dist/download/fetcher.js";
import { parseMediaPlaylist } from "../../dist/download/playlist.js";
import { createTimestampRepair } from "../../dist/download/timestamps.js";

const NO_TIMESTAMP = 0x1ffffffff;

function encodeTimestamp(value) {
  const pts = value % 2 ** 33;
  return [
    0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1),
    Math.floor(pts / 2 ** 22) & 0xff,
    ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 0x01,
    Math.floor(pts / 2 ** 7) & 0xff,
    ((pts & 0x7f) << 1) | 0x01,
  ];
}

function readTimestamp(buffer, offset) {
  return (
    ((buffer[offset] >> 1) & 0x07) * 2 ** 30 +
    buffer[offset + 1] * 2 ** 22 +
    ((buffer[offset + 2] >> 1) & 0x7f) * 2 ** 15 +
    buffer[offset + 3] * 2 ** 7 +
    ((buffer[offset + 4] >> 1) & 0x7f)
  );
}

function encodePcr(value) {
  const pcr = value % (2 ** 33 * 300);
  const base = Math.floor(pcr / 300);
  const extension = pcr % 300;
  return [
    Math.floor(base / 2 ** 25) & 0xff,
    Math.floor(base / 2 ** 17) & 0xff,
    Math.floor(base / 2 ** 9) & 0xff,
    Math.floor(base / 2) & 0xff,
    ((base & 1) << 7) | 0x7e | ((extension >> 8) & 1),
    extension & 0xff,
  ];
}

function readPcr(buffer, offset) {
  const base =
    buffer[offset] * 2 ** 25 +
    buffer[offset + 1] * 2 ** 17 +
    buffer[offset + 2] * 2 ** 9 +
    buffer[offset + 3] * 2 +
    (buffer[offset + 4] >> 7);
  const extension = ((buffer[offset + 4] & 1) << 8) | buffer[offset + 5];
  return base * 300 + extension;
}

/** The shape Twitch writes for an unset PCR: base 0x1FFFFFFFF with no extension. */
const SENTINEL_PCR = [0xff, 0xff, 0xff, 0xff, 0xfe, 0x00];

/**
 * One PES packet, split over as many TS packets as its payload needs. The
 * first packet can carry a PCR in an adaptation field, like Twitch's video
 * packets do; `pcr` accepts a 27 MHz value or "sentinel".
 */
function tsPackets({
  pid = 257,
  streamId = 0xe0,
  pts = null,
  dts = null,
  pcr = null,
  body = Buffer.alloc(16, 0xaa),
}) {
  const flags = (pts !== null ? 0x80 : 0) | (dts !== null ? 0x40 : 0);
  const stamps = Buffer.from([
    ...(pts !== null ? encodeTimestamp(pts) : []),
    ...(dts !== null ? encodeTimestamp(dts) : []),
  ]);
  const header = Buffer.from([0x00, 0x00, 0x01, streamId, 0x00, 0x00, 0x80, flags, stamps.length]);
  const payload = Buffer.concat([header, stamps, body]);
  const packets = [];
  let rest = payload;
  let index = 0;
  while (rest.length > 0) {
    const packet = Buffer.alloc(188, 0xff);
    packet[0] = 0x47;
    packet[1] = (index === 0 ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
    packet[2] = pid & 0xff;
    let start = 4;
    if (index === 0 && pcr !== null) {
      packet[3] = 0x30 | (index & 0x0f);
      packet[4] = 7;
      packet[5] = 0x10;
      const bytes = pcr === "sentinel" ? SENTINEL_PCR : encodePcr(pcr);
      for (let byte = 0; byte < bytes.length; byte += 1) packet[6 + byte] = bytes[byte];
      start = 12;
    } else {
      packet[3] = 0x10 | (index & 0x0f);
    }
    rest.subarray(0, 188 - start).copy(packet, start);
    rest = rest.subarray(188 - start);
    packets.push(packet);
    index += 1;
  }
  return Buffer.concat(packets);
}

// First PES timestamp bytes sit after the 4-byte TS header and the 9-byte PES
// header; the DTS follows the PTS five bytes later.
const PTS_OFFSET = 13;
const DTS_OFFSET = 18;
// With a 7-byte PCR adaptation field, the PCR starts at byte 6 and the PES at
// byte 12.
const PCR_OFFSET = 6;
const PCR_PTS_OFFSET = 21;

describe("timestamp repair", () => {
  it("replaces the unset sentinel with a value near the surrounding stream", () => {
    const repair = createTimestampRepair();
    repair.repair(tsPackets({ pts: 90_000 }));
    const segment = Buffer.concat([tsPackets({ pts: NO_TIMESTAMP }), tsPackets({ pts: 96_000 })]);

    repair.repair(segment);

    assert.equal(readTimestamp(segment, PTS_OFFSET), 90_000 + 3_003);
    assert.equal(readTimestamp(segment, 188 + PTS_OFFSET), 96_000);
  });

  it("uses the packet DTS when the PTS is unset", () => {
    const repair = createTimestampRepair();
    const segment = tsPackets({ pts: NO_TIMESTAMP, dts: 120_000 });

    repair.repair(segment);

    assert.equal(readTimestamp(segment, PTS_OFFSET), 120_000);
    assert.equal(readTimestamp(segment, DTS_OFFSET), 120_000);
  });

  it("falls back to the next timestamp when no earlier one is known", () => {
    const repair = createTimestampRepair();
    const segment = Buffer.concat([tsPackets({ pts: NO_TIMESTAMP }), tsPackets({ pts: 45_000 })]);

    repair.repair(segment);

    assert.equal(readTimestamp(segment, PTS_OFFSET), 45_000);
  });

  it("leaves a segment without sentinels byte-identical", () => {
    const repair = createTimestampRepair();
    const segment = Buffer.concat([
      tsPackets({ pts: 90_000 }),
      tsPackets({ pid: 256, streamId: 0xc0, pts: 90_000 }),
      tsPackets({ pts: 93_000 }),
    ]);
    const original = Buffer.from(segment);

    repair.repair(segment);

    assert.deepEqual(segment, original);
  });

  it("ignores buffers that are not MPEG-TS", () => {
    const repair = createTimestampRepair();
    const fragmentedMp4 = Buffer.alloc(400, 0x21);
    const original = Buffer.from(fragmentedMp4);

    repair.repair(fragmentedMp4);

    assert.deepEqual(fragmentedMp4, original);
  });

  it("replaces the all-ones PCR with an advance from the previous packet", () => {
    const repair = createTimestampRepair();
    repair.repair(tsPackets({ pcr: 27_000_000 }));
    repair.repair(tsPackets({ pcr: 27_270_000 }));
    const segment = tsPackets({ pcr: "sentinel" });

    repair.repair(segment);

    assert.equal(readPcr(segment, PCR_OFFSET), 27_270_000 + 270_000);
  });

  it("repairs a packet that carries both an unset PTS and an unset PCR", () => {
    const repair = createTimestampRepair();
    repair.repair(tsPackets({ pcr: 27_000_000, pts: 90_000 }));
    repair.repair(tsPackets({ pcr: 27_270_000, pts: 93_000 }));
    const segment = tsPackets({ pcr: "sentinel", pts: NO_TIMESTAMP });

    repair.repair(segment);

    assert.equal(readPcr(segment, PCR_OFFSET), 27_270_000 + 270_000);
    assert.equal(readTimestamp(segment, PCR_PTS_OFFSET), 93_000 + 3_000);
  });

  it("leaves valid PCR values byte-identical", () => {
    const repair = createTimestampRepair();
    const segment = Buffer.concat([
      tsPackets({ pcr: 27_000_000, pts: 90_000 }),
      tsPackets({ pcr: 27_270_000, pts: 93_000 }),
    ]);
    const original = Buffer.from(segment);

    repair.repair(segment);

    assert.deepEqual(segment, original);
  });
});

describe("timestamp repair during download", () => {
  it("repairs sentinel timestamps while concatenating segments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitch-timestamp-test-"));
    try {
      const output = join(directory, "out.ts");
      const playlist = parseMediaPlaylist(
        "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts\n#EXT-X-ENDLIST",
        "https://d2nvs31859zcd8.cloudfront.net/vod/index.m3u8",
      );
      const chunks = {
        "a.ts": tsPackets({ pcr: 27_000_000, pts: 90_000 }),
        "b.ts": tsPackets({ pcr: "sentinel", pts: NO_TIMESTAMP }),
      };
      const fakeFetch = async (url) => {
        const key = String(url).split("/").at(-1);
        return key in chunks ? new Response(chunks[key], { status: 200 }) : new Response("", { status: 404 });
      };

      await downloadPlaylist({ playlist, output, fetch: fakeFetch, retryDelayMs: 1 });

      const file = await readFile(output);
      const firstLength = chunks["a.ts"].length;
      assert.equal(file.length, firstLength + chunks["b.ts"].length);
      assert.equal(readTimestamp(file, PCR_PTS_OFFSET), 90_000);
      assert.equal(readTimestamp(file, firstLength + PCR_PTS_OFFSET), 90_000 + 3_003);
      // Only one valid PCR had been seen, so the sentinel repeats it.
      assert.equal(readPcr(file, PCR_OFFSET), 27_000_000);
      assert.equal(readPcr(file, firstLength + PCR_OFFSET), 27_000_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
