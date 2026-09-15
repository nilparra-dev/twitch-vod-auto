import { useEffect, useState } from "react";
import { array, record, string, number, nullableString } from "@chat-protocol";
import type { PlayerSession, ChatStatus } from "@chat-protocol";
export type { PlayerSession } from "@chat-protocol";

export interface PlayerBridge {
  session: PlayerSession;
  load: (input: string, channel?: string) => Promise<void>;
}
function parseSession(value: unknown): PlayerSession {
  const data = record(value);
  const raw = record(data.chat);
  let chat: ChatStatus;
  switch (raw.kind) {
    case "idle":
      chat = { kind: "idle" };
      break;
    case "downloading":
      chat = { kind: "downloading", messages: number(raw.messages) };
      break;
    case "ready":
      chat = {
        kind: "ready",
        url: string(raw.url),
        size: number(raw.size),
        name: string(raw.name),
      };
      break;
    case "unavailable":
      chat = { kind: "unavailable", message: string(raw.message) };
      break;
    default:
      throw new Error("Invalid chat session.");
  }
  if (
    data.state !== "idle" &&
    data.state !== "resolving" &&
    data.state !== "ready" &&
    data.state !== "error"
  )
    throw new Error("Invalid player state.");
  if (data.source !== null && data.source !== "public" && data.source !== "hidden" && data.source !== "live")
    throw new Error("Invalid video source.");
  return {
    revision: number(data.revision),
    input: string(data.input),
    state: data.state,
    error: nullableString(data.error),
    source: data.source,
    title: string(data.title),
    chat,
    formats: array(data.formats).map((value) => {
      const format = record(value);
      return { id: string(format.id), url: string(format.url) };
    }),
  };
}

export function usePlayerBridge(): { bridge?: PlayerBridge; error: string | null } {
  const [session, setSession] = useState<PlayerSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = /^\/[a-f0-9]{48}\/(?:replay\.html)?$/.test(location.pathname);
  const api = new URL("api/", location.href).href;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let delay = 1000;
    const poll = async () => {
      let ok = false;
      try {
        const response = await fetch(`${api}session`, { signal: controller.signal });
        if (!response.ok) throw new Error("The local player stopped. Restart twitch-m3u8 watch.");
        setSession(parseSession(await response.json()));
        setError(null);
        ok = true;
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : "Local player is unavailable.");
      }
      if (!controller.signal.aborted) {
        // Back off while the local server is unreachable instead of hammering
        // it. The first retry uses the base delay, then each failure doubles it.
        timer = setTimeout(() => void poll(), ok ? 1000 : delay);
        delay = ok ? 1000 : Math.min(delay * 2, 30_000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, api]);
  if (!session) return { error };
  return {
    error,
    bridge: {
      session,
      load: async (input, channel) => {
        const response = await fetch(`${api}resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input, ...(channel ? { channel } : {}) }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok)
          throw new Error("Could not start the VOD. Check that the local server is running.");
        setSession((previous) =>
          previous ? { ...previous, state: "resolving", error: null } : previous,
        );
      },
    },
  };
}
