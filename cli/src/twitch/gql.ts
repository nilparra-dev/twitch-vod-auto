import { GqlQueryError, queryTwitchGql } from "./query.js";

export { TWITCH_GQL_URL, TWITCH_WEB_CLIENT_ID } from "./query.js";

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

/** Minimal Twitch GraphQL client. The transport and retry policy are shared. */
export class GqlClient {
  constructor(private readonly options: GqlClientOptions = {}) {}

  async query(body: unknown): Promise<Record<string, unknown>> {
    try {
      return await queryTwitchGql(body, {
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        ...(this.options.signal ? { signal: this.options.signal } : {}),
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        ...(this.options.attempts !== undefined ? { attempts: this.options.attempts } : {}),
        ...(this.options.retryDelayMs !== undefined ? { retryDelayMs: this.options.retryDelayMs } : {}),
      });
    } catch (error) {
      if (error instanceof GqlQueryError) throw new GqlError(error.code, error.message);
      throw error;
    }
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
