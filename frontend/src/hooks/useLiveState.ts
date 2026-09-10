import { useEffect } from "react";

import { useEvents } from "@/store/events";

/** Subscribe to the SSE stream while the component is mounted. */
export function useLiveState() {
  const { state, conn, connect, disconnect } = useEvents();
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);
  return { state, conn };
}
