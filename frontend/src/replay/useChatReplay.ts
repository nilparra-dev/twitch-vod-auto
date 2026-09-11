import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import type { ArchiveInfo, ChatMessage } from "./archive";
import type { WorkerRequest, WorkerResponse } from "./protocol";

type ChatState =
  | { kind: "none" }
  | { kind: "loading"; percent: number }
  | { kind: "ready"; info: ArchiveInfo }
  | { kind: "error"; message: string };

interface ChatReplayOptions {
  /** Local export selected by the user, when any. */
  file: File | null;
  /** Chat served by the watch bridge, when available. */
  remoteUrl?: string;
  remoteSize: number;
  /** Replay clock: media time plus the user offset. */
  time: number;
}

export interface ChatReplay {
  chat: ChatState;
  ready: boolean;
  query: string;
  setQuery: (value: string) => void;
  searching: boolean;
  displayed: ChatMessage[];
  /** True when a search returned the maximum of 100 matches. */
  resultsFull: boolean;
  following: boolean;
  setFollowing: (value: boolean) => void;
  log: RefObject<HTMLDivElement>;
  /** Clear the rendered window and any pending search, e.g. after a seek. */
  reset: () => void;
  /** Clear only the rendered window, keeping an active search. */
  clearWindow: () => void;
}

/**
 * Owns the chat worker, the indexed archive state, the visible window and the
 * debounced search. The media clock decides which messages are visible.
 */
export function useChatReplay(options: ChatReplayOptions): ChatReplay {
  const { file, remoteUrl, remoteSize, time } = options;
  const [chat, setChat] = useState<ChatState>({ kind: "none" });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [results, setResults] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [following, setFollowing] = useState(true);
  const log = useRef<HTMLDivElement>(null);
  const worker = useRef<Worker | null>(null);
  const windowId = useRef(0);
  const searchId = useRef(0);
  const ready = chat.kind === "ready";

  useEffect(() => {
    setMessages([]);
    setResults([]);
    if (!file && !remoteUrl) {
      setChat({ kind: "none" });
      return;
    }
    let instance: Worker;
    try {
      instance = new Worker(new URL("./chat.worker.ts", import.meta.url), { type: "module" });
    } catch {
      setChat({
        kind: "error",
        message: "Could not start the chat reader. Reload the page and try again.",
      });
      return;
    }
    worker.current = instance;
    setChat({ kind: "loading", percent: 0 });
    instance.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (worker.current !== instance) return;
      switch (data.kind) {
        case "progress":
          setChat({ kind: "loading", percent: data.percent });
          break;
        case "ready":
          setChat({ kind: "ready", info: data.info });
          break;
        case "window":
          if (data.id === windowId.current) setMessages(data.messages);
          break;
        case "search":
          if (data.id === searchId.current) {
            setResults(data.messages);
            setSearching(false);
          }
          break;
        case "error":
          setChat({ kind: "error", message: data.message });
          setSearching(false);
          break;
      }
    };
    instance.onerror = () =>
      setChat({ kind: "error", message: "The chat reader stopped. Try opening the file again." });
    if (file) instance.postMessage({ kind: "load", file } satisfies WorkerRequest);
    else if (remoteUrl)
      instance.postMessage({
        kind: "loadRemote",
        url: new URL(remoteUrl, location.href).href,
        size: remoteSize,
      } satisfies WorkerRequest);
    return () => {
      worker.current = null;
      instance.terminate();
    };
  }, [file, remoteUrl, remoteSize]);

  useEffect(() => {
    if (!ready || !following || query.trim()) return;
    worker.current?.postMessage({
      kind: "window",
      id: ++windowId.current,
      time,
    } satisfies WorkerRequest);
  }, [ready, following, query, time]);

  useEffect(() => {
    // One id cancels any in-flight search, even while the input is debounced.
    const cancelId = ++searchId.current;
    setResults([]);
    if (!ready) return;
    worker.current?.postMessage({
      kind: "search",
      id: cancelId,
      query: "",
    } satisfies WorkerRequest);
    setSearching(Boolean(query.trim()));
    if (!query.trim()) return;
    const timer = window.setTimeout(() => {
      const id = ++searchId.current;
      worker.current?.postMessage({ kind: "search", id, query } satisfies WorkerRequest);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, ready]);

  useEffect(() => {
    if (following && !query.trim() && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages, following, query]);

  const displayed = query.trim()
    ? results
    : messages.filter((message) => message.offsetSeconds <= time);

  const reset = useCallback(() => {
    setMessages([]);
    setResults([]);
    setQuery("");
    setFollowing(true);
  }, []);

  const clearWindow = useCallback(() => setMessages([]), []);

  return {
    chat,
    ready,
    query,
    setQuery,
    searching,
    displayed,
    resultsFull: results.length === 100,
    following,
    setFollowing,
    log,
    reset,
    clearWindow,
  };
}
