import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve, extname, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { chooseFormat, ResolveError, resolveM3U8 } from "../resolver.js";
import { stripLiveAds } from "../live/ads.js";
import { resolveLiveM3U8 } from "../live/resolver.js";
import { downloadChat } from "../chat/archive.js";
import { TwitchChatClient } from "../chat/twitch.js";
import { ChatError, record, string } from "../chat/model.js";
import { fetchMedia } from "../net/media.js";
import { byteRange, MediaRegistry } from "./media.js";
import type { ResolveOptions, ResolveResult } from "../types.js";
import type { PlayerSession } from "./types.js";
export interface ServerOptions {
  assets: string;
  input?: string;
  channel?: string;
  quality?: string;
  chatFile?: string;
  autoChat?: boolean;
  cache?: string;
  port?: number;
  timestampWindow?: number;
  resolver?: (input: string, options: ResolveOptions) => Promise<ResolveResult>;
  fetch?: typeof fetch;
  /** "live" resolves channels that are broadcasting now and filters ads. */
  mode?: "vod" | "live";
  /** Strip stitched ad segments from live playlists. Defaults to true in live mode. */
  liveAds?: boolean;
}
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};
/** Time allowed to connect and receive response headers. */
const MEDIA_CONNECT_TIMEOUT_MS = 30_000;
/** Time allowed between body chunks before the upstream stream is cancelled. */
const MEDIA_IDLE_TIMEOUT_MS = 30_000;
const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};
async function readPlaylist(response: Response): Promise<string> {
  if (!response.body) throw new Error("Empty playlist.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("Playlist is too large.");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Read one body chunk, aborting `abort` when no data arrives within
 * `timeoutMs`. The caller has tied that controller's signal to the upstream
 * fetch, so aborting it rejects `reader.read()` with the abort reason.
 */
export async function readChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  abort: AbortController,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timer = setTimeout(
    () => abort.abort(new Error("Media stream stalled.")),
    timeoutMs,
  );
  try {
    return await reader.read();
  } finally {
    clearTimeout(timer);
  }
}
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  return header
    .split(",")
    .some((value) => value.trim() === "*" || normalize(value) === normalize(etag));
}

