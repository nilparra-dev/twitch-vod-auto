import {
  array, nullableString, number, record, string,
  type ChatMessage,
} from "../protocol.js";

export {
  array, ChatError, nullableString, number, parseStoredMessage, record, string,
  type ChatMessage,
} from "../protocol.js";

export interface VideoMetadata {
  vodId: string;
  title: string;
  createdAt: string;
  durationSeconds: number;
  status: string;
  channel: string | null;
  stream: { channel: string; streamId: string; startedAtSeconds: number } | null;
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
