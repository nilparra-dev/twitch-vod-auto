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

export interface VideoMetadata {
  vodId: string;
  title: string;
  createdAt: string;
  durationSeconds: number;
  status: string;
  channel: string | null;
  stream: { channel: string; streamId: string; startedAtSeconds: number } | null;
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

export interface ChatPage {
  messages: ChatMessage[];
  nextCursor: string | null;
  continuation: "cursor" | "offset";
}

export function parseMessage(value: unknown): ChatMessage {
  const node = record(value);
  const body = record(node.message);
  const user = node.commenter === null ? null : record(node.commenter);
  const fragments = array(body.fragments).map((value) => {
    const fragment = record(value);
    return {
      text: string(fragment.text),
      emoteId: fragment.emote === null ? null : string(record(fragment.emote).emoteID),
    };
  });
  return {
    id: string(node.id),
    offsetSeconds: number(node.contentOffsetSeconds),
    createdAt: string(node.createdAt),
    user: user === null ? null : {
      id: string(user.id), login: string(user.login), displayName: string(user.displayName),
    },
    text: fragments.map((fragment) => fragment.text).join(""),
    fragments,
    badges: array(body.userBadges).map((value) => {
      const badge = record(value);
      return { setId: string(badge.setID), version: string(badge.version) };
    }),
    color: nullableString(body.userColor),
  };
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
