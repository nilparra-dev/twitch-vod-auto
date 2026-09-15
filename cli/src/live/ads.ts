/**
 * Server-side ad filtering for Twitch live HLS media playlists.
 *
 * Twitch stitches live ads into the same media playlist (SSAI). The proxy
 * removes only the segments enclosed by explicit ad markers and rewrites the
 * sequence counters so the remaining timeline stays continuous for hls.js.
 *
 * Robustness rules, in order of importance:
 *
 * 1. Never break playback to remove an ad. Entry into an ad pod requires an
 *    explicit opt-out signal (`CUE-OUT`, `SCTE35-OUT`, `stitched-ad`); anything
 *    else is treated as content.
 * 2. Exits err towards showing content: a pod ends at an explicit end marker,
 *    at the next discontinuity once ad segments were seen, or once the pod's
 *    own planned duration has elapsed. Misjudging an exit shows an ad tail,
 *    never drops the returning broadcast.
 * 3. The filter is stateless per playlist fetch. A sliding live window that
 *    starts mid-pod without its opening marker is passed through, so the worst
 *    case is a briefly visible ad, never permanently dropped content.
 * 4. A playlist left with zero content segments is returned untouched: an
 *    empty playlist stalls hls.js, while the original at least keeps playing.
 *
 * Known limitation: a pod whose creatives are separated by discontinuities
 * looks like several short pods, so trailing creatives may play (fail open).
 */

const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;

/** Opening markers of an ad pod. Intentionally strict (see rule 1 above). */
const AD_OUT_PATTERN = /stitched-ad|twitch-ad|scte-?35-out|cue-out|cued-out|commercial|midroll|preroll|ad-break|adbreak/i;
/** Closing markers of an ad pod. Deliberately broader than the opening set. */
const AD_IN_PATTERN = /scte-?35-in|cue-in|cued-in|stitched-ad-end|ad-break-end/i;

export interface LiveAdFilterResult {
  text: string;
  removedSegments: number;
  removedDiscontinuities: number;
  insertedSplices: number;
  adPods: number;
}

const EMPTY_RESULT = { removedSegments: 0, removedDiscontinuities: 0, insertedSplices: 0, adPods: 0 };

function isTag(line: string, prefix: string): boolean {
  return line.startsWith(prefix);
}

function isAdOut(line: string): boolean {
  if (isTag(line, "#EXT-X-CUE-OUT") || isTag(line, "#EXT-X-CUE:OUT")) return true;
  if (isTag(line, "#EXT-X-SCTE35") && /OUT/i.test(line)) return true;
  return isTag(line, "#EXT-X-DATERANGE") && AD_OUT_PATTERN.test(line);
}

function isAdIn(line: string): boolean {
  if (isTag(line, "#EXT-X-CUE-IN") || isTag(line, "#EXT-X-CUE:IN")) return true;
  if (isTag(line, "#EXT-X-SCTE35") && /IN/i.test(line) && !/OUT/i.test(line)) return true;
  return isTag(line, "#EXT-X-DATERANGE") && !AD_OUT_PATTERN.test(line) && AD_IN_PATTERN.test(line);
}

function parseSequence(line: string, prefix: string): number | null {
  const raw = line.slice(prefix.length).trim();
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 0 && String(value) === raw ? value : null;
}

