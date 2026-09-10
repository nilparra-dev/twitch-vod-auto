import { createHash, randomBytes } from "node:crypto";
import { VOD_DOMAINS } from "../resolver.js";

const cdns = new Set(VOD_DOMAINS.map((domain) => new URL(domain).hostname));
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

export interface Resource {
  url: string;
  manifest: boolean;
}
export class MediaRegistry {
  readonly resources = new Map<string, Resource>();
  private readonly salt = randomBytes(16).toString("hex");
  constructor(readonly prefix: string) {}
  register(
    url: string,
    manifest = new URL(url).pathname.endsWith(".m3u8"),
  ): string {
    allowedMediaUrl(url);
    const id = createHash("sha256")
      .update(this.salt + url)
      .digest("hex")
      .slice(0, 32);
    if (this.resources.size > 100_000 && !this.resources.has(id))
      throw new Error("Playlist resource limit reached.");
    this.resources.set(id, { url, manifest });
    return `${this.prefix}media/${id}`;
  }
  rewrite(text: string, base: string): string {
    if (!text.trimStart().startsWith("#EXTM3U"))
      throw new Error("Twitch did not return an HLS playlist.");
    return text
      .split(/\r?\n/)
      .map((line) => {
        if (!line.trim()) return line;
        if (!line.startsWith("#"))
          return this.register(new URL(line.trim(), base).href);
        return line.replace(
          /URI="([^"]+)"/g,
          (_match: string, uri: string) =>
            `URI="${this.register(new URL(uri, base).href)}"`,
        );
      })
      .join("\n");
  }
}

export async function fetchMedia(
  url: string,
  args: { fetch?: typeof fetch; signal: AbortSignal; range?: string },
): Promise<Response> {
  let target = allowedMediaUrl(url).href;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const response = await (args.fetch ?? fetch)(target, {
      redirect: "manual",
      signal: args.signal,
      headers: args.range
        ? { Range: args.range, "Accept-Encoding": "identity" }
        : { "Accept-Encoding": "identity" },
    });
    // Archived playlists can retain an unavailable unmuted filename while the
    // corresponding muted segment is still served. Keep its original timing.
    const segment = new URL(target);
    if ((response.status === 403 || response.status === 404) && segment.pathname.endsWith("-unmuted.ts")) {
      await response.body?.cancel();
      segment.pathname = segment.pathname.replace(/-unmuted\.ts$/, "-muted.ts");
      target = allowedMediaUrl(segment.href).href;
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

export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]))
    throw new Error("Invalid byte range.");
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    start >= size
  )
    throw new Error("Unsatisfiable byte range.");
  return { start, end };
}
