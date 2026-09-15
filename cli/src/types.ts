export type TrackerProvider = "twitchtracker" | "streamscharts" | "sullygnome";

export type ParsedInput =
  | { kind: "public"; videoId: string }
  | { kind: "hidden"; channel: string; streamId: string; timestamp: number; source: "canonical" }
  | { kind: "tracker"; channel: string; streamId: string; provider: TrackerProvider }
  | { kind: "stream-id"; streamId: string }
  | { kind: "live"; channel: string };

export interface PlaylistFormat {
  id: string;
  url: string;
  height: number | null;
  fps: number | null;
}

export type TimestampSource = "provided" | "twitracker" | "streamervitals" | "sullygnome" | "window";

export interface TimestampReport {
  /** Timestamp supplied by the caller, when there was one. */
  requested: number | null;
  /** Timestamp that actually resolved the media path. */
  used: number;
  /** True when the resolved timestamp differs from the requested one. */
  adjusted: boolean;
  source: TimestampSource;
}

export type HiddenSource = TrackerProvider | "canonical" | "stream-id" | "vod-id";

export type ResolveResult =
  | {
      kind: "public";
      source: "twitch";
      videoId: string;
      masterUrl: string;
      formats: PlaylistFormat[];
    }
  | {
      kind: "live";
      source: "twitch";
      channel: string;
      masterUrl: string;
      formats: PlaylistFormat[];
    }
  | {
      kind: "hidden";
      source: HiddenSource;
      channel: string;
      streamId: string;
      startedAt: string;
      canonicalTarget: string;
      formats: PlaylistFormat[];
      vodId?: string | null;
      timestamp?: TimestampReport;
    };

export interface ResolveOptions {
  channel?: string;
  timeoutMs?: number;
  /** Seconds searched around a provided timestamp when exact sources fail. */
  timestampWindow?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}
