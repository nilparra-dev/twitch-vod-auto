import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePlayerBridge } from "./session";

const capability = `/${"a".repeat(48)}/replay.html`;

const session = {
  revision: 1,
  input: "2434567890",
  state: "ready" as const,
  error: null,
  title: "Twitch VOD 2434567890",
  source: "public" as const,
  formats: [{ id: "chunked", url: "/media/1" }],
  chat: { kind: "idle" as const },
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("usePlayerBridge", () => {
  it("backs off while the local server is unreachable and recovers", async () => {
    window.history.pushState({}, "", capability);
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("local player is unavailable"))
      .mockRejectedValueOnce(new Error("local player is unavailable"))
      .mockResolvedValue({ ok: true, json: async () => session });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => usePlayerBridge());
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe("local player is unavailable");

    // First retry after one second.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The second retry waits two seconds, not one: the delay doubles.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();
    expect(result.current.bridge?.session.title).toBe("Twitch VOD 2434567890");
  });
});
