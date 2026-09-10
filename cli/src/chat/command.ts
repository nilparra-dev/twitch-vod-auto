import { stderr, stdout } from "node:process";
import { downloadChat } from "./archive.js";
import { ChatError } from "./model.js";
import { TwitchChatClient } from "./twitch.js";

export const CHAT_HELP = `Download the available chat replay of a finished VOD.

Usage:
  twitch-m3u8 chat <URL|ID|video:...> --output <chat.json> [--channel CHANNEL] [--json]

Examples:
  twitch-m3u8 chat https://www.twitch.tv/videos/2434567890 -o downloads/chat.json
  twitch-m3u8 chat video:xqc_321192454233_1788467377 -o downloads/chat.json

Options:
  -o, --output <file.json>  Required. Existing output files are never overwritten
  --channel <channel>      Channel for a bare stream ID
  --json                   Print a machine-readable completion or error result
  -h, --help               Show this help

Pages are saved in <file.json>.archive; repeat the command to resume.
Hidden streams require an exact accessible VOD match. Recoverable video does
not imply recoverable chat. This command does not download or require video.
An empty replay is reported as empty, not proof that the original chat was empty.`;

export async function chatCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(`${CHAT_HELP}\n`);
    return;
  }
  let input: string | undefined;
  let output: string | undefined;
  let channel: string | undefined;
  const json = args.includes("--json");
  const controller = new AbortController();
  const cancel = () => controller.abort(new ChatError("CANCELLED", "Chat download interrupted. Repeat the command to resume."));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (!arg || arg === "--json") continue;
      if (arg === "--output" || arg === "-o" || arg === "--channel") {
        const value = args[++index];
        if (!value || value.startsWith("-")) throw new ChatError("INVALID_ARGUMENT", `${arg} requires a value.`);
        if (arg === "--channel") channel = value;
        else output = value;
      } else if (arg.startsWith("-")) {
        throw new ChatError("INVALID_ARGUMENT", `Unknown chat option: ${arg}`);
      } else if (input === undefined) input = arg;
      else throw new ChatError("INVALID_ARGUMENT", `Unexpected argument: ${arg}`);
    }
    if (!input || !output) throw new ChatError("INVALID_ARGUMENT", "Provide a VOD or stream target and --output chat.json. Run chat --help for examples.");
    const source = new TwitchChatClient({ signal: controller.signal });
    const vodId = await source.resolve(input, channel);
    if (!json) stderr.write(`Downloading available chat for VOD ${vodId}...\n`);
    let lastProgress = 0;
    const result = await downloadChat({
      vodId, output, source, signal: controller.signal,
      onProgress: ({ messages, offsetSeconds }) => {
        if (json || Date.now() - lastProgress < 2000) return;
        lastProgress = Date.now();
        stderr.write(`${messages} messages saved; replay position ${Math.floor(offsetSeconds)}s\n`);
      },
    });
    if (json) stdout.write(`${JSON.stringify({ ...result, output })}\n`);
    else stdout.write(result.status === "empty"
      ? `Twitch returned an empty replay. Saved ${output}; this does not prove the original chat was empty.\n`
      : `Saved ${result.messageCount} messages to ${output}\n`);
  } catch (error) {
    const code = error instanceof ChatError ? error.code : "ERROR";
    const message = error instanceof Error ? error.message : String(error);
    process.exitCode = controller.signal.aborted ? 130 : 1;
    if (json) stdout.write(`${JSON.stringify({ status: "error", error: { code, message } })}\n`);
    else stderr.write(`Error [${code}]: ${message}\n`);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
