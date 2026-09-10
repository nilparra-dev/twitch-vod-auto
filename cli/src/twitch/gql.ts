import { setTimeout as delay } from "node:timers/promises";

export const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
export const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

const VIDEO_FIELDS =
  "id title createdAt lengthSeconds status viewCount game { name } owner { login } seekPreviewsURL";

export class GqlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GqlError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new GqlError("INVALID_DATA", "Twitch returned an unexpected GraphQL payload.");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new GqlError("INVALID_DATA", "Twitch returned unexpected GraphQL data.");
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new GqlError("INVALID_DATA", "Twitch returned an unexpected number.");
  }
  return value;
}

export interface GqlClientOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
}

/** Minimal Twitch GraphQL client with backoff and Retry-After support. */
export class GqlClient {
  constructor(private readonly options: GqlClientOptions = {}) {}

  async query(body: unknown): Promise<Record<string, unknown>> {
    const attempts = this.options.attempts ?? 4;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.options.signal?.throwIfAborted();
      let waitMs = (this.options.retryDelayMs ?? 500) * 2 ** attempt;
      try {
        const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
        const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
        const response = await (this.options.fetch ?? fetch)(TWITCH_GQL_URL, {
          method: "POST",
          headers: { "Client-ID": TWITCH_WEB_CLIENT_ID, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status !== 429 && response.status < 500) {
            throw new GqlError("HTTP_ERROR", `Twitch returned HTTP ${response.status}.`);
          }
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter) {
            const seconds = Number(retryAfter);
            const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
            if (Number.isFinite(requested)) waitMs = Math.max(waitMs, Math.min(60_000, requested));
          }
          throw new Error(`Twitch returned HTTP ${response.status}.`);
        }
        const payload = record(await response.json());
        if (Array.isArray(payload.errors) && payload.errors.length > 0) {
          throw new GqlError("GRAPHQL_ERROR", "Twitch rejected the GraphQL request. Its internal API may have changed.");
        }
        return record(payload.data);
      } catch (error) {
        this.options.signal?.throwIfAborted();
        if (error instanceof GqlError) throw error;
        lastError = error;
      }
      if (attempt + 1 < attempts) await delay(waitMs, undefined, { signal: this.options.signal });
    }
    throw new GqlError("NETWORK_ERROR", lastError instanceof Error ? lastError.message : "Twitch request failed.");
  }
}

export interface ChannelVideoNode {
  vodId: string;
  title: string;
  createdAt: string;
  durationSeconds: number;
  status: string;
  viewCount: number | null;
  category: string | null;
  channel: string | null;
  /** Stream identity parsed from seekPreviewsURL, when Twitch exposes it. */
  streamId: string | null;
  startedAtSeconds: number | null;
}

export function parseChannelVideo(value: unknown): ChannelVideoNode {
  const node = record(value);
  const preview = nullableString(node.seekPreviewsURL);
  const match = preview?.match(/\/[a-f0-9]{20}_([a-z0-9_]+)_(\d+)_(\d+)\//i);
  const startedAt = match?.[3] ? Number.parseInt(match[3], 10) : Number.NaN;
  const category = isRecord(node.game) ? nullableString(node.game.name) : null;
  const channel = isRecord(node.owner) ? nullableString(node.owner.login) : null;
  return {
    vodId: string(node.id),
    title: string(node.title),
    createdAt: string(node.createdAt),
    durationSeconds: nonNegativeNumber(node.lengthSeconds),
    status: string(node.status),
    viewCount: typeof node.viewCount === "number" && Number.isFinite(node.viewCount) ? node.viewCount : null,
    category,
    channel: channel === null ? null : channel.toLowerCase(),
    streamId: match?.[2] ?? null,
    startedAtSeconds: Number.isFinite(startedAt) ? startedAt : null,
  };
}

export interface ChannelVideoOptions {
  /** Maximum number of VODs to return. Defaults to 15. */
  limit?: number;
  /** Walk every page instead of stopping at limit. Capped at 2000 videos. */
  all?: boolean;
}

const MAX_DISCOVERY_VIDEOS = 2000;
const PAGE_SIZE = 100;

/**
 * List a channel's public archive VODs through GraphQL. Hidden or deleted VODs
 * are not part of this listing; use the tracker sources for those.
 */
export async function fetchChannelVideos(
  client: GqlClient,
  login: string,
  options: ChannelVideoOptions = {},
): Promise<ChannelVideoNode[]> {
  const limit = Math.min(options.all ? MAX_DISCOVERY_VIDEOS : (options.limit ?? 15), MAX_DISCOVERY_VIDEOS);
  const videos: ChannelVideoNode[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  while (videos.length < limit) {
    const data = await client.query({
      query: `query($login: String!, $after: Cursor) { user(login: $login) { videos(first: ${PAGE_SIZE}, after: $after, type: ARCHIVE, sort: TIME) { edges { cursor node { ${VIDEO_FIELDS} } } pageInfo { hasNextPage } } } }`,
      variables: { login: login.toLowerCase(), after: cursor },
    });
    if (data.user === null || data.user === undefined) break;
    const listing = record(record(data.user).videos);
    const edges = Array.isArray(listing.edges) ? listing.edges.map(record) : [];
    for (const edge of edges) {
      videos.push(parseChannelVideo(edge.node));
      if (videos.length >= limit) break;
    }
    const info = record(listing.pageInfo);
    if (info.hasNextPage !== true) break;
    const last = edges.at(-1);
    if (!last) throw new GqlError("PAGINATION_STALLED", "Twitch returned an empty video page with more results.");
    cursor = string(last.cursor);
    if (!cursor || cursors.has(cursor)) {
      throw new GqlError("PAGINATION_STALLED", "Twitch video pagination cursor repeated.");
    }
    cursors.add(cursor);
  }
  return videos;
}

/** One VOD's metadata, including restricted VODs Twitch still describes. */
export async function fetchVideoMetadata(client: GqlClient, vodId: string): Promise<ChannelVideoNode | null> {
  const data = await client.query({
    query: `query($id: ID!) { video(id: $id) { ${VIDEO_FIELDS} } }`,
    variables: { id: vodId },
  });
  if (data.video === null || data.video === undefined) return null;
  return parseChannelVideo(data.video);
}
