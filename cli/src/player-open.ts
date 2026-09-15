import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { ResolveError } from "./resolver.js";

function commandExists(command: string): boolean {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(lookup, [command], { stdio: "ignore" }).status === 0;
}

/** Open a media URL in an external player without blocking the CLI. */
export function openPlayer(url: string, requested?: string): Promise<void> {
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
  const playerCommand = command;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(playerCommand, args, { detached: true, stdio: "ignore" });
    // A missing or unexecutable player fails asynchronously; surface it instead
    // of crashing with an unhandled "error" event.
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Copy a URL to the system clipboard, trying each platform helper in turn. */
export function copyToClipboard(value: string): void {
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
