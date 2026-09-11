/**
 * Persisted chat contract shared by the CLI and the replay player.
 *
 * This module must stay dependency-free: the player bundles it for the browser.
 * A change here changes the on-disk chat.json format or the session bridge, so
 * treat it as a versioned contract change and update both consumers together.
 */

export class ChatError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ChatError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ChatError("INVALID_DATA", "Expected an object in chat data.");
  }
  return value;
}

export function string(value: unknown): string {
  if (typeof value !== "string") throw new ChatError("INVALID_DATA", "Expected a string in chat data.");
  return value;
}

export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ChatError("INVALID_DATA", "Expected a non-negative finite number in chat data.");
  }
  return value;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ChatError("INVALID_DATA", "Expected an array in chat data.");
  return value;
}

export function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

export interface ChatMessage {
  id: string;
  offsetSeconds: number;
  createdAt: string;
  user: { id: string; login: string; displayName: string } | null;
  text: string;
  fragments: { text: string; emoteId: string | null }[];
  badges: { setId: string; version: string }[];
  color: string | null;
}

// Validate persisted messages as well as network responses. Deleted users are
// deliberately preserved; replay timing comes from the VOD offset, not createdAt.
export function parseStoredMessage(value: unknown): ChatMessage {
  const message = record(value);
  const user = message.user === null ? null : record(message.user);
  return {
    id: string(message.id), offsetSeconds: number(message.offsetSeconds), createdAt: string(message.createdAt),
    user: user === null ? null : {
      id: string(user.id), login: string(user.login), displayName: string(user.displayName),
    },
    text: string(message.text),
    color: nullableString(message.color),
    fragments: array(message.fragments).map((value) => {
      const fragment = record(value);
      return { text: string(fragment.text), emoteId: nullableString(fragment.emoteId) };
    }),
    badges: array(message.badges).map((value) => {
      const badge = record(value);
      return { setId: string(badge.setId), version: string(badge.version) };
    }),
  };
}

/** Chat state carried by the player session bridge. */
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
