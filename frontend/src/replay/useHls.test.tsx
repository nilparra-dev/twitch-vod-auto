import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";

const hls = vi.hoisted(() => {
  class FakeHls {
    static supported = true;
    static instances: FakeHls[] = [];
    static isSupported() {
      return FakeHls.supported;
    }
    static Events = { ERROR: "ERROR" };
    static ErrorTypes = { MEDIA_ERROR: "MEDIA_ERROR", NETWORK_ERROR: "NETWORK_ERROR" };
    loaded = "";
    constructor() {
      FakeHls.instances.push(this);
    }
    on() {}
    loadSource(url: string) {
      this.loaded = url;
    }
    attachMedia() {}
    destroy() {}
    recoverMediaError() {}
  }
  return { FakeHls };
});

vi.mock("hls.js", () => ({ default: hls.FakeHls }));

import { useHls } from "./useHls";

function videoRef() {
  const element = document.createElement("video");
  return { element, ref: { current: element } as RefObject<HTMLVideoElement> };
}

beforeEach(() => {
  hls.FakeHls.supported = true;
  hls.FakeHls.instances.length = 0;
});

describe("useHls", () => {
  it("imports hls.js lazily and attaches the remote source", async () => {
    const { ref } = videoRef();
    renderHook(() => useHls(ref, "http://127.0.0.1/video.m3u8", true, () => {}));
    await waitFor(() => expect(hls.FakeHls.instances).toHaveLength(1));
    expect(hls.FakeHls.instances[0]?.loaded).toBe("http://127.0.0.1/video.m3u8");
  });

  it("falls back to native HLS when hls.js is not supported", async () => {
    hls.FakeHls.supported = false;
    const { element, ref } = videoRef();
    element.canPlayType = () => "maybe";
    renderHook(() => useHls(ref, "http://127.0.0.1/video.m3u8", true, () => {}));
    await waitFor(() => expect(element.getAttribute("src")).toBe("http://127.0.0.1/video.m3u8"));
  });
});
