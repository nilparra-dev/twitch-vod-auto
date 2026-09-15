import {
  FolderOpen,
  MessageSquare,
  Search,
  X,
  Github,
  History,
  ArrowRight,
  ChevronDown,
  RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ChatMessage } from "./archive";
import { useChatReplay } from "./useChatReplay";
import { usePositionPersistence } from "./usePositionPersistence";
import { usePlayerBridge } from "./session";
import { useTheaterMode } from "./useTheaterMode";
import { useHls } from "./useHls";
import { VideoControls } from "./VideoControls";
import { clock } from "./time";
import "./player.css";

function Message({ message, seek }: { message: ChatMessage; seek: (time: number) => void }) {
  const color = message.color && /^#[a-f\d]{6}$/i.test(message.color) ? message.color : undefined;
  return (
    <div className="replay-message">
      <button
        type="button"
        onClick={() => seek(message.offsetSeconds)}
        className="replay-message-time"
        aria-label={`Jump to ${clock(message.offsetSeconds)}`}
      >
        {clock(message.offsetSeconds)}
      </button>
      <span
        className="replay-message-name"
        style={{ color }}
        title={message.badges.map((badge) => `${badge.setId} ${badge.version}`).join(", ")}
      >
        {message.user?.displayName || message.user?.login || "Deleted user"}
      </span>
      <span>: </span>
      <span className="whitespace-pre-wrap">{message.text}</span>
    </div>
  );
}

