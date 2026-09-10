export type ChatStatus =
  | { kind: "idle" }
  | { kind: "downloading"; messages: number }
  | { kind: "ready"; url: string; size: number; name: string }
  | { kind: "unavailable"; message: string };
export interface PlayerSession {
  revision: number;
  input: string;
  state: "idle" | "resolving" | "ready" | "error";
  error: string | null;
  title: string;
  source: "hidden" | "public" | null;
  formats: { id: string; url: string }[];
  chat: ChatStatus;
}
