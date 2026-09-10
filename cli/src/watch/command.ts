import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DEFAULT_TIMESTAMP_WINDOW } from "../resolver.js";
import { startWatchServer, type ServerOptions } from "./server.js";

export async function watchCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout
      .write(`Watch a recovered Twitch VOD without downloading the video first.

Usage: twitch-m3u8 watch [URL|ID|video:...] [options]

  --channel CHANNEL   Channel for a hidden stream ID
  -q, --quality NAME  Initial quality (default: best)
  --chat FILE.json    Use an existing chat export instead of fetching replay
  --no-chat          Do not fetch chat automatically
  --no-open          Print the local URL without opening a browser
  --port NUMBER      Local port (default: a free port)
  --timestamp-window SECS  Seconds searched around an approximate timestamp
                           (default: ${DEFAULT_TIMESTAMP_WINDOW}; 0 disables)

Leave this process running while watching. Ctrl+C closes the local server.
Video is streamed from remaining Twitch CDN fragments. Deleted media cannot
be reconstructed, and chat availability is independent of video recovery.
`);
    return;
  }
  const options: ServerOptions = {
    assets: fileURLToPath(new URL("../player/", import.meta.url)),
  };
  let openBrowser = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--no-open") {
      openBrowser = false;
      continue;
    }
    if (arg === "--no-chat") {
      options.autoChat = false;
      continue;
    }
    if (["--channel", "--quality", "-q", "--chat", "--port", "--timestamp-window"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("-"))
        throw new Error(`${arg} requires a value.`);
      if (arg === "--channel") options.channel = value;
      else if (arg === "--chat") options.chatFile = value;
      else if (arg === "--port") {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          throw new Error("Port must be an integer between 0 and 65535.");
        options.port = port;
      } else if (arg === "--timestamp-window") {
        const window = Number(value);
        if (!Number.isInteger(window) || window < 0 || window > 900)
          throw new Error("Timestamp window must be an integer between 0 and 900.");
        options.timestampWindow = window;
      } else options.quality = value;
    } else if (arg.startsWith("-"))
      throw new Error(`Unknown watch option: ${arg}`);
    else if (!options.input) options.input = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  const server = await startWatchServer(options);
  process.stdout.write(`${server.url}\n`);
  process.stderr.write(
    "Local player is running. Keep this terminal open; Ctrl+C stops it.\n",
  );
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
  if (openBrowser) {
    const command =
      process.platform === "win32"
        ? "rundll32.exe"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    const parameters =
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", server.url]
        : [server.url];
    const child = spawn(command, parameters, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () =>
      process.stderr.write(
        "Could not open the browser automatically. Open the printed URL.\n",
      ),
    );
    child.unref();
  }
}
