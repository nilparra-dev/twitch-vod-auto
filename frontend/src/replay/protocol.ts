import type { ArchiveInfo, ChatMessage } from "./archive";

export type WorkerRequest =
  | { kind: "load"; file: File }
  | { kind: "loadRemote"; url: string; size: number }
  | { kind: "window"; id: number; time: number }
  | { kind: "search"; id: number; query: string };

export type WorkerResponse =
  | { kind: "progress"; percent: number }
  | { kind: "ready"; info: ArchiveInfo }
  | { kind: "window"; id: number; messages: ChatMessage[] }
  | { kind: "search"; id: number; messages: ChatMessage[] }
  | { kind: "error"; message: string };
