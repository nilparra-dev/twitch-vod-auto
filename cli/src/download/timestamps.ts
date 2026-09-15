/**
 * Twitch's packager occasionally emits MPEG-TS packets whose timestamp is the
 * "unset" sentinel: a PES PTS/DTS of 0x1FFFFFFFF, or a PCR whose 33-bit base is
 * also all ones. VLC and Windows Media Foundation take those values literally,
 * so seeking into an affected segment jumps the media clock to ~26.5 hours, the
 * 33-bit 90 kHz limit. ffmpeg treats the values as a wrap and ignores them,
 * which is why ffmpeg-based tools do not show the problem.
 *
 * A raw segment concatenation keeps the original packets, so this module
 * rewrites the timestamp fields in place with values interpolated from the
 * surrounding stream. The segment length and TS packet alignment do not
 * change, and a segment without sentinels stays byte-identical.
 */

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const NO_TIMESTAMP = 0x1ffffffff;
const TIMESTAMP_MODULUS = 2 ** 33;
/** A PTS advance above one second is a jump, not a frame interval. */
const MAX_FRAME_TICKS = 90_000;
/** 33 ms, a common frame interval, when no stream delta has been observed yet. */
const FALLBACK_FRAME_TICKS = 3_003;
const MAX_RECENT_DELTAS = 32;
/** PCR ticks per PTS tick: the PCR runs at 27 MHz, PTS at 90 kHz. */
const PCR_SCALE = 300;
const MAX_PCR_DELTA = 27_000_000;

interface StreamState {
  lastPts: number | null;
  lastDts: number | null;
  /** Positive PTS advances, newest last. Their minimum approximates one frame. */
  deltas: number[];
}

interface PesEvent {
  pid: number;
  ptsOffset: number | null;
  pts: number | null;
  dtsOffset: number | null;
  dts: number | null;
}

interface PcrState {
  /** Last valid PCR in 27 MHz ticks. */
  last: number | null;
  /** Last positive PCR advance in 27 MHz ticks. */
  step: number | null;
}

interface PcrEvent {
  pid: number;
  /** Offset of the first PCR byte, inside the adaptation field. */
  offset: number;
  /** PCR in 27 MHz ticks, or null for the all-ones sentinel. */
  value: number | null;
}

export interface TimestampRepair {
  /** Repairs one segment in place, in playback order. */
  repair(buffer: Buffer): void;
}

function looksLikeTransportStream(buffer: Buffer): boolean {
  if (buffer.length === 0 || buffer.length % TS_PACKET_SIZE !== 0) return false;
  const probes = Math.min(Math.floor(buffer.length / TS_PACKET_SIZE), 5);
  for (let packet = 0; packet < probes; packet += 1) {
    if (buffer.readUInt8(packet * TS_PACKET_SIZE) !== TS_SYNC_BYTE) return false;
  }
  return true;
}

function readTimestamp(buffer: Buffer, offset: number): number {
  return (
    ((buffer.readUInt8(offset) >> 1) & 0x07) * 2 ** 30 +
    buffer.readUInt8(offset + 1) * 2 ** 22 +
    ((buffer.readUInt8(offset + 2) >> 1) & 0x7f) * 2 ** 15 +
    buffer.readUInt8(offset + 3) * 2 ** 7 +
    ((buffer.readUInt8(offset + 4) >> 1) & 0x7f)
  );
}

