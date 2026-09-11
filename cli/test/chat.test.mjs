import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { downloadChat } from "../../dist/chat/archive.js";
import { ChatError, parseMessage } from "../../dist/chat/model.js";
import { parseVideo, TwitchChatClient } from "../../dist/chat/twitch.js";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function outputPath() {
  const directory = await mkdtemp(join(tmpdir(), "twitch-chat-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "chat.json");
}

const metadata = {
  vodId: "123", title: "Replay", createdAt: "2026-09-01T12:00:00Z", durationSeconds: 100,
  status: "RECORDED", channel: "some_channel",
  stream: { channel: "some_channel", streamId: "999999999999", startedAtSeconds: 1788264000 },
};
const rawVideo = {
  id: "123", title: "Replay", createdAt: metadata.createdAt, lengthSeconds: 100,
  status: "RECORDED", owner: { login: "some_channel" },
  seekPreviewsURL: "https://cdn.example/0123456789abcdef0123_some_channel_999999999999_1788264000/storyboards/123-info.json",
};
const rawMessage = {
  id: "a", contentOffsetSeconds: 1, createdAt: "2026-09-01T12:00:01Z", commenter: null,
  message: { fragments: [{ text: "Hello ", emote: null }, { text: "Kappa", emote: { emoteID: "25" } }],
    userBadges: [{ setID: "subscriber", version: "12" }], userColor: "#123456" },
};
const message = (id, offsetSeconds) => ({ ...parseMessage(rawMessage), id, offsetSeconds });
const a = message("a", 1);
const b = message("b", 1);
const c = message("c", 99);
const errorCode = (code) => (error) => error instanceof ChatError && error.code === code;
const jsonResponse = (data) => new Response(JSON.stringify({ data }), { status: 200 });
const commentsResponse = (messages, hasNextPage, cursor = "next") => jsonResponse({
  video: { comments: { edges: messages.map((node) => ({ node, cursor })), pageInfo: { hasNextPage } } },
});

describe("Twitch chat protocol", () => {
  it("keeps messages from deleted users and emote/badge metadata", () => {
    const parsed = parseMessage(rawMessage);
    assert.equal(parsed.user, null);
    assert.equal(parsed.text, "Hello Kappa");
    assert.equal(parsed.fragments[1].emoteId, "25");
    assert.deepEqual(parsed.badges, [{ setId: "subscriber", version: "12" }]);
    assert.equal(parsed.offsetSeconds, 1);
  });

  it("rejects malformed offsets instead of silently dropping messages", () => {
    for (const offset of [NaN, Infinity, -1, "4"]) {
      assert.throws(() => parseMessage({ ...rawMessage, contentOffsetSeconds: offset }), errorCode("INVALID_DATA"));
    }
  });

  it("distinguishes stream identity from VOD identity using an exact path component", () => {
    assert.deepEqual(parseVideo(rawVideo), metadata);
    assert.equal(parseVideo({ ...rawVideo, seekPreviewsURL: "https://cdn.example/123.jpg" }).stream, null);
  });

  it("resolves a hidden stream only on exact ID/channel/timestamp evidence", async () => {
    const client = new TwitchChatClient({ fetch: async () => jsonResponse({
      user: { videos: { edges: [{ node: rawVideo, cursor: "end" }], pageInfo: { hasNextPage: false } } },
    }) });
    assert.equal(await client.resolve("video:some_channel_999999999999_1788264000"), "123");
    await assert.rejects(client.resolve("video:some_channel_999999999999_1788264001"), errorCode("VOD_ID_UNRESOLVED"));
    await assert.rejects(client.resolve("video:some_channel_999999999998_1788264000"), errorCode("VOD_ID_UNRESOLVED"));
    await assert.rejects(client.resolve("999999999999"), errorCode("CHANNEL_REQUIRED"));
  });

  it("paginates VOD discovery and detects repeated discovery cursors", async () => {
    const requests = [];
    const client = new TwitchChatClient({ fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body.variables.after);
      return jsonResponse({ user: { videos: {
        edges: [{ node: { ...rawVideo, seekPreviewsURL: null }, cursor: "same" }], pageInfo: { hasNextPage: true },
      } } });
    } });
    await assert.rejects(client.resolve("999999999999", "some_channel"), errorCode("PAGINATION_STALLED"));
    assert.deepEqual(requests, [null, "same"]);
  });

  it("classifies GraphQL errors with null extensions instead of failing validation", async () => {
    const client = new TwitchChatClient({ retryDelayMs: 0, fetch: async () =>
      new Response(JSON.stringify({ errors: [{ message: "nope", extensions: null }] }), { status: 200 }),
    });
    await assert.rejects(client.video("123"), errorCode("GRAPHQL_ERROR"));
  });

  it("takes a VOD URL literally, even with a long ID, without querying discovery", async () => {
    const client = new TwitchChatClient({ fetch: async () => { throw new Error("not expected"); } });
    assert.equal(await client.resolve("https://twitch.tv/videos/999999999999"), "999999999999");
  });

  it("uses offset zero only on the first page, then opaque cursors", async () => {
    const requests = [];
    const client = new TwitchChatClient({ fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body).variables);
      return commentsResponse([rawMessage], requests.length === 1);
    } });
    const first = await client.page({ vodId: "123", cursor: null, offsetSeconds: 0 });
    assert.equal(first.nextCursor, "next");
    const second = await client.page({ vodId: "123", cursor: first.nextCursor, offsetSeconds: 1 });
    assert.equal(second.nextCursor, null);
    assert.deepEqual(requests, [{ videoID: "123", contentOffsetSeconds: 0 }, { videoID: "123", cursor: "next" }]);
  });

  it("retries rate limits and network errors but does not retry access denial", async () => {
    let calls = 0;
    const client = new TwitchChatClient({ retryDelayMs: 0, fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response("limited", { status: 429, headers: { "retry-after": "0" } });
      if (calls === 2) throw new TypeError("network error");
      return jsonResponse({ video: rawVideo });
    } });
    assert.equal((await client.video("123")).vodId, "123");
    assert.equal(calls, 3);
    calls = 0;
    const denied = new TwitchChatClient({ fetch: async () => { calls += 1; return new Response("denied", { status: 403 }); } });
    await assert.rejects(denied.video("123"), errorCode("HTTP_ERROR"));
    assert.equal(calls, 1);
  });

  it("distinguishes null chat, unavailable VOD, empty replay and GraphQL errors", async () => {
    const clientFor = (response) => new TwitchChatClient({ retryDelayMs: 0, fetch: async () => response() });
    const args = { vodId: "123", cursor: null, offsetSeconds: 0 };
    await assert.rejects(clientFor(() => jsonResponse({ video: { comments: null } })).page(args), errorCode("CHAT_NOT_READY"));
    await assert.rejects(clientFor(() => jsonResponse({ video: null })).page(args), errorCode("CHAT_UNAVAILABLE"));
    assert.deepEqual(await clientFor(() => commentsResponse([], false)).page(args), { messages: [], nextCursor: null, continuation: "cursor" });
    await assert.rejects(clientFor(() => commentsResponse([], true)).page(args), errorCode("PAGINATION_STALLED"));
    await assert.rejects(clientFor(() => new Response(JSON.stringify({ errors: [{ message: "schema changed" }], data: { video: null } }))).page(args), errorCode("GRAPHQL_ERROR"));
  });
  it("falls back from rejected cursors to the same second and reuses offset pagination", async () => {
    const requests = [];
    const client = new TwitchChatClient({ fetch: async (_url, init) => {
      const variables = JSON.parse(init.body).variables;
      requests.push(variables);
      if (variables.cursor) return new Response(JSON.stringify({ errors: [{ extensions: { code: "IntegrityCheckFailed" } }] }));
      return commentsResponse([rawMessage], true);
    } });
    const page = await client.page({ vodId: "123", cursor: "rejected", offsetSeconds: 12.5 });
    assert.equal(page.continuation, "offset");
    await client.page({ vodId: "123", cursor: "another", offsetSeconds: 15 });
    assert.deepEqual(requests, [
      { videoID: "123", cursor: "rejected" }, { videoID: "123", contentOffsetSeconds: 12 },
      { videoID: "123", contentOffsetSeconds: 15 },
    ]);
  });
});

