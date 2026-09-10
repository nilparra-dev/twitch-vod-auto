import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  RectangleHorizontal,
  SkipBack,
  SkipForward,
} from "lucide-react";

import { clock as mediaClock } from "./time";

export function VideoControls({
  video,
  source,
  theater,
  onTheater,
  onError,
  children,
}: {
  video: RefObject<HTMLVideoElement>;
  source: string;
  theater: boolean;
  onTheater: () => void;
  onError: (message: string) => void;
  children?: ReactNode;
}) {
  const [state, setState] = useState({
    paused: true,
    time: 0,
    duration: 0,
    volume: 1,
    muted: false,
    buffered: 0,
  });
  const [fullscreen, setFullscreen] = useState(false);
  const audio = useRef({ volume: 1, muted: false });
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.volume = audio.current.volume;
    element.muted = audio.current.muted;
    const update = () => {
      audio.current = { volume: element.volume, muted: element.muted };
      let buffered = 0;
      for (let i = 0; i < element.buffered.length; i++) {
        if (
          element.buffered.start(i) <= element.currentTime &&
          element.buffered.end(i) >= element.currentTime
        )
          buffered = element.buffered.end(i);
      }
      setState({
        paused: element.paused,
        time: element.currentTime,
        duration: Number.isFinite(element.duration) ? element.duration : 0,
        volume: element.volume,
        muted: element.muted,
        buffered,
      });
    };
    const events = [
      "play",
      "pause",
      "timeupdate",
      "durationchange",
      "loadedmetadata",
      "volumechange",
      "progress",
      "emptied",
      "ended",
    ];
    events.forEach((event) => element.addEventListener(event, update));
    update();
    return () => events.forEach((event) => element.removeEventListener(event, update));
  }, [video, source]);
  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  function toggle() {
    const element = video.current;
    if (!element) return;
    if (!element.paused) element.pause();
    else
      void element.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        onError("Playback could not start. Try reconnecting or opening the video again.");
      });
  }
  function jump(value: number) {
    if (video.current && state.duration)
      video.current.currentTime = Math.max(0, Math.min(state.duration, value));
  }
  function toggleFullscreen() {
    const container = video.current?.parentElement;
    const action = document.fullscreenElement
      ? document.exitFullscreen()
      : container?.requestFullscreen?.();
    void action?.catch(() => onError("Fullscreen is unavailable in this browser window."));
  }
  return (
    <div
      className="vod-controls"
      role="group"
      aria-label="Video controls"
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)
          return;
        if (event.key === "k") {
          event.preventDefault();
          toggle();
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          jump(state.time - 10);
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          jump(state.time + 10);
        }
        if (event.key === "m" && video.current) video.current.muted = !video.current.muted;
        if (event.key === "f") toggleFullscreen();
      }}
    >
      <div className="vod-scrubber">
        <div
          className="vod-buffer"
          style={{ width: `${state.duration ? (state.buffered / state.duration) * 100 : 0}%` }}
        />
        <div
          className="vod-progress"
          style={{ width: `${state.duration ? (state.time / state.duration) * 100 : 0}%` }}
        />
        <input
          aria-label="Seek video"
          aria-valuetext={`${mediaClock(state.time)} of ${mediaClock(state.duration)}`}
          type="range"
          min="0"
          max={state.duration || 1}
          step="0.1"
          value={state.time}
          disabled={!state.duration}
          onChange={(event) => jump(Number(event.target.value))}
        />
      </div>
      <div className="vod-control-row">
        <button
          type="button"
          className="vod-icon"
          aria-label={state.paused ? "Play" : "Pause"}
          title={state.paused ? "Play (K)" : "Pause (K)"}
          disabled={!source}
          onClick={toggle}
        >
          {state.paused ? (
            <Play size={20} fill="currentColor" />
          ) : (
            <Pause size={20} fill="currentColor" />
          )}
        </button>
        <button
          type="button"
          className="vod-icon vod-skip"
          aria-label="Back 10 seconds"
          title="Back 10 seconds"
          disabled={!state.duration}
          onClick={() => jump(state.time - 10)}
        >
          <SkipBack size={17} />
        </button>
        <button
          type="button"
          className="vod-icon vod-skip"
          aria-label="Forward 10 seconds"
          title="Forward 10 seconds"
          disabled={!state.duration}
          onClick={() => jump(state.time + 10)}
        >
          <SkipForward size={17} />
        </button>
        <div className="vod-volume">
          <button
            type="button"
            className="vod-icon"
            aria-label={state.muted ? "Unmute" : "Mute"}
            title="Mute (M)"
            disabled={!source}
            onClick={() => {
              if (video.current) video.current.muted = !video.current.muted;
            }}
          >
            {state.muted || state.volume === 0 ? <VolumeX size={19} /> : <Volume2 size={19} />}
          </button>
          <input
            type="range"
            aria-label="Volume"
            min="0"
            max="1"
            step=".01"
            value={state.muted ? 0 : state.volume}
            disabled={!source}
            onChange={(event) => {
              if (video.current) {
                video.current.volume = Number(event.target.value);
                video.current.muted = false;
              }
            }}
          />
        </div>
        <time className="vod-time">
          {mediaClock(state.time)}
          <span> / {mediaClock(state.duration)}</span>
        </time>
        <div className="vod-control-end">
          {children}
          <button
            type="button"
            className="vod-icon"
            onClick={onTheater}
            aria-label={theater ? "Exit theater mode" : "Theater mode"}
            aria-pressed={theater}
            title="Theater mode"
          >
            <RectangleHorizontal size={19} />
          </button>
          <button
            type="button"
            className="vod-icon"
            disabled={!source}
            onClick={toggleFullscreen}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            title="Fullscreen (F)"
          >
            {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
          </button>
        </div>
      </div>
    </div>
  );
}
