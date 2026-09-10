import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayPlayer } from "./ReplayPlayer";
import type { WorkerRequest, WorkerResponse } from "./protocol";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: WorkerRequest[] = [];
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: WorkerRequest) {
    this.sent.push(message);
  }
  emit(data: WorkerResponse) {
    act(() => this.onmessage?.(new MessageEvent("message", { data })));
  }
  lastWindow() {
    const request = [...this.sent].reverse().find((item) => item.kind === "window");
    if (!request || request.kind !== "window") throw new Error("No window request");
    return request;
  }
}
const revoke = vi.fn();
beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  const NativeURL = URL;
  let id = 0;
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static createObjectURL() {
        return `blob:test-${++id}`;
      }
      static revokeObjectURL = revoke;
    },
  );
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function openVideo() {
  fireEvent.change(screen.getByLabelText("Video file"), {
    target: { files: [new File(["media"], "recording.mp4")] },
  });
  const video = screen.getByLabelText("Archived video");
  if (!(video instanceof HTMLVideoElement)) throw new Error("Expected a video");
  Object.defineProperty(video, "duration", { configurable: true, value: 100 });
  return video;
}
function openChat() {
  fireEvent.change(screen.getByLabelText("Add archived chat"), {
    target: { files: [new File(["chat"], "chat.json")] },
  });
  const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
  worker.emit({
    kind: "ready",
    info: { vodId: "123", title: "Broadcast", count: 1, status: "complete" },
  });
  return worker;
}
const message = {
  id: "message",
  offsetSeconds: 5,
  createdAt: "2026-09-01",
  user: null,
  text: "Message at five",
  fragments: [],
  badges: [],
  color: null,
};

describe("local replay controls", () => {
  it("uses media time plus the selected offset, including negative times", () => {
    render(<ReplayPlayer />);
    const video = openVideo();
    const worker = openChat();
    expect(worker.lastWindow().time).toBe(0);
    video.currentTime = 10;
    fireEvent.timeUpdate(video);
    expect(worker.lastWindow().time).toBe(10);
    fireEvent.change(screen.getByLabelText("Chat offset in seconds"), { target: { value: "-20" } });
    expect(worker.lastWindow().time).toBe(-10);
    fireEvent.change(screen.getByLabelText("Playback speed"), { target: { value: "2" } });
    expect(video.playbackRate).toBe(2);
    // A speed change must not invent elapsed video time.
    expect(worker.lastWindow().time).toBe(-10);
  });
  it("discards stale worker replies after seeking backwards", () => {
    render(<ReplayPlayer />);
    const video = openVideo();
    const worker = openChat();
    video.currentTime = 10;
    fireEvent.timeUpdate(video);
    const old = worker.lastWindow();
    worker.emit({ kind: "window", id: old.id, messages: [message] });
    expect(screen.getByText("Message at five")).toBeInTheDocument();
    video.currentTime = 1;
    fireEvent.seeking(video);
    worker.emit({ kind: "window", id: old.id, messages: [message] });
    expect(screen.queryByText("Message at five")).not.toBeInTheDocument();
    expect(worker.lastWindow().time).toBe(1);
  });
  it("seeks from a chat timestamp while applying the sync offset", () => {
    render(<ReplayPlayer />);
    const video = openVideo();
    const worker = openChat();
    fireEvent.change(screen.getByLabelText("Chat offset in seconds"), { target: { value: "2" } });
    video.currentTime = 5;
    fireEvent.timeUpdate(video);
    worker.emit({ kind: "window", id: worker.lastWindow().id, messages: [message] });
    fireEvent.click(screen.getByRole("button", { name: "Jump to 00:00:05" }));
    expect(video.currentTime).toBe(3);
  });
  it("retains video when chat fails or is removed, and terminates the reader", () => {
    render(<ReplayPlayer />);
    const video = openVideo();
    const worker = openChat();
    worker.emit({ kind: "error", message: "Malformed archive" });
    expect(screen.getByRole("alert")).toHaveTextContent("Malformed archive");
    expect(screen.getByLabelText("Archived video")).toBe(video);
    fireEvent.click(screen.getByRole("button", { name: "Remove chat" }));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Archived video")).toBe(video);
  });
  it("releases object URLs and exits theater mode with Escape", () => {
    const view = render(<ReplayPlayer />);
    openVideo();
    fireEvent.click(screen.getByRole("button", { name: "Theater mode" }));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Theater mode" })).toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe("hidden");
    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:test-1");
  });
});
