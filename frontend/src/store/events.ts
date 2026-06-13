import { create } from "zustand";

import type { DashboardState } from "@/lib/api";

type ConnState = "connecting" | "open" | "closed";

interface EventsStore {
  state: DashboardState | null;
  conn: ConnState;
  connect: () => void;
  disconnect: () => void;
}

let source: EventSource | null = null;
let refCount = 0;

export const useEvents = create<EventsStore>((set) => ({
  state: null,
  conn: "closed",

  connect: () => {
    refCount += 1;
    if (source) return;

    set({ conn: "connecting" });
    source = new EventSource("/api/events");

    source.addEventListener("state", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as DashboardState;
        set({ state: data, conn: "open" });
      } catch {
        /* ignora frames malformados */
      }
    });

    source.onopen = () => set({ conn: "open" });

    source.onerror = () => {
      // EventSource reintenta solo; reflejamos el estado de reconexión.
      set({ conn: "connecting" });
    };
  },

  disconnect: () => {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && source) {
      source.close();
      source = null;
      set({ conn: "closed" });
    }
  },
}));
