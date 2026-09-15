import { stdout, stderr } from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { copyToClipboard, openPlayer } from "../player-open.js";
import { chooseFormat, ResolveError } from "../resolver.js";
import { parseLiveChannel } from "./channel.js";
import { resolveLiveM3U8 } from "./resolver.js";
import { startWatchServer } from "../watch/server.js";

function help(): string {
  return `twitch-m3u8 live <channel|URL> [options]

Watch a channel that is live right now, or print its M3U8 URL.

Usage:
  twitch-m3u8 live xqc
  twitch-m3u8 live https://www.twitch.tv/xqc
  twitch-m3u8 live xqc --watch
  twitch-m3u8 live xqc --watch --with-ads
  twitch-m3u8 live xqc --open vlc

Options:
  --watch               Open the local player instead of printing the URL
  --with-ads            Disable the ad filter in the local player
  -q, --quality <name>  Select a quality; defaults to best
  --all                 Print every available quality
  --json                Print structured JSON
  --copy                Copy the selected URL to the clipboard
  --open [player]       Open VLC, MPV, IINA, or PotPlayer with the raw URL
  --no-open             With --watch, do not open a browser
  --port NUMBER         Local player port (default: a free port)
  -h, --help            Show this help

The printed or opened raw URL is Twitch's own stream and still contains ads.
Ad filtering only applies to the local player (--watch), which removes
server-stitched ad segments from the proxied playlists before they reach
the browser. Live chat is not supported yet; video still plays.`;
}

interface LiveOptions {
  input?: string;
  watch: boolean;
  withAds: boolean;
  quality: string;
  all: boolean;
  json: boolean;
  copy: boolean;
  open: boolean;
  player?: string;
  noOpen: boolean;
  port?: number;
}

const PLAYERS = new Set(["vlc", "mpv", "iina", "potplayer"]);

export async function liveCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(`${help()}\n`);
    return;
  }
  const options: LiveOptions = {
    watch: false,
    withAds: false,
    quality: "best",
    all: false,
    json: false,
    copy: false,
    open: false,
    noOpen: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--watch") options.watch = true;
    else if (arg === "--with-ads") options.withAds = true;
    else if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--copy") options.copy = true;
    else if (arg === "--open") {
      options.open = true;
      const possiblePlayer = args[index + 1]?.toLowerCase();
      if (possiblePlayer && PLAYERS.has(possiblePlayer)) {
        options.player = possiblePlayer;
        index += 1;
      }
    } else if (arg === "-q" || arg === "--quality") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new ResolveError(`${arg} requires a value.`);
      options.quality = value;
      index += 1;
    } else if (arg === "--port") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new ResolveError(`${arg} requires a value.`);
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new ResolveError("Port must be an integer between 0 and 65535.", "INVALID_ARGUMENT");
      }
      options.port = port;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new ResolveError(`Unknown live option: ${arg}`);
    } else if (!options.input) {
      options.input = arg;
    } else {
      throw new ResolveError(`Unexpected argument: ${arg}`);
    }
  }
  if (!options.input) throw new ResolveError("Missing channel. Run `twitch-m3u8 live --help` for examples.");
  if (!options.watch) {
    // Player-only flags are silently ignored without --watch; fail loudly so
    // a typo does not look like a working ad filter or custom port.
    if (options.withAds) throw new ResolveError("`--with-ads` only applies with `--watch`.");
    if (options.noOpen) throw new ResolveError("`--no-open` only applies with `--watch`.");
    if (options.port !== undefined) throw new ResolveError("`--port` only applies with `--watch`.");
  } else {
    if (options.all) throw new ResolveError("`--all` prints URLs without `--watch`. Drop `--watch` to list qualities.");
    if (options.json) throw new ResolveError("`--json` prints URLs without `--watch`. Drop `--watch` for JSON output.");
    if (options.copy) throw new ResolveError("`--copy` copies the URL without `--watch`. Drop `--watch` to copy.");
    if (options.open) throw new ResolveError("`--open` opens the raw URL without `--watch`. Drop `--watch` to open it.");
  }
  const channel = parseLiveChannel(options.input);

  if (!options.watch) {
    if (stderr.isTTY) stderr.write(`Checking if ${channel} is live...\n`);
    const result = await resolveLiveM3U8(channel);
    const selected = chooseFormat(result.formats, options.quality);
    if (options.json) {
      stdout.write(`${JSON.stringify({ ...result, selected }, null, 2)}\n`);
    } else if (options.all) {
      stdout.write(`${result.formats.map((format) => `${format.id}\t${format.url}`).join("\n")}\n`);
    } else {
      stdout.write(`${selected.url}\n`);
    }
    if (options.copy) {
      copyToClipboard(selected.url);
      if (stderr.isTTY) stderr.write("URL copied.\n");
    }
    if (options.open) {
      if (stderr.isTTY) {
        stderr.write("Note: the raw URL still contains ads. Use `live --watch` for the ad-filtered player.\n");
      }
      await openPlayer(selected.url, options.player);
      if (stderr.isTTY) stderr.write("Player opened.\n");
    }
    return;
  }

  const server = await startWatchServer({
    assets: fileURLToPath(new URL("../player/", import.meta.url)),
    mode: "live",
    liveAds: !options.withAds,
    input: channel,
    quality: options.quality,
    ...(options.port !== undefined ? { port: options.port } : {}),
  });
  stdout.write(`${server.url}\n`);
  stderr.write("Local live player is running. Keep this terminal open; Ctrl+C stops it.\n");
  if (!options.withAds) stderr.write("Ad filter is on. If a segment looks like content, it is kept.\n");
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (!options.noOpen) {
    const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const parameters = process.platform === "win32" ? ["url.dll,FileProtocolHandler", server.url] : [server.url];
    const child = spawn(command, parameters, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => stderr.write("Could not open the browser automatically. Open the printed URL.\n"));
    child.unref();
  }
}
