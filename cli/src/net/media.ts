/** Twitch VOD distributions used by the hidden-VOD resolver. */
export const VOD_DOMAINS = [
  "https://ds0h3roq6wcgc.cloudfront.net",
  "https://d2nvs31859zcd8.cloudfront.net",
  "https://d2aba1wr3818hz.cloudfront.net",
  "https://d3c27h4odz752x.cloudfront.net",
  "https://dgeft87wbj63p.cloudfront.net",
  "https://d1m7jfoe9zdc1j.cloudfront.net",
  "https://d3vd9lfkzbru3h.cloudfront.net",
  "https://ddacn6pr5v0tl.cloudfront.net",
  "https://d3aqoihi2n8ty8.cloudfront.net",
  "https://d3fi1amfgojobc.cloudfront.net",
  "https://d2vi6trrdongqn.cloudfront.net",
  "https://d3stzm2eumvgb4.cloudfront.net",
  // Verified aliases of the ds0h/d2nv distribution. They only help when a
  // network can reach twitch.tv but not the CloudFront hostname.
  "https://vod-secure.twitch.tv",
  "https://vod-metro.twitch.tv",
  "https://vod-pop-secure.twitch.tv",
] as const;

const cdns = new Set(VOD_DOMAINS.map((domain) => new URL(domain).hostname));
const MAX_MEDIA_REDIRECTS = 4;

/**
 * Accept only HTTPS Twitch media hosts. Shared by the player proxy, the
 * downloader and the resolver probes so all three enforce the same policy on
 * playlist contents and probe URLs.
 */
export function allowedMediaUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    (!cdns.has(url.hostname) &&
      url.hostname !== "usher.ttvnw.net" &&
      !url.hostname.endsWith(".ttvnw.net"))
  ) {
    throw new Error(
      "The playlist contains a resource outside Twitch's media servers.",
    );
  }
  return url;
}

export interface MediaRequestOptions {
  fetch?: typeof fetch;
  signal: AbortSignal;
  method?: string;
  headers?: Record<string, string>;
  /**
   * Retry an unavailable `-unmuted.ts` resource as its `-muted.ts` sibling.
   * Archived playlists can keep the old filename after Twitch re-encodes the
   * segment; both files share timing.
   */
  mutedFallback?: boolean;
}

/**
 * Fetch a Twitch media resource following redirects manually, so every hop is
 * validated against the allowlist before it is requested.
 */
export async function fetchAllowedMedia(
  url: string,
  options: MediaRequestOptions,
): Promise<Response> {
  let target = allowedMediaUrl(url).href;
  for (let redirects = 0; redirects < MAX_MEDIA_REDIRECTS; redirects += 1) {
    const response = await (options.fetch ?? fetch)(target, {
      redirect: "manual",
      signal: options.signal,
      ...(options.method ? { method: options.method } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });
    const resource = new URL(target);
    if (
      options.mutedFallback &&
      (response.status === 403 || response.status === 404) &&
      resource.pathname.endsWith("-unmuted.ts")
    ) {
      await response.body?.cancel();
      resource.pathname = resource.pathname.replace(/-unmuted\.ts$/, "-muted.ts");
      target = allowedMediaUrl(resource.href).href;
      continue;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Media redirect has no destination.");
      target = allowedMediaUrl(new URL(location, target).href).href;
      continue;
    }
    return response;
  }
  throw new Error("Too many media redirects.");
}

/** Media fetch used by the downloader and the player proxy. */
export function fetchMedia(
  url: string,
  args: { fetch?: typeof fetch; signal: AbortSignal; range?: string },
): Promise<Response> {
  return fetchAllowedMedia(url, {
    ...(args.fetch ? { fetch: args.fetch } : {}),
    signal: args.signal,
    headers: args.range
      ? { Range: args.range, "Accept-Encoding": "identity" }
      : { "Accept-Encoding": "identity" },
    mutedFallback: true,
  });
}
