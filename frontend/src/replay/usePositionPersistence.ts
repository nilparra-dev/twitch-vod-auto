import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Persist the playback position per source key and restore it when the same
 * source is opened again. Browser storage is optional: every failure is
 * ignored because playback works without it.
 */
export function usePositionPersistence(
  storageKey: string,
  video: RefObject<HTMLVideoElement>,
) {
  const lastSaved = useRef(0);

  // A new source starts a new throttle window.
  useEffect(() => {
    lastSaved.current = 0;
  }, [storageKey]);

  const remember = useCallback(
    (force = false) => {
      const element = video.current;
      if (!element || !storageKey || (!force && Date.now() - lastSaved.current < 3000)) return;
      lastSaved.current = Date.now();
      try {
        localStorage.setItem(storageKey, String(element.currentTime));
      } catch {
        /* Playback works without browser storage. */
      }
    },
    [storageKey, video],
  );

  const restore = useCallback(() => {
    const element = video.current;
    if (!element || !storageKey) return;
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved > 0 && saved < element.duration - 2)
        element.currentTime = saved;
    } catch {
      /* Storage is optional. */
    }
  }, [storageKey, video]);

  useEffect(() => {
    const save = () => remember(true);
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, [remember]);

  return { remember, restore };
}
