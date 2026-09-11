import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { allowedMediaUrl, fetchMedia } from "../../dist/net/media.js";
import { MediaRegistry, byteRange } from "../../dist/watch/media.js";
import { startWatchServer, readChunkWithIdleTimeout } from "../../dist/watch/server.js";

const media = "https://vod-secure.twitch.tv.invalid/file.m3u8";
const source = "https://video-weaver.test.ttvnw.net/archive/index.m3u8";
const result = (id = "123") => ({
  kind: "public",
  source: "twitch",
  videoId: id,
  masterUrl: source,
  formats: [{ id: "720p60", url: source, height: 720, fps: 60 }],
});
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "watch-test-"));
  await writeFile(
    join(directory, "replay.html"),
    "<!doctype html><title>Replay</title>",
  );
  await writeFile(join(directory, "chat.json"), '{"messages":[]}');
  const server = await startWatchServer({
    assets: directory,
    autoChat: false,
    resolver: async () => result(),
    ...options,
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...server, directory, api: new URL("api/", server.url).href };
}
async function ready(server) {
  for (let i = 0; i < 100; i++) {
    const state = await (await fetch(server.api + "session")).json();
    if (state.state === "ready") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Session did not resolve");
}
test("media allowlist rejects arbitrary hosts, credentials, ports and schemes", () => {
  assert.equal(allowedMediaUrl(source).protocol, "https:");
  for (const url of [
    media,
    "http://127.0.0.1/secret",
    "file:///etc/passwd",
    "https://evil.test/a",
    "https://a.ttvnw.net.evil.test/a",
    "https://user:pass@a.ttvnw.net/a",
    "https://a.ttvnw.net:8080/a",
  ]) {
    assert.throws(() => allowedMediaUrl(url));
  }
});
test("playlist rewriting registers segments, keys, init maps and child playlists", () => {
  const registry = new MediaRegistry("/secret/");
  const rewritten = registry.rewrite(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\nchunk.ts?token=abc\n',
    source,
  );
  assert.ok(!rewritten.includes("token=abc"));
  assert.equal(registry.resources.size, 4);
  assert.equal(
    [...registry.resources.values()].filter((r) => r.manifest).length,
    1,
  );
  assert.ok(rewritten.includes('URI="/secret/media/'));
  assert.throws(() =>
    registry.rewrite("#EXTM3U\nhttp://127.0.0.1/admin", source),
  );
  assert.throws(() => registry.rewrite("<html>blocked</html>", source));
  const next = new MediaRegistry("/secret/");
  assert.notEqual(
    next.register(source),
    registry.register(source),
    "reconnect gets a new URL even for unsigned playlists",
  );
});
test("redirects are validated before following and Range is preserved", async () => {
  const calls = [];
  await assert.rejects(
    fetchMedia(source, {
      signal: new AbortController().signal,
      range: "bytes=1-3",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      },
    }),
    /outside Twitch/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Range, "bytes=1-3");
  let count = 0;
  const response = await fetchMedia(source, {
    signal: new AbortController().signal,
    fetch: async () =>
      ++count === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "next.m3u8" },
          })
        : new Response("ok"),
  });
  assert.equal(await response.text(), "ok");
  assert.equal(count, 2);
});
test("missing unmuted segments fall back to the matching muted segment", async () => {
  const calls = [];
  const response = await fetchMedia(source.replace("index.m3u8", "0-unmuted.ts?token=abc"), {
    signal: new AbortController().signal,
    fetch: async url => { calls.push(url); return calls.length === 1 ? new Response(null, {status:403}) : new Response("muted-video"); },
  });
  assert.equal(await response.text(), "muted-video");
  assert.match(calls[1], /0-muted\.ts\?token=abc$/);
});
test("local byte ranges support suffix, open end, clamp and reject invalid requests", () => {
  assert.deepEqual(byteRange("bytes=3-5", 10), { start: 3, end: 5 });
  assert.deepEqual(byteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange("bytes=8-", 10), { start: 8, end: 9 });
  assert.deepEqual(byteRange("bytes=0-100", 10), { start: 0, end: 9 });
  assert.equal(byteRange(undefined, 10), null);
  for (const range of [
    "bytes=-",
    "bytes=-0",
    "bytes=11-",
    "bytes=4-2",
    "bytes=0-1,3-4",
  ])
    assert.throws(() => byteRange(range, 10));
});
test("server requires its capability path, expected Host and same-origin writes", async (t) => {
  const server = await fixture(t);
  assert.equal((await fetch(server.origin)).status, 404);
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal((await fetch(server.url + "missing.js")).status, 404);
  const wrongHost = await new Promise((resolve, reject) => {
    get(server.url, { headers: { Host: "evil.test" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal(
    (
      await fetch(server.api + "session", {
        headers: { Origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(server.api + "resolve", {
        method: "POST",
        body: '{"input":"123"}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(server.api + "resolve", {
        method: "POST",
        headers: { Origin: server.origin },
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(server.api + "resolve", {
        method: "POST",
        headers: { Origin: server.origin },
        body: JSON.stringify({ input: "" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(server.url + "media/https://evil.test")).status,
    404,
  );
  assert.equal(
    (
      await fetch(server.api + "resolve", {
        method: "POST",
        headers: { Origin: server.origin },
        body: JSON.stringify({ input: "123" }),
      })
    ).status,
    202,
  );
  assert.equal((await ready(server)).input, "123");
});
test("an idle media body aborts instead of hanging", async () => {
  const abort = new AbortController();
  const stream = new ReadableStream({
    start(controller) {
      abort.signal.addEventListener("abort", () =>
        controller.error(abort.signal.reason),
      );
    },
  });
  const reader = stream.getReader();
  await assert.rejects(readChunkWithIdleTimeout(reader, 10, abort));
  assert.equal(abort.signal.aborted, true);
});
test("maps malformed requests to 400 and blocks encoded traversal", async (t) => {
  const server = await fixture(t);
  for (const body of ["null", "[]", '{"input":123}', '{"input":["x"]}']) {
    const response = await fetch(server.api + "resolve", {
      method: "POST",
      headers: { Origin: server.origin },
      body,
    });
    assert.equal(response.status, 400, `body ${body} should be a client error`);
  }
  for (const route of ["%2e%2e%2fserver.js", "..%2fserver.js"]) {
    const response = await fetch(new URL(route, server.url));
    assert.equal(response.status, 404, `route ${route} should not escape the asset root`);
  }
  for (const route of ["%zz", "%E0%A4%A"]) {
    const response = await fetch(new URL(route, server.url));
    assert.equal(response.status, 400, `route ${route} should be a bad request`);
  }
  // A legitimate file whose name starts with dots must still be served.
  await writeFile(join(server.directory, "..config.txt"), "ok");
  const dots = await fetch(new URL("..config.txt", server.url));
  assert.equal(dots.status, 200);
  assert.equal(await dots.text(), "ok");
});
test("media proxy rewrites manifests and relays segment byte ranges", async (t) => {
  const calls = [];
  const server = await fixture(t, {
    input: "123",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return url.endsWith(".m3u8")
        ? new Response("#EXTM3U\n#EXTINF:10,\n0.ts\n#EXT-X-ENDLIST\n")
        : new Response("abc", {
            status: 206,
            headers: {
              "content-range": "bytes 1-3/10",
              "content-length": "3",
              "content-type": "video/mp2t",
            },
          });
    },
  });
  const session = await ready(server);
  const playlist = await (
    await fetch(new URL(session.formats[0].url, server.origin))
  ).text();
  const segment = playlist.split("\n").find((line) => line.startsWith("/"));
  const response = await fetch(new URL(segment, server.origin), {
    headers: { Range: "bytes=1-3" },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 1-3/10");
  assert.equal(await response.text(), "abc");
  assert.equal(calls[1].init.headers.Range, "bytes=1-3");
});
test("stale resolver results cannot replace a newer broadcast", async (t) => {
  let finish;
  const server = await fixture(t, {
    input: "old",
    resolver: async (input) =>
      input === "old"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : result(input),
  });
  await fetch(server.api + "resolve", {
    method: "POST",
    headers: { Origin: server.origin },
    body: JSON.stringify({ input: "new" }),
  });
  await ready(server);
  finish(result("old"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const state = await (await fetch(server.api + "session")).json();
  assert.equal(state.input, "new");
  assert.equal(state.title, "Twitch VOD new");
});
test("explicit chat is served by revision and byte range independently of media", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "watch-chat-"));
  const chat = join(directory, "chat.json");
  await writeFile(chat, "0123456789");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await fixture(t, { input: "123", chatFile: chat });
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(server.api + "session")).json();
    if (state.chat.kind === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state.chat.kind, "ready");
  const response = await fetch(new URL(state.chat.url, server.origin), {
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "2345");
  assert.equal((await fetch(server.api + "chat?revision=999")).status, 404);
});
test("unavailable chat does not turn a playable video into an error", async (t) => {
  const server = await fixture(t, {
    input: "123",
    chatFile: join(tmpdir(), "missing-chat-for-watch-test.json"),
  });
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(server.api + "session")).json();
    if (state.chat.kind === "unavailable") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state.state, "ready");
  assert.equal(state.chat.kind, "unavailable");
});
