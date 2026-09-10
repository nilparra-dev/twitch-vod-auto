/**
 * Twitch VOD media playlists are plain MPEG-TS segment lists (occasionally
 * fragmented MP4 with an init segment). These parsers expose the segments so
 * the downloader can fetch and concatenate them without ffmpeg.
 */

export interface MediaSegment {
  uri: string;
  durationSeconds: number;
}

export interface MediaPlaylist {
  segments: MediaSegment[];
  initSegment: string | null;
  endList: boolean;
  totalDurationSeconds: number;
}

/**
 * Return the variant URLs when the text is a master playlist, or null when it
 * already is a media playlist.
 */
export function parseMasterPlaylist(text: string, baseUrl: string): string[] | null {
  if (!text.includes("#EXT-X-STREAM-INF")) return null;
  const variants: string[] = [];
  let pending = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      pending = true;
      continue;
    }
    if (line.startsWith("#")) continue;
    if (pending) {
      variants.push(new URL(line, baseUrl).href);
      pending = false;
    }
  }
  return variants;
}

export function parseMediaPlaylist(text: string, baseUrl: string): MediaPlaylist {
  const segments: MediaSegment[] = [];
  let pendingDuration: number | null = null;
  let initSegment: string | null = null;
  let endList = false;
  let totalDurationSeconds = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const value = Number.parseFloat(line.slice(8));
      pendingDuration = Number.isFinite(value) ? value : null;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (uri) initSegment = new URL(uri, baseUrl).href;
      continue;
    }
    if (line === "#EXT-X-ENDLIST") {
      endList = true;
      continue;
    }
    if (line.startsWith("#")) continue;
    if (pendingDuration === null) continue;
    segments.push({ uri: new URL(line, baseUrl).href, durationSeconds: pendingDuration });
    totalDurationSeconds += pendingDuration;
    pendingDuration = null;
  }

  return { segments, initSegment, endList, totalDurationSeconds };
}