function parseExtInfDuration(line: string): number {
  const duration = Number.parseFloat(line.slice("#EXTINF:".length).split(",")[0] ?? "");
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/** Planned pod length from an opening marker, when Twitch states one. */
function parseOutDuration(line: string): number | null {
  if (isTag(line, "#EXT-X-CUE-OUT")) {
    const duration = Number.parseFloat(line.slice("#EXT-X-CUE-OUT:".length).split(",")[0] ?? "");
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  }
  const planned = line.match(/PLANNED-DURATION=([0-9.]+)/)?.[1];
  const stated = planned ?? line.match(/[,\s]DURATION=([0-9.]+)/)?.[1];
  const duration = stated === undefined ? Number.NaN : Number.parseFloat(stated);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

/**
 * Remove ad-pod segments from a live media playlist. Master playlists (no
 * `#EXTINF`) are returned byte-identical. Never throws for well-formed
 * playlists; callers should still pass through the original on error.
 */
export function stripLiveAds(playlist: string): LiveAdFilterResult {
  if (playlist.length > MAX_PLAYLIST_BYTES) throw new Error("Playlist is too large.");
  if (!playlist.trimStart().startsWith("#EXTM3U")) throw new Error("Twitch did not return an HLS playlist.");
  if (!playlist.includes("#EXTINF")) return { text: playlist, ...EMPTY_RESULT };

  const output: string[] = [];
  let mediaSequenceIndex = -1;
  let discontinuitySequenceIndex = -1;
  let targetDurationIndex = -1;

  let inAd = false;
  let droppedInPod = 0;
  let podPlanned: number | null = null;
  let podDroppedDuration = 0;
  let pendingAdDuration = 0;
  let pendingSplice = false;
  let skipNextDiscontinuity = false;
  let removedSegments = 0;
  let removedDiscontinuities = 0;
  let insertedSplices = 0;
  let adPods = 0;
  let keptSegments = 0;
  let droppedBeforeFirstKept = 0;
  let maxExtInf = 0;

  const lastOutput = (): string | undefined => output.at(-1);

  const insertSplice = (): void => {
    if (lastOutput() === "#EXT-X-DISCONTINUITY") return;
    output.push("#EXT-X-DISCONTINUITY");
    insertedSplices += 1;
  };

  /** Leave the pod, collapsing its boundaries into one content splice. */
  const exitPod = (): void => {
    inAd = false;
    if (droppedInPod > 0) {
      adPods += 1;
      pendingSplice = true;
    }
    droppedInPod = 0;
    podPlanned = null;
    podDroppedDuration = 0;
    pendingAdDuration = 0;
  };

  for (const line of playlist.split(/\r?\n/)) {
    if (!line.trim()) {
      if (!inAd) output.push(line);
      continue;
    }

    if (!line.startsWith("#")) {
      if (inAd) {
        removedSegments += 1;
        droppedInPod += 1;
        podDroppedDuration += pendingAdDuration;
        pendingAdDuration = 0;
        if (keptSegments === 0) droppedBeforeFirstKept += 1;
        // Planned duration elapsed with no other end signal: stop dropping so
        // the returning broadcast is kept. Overshooting shows an ad tail,
        // undershooting would drop real content.
        if (podPlanned !== null && podDroppedDuration + 0.05 >= podPlanned) exitPod();
        continue;
      }
      if (keptSegments === 0) {
        // First content segment: nothing precedes it, so no splice is needed.
        pendingSplice = false;
        skipNextDiscontinuity = false;
      } else if (pendingSplice && lastOutput() !== "#EXT-X-DISCONTINUITY") {
        insertSplice();
        pendingSplice = false;
        skipNextDiscontinuity = false;
      }
      output.push(line);
      keptSegments += 1;
      continue;
    }

    if (isTag(line, "#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequenceIndex = output.length;
      output.push(line);
      continue;
    }
    if (isTag(line, "#EXT-X-DISCONTINUITY-SEQUENCE:")) {
      discontinuitySequenceIndex = output.length;
      output.push(line);
      continue;
    }
    if (isTag(line, "#EXT-X-TARGETDURATION:")) {
      targetDurationIndex = output.length;
      output.push(line);
      continue;
    }

    if (isAdOut(line)) {
      if (!inAd) {
        inAd = true;
        droppedInPod = 0;
        podPlanned = parseOutDuration(line);
        podDroppedDuration = 0;
        pendingAdDuration = 0;
        // A discontinuity immediately before the opening marker is the pod's
        // entry boundary, not a content splice.
        if (lastOutput() === "#EXT-X-DISCONTINUITY") {
          output.pop();
          removedDiscontinuities += 1;
        }
      }
      continue;
    }
    if (isAdIn(line)) {
      if (inAd) {
        exitPod();
        // The discontinuity that re-opens the content is collapsed into the
        // single splice inserted before the next content segment.
        skipNextDiscontinuity = true;
      }
      continue;
    }

    if (isTag(line, "#EXT-X-DISCONTINUITY") && !isTag(line, "#EXT-X-DISCONTINUITY-SEQUENCE:")) {
      if (inAd) {
        removedDiscontinuities += 1;
        if (droppedInPod === 0) {
          // Boundary between the opening marker and the first ad segment.
          continue;
        }
        // End of the pod: consume this boundary here instead of skipping the
        // next one, then splice once before the returning content.
        exitPod();
        continue;
      }
      if (skipNextDiscontinuity) {
        removedDiscontinuities += 1;
        skipNextDiscontinuity = false;
        continue;
      }
      // A genuine content splice supersedes the pending ad splice.
      pendingSplice = false;
      output.push(line);
      continue;
    }

    if (isTag(line, "#EXTINF:")) {
      if (inAd) {
        pendingAdDuration = parseExtInfDuration(line);
        continue;
      }
      const duration = parseExtInfDuration(line);
      if (duration > maxExtInf) maxExtInf = duration;
      if (keptSegments === 0) {
        pendingSplice = false;
        skipNextDiscontinuity = false;
      } else if (pendingSplice) {
        insertSplice();
        pendingSplice = false;
        skipNextDiscontinuity = false;
      }
      output.push(line);
      continue;
    }

    // Keys, init maps, date ranges and any other tag inside a pod belong to
    // the ad creative and are dropped with it.
    if (inAd) continue;
    output.push(line);
  }

  if (inAd && droppedInPod > 0) adPods += 1;

  // Fail closed: an empty playlist stalls the player, the original keeps it
  // playing (with ads) until the next refresh.
  if (keptSegments === 0) return { text: playlist, ...EMPTY_RESULT };

  if (mediaSequenceIndex >= 0 && droppedBeforeFirstKept > 0) {
    const current = parseSequence(output[mediaSequenceIndex] ?? "", "#EXT-X-MEDIA-SEQUENCE:");
    if (current !== null) output[mediaSequenceIndex] = `#EXT-X-MEDIA-SEQUENCE:${current + droppedBeforeFirstKept}`;
  }
  if (discontinuitySequenceIndex >= 0) {
    const current = parseSequence(output[discontinuitySequenceIndex] ?? "", "#EXT-X-DISCONTINUITY-SEQUENCE:");
    if (current !== null) {
      output[discontinuitySequenceIndex] =
        `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.max(0, current - (removedDiscontinuities - insertedSplices))}`;
    }
  }
  if (targetDurationIndex >= 0 && maxExtInf > 0) {
    output[targetDurationIndex] = `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(maxExtInf))}`;
  }

  return { text: output.join("\n"), removedSegments, removedDiscontinuities, insertedSplices, adPods };
}
