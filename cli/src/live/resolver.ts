import { fetchAllowedMedia } from "../net/media.js";
import { parseMasterManifest, ResolveError } from "../resolver.js";
import { TWITCH_WEB_CLIENT_ID } from "../twitch/gql.js";
import type { PlaylistFormat, ResolveOptions } from "../types.js";
import { parseLiveChannel } from "./channel.js";

export interface LiveResolveResult {
  kind: "live";
  source: "twitch";
  channel: string;
  masterUrl: string;
  formats: PlaylistFormat[];
}

const DEFAULT_TIMEOUT_MS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * Resolve a channel that is live right now to its multivariant HLS URL.
 *
 * Uses the same playback-token flow as public VODs, but with the live token
 * (`streamPlaybackAccessToken`) and the live usher endpoint. Throws
 * `OFFLINE` when the channel is not broadcasting or denies playback, so the
 * caller can report "not live" instead of a generic failure.
 */
export async function resolveLiveM3U8(rawInput: string, options: ResolveOptions = {}): Promise<LiveResolveResult> {
  const channel = parseLiveChannel(rawInput);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;
  const withTimeout = (signal?: AbortSignal): AbortSignal => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([timeout, signal]) : timeout;
  };

  const tokenResponse = await fetchImpl("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "Client-ID": TWITCH_WEB_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationName: "PlaybackAccessToken_Template",
      query:
        "query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isLive) { value signature } videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isVod) { value signature } }",
      variables: { isLive: true, login: channel, isVod: false, vodID: "", playerType: "site", platform: "web" },
    }),
    signal: withTimeout(options.signal),
  });
  if (!tokenResponse.ok) throw new ResolveError(`Twitch returned HTTP ${tokenResponse.status}.`, "HTTP_ERROR");
  const payload: unknown = await tokenResponse.json();
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new ResolveError(`"${channel}" is not live right now, or Twitch refused playback access.`, "OFFLINE");
  }
  const token = payload.data.streamPlaybackAccessToken;
  if (!isRecord(token)) {
    throw new ResolveError(`"${channel}" is not live right now, or Twitch refused playback access.`, "OFFLINE");
  }
  const signature = getString(token, "signature");
  const value = getString(token, "value");
  if (!signature || !value) throw new ResolveError("The live playback token is incomplete.", "OFFLINE");

  const params = new URLSearchParams({
    allow_source: "true",
    allow_audio_only: "true",
    allow_spectre: "false",
    player: "twitchweb",
    playlist_include_framerate: "true",
    sig: signature,
    supported_codecs: "av1,h265,h264",
    token: value,
  });
  const masterUrl = `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8?${params}`;
  // The manifest request uses the media allowlist too: a redirect must not
  // leave Twitch's media hosts. Forward the caller's fetch so tests and
  // the player proxy control the transport.
  const manifestResponse = await fetchAllowedMedia(masterUrl, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    signal: withTimeout(options.signal),
  });
  if (manifestResponse.status === 404) {
    await manifestResponse.body?.cancel();
    throw new ResolveError(`"${channel}" is not live right now.`, "OFFLINE");
  }
  if (!manifestResponse.ok) {
    await manifestResponse.body?.cancel();
    throw new ResolveError(`The live manifest returned HTTP ${manifestResponse.status}.`, "HTTP_ERROR");
  }
  const formats = parseMasterManifest(await manifestResponse.text());
  if (formats.length === 0) throw new ResolveError("The live manifest contains no playable qualities.", "OFFLINE");
  return { kind: "live", source: "twitch", channel, masterUrl, formats };
}
