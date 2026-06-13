import { useEffect } from "react";

import { useEvents } from "@/store/events";

/** Suscribe el componente al stream SSE mientras está montado. */
export function useLiveState() {
  const { state, conn, connect, disconnect } = useEvents();
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);
  return { state, conn };
}
