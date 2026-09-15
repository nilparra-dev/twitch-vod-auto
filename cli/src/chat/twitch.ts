import { setTimeout as delay } from "node:timers/promises";
import { parseInput } from "../resolver.js";
import { GqlQueryError, queryTwitchGql } from "../twitch/query.js";
import {
  array, ChatError, nullableString, number, parseMessage, record, string,
  type ChatPage, type VideoMetadata,
} from "./model.js";

const VIDEO_FIELDS = "id title createdAt lengthSeconds status seekPreviewsURL owner { login }";
const COMMENTS_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";

export interface ChatSource {
  video(vodId: string): Promise<VideoMetadata | null>;
  page(args: { vodId: string; cursor: string | null; offsetSeconds: number }): Promise<ChatPage>;
}

export class TwitchChatClient implements ChatSource {
  private useOffsets = false;
  constructor(private readonly options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    attempts?: number;
    retryDelayMs?: number;
  } = {}) {}

  private async query(body: unknown): Promise<Record<string, unknown>> {
    try {
      return await queryTwitchGql(body, {
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        ...(this.options.signal ? { signal: this.options.signal } : {}),
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        ...(this.options.attempts !== undefined ? { attempts: this.options.attempts } : {}),
        ...(this.options.retryDelayMs !== undefined ? { retryDelayMs: this.options.retryDelayMs } : {}),
        graphqlErrors: (errors) => {
          const integrityFailure = errors.some((value) => {
            if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
            const extensions = (value as Record<string, unknown>).extensions;
            return (
              typeof extensions === "object" &&
              extensions !== null &&
              !Array.isArray(extensions) &&
              (extensions as Record<string, unknown>).code === "IntegrityCheckFailed"
            );
          });
          return integrityFailure
            ? new GqlQueryError("CURSOR_REJECTED", "Twitch rejected cursor pagination.")
            : new GqlQueryError(
                "GRAPHQL_ERROR",
                "Twitch rejected the GraphQL request. Its internal API may have changed.",
              );
        },
      });
    } catch (error) {
      if (error instanceof GqlQueryError) throw new ChatError(error.code, error.message);
      throw error;
    }
  }

  async video(vodId: string): Promise<VideoMetadata | null> {
    const data = await this.query({
      query: `query($id: ID!) { video(id: $id) { ${VIDEO_FIELDS} } }`, variables: { id: vodId },
    });
    return data.video === null ? null : parseVideo(data.video);
  }

  async resolve(input: string, channelOption?: string): Promise<string> {
    const target = parseInput(input);
    if (target.kind === "public") return target.videoId;
    if (target.kind === "live") {
      throw new ChatError("LIVE_UNSUPPORTED", "Live chat archiving is not supported yet. Watch the live video first; its replay can be archived once Twitch publishes the VOD.");
    }
    const channel = target.kind === "stream-id" ? channelOption : target.channel;
    if (!channel || !/^\w+$/.test(channel)) {
      throw new ChatError("CHANNEL_REQUIRED", "A stream ID requires --channel CHANNEL or a tracker URL.");
    }
    const cursors = new Set<string>();
    let cursor: string | null = null;
    // This is discovery, not a claim that hidden/deleted VODs are enumerable.
    for (let page = 0; page < 20; page += 1) {
      const data = await this.query({
        query: `query($login: String!, $after: Cursor) { user(login: $login) { videos(first: 100, after: $after, type: ARCHIVE, sort: TIME) { edges { cursor node { ${VIDEO_FIELDS} } } pageInfo { hasNextPage } } } }`,
        variables: { login: channel.toLowerCase(), after: cursor },
      });
      if (data.user === null) break;
      const videos = record(record(data.user).videos);
      const edges = array(videos.edges).map(record);
      for (const edge of edges) {
        const video = parseVideo(edge.node);
        if (video.channel === channel.toLowerCase() && video.stream?.streamId === target.streamId && video.stream.channel === channel.toLowerCase()) {
          if (target.kind === "hidden" && video.stream.startedAtSeconds !== target.timestamp) continue;
          return video.vodId;
        }
      }
      const info = record(videos.pageInfo);
      if (typeof info.hasNextPage !== "boolean") throw new ChatError("INVALID_DATA", "Missing video pagination state.");
      if (!info.hasNextPage) break;
      const last = edges.at(-1);
      if (!last) throw new ChatError("PAGINATION_STALLED", "Twitch returned an empty video page with more results.");
      cursor = string(last.cursor);
      if (!cursor || cursors.has(cursor)) throw new ChatError("PAGINATION_STALLED", "Video discovery cursor repeated.");
      cursors.add(cursor);
    }
    throw new ChatError("VOD_ID_UNRESOLVED", "No exact VOD match was found in the accessible channel history. If you know its VOD ID, use a twitch.tv/videos/ID URL. The hidden video may still be recoverable without chat.");
  }

  async page({ vodId, cursor, offsetSeconds }: { vodId: string; cursor: string | null; offsetSeconds: number }): Promise<ChatPage> {
    number(offsetSeconds);
    // Null comment lists can be transient; never interpret them as an empty chat.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestPage = () => this.query({
        operationName: "VideoCommentsByOffsetOrCursor",
        variables: cursor === null || this.useOffsets
          ? { videoID: vodId, contentOffsetSeconds: cursor === null ? 0 : Math.floor(offsetSeconds) }
          : { videoID: vodId, cursor },
        extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_HASH } },
      });
      let data;
      try {
        data = await requestPage();
      } catch (error) {
        if (!(error instanceof ChatError) || error.code !== "CURSOR_REJECTED" || cursor === null || this.useOffsets) throw error;
        // Query the same second again, never advance by +1: crowded seconds must
        // overlap the committed page or fail as partial rather than lose messages.
        this.useOffsets = true;
        data = await requestPage();
      }
      if (data.video === null) throw new ChatError("CHAT_UNAVAILABLE", "Twitch no longer exposes chat for this VOD. Video recovery is independent.");
      const video = record(data.video);
      if (video.comments === null) {
        if (attempt < 2) await delay(this.options.retryDelayMs ?? 1000, undefined, { signal: this.options.signal });
        continue;
      }
      const comments = record(video.comments);
      const edges = array(comments.edges).map(record);
      const hasNext = record(comments.pageInfo).hasNextPage;
      if (typeof hasNext !== "boolean") throw new ChatError("INVALID_DATA", "Missing chat pagination state.");
      const last = edges.at(-1);
      if (hasNext && !last) throw new ChatError("PAGINATION_STALLED", "Twitch returned an empty chat page with more results.");
      const nextCursor = hasNext && last ? string(last.cursor) : null;
      if (nextCursor === "") throw new ChatError("PAGINATION_STALLED", "Twitch returned an empty cursor.");
      return { messages: edges.map((edge) => parseMessage(edge.node)), nextCursor, continuation: this.useOffsets ? "offset" : "cursor" };
    }
    throw new ChatError("CHAT_NOT_READY", "Twitch repeatedly returned a null comment list. Retry later; the archive remains resumable.");
  }
}

export function parseVideo(value: unknown): VideoMetadata {
  const video = record(value);
  const preview = nullableString(video.seekPreviewsURL);
  const channel = video.owner === null ? null : string(record(video.owner).login).toLowerCase();
  // Match the entire CDN path component, not an arbitrary ID substring.
  const match = preview?.match(/\/[a-f0-9]{20}_([a-z0-9_]+)_(\d+)_(\d+)\//i);
  const stream = match?.[1] && match[2] && match[3] ? {
    channel: match[1].toLowerCase(), streamId: match[2], startedAtSeconds: Number(match[3]),
  } : null;
  return {
    vodId: string(video.id), title: string(video.title), createdAt: string(video.createdAt),
    durationSeconds: number(video.lengthSeconds), status: string(video.status), channel, stream,
  };
}