async function fileResponse(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  cache?: "revalidate",
): Promise<void> {
  const info = await stat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
  if (!info) {
    response.writeHead(404).end();
    return;
  }
  if (!info.isFile()) {
    response.writeHead(404).end();
    return;
  }
  // Player assets are content-addressed by the build and revalidated with an
  // ETag, so a reload inside a session transfers headers instead of bodies.
  // The capability path changes per session, which is why this is not
  // immutable caching across sessions.
  const etag =
    cache === "revalidate"
      ? `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
      : null;
  if (etag) {
    response.setHeader("Cache-Control", "private, no-cache");
    response.setHeader("ETag", etag);
    if (etagMatches(request.headers["if-none-match"], etag)) {
      response.writeHead(304).end();
      return;
    }
  }
  let range;
  try {
    range = byteRange(request.headers.range, info.size);
  } catch {
    response.writeHead(416, { "Content-Range": `bytes */${info.size}` }).end();
    return;
  }
  response.writeHead(range ? 206 : 200, {
    "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Length": range ? range.end - range.start + 1 : info.size,
    ...(range
      ? { "Content-Range": `bytes ${range.start}-${range.end}/${info.size}` }
      : {}),
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await pipeline(createReadStream(path, range ?? {}), response);
}

export async function startWatchServer(options: ServerOptions) {
  const assets = resolve(options.assets);
  await stat(join(assets, "replay.html")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error(
        "The bundled player is missing. From a checkout, run npm run build:package.",
      );
    throw error;
  });
  const prefix = `/${randomBytes(24).toString("hex")}/`;
  const liveMode = options.mode === "live";
  const filterLiveAds = liveMode && options.liveAds !== false;
  let registry = new MediaRegistry(prefix, liveMode ? { evictOldest: true } : {});
  let previousRegistry: MediaRegistry | null = null;
  let origin = "";
  let chatPath: string | null = null;
  let generation = 0;
  let closed = false;
  let controller = new AbortController();
  let chatTask: Promise<void> = Promise.resolve();
  /** Normalized live channel of the current session, for token refresh. */
  let liveChannel: string | null = null;
  let liveRefreshAt = 0;
  let liveRefreshTask: Promise<void> | null = null;
  let session: PlayerSession = {
    revision: 0,
    input: "",
    state: "idle",
    error: null,
    title: "",
    source: null,
    formats: [],
    chat: { kind: "idle" },
  };
  const resolver = options.resolver ?? resolveM3U8;
  /**
   * Resolve one session input. A custom resolver always wins so tests can
   * inject transports; otherwise live mode uses the live token flow and VOD
   * mode uses the default resolver. The caller-provided fetch is forwarded
   * in every path so staged servers control the transport.
   */
  async function resolveForSession(input: string, channel: string | undefined, signal: AbortSignal): Promise<ResolveResult> {
    if (options.resolver) {
      return resolver(input, {
        signal,
        ...(channel ? { channel } : {}),
        ...(options.timestampWindow !== undefined ? { timestampWindow: options.timestampWindow } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    }
    if (liveMode) {
      return resolveLiveM3U8(channel ?? input, {
        signal,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    }
    return resolver(input, {
      signal,
      ...(channel ? { channel } : {}),
      ...(options.timestampWindow !== undefined ? { timestampWindow: options.timestampWindow } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  async function prepareChat(
    id: number,
    input: string,
    result: ResolveResult,
    signal: AbortSignal,
  ) {
    if (signal.aborted || id !== generation) return;
    try {
      let path: string;
      if (options.chatFile) path = resolve(options.chatFile);
      else {
        const source = new TwitchChatClient({ signal });
        const vodId =
          result.kind === "public"
            ? result.videoId
            : await source.resolve(input, result.channel);
        const cache =
          options.cache ?? join(homedir(), ".cache", "twitch-vod-m3u8", "chat");
        await mkdir(cache, { recursive: true });
        path = join(
          cache,
          `${createHash("sha256").update(vodId).digest("hex")}.json`,
        );
        let exists = true;
        try {
          await stat(path);
        } catch {
          exists = false;
        }
        if (!exists)
          await downloadChat({
            vodId,
            output: path,
            source,
            signal,
            onProgress: ({ messages }) => {
              if (id === generation)
                session.chat = { kind: "downloading", messages };
            },
          });
      }
      const info = await stat(path);
      if (!info.isFile() || info.size > 4 * 1024 ** 3)
        throw new Error("The chat file is not supported.");
      if (id !== generation || signal.aborted) return;
      chatPath = path;
      session.chat = {
        kind: "ready",
        url: `${prefix}api/chat?revision=${id}`,
        size: info.size,
        name: "chat.json",
      };
    } catch (error) {
      if (id === generation && !signal.aborted)
        session.chat = {
          kind: "unavailable",
          message:
            error instanceof Error
              ? error.message
              : "Chat is unavailable. You can still watch the video.",
        };
    }
  }
  async function load(input: string, channel?: string): Promise<void> {
    const id = ++generation;
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const previousChat = chatTask;
    chatPath = null;
    liveChannel = null;
    session = {
      revision: id,
      input,
      state: "resolving",
      error: null,
      title: input,
      source: null,
      formats: [],
      chat: { kind: "idle" },
    };
    try {
      const result = await resolveForSession(input, channel, signal);
      if (id !== generation || closed) return;
      previousRegistry = registry;
      registry = new MediaRegistry(prefix, liveMode ? { evictOldest: true } : {});
      const selected = chooseFormat(result.formats, options.quality ?? "best");
      if (result.kind === "live") liveChannel = result.channel;
      session = {
        ...session,
        state: "ready",
        title:
          result.kind === "hidden"
            ? `${result.channel} · ${new Date(result.startedAt).toLocaleDateString("en-GB")}`
            : result.kind === "live"
              ? `${result.channel} · live`
              : `Twitch VOD ${result.videoId}`,
        source: result.kind,
        formats: [
          selected,
          ...result.formats.filter((format) => format !== selected),
        ].map((format) => ({
          id: format.id,
          url: registry.register(format.url, true),
        })),
      };
      if (liveMode) {
        // V1 has no live chat: the replay archiver needs a finished VOD.
        session.chat = {
          kind: "unavailable",
          message: "Live chat is not supported yet. Video still plays.",
        };
      } else if (options.autoChat !== false || options.chatFile) {
        session.chat = { kind: "downloading", messages: 0 };
        chatTask = previousChat.then(() =>
          prepareChat(id, input, result, signal),
        );
      }
    } catch (error) {
      if (id === generation && !closed)
        session = {
          ...session,
          state: "error",
          error:
            error instanceof Error
              ? error.message
              : liveMode
                ? "Could not open this live channel."
                : "Could not recover this VOD.",
        };
    }
  }
  /**
   * Re-resolve the live channel after an upstream 401/403 (expired playback
   * token). Single-flight with a cooldown so a retry storm from several
   * qualities triggers at most one refresh; the polling player picks up the
   * new revision with fresh URLs on its next tick.
   *
   * Unlike load(), a transient refresh failure keeps the current ready
   * session and channel so the next 401/403 retries. Only a definitive
   * OFFLINE (stream ended) replaces the session with an error.
   */
  async function refreshLive(): Promise<void> {
    if (!liveMode || closed) return;
    const channel = liveChannel;
    if (!channel) return;
    const now = Date.now();
    if (liveRefreshTask) return liveRefreshTask;
    if (now - liveRefreshAt < 5_000) return;
    liveRefreshAt = now;
    const task = (async (): Promise<void> => {
      const signal = controller.signal;
      let result: ResolveResult;
      try {
        result = await resolveForSession(channel, undefined, signal);
      } catch (error) {
        if (signal.aborted || closed) return;
        if (error instanceof ResolveError && error.code === "OFFLINE") {
          const id = ++generation;
          liveChannel = null;
          session = {
            revision: id,
            input: channel,
            state: "error",
            error: error.message,
            title: channel,
            source: null,
            formats: [],
            chat: session.chat,
          };
        }
        return;
      }
      if (closed || signal.aborted || liveChannel !== channel) return;
      const id = ++generation;
      previousRegistry = registry;
      registry = new MediaRegistry(prefix, { evictOldest: true });
      const selected = chooseFormat(result.formats, options.quality ?? "best");
      liveChannel = result.kind === "live" ? result.channel : null;
      session = {
        revision: id,
        input: channel,
        state: "ready",
        error: null,
        title:
          result.kind === "hidden"
            ? `${result.channel} · ${new Date(result.startedAt).toLocaleDateString("en-GB")}`
            : result.kind === "live"
              ? `${result.channel} · live`
              : `Twitch VOD ${result.videoId}`,
        source: result.kind,
        formats: [
          selected,
          ...result.formats.filter((format) => format !== selected),
        ].map((format) => ({
          id: format.id,
          url: registry.register(format.url, true),
        })),
        chat: {
          kind: "unavailable",
          message: "Live chat is not supported yet. Video still plays.",
        },
      };
    })().catch(() => undefined);
    liveRefreshTask = task;
    try {
      await task;
    } finally {
      if (liveRefreshTask === task) liveRefreshTask = null;
    }
  }
  const server = createServer((request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    const run = async () => {
      if (
        request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin)
      ) {
        response.writeHead(403).end();
        return;
      }
      const url = new URL(request.url ?? "/", origin);
      if (!url.pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      const route = url.pathname.slice(prefix.length);
      if (request.method === "POST" && route === "api/resolve") {
        if (request.headers.origin !== origin) {
          response.writeHead(403).end();
          return;
        }
        let body = "";
        for await (const part of request) {
          body += String(part);
          if (body.length > 8192) {
            json(response, 413, { error: "Request is too large." });
            return;
          }
        }
        const payload = record(JSON.parse(body));
        const input = string(payload.input).trim();
        const channel =
          payload.channel === undefined
            ? options.channel
            : string(payload.channel).trim();
        if (!input || input.length > 2000) {
          json(response, 400, { error: liveMode ? "Enter a Twitch channel name or URL." : "Enter a Twitch VOD or tracker URL." });
          return;
        }
        void load(input, channel);
        json(response, 202, { accepted: true });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      if (route === "api/session") {
        json(response, 200, session);
        return;
      }
      if (route === "api/chat") {
        if (
          !chatPath ||
          url.searchParams.get("revision") !== String(session.revision)
        ) {
          response.writeHead(404).end();
          return;
        }
        await fileResponse(chatPath, request, response);
        return;
      }
      if (route.startsWith("media/")) {
        const currentRegistry = registry.resources.has(route.slice(6)) ? registry : previousRegistry ?? registry;
        const resource = currentRegistry.resources.get(route.slice(6));
        if (!resource) {
          response.writeHead(404).end();
          return;
        }
        if (
          request.headers.range &&
          !/^bytes=\d*-\d*$/.test(request.headers.range)
        ) {
          response.writeHead(416).end();
          return;
        }
        const abort = new AbortController();
        response.on("close", () => abort.abort());
        // The connect timeout covers the request and its headers only. The body
        // uses a per-chunk idle timeout below, so a slow segment is not killed
        // just because the whole transfer takes longer than the timeout.
        const connect = new AbortController();
        const connectTimer = setTimeout(
          () => connect.abort(new Error("Media connection timed out.")),
          MEDIA_CONNECT_TIMEOUT_MS,
        );
        let upstream: Response;
        try {
          upstream = await fetchMedia(resource.url, {
            signal: AbortSignal.any([abort.signal, connect.signal]),
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(request.headers.range ? { range: request.headers.range } : {}),
          });
        } finally {
          clearTimeout(connectTimer);
        }
        if (liveMode && (upstream.status === 401 || upstream.status === 403)) {
          await upstream.body?.cancel();
          void refreshLive();
          json(response, 502, {
            error: "The live source expired and is being refreshed. Wait a moment or reconnect.",
          });
          return;
        }
        if (!upstream.ok) {
          await upstream.body?.cancel();
          json(response, upstream.status, {
            error: `Media unavailable (HTTP ${upstream.status}). Try reconnecting.`,
          });
          return;
        }
        if (resource.manifest) {
          const playlistTimer = setTimeout(
            () => abort.abort(new Error("Playlist download timed out.")),
            MEDIA_CONNECT_TIMEOUT_MS,
          );
          let text: string;
          try {
            text = await readPlaylist(upstream);
          } finally {
            clearTimeout(playlistTimer);
          }
          if (filterLiveAds) {
            try {
              text = stripLiveAds(text).text;
            } catch {
              // Fail closed: serve the original playlist with ads rather than
              // breaking playback because the filter rejected it.
            }
          }
          response.writeHead(200, {
            "Content-Type": "application/vnd.apple.mpegurl",
          });
          response.end(
            currentRegistry.rewrite(text, upstream.url || resource.url),
          );
          return;
        }
        response.statusCode = upstream.status;
        response.setHeader(
          "Content-Type",
          upstream.headers.get("content-type") ?? "application/octet-stream",
        );
        for (const header of [
          "content-length",
          "content-range",
          "accept-ranges",
        ]) {
          const value = upstream.headers.get(header);
          if (value) response.setHeader(header, value);
        }
        if (request.method === "HEAD") {
          await upstream.body?.cancel();
          response.end();
          return;
        }
        if (!upstream.body) {
          response.end();
          return;
        }
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const chunk = await readChunkWithIdleTimeout(
              reader,
              MEDIA_IDLE_TIMEOUT_MS,
              abort,
            );
            if (chunk.done) break;
            if (!response.write(chunk.value))
              await once(response, "drain", { signal: abort.signal });
          }
          response.end();
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        return;
      }
      if (route.startsWith("api/")) {
        response.writeHead(404).end();
        return;
      }
      const path = resolve(
        assets,
        route ? decodeURIComponent(route) : "replay.html",
      );
      const local = relative(assets, path);
      if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
        response.writeHead(404).end();
        return;
      }
      await fileResponse(path, request, response, "revalidate");
    };
    void run().catch((error: unknown) => {
      if (response.headersSent) response.destroy();
      else {
        const clientError =
          error instanceof SyntaxError ||
          error instanceof URIError ||
          error instanceof ChatError;
        json(response, clientError ? 400 : 502, {
          error:
            error instanceof Error ? error.message : "Player request failed.",
        });
      }
    });
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      done();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not bind the local player.");
  origin = `http://127.0.0.1:${address.port}`;
  if (options.input) void load(options.input, options.channel);
  return {
    url: `${origin}${prefix}`,
    origin,
    close: async () => {
      closed = true;
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await chatTask;
    },
  };
}
