import Hls from "hls.js";
import { useEffect, type RefObject } from "react";

export function useHls(
  video: RefObject<HTMLVideoElement>,
  url: string,
  active: boolean,
  onError: (message: string) => void,
) {
  useEffect(() => {
    const element = video.current;
    if (!element || !url || !active) return;
    if (Hls.isSupported()) {
      const player = new Hls({ enableWorker: false, maxBufferLength: 30, backBufferLength: 30 });
      let recovered = false;
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
          recovered = true;
          player.recoverMediaError();
          return;
        }
        onError(
          data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? "The video connection was interrupted or has expired. Reconnect to refresh the source."
            : "This video could not be decoded. Try another quality or a browser with H.264 support.",
        );
        player.destroy();
      });
      player.loadSource(url);
      player.attachMedia(element);
      return () => player.destroy();
    }
    if (element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = url;
      return () => {
        element.removeAttribute("src");
        element.load();
      };
    }
    onError(
      "This browser does not support HLS playback. Try a current Chrome, Firefox, Edge or Safari.",
    );
  }, [video, url, active, onError]);
}
