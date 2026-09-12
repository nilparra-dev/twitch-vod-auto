/**
 * Direct HLS engine. Instead of concatenating segments ourselves, the playlist
 * text is rewritten so every referenced resource is an absolute, allowlisted
 * Twitch media URL, and ffmpeg demuxes that local playlist. ffmpeg then handles
 * segment boundaries, discontinuities and timestamps itself, which avoids the
 * raw concatenation artifacts at the cost of downloading sequentially.
 *
 * The rewrite is the trust boundary: ffmpeg never sees the original playlist,
 * only a local file whose references were validated here. The protocol
 * whitelist keeps the demuxer from opening anything else.
 *
 * Twitch keeps archived playlists that still name `-unmuted.ts` resources after
 * the CDN removed them; the matching `-muted.ts` sibling shares the timing, the
 * same fallback the native downloader applies. The availability check runs
 * before ffmpeg starts so the engine fails early instead of midway.
 */

import { rename, rm, writeFile } from "node:fs/promises";
import { extname } from "node:path";

import { mapWithConcurrency } from "../concurrency.js";
import { fetchAllowedMedia } from "../net/media.js";
import { assertAllowedMediaUrl, DownloadError } from "./fetcher.js";
import { runFfmpeg, type FfmpegProgress, type FfmpegTools } from "./ffmpeg.js";

const PROTOCOL_WHITELIST = "file,http,https,tcp,tls,crypto";
const PROBE_CONCURRENCY = 24;
const UNMUTED_SUFFIX = "-unmuted.ts";
const MUTED_SUFFIX = "-muted.ts";

function validateUri(uri: string, baseUrl: string): string {
  const absolute = new URL(uri, baseUrl).href;
  assertAllowedMediaUrl(absolute);
  return absolute;
}

function collectUris(text: string, baseUrl: string): string[] {
  const uris: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    uris.push(new URL(line, baseUrl).href);
  }
  return uris;
}

/**
 * Rewrite a media playlist so every URI is absolute and allowlisted. Tags are
 * preserved; `URI="..."` attributes (init maps, keys, child playlists) are
 * rewritten too. `replacements` swaps specific absolute URIs, used for the
 * muted fallback.
 */
function rewritePlaylist(
  text: string,
  baseUrl: string,
  replacements?: ReadonlyMap<string, string>,
): string {
  const substitute = (uri: string): string => {
    const absolute = validateUri(uri, baseUrl);
    return replacements?.get(absolute) ?? absolute;
  };
  const lines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (!line.startsWith("#")) {
      lines.push(substitute(line));
      continue;
    }
    lines.push(line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${substitute(uri)}"`));
  }
  return `${lines.join("\n")}\n`;
}

export function buildLocalPlaylist(text: string, baseUrl: string): string {
  return rewritePlaylist(text, baseUrl);
}

export interface PreparePlaylistOptions {
  signal: AbortSignal;
  fetch?: typeof fetch | undefined;
  concurrency?: number | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

async function probeStatus(url: string, options: PreparePlaylistOptions): Promise<number> {
  const common = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    signal: options.signal,
    mutedFallback: false,
  };
  const head = await fetchAllowedMedia(url, {
    ...common,
    method: "HEAD",
    headers: { "Accept-Encoding": "identity" },
  });
  await head.body?.cancel();
  if (head.status !== 405 && head.status !== 501) return head.status;
  const ranged = await fetchAllowedMedia(url, {
    ...common,
    headers: { Range: "bytes=0-0", "Accept-Encoding": "identity" },
  });
  await ranged.body?.cancel();
  return ranged.status;
}

/**
 * Like `buildLocalPlaylist`, but checks every `-unmuted.ts` reference and
 * replaces it with its `-muted.ts` sibling when the unmuted resource is gone.
 * Other non-2xx responses (rate limits, transient failures) keep the original
 * URI and let ffmpeg retry it.
 */
export async function prepareLocalPlaylist(
  text: string,
  baseUrl: string,
  options: PreparePlaylistOptions,
): Promise<string> {
  const candidates = new Set<string>();
  for (const uri of collectUris(text, baseUrl)) {
    assertAllowedMediaUrl(uri);
    if (uri.endsWith(UNMUTED_SUFFIX)) candidates.add(uri);
  }
  const replacements = new Map<string, string>();
  const list = [...candidates];
  if (list.length > 0) {
    let done = 0;
    await mapWithConcurrency(list, options.concurrency ?? PROBE_CONCURRENCY, async (url) => {
      const status = await probeStatus(url, options);
      if (status === 403 || status === 404) {
        const muted = url.replace(/-unmuted\.ts$/, MUTED_SUFFIX);
        const mutedStatus = await probeStatus(muted, options);
        if (mutedStatus === 200 || mutedStatus === 206) {
          replacements.set(url, muted);
        } else {
          throw new DownloadError(
            `The playlist references an unavailable segment: ${url} (the muted sibling returned HTTP ${mutedStatus}).`,
            "SEGMENT_UNAVAILABLE",
          );
        }
      }
      done += 1;
      options.onProgress?.(done, list.length);
    });
  }
  return rewritePlaylist(text, baseUrl, replacements);
}

export interface HlsDownloadOptions {
  tools: FfmpegTools;
  /** Raw media playlist text, as served by Twitch. */
  playlistText: string;
  /** URL the playlist was loaded from, used to resolve relative references. */
  playlistUrl: string;
  /** Local path for the validated playlist; removed after the run. */
  playlistPath: string;
  /** Final output path. Written through a temporary sibling. */
  output: string;
  durationSeconds?: number | undefined;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch | undefined;
  onPrepareProgress?: ((done: number, total: number) => void) | undefined;
  onProgress?: ((progress: FfmpegProgress & { percent: number | null }) => void) | undefined;
  spawn?: typeof import("node:child_process").spawn | undefined;
}

/**
 * Download and remux the playlist with ffmpeg in one pass. No `.part` resume:
 * on failure the temporary output is removed and the next run starts over.
 */
export async function downloadHls(options: HlsDownloadOptions): Promise<void> {
  const playlistText = await prepareLocalPlaylist(options.playlistText, options.playlistUrl, {
    signal: options.signal ?? new AbortController().signal,
    fetch: options.fetch,
    onProgress: options.onPrepareProgress,
  });
  await writeFile(options.playlistPath, playlistText);
  const temporary = `${options.output}.tmp${extname(options.output) || ".ts"}`;
  const durationMs = options.durationSeconds !== undefined ? options.durationSeconds * 1000 : null;
  try {
    await runFfmpeg({
      command: options.tools.ffmpeg,
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
        "-y",
        "-protocol_whitelist",
        PROTOCOL_WHITELIST,
        "-i",
        options.playlistPath,
        "-c",
        "copy",
        ...(/\.mp4$/i.test(options.output) ? ["-movflags", "+faststart"] : []),
        temporary,
      ],
      signal: options.signal,
      spawn: options.spawn,
      onProgress: (progress) => {
        if (!options.onProgress) return;
        const percent =
          durationMs !== null && durationMs > 0 && progress.outTimeMs !== null
            ? Math.max(0, Math.min(100, Math.floor((progress.outTimeMs / durationMs) * 100)))
            : null;
        options.onProgress({ ...progress, percent });
      },
    });
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await rm(options.playlistPath, { force: true });
  }
  await rm(options.output, { force: true });
  await rename(temporary, options.output);
}