describe("resumable chat archive", () => {
  it("requires overlap when falling back to offsets", async () => {
    const output = await outputPath();
    await assert.rejects(downloadChat({ vodId: "123", output, source: {
      video: async () => metadata, page: async ({ cursor, offsetSeconds }) => {
        if (cursor === null) return { messages: [a], nextCursor: "next", continuation: "cursor" };
        assert.equal(offsetSeconds, 1);
        return { messages: [c], nextCursor: null, continuation: "offset" };
      },
    } }), errorCode("COVERAGE_GAP"));
    const result = await downloadChat({ vodId: "123", output, source: {
      video: async () => metadata, page: async () => ({ messages: [a, b, c], nextCursor: null, continuation: "offset" }),
    } });
    assert.equal(result.messageCount, 3);
  });
  it("does not skip a crowded second when offset pagination cannot advance", async () => {
    const output = await outputPath();
    await assert.rejects(downloadChat({ vodId: "123", output, source: {
      video: async () => metadata, page: async ({ cursor }) => ({
        messages: [a], nextCursor: cursor === null ? "first" : "different", continuation: "offset",
      }),
    } }), errorCode("PAGINATION_STALLED"));
  });
  it("exports all pages and deduplicates IDs while preserving equal-time messages", async () => {
    const output = await outputPath();
    const source = { video: async () => metadata, page: async ({ cursor }) => cursor === null
      ? { messages: [a, b], nextCursor: "next" } : { messages: [b, c], nextCursor: null } };
    const result = await downloadChat({ vodId: "123", output, source });
    const exported = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.status, "complete");
    assert.equal(result.messageCount, 3);
    assert.equal(exported.coverage, "available-replay");
    assert.deepEqual(exported.messages, [a, b, c]);
    await assert.rejects(stat(join(`${output}.archive`, "lock")), { code: "ENOENT" });
  });

  it("resumes a network interruption at the last committed cursor", async () => {
    const output = await outputPath();
    await assert.rejects(downloadChat({ vodId: "123", output, source: {
      video: async () => metadata,
      page: async ({ cursor }) => {
        if (cursor === null) return { messages: [a], nextCursor: "next" };
        throw new ChatError("NETWORK_ERROR", "disconnected");
      },
    } }), errorCode("NETWORK_ERROR"));
    await assert.rejects(stat(output), { code: "ENOENT" });
    const manifest = JSON.parse(await readFile(join(`${output}.archive`, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "partial");
    assert.equal(manifest.messageCount, 1);
    const requested = [];
    await downloadChat({ vodId: "123", output, source: {
      video: async () => metadata,
      page: async ({ cursor }) => { requested.push(cursor); return { messages: [c], nextCursor: null }; },
    } });
    assert.deepEqual(requested, ["next"]);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")).messages, [a, c]);
  });

  it("recovers an uncommitted journal tail after cancellation", async () => {
    const output = await outputPath();
    const controller = new AbortController();
    await assert.rejects(downloadChat({ vodId: "123", output, signal: controller.signal,
      source: { video: async () => metadata, page: async () => ({ messages: [a], nextCursor: "next" }) },
      onProgress: () => controller.abort(),
    }));
    await appendFile(join(`${output}.archive`, "pages.jsonl"), '{"cursor":"next","messages":[');
    await downloadChat({ vodId: "123", output, source: {
      video: async () => metadata, page: async ({ cursor }) => {
        assert.equal(cursor, "next"); return { messages: [c], nextCursor: null };
      },
    } });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")).messages, [a, c]);
  });

  it("can export a completed journal offline after interruption and preserves metadata", async () => {
    const output = await outputPath();
    const controller = new AbortController();
    await assert.rejects(downloadChat({ vodId: "123", output, signal: controller.signal,
      source: { video: async () => metadata, page: async () => ({ messages: [a], nextCursor: null }) },
      onProgress: () => controller.abort(),
    }));
    await downloadChat({ vodId: "123", output, source: {
      video: async () => { throw new Error("must stay offline"); },
      page: async () => { throw new Error("must stay offline"); },
    } });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")).video, metadata);
  });

  it("refuses unfinished VODs without requesting chat", async () => {
    const output = await outputPath();
    await assert.rejects(downloadChat({ vodId: "123", output, source: {
      video: async () => ({ ...metadata, status: "RECORDING" }),
      page: async () => { throw new Error("must not request chat"); },
    } }), errorCode("VOD_NOT_FINISHED"));
  });

  it("tries chat even if metadata has disappeared; never requires playable video", async () => {
    const output = await outputPath();
    const result = await downloadChat({ vodId: "123", output, source: {
      video: async () => null, page: async () => ({ messages: [a], nextCursor: null }),
    } });
    assert.equal(result.status, "complete");
    assert.equal(result.video, null);
  });

  it("reports inaccessible replay separately from an empty response", async () => {
    const output = await outputPath();
    await assert.rejects(downloadChat({ vodId: "123", output, source: {
      video: async () => null, page: async () => { throw new ChatError("CHAT_UNAVAILABLE", "gone"); },
    } }), errorCode("CHAT_UNAVAILABLE"));
    const manifest = JSON.parse(await readFile(join(`${output}.archive`, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "unavailable");
    await assert.rejects(stat(output), { code: "ENOENT" });
    const result = await downloadChat({ vodId: "123", output, source: {
      video: async () => metadata, page: async () => ({ messages: [], nextCursor: null }),
    } });
    assert.equal(result.status, "empty");
  });

  it("stops pagination loops without committing the repeated page", async () => {
    const output = await outputPath();
    await assert.rejects(downloadChat({ vodId: "123", output, source: {
      video: async () => metadata,
      page: async ({ cursor }) => ({ messages: cursor === null ? [a] : [c], nextCursor: "same" }),
    } }), errorCode("PAGINATION_STALLED"));
    const lines = (await readFile(join(`${output}.archive`, "pages.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
  });

  it("rejects out-of-order messages and leaves committed pages resumable", async () => {
    const output = await outputPath();
    await assert.rejects(downloadChat({ vodId: "123", output, source: {
      video: async () => metadata, page: async ({ cursor }) => cursor === null
        ? { messages: [c], nextCursor: "next" } : { messages: [a], nextCursor: null },
    } }), errorCode("OUT_OF_ORDER"));
    assert.equal(JSON.parse(await readFile(join(`${output}.archive`, "manifest.json"), "utf8")).messageCount, 1);
  });

  it("refuses a different VOD in an existing archive", async () => {
    const output = await outputPath();
    await assert.rejects(downloadChat({ vodId: "123", output, source: {
      video: async () => metadata, page: async () => { throw new ChatError("NETWORK_ERROR", "offline"); },
    } }));
    await assert.rejects(downloadChat({ vodId: "456", output, source: {} }), errorCode("ARCHIVE_MISMATCH"));
    assert.equal(JSON.parse(await readFile(join(`${output}.archive`, "manifest.json"), "utf8")).vodId, "123");
  });

  it("does not overwrite output files, including a collision during export", async () => {
    const output = await outputPath();
    await writeFile(output, "keep me");
    await assert.rejects(downloadChat({ vodId: "123", output, source: {} }), errorCode("OUTPUT_EXISTS"));
    assert.equal(await readFile(output, "utf8"), "keep me");
    await rm(output);
    await assert.rejects(downloadChat({ vodId: "123", output, source: {
      video: async () => metadata, page: async () => {
        await writeFile(output, "other process");
        return { messages: [a], nextCursor: null };
      },
    } }), { code: "EEXIST" });
    assert.equal(await readFile(output, "utf8"), "other process");
  });

  it("locks concurrent writers to the same archive", async () => {
    const output = await outputPath();
    let release;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    const first = downloadChat({ vodId: "123", output, source: {
      video: async () => metadata, page: async () => { started(); await waiting; return { messages: [a], nextCursor: null }; },
    } });
    await ready;
    try {
      await assert.rejects(downloadChat({ vodId: "123", output, source: {} }), errorCode("ARCHIVE_LOCKED"));
    } finally {
      release();
      await first;
    }
  });

  it("recovers a lock left by a crashed downloader", async () => {
    const output = await outputPath();
    const directory = `${output}.archive`;
    await mkdir(directory, { recursive: true });
    // A finished child process gives us a PID that is no longer running.
    const finished = spawnSync(process.execPath, ["-e", ""]);
    assert.ok(finished.pid);
    await writeFile(
      join(directory, "lock"),
      JSON.stringify({ pid: finished.pid, host: hostname(), startedAt: new Date().toISOString() }),
    );
    const result = await downloadChat({ vodId: "123", output, source: {
      video: async () => metadata, page: async () => ({ messages: [a], nextCursor: null }),
    } });
    assert.equal(result.status, "complete");
    assert.equal(JSON.parse(await readFile(output, "utf8")).messages.length, 1);
  });

  it("does not discard corruption in a committed page", async () => {
    const output = await outputPath();
    await assert.rejects(downloadChat({ vodId: "123", output, source: {
      video: async () => metadata, page: async () => { throw new Error("offline"); },
    } }));
    const journal = join(`${output}.archive`, "pages.jsonl");
    await writeFile(journal, "corrupted committed page\n");
    await assert.rejects(downloadChat({ vodId: "123", output, source: {} }));
    assert.equal(await readFile(journal, "utf8"), "corrupted committed page\n");
  });
});

describe("chat CLI", () => {
  it("documents the separate chat command", () => {
    const output = execFileSync(process.execPath, ["dist/cli.js", "chat", "--help"], { encoding: "utf8" });
    assert.match(output, /--output/);
    assert.match(output, /does not download or require video/);
  });
  it("emits structured errors without starting network work for missing arguments", () => {
    const result = spawnSync(process.execPath, ["dist/cli.js", "chat", "123", "--json"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_ARGUMENT");
    assert.equal(result.stderr, "");
  });
});
