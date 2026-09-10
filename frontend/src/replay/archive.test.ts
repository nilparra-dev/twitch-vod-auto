// @vitest-environment node
import { describe, expect, it } from "vitest";
import { indexArchive, readWindow, searchArchive, upperBound, type ChatMessage } from "./archive";

const message = (id: string, offsetSeconds: number, text = "hello"): ChatMessage => ({
  id,
  offsetSeconds,
  text,
  createdAt: "2026-09-01T12:00:00Z",
  user: null,
  color: null,
  fragments: [{ text, emoteId: null }],
  badges: [],
});
const archive = (
  messages = [message("a", 0), message("b", 5), message("c", 5), message("d", 20)],
) => ({
  schemaVersion: 1,
  vodId: "123",
  video: { title: "Test archive" },
  coverage: "available-replay",
  status: "complete",
  messageCount: messages.length,
  messages,
});
const file = (data: unknown) => new Blob([JSON.stringify(data)]);

describe("streaming chat index", () => {
  it("indexes exported JSON without retaining message text in entries", async () => {
    const data = archive();
    const index = await indexArchive(file(data));
    expect(index.info).toEqual({
      vodId: "123",
      title: "Test archive",
      count: 4,
      status: "complete",
    });
    expect(index.entries[0]).not.toHaveProperty("text");
    expect(await readWindow(index, 5)).toEqual(data.messages.slice(0, 3));
  });
  it("handles UTF-8, escaped quotes/braces and chunk boundaries", async () => {
    const messages = Array.from({ length: 1600 }, (_, i) =>
      message(String(i), i, `Español 日本語 🚀 {"messages":[ ]} \\ ${"x".repeat(150)}`),
    );
    const data = new Blob([JSON.stringify(archive(messages), null, 2)]);
    const progress: number[] = [];
    const index = await indexArchive(data, (value) => progress.push(value));
    expect(progress.length).toBeGreaterThan(2);
    expect(progress[progress.length - 1]).toBe(100);
    expect(await readWindow(index, 1599, 3)).toEqual(messages.slice(-3));
    expect(await readWindow(index, 350, 1)).toEqual([messages[350]]);
  });
  it("supports metadata after messages and a null deleted-VOD metadata record", async () => {
    const data = archive();
    const { messages, ...metadata } = data;
    const index = await indexArchive(file({ messages, ...metadata, video: null }));
    expect(index.info.title).toBe("VOD 123");
    expect(await readWindow(index, 0)).toEqual([messages[0]]);
  });
  it("rebuilds the window on backwards seeks and includes every equal-time message", async () => {
    const data = archive();
    const index = await indexArchive(file(data));
    expect(await readWindow(index, 100)).toEqual(data.messages);
    expect(await readWindow(index, 5)).toEqual(data.messages.slice(0, 3));
    expect(await readWindow(index, -1)).toEqual([]);
    expect(await readWindow(index, 4)).toEqual(data.messages.slice(0, 1));
  });
  it("caps the rendered window independently of archive size", async () => {
    const messages = Array.from({ length: 5000 }, (_, i) => message(String(i), i));
    const index = await indexArchive(file(archive(messages)));
    expect(await readWindow(index, 4999)).toEqual(messages.slice(-80));
    expect(upperBound(index.entries, 2500)).toBe(2501);
  });
  it("searches message content and users without loading the entire file", async () => {
    const messages = [
      message("a", 0, "one"),
      { ...message("b", 2, "two"), user: { id: "4", login: "person", displayName: "Person" } },
    ];
    const index = await indexArchive(file(archive(messages)));
    expect(await searchArchive(index, "PERSON", () => false)).toEqual([messages[1]]);
    expect(await searchArchive(index, "one", () => false)).toEqual([messages[0]]);
    expect(await searchArchive(index, "one", () => true)).toEqual([]);
  });
  it("distinguishes empty/partial archives and rejects incomplete or corrupt exports", async () => {
    const empty = await indexArchive(file({ ...archive([]), status: "empty" }));
    expect(await readWindow(empty, 10)).toEqual([]);
    expect((await indexArchive(file({ ...archive(), status: "partial" }))).info.status).toBe(
      "partial",
    );
    for (const invalid of [
      { ...archive(), schemaVersion: 2 },
      { ...archive(), messageCount: 99 },
      archive([message("a", 5), message("b", 1)]),
      archive([message("a", 1), message("a", 2)]),
      { ...archive(), messages: "not an array" },
      { ...archive(), messages: [null] },
    ])
      await expect(indexArchive(file(invalid))).rejects.toThrow();
    await expect(
      indexArchive(new Blob([JSON.stringify(archive()).slice(0, -3)])),
    ).rejects.toThrow();
    await expect(
      indexArchive(new Blob([JSON.stringify(archive()).replace(/\]\}$/, ",]}")])),
    ).rejects.toThrow();
  });
});
