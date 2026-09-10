import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve, extname, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { chooseFormat, resolveM3U8 } from "../resolver.js";
import { downloadChat } from "../chat/archive.js";
import { TwitchChatClient } from "../chat/twitch.js";
import { record, string } from "../chat/model.js";
import { byteRange, fetchMedia, MediaRegistry } from "./media.js";
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
}
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
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
async function fileResponse(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
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
  await stat(join(assets, "replay.html")).catch(() => {
    throw new Error(
      "The bundled player is missing. From a checkout, run npm run build:package.",
    );
  });
  const prefix = `/${randomBytes(24).toString("hex")}/`;
  let registry = new MediaRegistry(prefix);
  let previousRegistry: MediaRegistry | null = null;
  let origin = "";
  let chatPath: string | null = null;
  let generation = 0;
  let closed = false;
  let controller = new AbortController();
  let chatTask: Promise<void> = Promise.resolve();
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
      const result = await resolver(input, {
        signal,
        ...(channel ? { channel } : {}),
        ...(options.timestampWindow !== undefined ? { timestampWindow: options.timestampWindow } : {}),
      });
      if (id !== generation || closed) return;
      previousRegistry = registry;
      registry = new MediaRegistry(prefix);
      const selected = chooseFormat(result.formats, options.quality ?? "best");
      session = {
        ...session,
        state: "ready",
        title:
          result.kind === "hidden"
            ? `${result.channel} · ${new Date(result.startedAt).toLocaleDateString("en-GB")}`
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
      if (options.autoChat !== false || options.chatFile) {
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
              : "Could not recover this VOD.",
        };
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
          json(response, 400, { error: "Enter a Twitch VOD or tracker URL." });
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
        const upstream = await fetchMedia(resource.url, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(request.headers.range ? { range: request.headers.range } : {}),
        });
        if (!upstream.ok) {
          await upstream.body?.cancel();
          json(response, upstream.status, {
            error: `Media unavailable (HTTP ${upstream.status}). Try reconnecting.`,
          });
          return;
        }
        if (resource.manifest) {
          const text = await readPlaylist(upstream);
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
            const chunk = await reader.read();
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
      if (local.startsWith("..") || isAbsolute(local)) {
        response.writeHead(404).end();
        return;
      }
      await fileResponse(path, request, response);
    };
    void run().catch((error: unknown) => {
      if (response.headersSent) response.destroy();
      else
        json(response, error instanceof SyntaxError ? 400 : 502, {
          error:
            error instanceof Error ? error.message : "Player request failed.",
        });
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
