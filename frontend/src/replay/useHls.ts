import { useEffect, type RefObject } from "react";
import type Hls from "hls.js";

/**
 * Attach a remote HLS source. hls.js is imported dynamically so the player
 * shell does not pay for it unless remote streaming is actually used: local
 * file playback never loads the library.
 */
export function useHls(
  video: RefObject<HTMLVideoElement>,
  url: string,
  active: boolean,
  onError: (message: string) => void,
) {
  useEffect(() => {
    const element = video.current;
    if (!element || !url || !active) return;
    let cancelled = false;
    let player: Hls | null = null;
    let usedNative = false;
    const attachNative = () => {
      if (element.canPlayType("application/vnd.apple.mpegurl")) {
        element.src = url;
        usedNative = true;
      } else {
        onError(
          "This browser does not support HLS playback. Try a current Chrome, Firefox, Edge or Safari.",
        );
      }
    };

    void import("hls.js")
      .then((module) => {
        const Hls = module.default;
        if (cancelled) return;
        if (!Hls.isSupported()) {
          attachNative();
          return;
        }
        player = new Hls({ enableWorker: false, maxBufferLength: 30, backBufferLength: 30 });
        let recovered = false;
        player.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
            recovered = true;
            player?.recoverMediaError();
            return;
          }
          onError(
            data.type === Hls.ErrorTypes.NETWORK_ERROR
              ? "The video connection was interrupted or has expired. Reconnect to refresh the source."
              : "This video could not be decoded. Try another quality or a browser with H.264 support.",
          );
          player?.destroy();
        });
        player.loadSource(url);
        player.attachMedia(element);
      })
      .catch(() => {
        if (!cancelled) attachNative();
      });

    return () => {
      cancelled = true;
      player?.destroy();
      if (usedNative) {
        element.removeAttribute("src");
        element.load();
      }
    };
  }, [video, url, active, onError]);
}
