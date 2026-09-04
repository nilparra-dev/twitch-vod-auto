#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stdin, stderr, stdout } from "node:process";

import { chooseFormat, parseInput, ResolveError, resolveM3U8 } from "./resolver.js";

function readPackageVersion(): string {
  const metadata: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (typeof metadata === "object" && metadata !== null && "version" in metadata && typeof metadata.version === "string") {
    return metadata.version;
  }
  throw new Error("package.json does not contain a valid version");
}

const VERSION = readPackageVersion();
const PLAYERS = new Set(["vlc", "mpv", "iina", "potplayer"]);

interface CliOptions {
  input?: string;
  channel?: string;
  quality: string;
  all: boolean;
  json: boolean;
  copy: boolean;
  open: boolean;
  player?: string;
}

function help(): string {
  return `twitch-m3u8 ${VERSION}

Resolve public and hidden Twitch VODs to M3U8 URLs.

Usage:
  twitch-m3u8 <URL|ID|video:...> [options]

Examples:
  twitch-m3u8 2434567890
  twitch-m3u8 51582913581 --channel xqc
  twitch-m3u8 "https://twitchtracker.com/xqc/streams/51582913581"
  twitch-m3u8 "video:xqc_51582913581_1721686515" --open vlc

Options:
  -q, --quality <quality>  Select a quality; defaults to best
  --channel <channel>      Channel for a hidden stream ID
  --all                    Print every available quality
  --json                   Print structured JSON
  --copy                   Copy the selected URL to the clipboard
  --open [player]          Open VLC, MPV, IINA, or PotPlayer
  -h, --help               Show this help
  -v, --version            Show the version`;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new ResolveError(`${option} requires a value.`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { quality: "best", all: false, json: false, copy: false, open: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") {
      stdout.write(`${help()}\n`);
      process.exit(0);
    }
    if (arg === "-v" || arg === "--version") {
      stdout.write(`${VERSION}\n`);
      process.exit(0);
    }
    if (arg === "-q" || arg === "--quality") {
      options.quality = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--channel") {
      options.channel = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--copy") {
      options.copy = true;
    } else if (arg === "--open") {
      options.open = true;
      const possiblePlayer = args[index + 1]?.toLowerCase();
      if (possiblePlayer && PLAYERS.has(possiblePlayer)) {
        options.player = possiblePlayer;
        index += 1;
      }
    } else if (arg.startsWith("-")) {
      throw new ResolveError(`Unknown option: ${arg}`);
    } else if (!options.input) {
      options.input = arg;
    } else {
      throw new ResolveError(`Unexpected argument: ${arg}`);
    }
  }
  return options;
}

async function askInput(options: CliOptions): Promise<CliOptions> {
  if (options.input) return options;
  if (!stdin.isTTY) throw new ResolveError("Missing URL or ID. Run --help for examples.");
  const prompt = createInterface({ input: stdin, output: stderr });
  const input = (await prompt.question("Paste a URL, ID, or video:... target\n> ")).trim();
  prompt.close();
  if (!input) throw new ResolveError("No input was provided.");
  return { ...options, input };
}

async function askForMissingChannel(options: CliOptions): Promise<CliOptions> {
  if (!options.input || options.channel || parseInput(options.input).kind !== "stream-id" || !stdin.isTTY) {
    return options;
  }
  const prompt = createInterface({ input: stdin, output: stderr });
  const channel = (await prompt.question("Channel for this hidden stream:\n> ")).trim();
  prompt.close();
  if (!channel) throw new ResolveError("A channel is required to resolve a hidden stream ID.");
  return { ...options, channel };
}

function commandExists(command: string): boolean {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(lookup, [command], { stdio: "ignore" }).status === 0;
}

function openPlayer(url: string, requested?: string): void {
  let command: string | undefined;
  let args = [url];

  if (process.platform === "darwin") {
    const app = requested === "mpv" ? "mpv" : "VLC";
    command = "open";
    args = ["-a", app, url];
  } else if (process.platform === "win32") {
    const candidates = requested
      ? [requested]
      : [
          "vlc",
          join(process.env.ProgramFiles ?? "C:\\Program Files", "VideoLAN", "VLC", "vlc.exe"),
          join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "VideoLAN", "VLC", "vlc.exe"),
          "mpv",
        ];
    command = candidates.find((candidate) => existsSync(candidate) || commandExists(candidate));
  } else {
    const candidates = requested ? [requested] : ["vlc", "mpv"];
    command = candidates.find(commandExists);
  }

  if (!command) throw new ResolveError("VLC or MPV was not found. Install a player or copy the URL with --copy.");
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function copyToClipboard(value: string): void {
  const commands: ReadonlyArray<readonly [string, string[]]> =
    process.platform === "win32"
      ? [["clip", []]]
      : process.platform === "darwin"
        ? [["pbcopy", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { input: value, encoding: "utf8" });
    if (result.status === 0) return;
  }
  throw new ResolveError("The clipboard is not available on this system.");
}

async function main(): Promise<void> {
  const options = await askForMissingChannel(await askInput(parseArgs(process.argv.slice(2))));
  if (!options.input) throw new ResolveError("Missing URL or ID.");

  if (stderr.isTTY) stderr.write("Searching Twitch playlists...\n");
  const resolveOptions = options.channel ? { channel: options.channel } : {};
  const result = await resolveM3U8(options.input, resolveOptions);
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
    openPlayer(selected.url, options.player);
    if (stderr.isTTY) stderr.write("Player opened.\n");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
