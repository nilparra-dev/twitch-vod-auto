export type TrackerProvider = "twitchtracker" | "streamscharts" | "sullygnome";

export type ParsedInput =
  | { kind: "public"; videoId: string }
  | { kind: "hidden"; channel: string; streamId: string; timestamp: number; source: "canonical" }
  | { kind: "tracker"; channel: string; streamId: string; provider: TrackerProvider }
  | { kind: "stream-id"; streamId: string };

export interface PlaylistFormat {
  id: string;
  url: string;
  height: number | null;
  fps: number | null;
}

export type ResolveResult =
  | {
      kind: "public";
      source: "twitch";
      videoId: string;
      masterUrl: string;
      formats: PlaylistFormat[];
    }
  | {
      kind: "hidden";
      source: TrackerProvider | "canonical" | "stream-id";
      channel: string;
      streamId: string;
      startedAt: string;
      canonicalTarget: string;
      formats: PlaylistFormat[];
    };

export interface ResolveOptions {
  channel?: string;
  timeoutMs?: number;
}