function writeTimestamp(buffer: Buffer, offset: number, value: number): void {
  const pts = ((value % TIMESTAMP_MODULUS) + TIMESTAMP_MODULUS) % TIMESTAMP_MODULUS;
  buffer.writeUInt8(0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1), offset);
  buffer.writeUInt8(Math.floor(pts / 2 ** 22) & 0xff, offset + 1);
  buffer.writeUInt8(((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 0x01, offset + 2);
  buffer.writeUInt8(Math.floor(pts / 2 ** 7) & 0xff, offset + 3);
  buffer.writeUInt8(((pts & 0x7f) << 1) | 0x01, offset + 4);
}

function readPcr(buffer: Buffer, offset: number): { base: number; value: number } {
  const base =
    buffer.readUInt8(offset) * 2 ** 25 +
    buffer.readUInt8(offset + 1) * 2 ** 17 +
    buffer.readUInt8(offset + 2) * 2 ** 9 +
    buffer.readUInt8(offset + 3) * 2 +
    (buffer.readUInt8(offset + 4) >> 7);
  const extension = ((buffer.readUInt8(offset + 4) & 0x01) << 8) | buffer.readUInt8(offset + 5);
  return { base, value: base * PCR_SCALE + extension };
}

function writePcr(buffer: Buffer, offset: number, value: number): void {
  const modulus = TIMESTAMP_MODULUS * PCR_SCALE;
  const pcr = ((value % modulus) + modulus) % modulus;
  const base = Math.floor(pcr / PCR_SCALE);
  const extension = pcr % PCR_SCALE;
  buffer.writeUInt8(Math.floor(base / 2 ** 25) & 0xff, offset);
  buffer.writeUInt8(Math.floor(base / 2 ** 17) & 0xff, offset + 1);
  buffer.writeUInt8(Math.floor(base / 2 ** 9) & 0xff, offset + 2);
  buffer.writeUInt8(Math.floor(base / 2) & 0xff, offset + 3);
  buffer.writeUInt8(((base & 0x01) << 7) | 0x7e | ((extension >> 8) & 0x01), offset + 4);
  buffer.writeUInt8(extension & 0xff, offset + 5);
}

function collectPcrEvents(buffer: Buffer, events: PcrEvent[]): void {
  for (let offset = 0; offset + TS_PACKET_SIZE <= buffer.length; offset += TS_PACKET_SIZE) {
    if (buffer.readUInt8(offset) !== TS_SYNC_BYTE) continue;
    const second = buffer.readUInt8(offset + 1);
    const pid = ((second & 0x1f) << 8) | buffer.readUInt8(offset + 2);
    const control = (buffer.readUInt8(offset + 3) >> 4) & 0x03;
    if ((control & 0x02) === 0) continue;
    const adaptation = offset + 4;
    const length = buffer.readUInt8(adaptation);
    if (length < 7) continue;
    if ((buffer.readUInt8(adaptation + 1) & 0x10) === 0) continue;
    const pcrOffset = adaptation + 2;
    const { base, value } = readPcr(buffer, pcrOffset);
    events.push({ pid, offset: pcrOffset, value: base === NO_TIMESTAMP ? null : value });
  }
}

function nextValidPcr(events: PcrEvent[], from: number, pid: number): number | null {
  for (let index = from + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event && event.pid === pid && event.value !== null) return event.value;
  }
  return null;
}

function repairPcrs(buffer: Buffer, events: PcrEvent[], streams: Map<number, PcrState>): void {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    const state = streams.get(event.pid) ?? { last: null, step: null };
    if (event.value === null) {
      let replacement: number | null = null;
      if (state.last !== null && state.step !== null) {
        replacement = state.last + state.step;
      } else {
        replacement = nextValidPcr(events, index, event.pid);
        if (replacement === null || (state.last !== null && replacement < state.last)) {
          replacement = state.last;
        }
      }
      if (replacement !== null) {
        writePcr(buffer, event.offset, replacement);
        event.value = replacement;
      }
    }
    if (event.value !== null) {
      if (state.last !== null) {
        const delta = event.value - state.last;
        if (delta > 0 && delta <= MAX_PCR_DELTA) state.step = delta;
      }
      state.last = event.value;
    }
    streams.set(event.pid, state);
  }
}

/** Elementary streams carrying PTS/DTS: video, audio, private stream 1 (AC-3). */
function isElementaryStream(streamId: number): boolean {
  return (streamId >= 0xc0 && streamId <= 0xef) || streamId === 0xbd || streamId === 0xfd;
}

function collectPesEvents(buffer: Buffer, events: PesEvent[]): void {
  for (let offset = 0; offset + TS_PACKET_SIZE <= buffer.length; offset += TS_PACKET_SIZE) {
    if (buffer.readUInt8(offset) !== TS_SYNC_BYTE) continue;
    const second = buffer.readUInt8(offset + 1);
    // Only the packet that starts a PES header carries its timestamps.
    if ((second & 0x40) === 0) continue;
    const pid = ((second & 0x1f) << 8) | buffer.readUInt8(offset + 2);
    const control = (buffer.readUInt8(offset + 3) >> 4) & 0x03;
    let payload = offset + 4;
    if (control & 0x02) payload += 1 + buffer.readUInt8(payload);
    if ((control & 0x01) === 0) continue;
    const end = offset + TS_PACKET_SIZE;
    if (payload + 9 > end) continue;
    if (
      buffer.readUInt8(payload) !== 0x00 ||
      buffer.readUInt8(payload + 1) !== 0x00 ||
      buffer.readUInt8(payload + 2) !== 0x01
    ) {
      continue;
    }
    if (!isElementaryStream(buffer.readUInt8(payload + 3))) continue;

    const flags = buffer.readUInt8(payload + 7);
    let cursor = payload + 9;
    let pts: number | null = null;
    let ptsOffset: number | null = null;
    let dts: number | null = null;
    let dtsOffset: number | null = null;
    if (flags & 0x80 && cursor + 5 <= end) {
      pts = readTimestamp(buffer, cursor);
      ptsOffset = cursor;
      cursor += 5;
    }
    if ((flags & 0xc0) === 0xc0 && cursor + 5 <= end) {
      dts = readTimestamp(buffer, cursor);
      dtsOffset = cursor;
    }
    if (pts === null && dts === null) continue;
    events.push({ pid, ptsOffset, pts, dtsOffset, dts });
  }
}