export function ReplayPlayer() {
  const { bridge, error: bridgeError } = usePlayerBridge();
  const [media, setMedia] = useState<
    | { kind: "local"; file: File; url: string }
    | { kind: "remote"; title: string; key: string; url: string }
    | null
  >(null);
  const videoFile = media?.kind === "local" ? media.file : null;
  const videoUrl = media?.url ?? "";
  const [target, setTarget] = useState("");
  const [channel, setChannel] = useState("");
  const [openError, setOpenError] = useState("");
  const [loadedRevision, setLoadedRevision] = useState(-1);
  const [ignoreRemoteChat, setIgnoreRemoteChat] = useState(-1);
  const [videoError, setVideoError] = useState("");
  const [chatFile, setChatFile] = useState<File | null>(null);
  const [time, setTime] = useState(0);
  const [shift, setShift] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [chatVisible, setChatVisible] = useState(true);
  const [theater, setTheater] = useTheaterMode();
  const video = useRef<HTMLVideoElement>(null);
  const videoPicker = useRef<HTMLInputElement>(null);
  const chatPicker = useRef<HTMLInputElement>(null);
  const storageKey = videoFile
    ? `replay:${videoFile.name}:${videoFile.size}:${videoFile.lastModified}`
    : media?.kind === "remote"
      ? `replay:stream:${media.key}`
      : "";
  const replayTime = time + shift;
  const remote = bridge?.session;
  const remoteChat =
    remote?.state === "ready" &&
    remote.chat.kind === "ready" &&
    remote.revision !== ignoreRemoteChat &&
    media?.kind === "remote"
      ? remote.chat
      : null;
  const remoteChatUrl = remoteChat?.url;
  const remoteChatSize = remoteChat?.size ?? 0;
  const title = media?.kind === "remote" ? media.title : videoFile?.name;
  const isLive = remote?.source === "live" && media?.kind === "remote";

  const {
    chat,
    ready,
    query,
    setQuery,
    searching,
    displayed,
    resultsFull,
    following,
    setFollowing,
    log,
    reset,
    clearWindow,
  } = useChatReplay({
    file: chatFile,
    ...(remoteChatUrl ? { remoteUrl: remoteChatUrl } : {}),
    remoteSize: remoteChatSize,
    time: replayTime,
  });
  const { remember, restore } = usePositionPersistence(storageKey, video);

  useHls(video, videoUrl, media?.kind === "remote", setVideoError, isLive);

  useEffect(() => {
    if (
      !remote ||
      remote.state !== "ready" ||
      remote.revision === loadedRevision ||
      !remote.formats[0]
    )
      return;
    setMedia({
      kind: "remote",
      title: remote.title,
      key: remote.input,
      url: remote.formats[0].url,
    });
    setTarget(remote.input);
    setLoadedRevision(remote.revision);
    setVideoError("");
    setChatFile(null);
    setTime(0);
    setShift(0);
    setSpeed(1);
    reset();
  }, [remote, loadedRevision, reset]);

  useEffect(() => {
    return () => {
      if (media?.kind === "local") URL.revokeObjectURL(media.url);
    };
  }, [media]);

  function updateTime() {
    if (video.current) setTime(video.current.currentTime);
    remember();
  }

  function selectVideo(file: File | undefined) {
    if (!file) return;
    remember(true);
    setMedia({ kind: "local", file, url: URL.createObjectURL(file) });
    setIgnoreRemoteChat(remote?.revision ?? -1);
    setVideoError("");
    setTime(0);
    setShift(0);
    setSpeed(1);
    setChatFile(null);
    reset();
  }

  function seek(offset: number) {
    const element = video.current;
    if (!element || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.min(element.duration, Math.max(0, offset - shift));
    reset();
    updateTime();
    remember(true);
  }

  async function openTarget(input = target) {
    if (!bridge || !input.trim()) return;
    remember(true);
    setOpenError("");
    try {
      await bridge.load(input.trim(), channel.trim() || undefined);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Could not open this broadcast.");
    }
  }

  const resolving = remote?.state === "resolving";
  const sourceError = openError || bridgeError || (remote?.state === "error" ? remote.error : "");
  const downloading =
    media?.kind === "remote" && remote?.chat.kind === "downloading" ? remote.chat : null;
  const unavailable =
    media?.kind === "remote" && remote?.chat.kind === "unavailable" ? remote.chat.message : null;
  return (
    <section
      aria-label="Local replay player"
      className={`replay-kit${theater ? " is-theater" : ""}${chatVisible ? "" : " chat-hidden"}`}
    >
      <header className="replay-topbar">
        <a className="replay-brand" href="./" aria-label="Twitch VOD Replay home">
          <History size={26} strokeWidth={2.3} />
          <strong>
            twitch<span>vod</span>
          </strong>
        </a>
        <form
          className="replay-open-form"
          onSubmit={(event) => {
            event.preventDefault();
            void openTarget();
          }}
        >
          <div className="replay-url">
            <input
              aria-label="Open a broadcast"
              placeholder={
                bridge ? "Paste a VOD or tracker URL" : "Launch twitch-m3u8 watch to stream a URL"
              }
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              disabled={!bridge || resolving}
            />
            <button
              type="submit"
              aria-label="Watch replay"
              title="Open broadcast"
              disabled={!bridge || resolving || !target.trim()}
            >
              <ArrowRight size={17} />
            </button>
          </div>
          <details className="replay-source-options">
            <summary title="Source options">
              <ChevronDown size={15} />
              <span className="sr-only">Source options</span>
            </summary>
            <div>
              <label>
                Channel, if needed
                <input
                  aria-label="Channel name (optional)"
                  placeholder="Channel name"
                  value={channel}
                  onChange={(event) => setChannel(event.target.value)}
                />
              </label>
            </div>
          </details>
        </form>
        <div className="replay-top-actions">
          <button
            type="button"
            className="vod-icon"
            aria-label="Open video"
            title="Open local video"
            onClick={() => videoPicker.current?.click()}
          >
            <FolderOpen size={19} />
          </button>
          <button
            type="button"
            className="vod-icon"
            aria-label={chatVisible ? "Hide chat" : "Show chat"}
            title={chatVisible ? "Hide chat" : "Show chat"}
            onClick={() => setChatVisible(!chatVisible)}
          >
            <MessageSquare size={18} />
          </button>
          <a
            href="https://github.com/nilparra-dev/twitch-vod-auto"
            target="_blank"
            rel="noreferrer"
            aria-label="Source on GitHub"
            title="Source on GitHub"
            className="vod-icon"
          >
            <Github size={19} />
          </a>
        </div>
      </header>
      {sourceError && (
        <p className="replay-source-error" role="alert">
          {sourceError}
        </p>
      )}
      {resolving && (
        <p className="replay-resolving" role="status">
          Finding the broadcast…
        </p>
      )}
      <div className="replay-layout">
        <div className="replay-main">
          <div className="replay-watch-heading">
            <span>{isLive ? "Live" : "Replay"}</span>
            <span className="replay-heading-divider">/</span>
            <span className="replay-heading-title">{title || "No broadcast open"}</span>
            <span className="replay-local-status">
              {media?.kind === "remote" ? "Streaming" : "Local player"}
            </span>
          </div>
          <div className="replay-screen">
            {videoUrl ? (
              <video
                key={videoUrl}
                ref={video}
                src={media?.kind === "local" ? videoUrl : undefined}
                playsInline
                preload="metadata"
                aria-label="Archived video"
                onTimeUpdate={updateTime}
                onSeeking={() => {
                  clearWindow();
                  setFollowing(true);
                  updateTime();
                }}
                onSeeked={updateTime}
                onWaiting={updateTime}
                onPlaying={updateTime}
                onPause={() => {
                  updateTime();
                  remember(true);
                }}
                onEnded={() => remember(true)}
                onRateChange={() => {
                  if (video.current) setSpeed(video.current.playbackRate);
                }}
                onLoadedMetadata={() => {
                  const element = video.current;
                  if (!element) return;
                  element.playbackRate = speed;
                  restore();
                  updateTime();
                }}
                onError={() =>
                  setVideoError(
                    media?.kind === "remote"
                      ? "Playback stopped. Reconnect the broadcast or try another quality."
                      : "This browser cannot play this file. Try an H.264/AAC MP4 or WebM.",
                  )
                }
              />
            ) : (
              <div className="replay-empty-video">
                <History size={36} strokeWidth={1.4} />
                <h1>Open a broadcast</h1>
                <p>
                  {bridge
                    ? "Paste a link above, or play a video from your files."
                    : "Choose a video from your files to start watching."}
                </p>
                <button
                  type="button"
                  className="replay-button"
                  onClick={() => videoPicker.current?.click()}
                >
                  <FolderOpen size={15} />
                  Open video file
                </button>
                <span>Chat can be added at any time.</span>
              </div>
            )}
            {videoError && (
              <div className="replay-video-error" role="alert">
                {videoError}
                <button
                  type="button"
                  aria-label="Dismiss video error"
                  onClick={() => setVideoError("")}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            <VideoControls
              video={video}
              source={videoUrl}
              theater={theater}
              onTheater={() => setTheater(!theater)}
              onError={setVideoError}
            >
              {media?.kind === "remote" && remote && (
                <select
                  aria-label="Video quality"
                  title="Video quality"
                  value={media.url}
                  onChange={(event) => {
                    remember(true);
                    setVideoError("");
                    setMedia({ ...media, url: event.target.value });
                  }}
                >
                  {remote.formats.map((format) => (
                    <option key={format.id} value={format.url}>
                      {format.id}
                    </option>
                  ))}
                </select>
              )}
              <select
                aria-label="Playback speed"
                title="Playback speed"
                value={speed}
                disabled={!videoUrl}
                onChange={(event) => {
                  const rate = Number(event.target.value);
                  if (video.current) video.current.playbackRate = rate;
                  setSpeed(rate);
                }}
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}×
                  </option>
                ))}
              </select>
            </VideoControls>
          </div>
          <div className="replay-details">
            <div className="replay-avatar" aria-hidden="true">
              {media?.kind === "remote" ? title?.slice(0, 1).toUpperCase() : <History size={23} />}
            </div>
            <div className="replay-description">
              <h2>{title || "No video selected"}</h2>
              <div className="replay-metadata">
                <span className="replay-source-badge">
                  {media?.kind === "remote"
                    ? remote?.source === "live"
                      ? "Live · ads filtered"
                      : remote?.source === "hidden"
                        ? "Recovered VOD"
                        : "Twitch VOD"
                    : "Local video"}
                </span>
                <span>
                  {chat.kind === "ready"
                    ? `${chat.info.count.toLocaleString()} messages${chat.info.status === "partial" ? " · Partial archive" : ""}`
                    : media?.kind === "remote"
                      ? "Video loads as you watch"
                      : "Files stay on this device"}
                </span>
              </div>
              {chat.kind === "ready" && (
                <p className="replay-chat-title" title={chat.info.title}>
                  Chat: {chat.info.title} · VOD {chat.info.vodId}
                </p>
              )}
            </div>
            {media?.kind === "remote" && (
              <button
                type="button"
                className="replay-button reconnect"
                disabled={resolving}
                onClick={() => void openTarget(media.key)}
              >
                <RotateCcw size={14} />
                Reconnect<span className="sr-only"> broadcast</span>
              </button>
            )}
          </div>
        </div>
        <aside aria-label="Replay chat" className="replay-chat" hidden={!chatVisible}>
          <div className="replay-chat-heading">
            <h2>Stream Chat</h2>
            <span className="replay-chat-replay">
              <History size={12} />
              Replay
            </span>
          </div>
          <div className="replay-chat-tools">
            <time>{clock(replayTime)}</time>
            <span>{ready ? "Following video time" : "Chat replay"}</span>
          </div>
          {ready && (
            <div className="replay-search">
              <Search size={14} />
              <input
                aria-label="Search chat"
                placeholder="Search messages"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              )}
            </div>
          )}
          <div className="replay-chat-window">
            <div
              ref={log}
              aria-label="Chat messages"
              role="log"
              aria-live="polite"
              aria-relevant="additions text"
              className="replay-chat-log"
              tabIndex={0}
              onScroll={() => {
                const element = log.current;
                if (!query && element)
                  setFollowing(
                    element.scrollHeight - element.scrollTop - element.clientHeight < 48,
                  );
              }}
            >
              {chat.kind === "none" && (
                <div className="replay-empty-chat">
                  <MessageSquare size={24} strokeWidth={1.5} />
                  <h3>{downloading ? "Loading chat" : "Welcome to the replay."}</h3>
                  <p>
                    {downloading
                      ? `${downloading.messages.toLocaleString()} messages saved. Keep watching while we get the rest.`
                      : "The conversation will follow the video. Open its chat archive to join the moment."}
                  </p>
                  {unavailable && (
                    <details>
                      <summary>Chat is unavailable</summary>
                      <p>{unavailable}</p>
                    </details>
                  )}
                  <button
                    type="button"
                    className="replay-button"
                    disabled={!media}
                    onClick={() => chatPicker.current?.click()}
                  >
                    Open chat file
                  </button>
                </div>
              )}
              {chat.kind === "loading" && (
                <p role="status" className="replay-chat-status">
                  Indexing chat… {chat.percent}%
                </p>
              )}
              {chat.kind === "error" && (
                <p role="alert" className="replay-error">
                  {chat.message}
                </p>
              )}
              {ready && searching && (
                <p role="status" className="replay-chat-status">
                  Searching archive…
                </p>
              )}
              {ready && !searching && displayed.length === 0 && (
                <p className="replay-chat-status">
                  {query.trim()
                    ? "No matching messages."
                    : "No messages at this point in the replay."}
                </p>
              )}
              {ready &&
                displayed.map((message) => (
                  <Message key={message.id} message={message} seek={seek} />
                ))}
              {query.trim() && resultsFull && (
                <p className="replay-chat-status">
                  First 100 matches. Refine your search to find more.
                </p>
              )}
            </div>
            {!following && !query.trim() && ready && (
              <button type="button" className="replay-follow" onClick={() => setFollowing(true)}>
                <ChevronDown size={14} />
                Follow replay
              </button>
            )}
          </div>
          <div className="replay-chat-footer">
            <div className="replay-chat-file">
              <span title={chatFile?.name || remoteChat?.name}>
                {chatFile?.name || (remoteChat ? "Recovered chat" : "No chat attached")}
              </span>
              <button type="button" disabled={!media} onClick={() => chatPicker.current?.click()}>
                {chatFile || remoteChat ? "Replace" : "Open"}
              </button>
              {(chatFile || remoteChat) && (
                <button
                  type="button"
                  aria-label="Remove chat"
                  onClick={() => {
                    setChatFile(null);
                    setIgnoreRemoteChat(remote?.revision ?? -1);
                    setQuery("");
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <label className="replay-offset">
              Sync offset
              <span>
                <input
                  type="number"
                  aria-label="Chat offset in seconds"
                  value={shift}
                  disabled={!ready}
                  step=".5"
                  min="-86400"
                  max="86400"
                  onChange={(event) => {
                    const value = event.target.valueAsNumber;
                    if (Number.isFinite(value)) {
                      setShift(Math.max(-86400, Math.min(86400, value)));
                      clearWindow();
                      setFollowing(true);
                    }
                  }}
                />
                s
              </span>
            </label>
            <p className="replay-readonly">Archived conversation · Read only</p>
          </div>
        </aside>
      </div>
      <input
        ref={videoPicker}
        type="file"
        accept="video/*,.mp4,.webm,.m4v,.mov,.mkv"
        aria-label="Video file"
        className="sr-only"
        onChange={(event) => {
          selectVideo(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <input
        ref={chatPicker}
        type="file"
        aria-label={chatFile ? "Replace chat file" : "Add archived chat"}
        accept=".json,application/json"
        disabled={!media}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            setChatFile(file);
            setQuery("");
            setFollowing(true);
          }
          event.target.value = "";
        }}
      />
    </section>
  );
}
