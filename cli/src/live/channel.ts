import { ResolveError } from "../resolver.js";

/**
 * Normalize a live channel reference to a lowercase Twitch login.
 *
 * Accepted forms: a bare login (`xqc`), a `live:login` target, or a
 * `twitch.tv/login` URL. Full VOD, clip and category URLs are rejected so a
 * VOD is never mistaken for a live channel.
 */
export function parseLiveChannel(rawInput: string): string {
  const input = rawInput.trim();
  if (!input) throw new ResolveError("Enter a Twitch channel name or URL.", "INVALID_INPUT");

  const liveTarget = input.match(/^live:(?<channel>\w{1,25})$/i);
  if (liveTarget?.groups?.channel) return liveTarget.groups.channel.toLowerCase();

  // Accept the same single-segment channel URLs as parseInput, including an
  // optional trailing slash, query string or fragment. Multi-segment paths
  // (/videos, /clip, ...) are rejected below so a VOD is never live-resolved.
  const url = input.match(/^https?:\/\/(?:www\.)?twitch\.tv\/(?<path>[^?#]+?)\/?(?:[?#].*)?$/i);
  if (url?.groups?.path) {
    const segments = url.groups.path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 1 && /^\w{1,25}$/.test(segments[0] ?? "")) {
      return (segments[0] ?? "").toLowerCase();
    }
    throw new ResolveError(
      "That Twitch URL is not a live channel. Use twitch.tv/<channel> without /videos or /clip.",
      "INVALID_INPUT",
    );
  }

  if (/^\w{1,25}$/.test(input)) return input.toLowerCase();

  throw new ResolveError("Enter a Twitch channel name or a twitch.tv/<channel> URL.", "INVALID_INPUT");
}