function estimateStep(state: StreamState): number {
  let step = Number.POSITIVE_INFINITY;
  for (const delta of state.deltas) step = Math.min(step, delta);
  return Number.isFinite(step) ? Math.max(1, step) : FALLBACK_FRAME_TICKS;
}

function nextValidTimestamp(events: PesEvent[], from: number, pid: number, kind: "pts" | "dts"): number | null {
  for (let index = from + 1; index < events.length; index += 1) {
    const event = events[index];
    if (!event || event.pid !== pid) continue;
    const value = kind === "pts" ? event.pts : event.dts;
    if (value !== null && value !== NO_TIMESTAMP) return value;
  }
  return null;
}

function chooseReplacement(
  event: PesEvent,
  state: StreamState,
  events: PesEvent[],
  index: number,
  kind: "pts" | "dts",
): number | null {
  // A missing PTS can fall back to the packet's DTS and the other way around.
  const sibling = kind === "pts" ? event.dts : event.pts;
  if (sibling !== null && sibling !== NO_TIMESTAMP) return sibling;

  const previous = kind === "pts" ? state.lastPts : state.lastDts;
  const next = nextValidTimestamp(events, index, event.pid, kind);
  const step = estimateStep(state);
  if (previous !== null) {
    const candidate = previous + step;
    // Do not pass a known later timestamp; a B-frame reorder can make the next
    // valid timestamp earlier than the previous one, and then advancing is the
    // only monotonic option.
    return next !== null && next > previous && candidate > next ? next : candidate;
  }
  return next;
}

function recordPts(state: StreamState, pts: number): void {
  if (state.lastPts !== null) {
    const delta = pts - state.lastPts;
    if (delta > 0 && delta <= MAX_FRAME_TICKS) {
      state.deltas.push(delta);
      if (state.deltas.length > MAX_RECENT_DELTAS) state.deltas.shift();
    }
  }
  state.lastPts = pts;
}

/**
 * Stateful repair for one download. Segments must be repaired in playback
 * order so a sentinel on a segment boundary can use the previous segment.
 */
export function createTimestampRepair(): TimestampRepair {
  const streams = new Map<number, StreamState>();
  const pcrStreams = new Map<number, PcrState>();
  const events: PesEvent[] = [];
  const pcrEvents: PcrEvent[] = [];
  return {
    repair(buffer: Buffer): void {
      if (!looksLikeTransportStream(buffer)) return;
      events.length = 0;
      collectPesEvents(buffer, events);
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (!event) continue;
        const state = streams.get(event.pid) ?? { lastPts: null, lastDts: null, deltas: [] };
        if (event.pts === NO_TIMESTAMP && event.ptsOffset !== null) {
          const replacement = chooseReplacement(event, state, events, index, "pts");
          if (replacement !== null) {
            writeTimestamp(buffer, event.ptsOffset, replacement);
            event.pts = replacement;
          }
        }
        if (event.dts === NO_TIMESTAMP && event.dtsOffset !== null) {
          const replacement = chooseReplacement(event, state, events, index, "dts");
          if (replacement !== null) {
            writeTimestamp(buffer, event.dtsOffset, replacement);
            event.dts = replacement;
          }
        }
        if (event.pts !== null && event.pts !== NO_TIMESTAMP) recordPts(state, event.pts);
        if (event.dts !== null && event.dts !== NO_TIMESTAMP) state.lastDts = event.dts;
        streams.set(event.pid, state);
      }
      pcrEvents.length = 0;
      collectPcrEvents(buffer, pcrEvents);
      repairPcrs(buffer, pcrEvents, pcrStreams);
    },
  };
}
