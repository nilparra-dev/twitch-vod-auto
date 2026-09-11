import { createHash, randomBytes } from "node:crypto";

import { allowedMediaUrl } from "../net/media.js";

export interface Resource {
  url: string;
  manifest: boolean;
}

/** Maps Twitch media URLs to unguessable local URLs for the player page. */
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
