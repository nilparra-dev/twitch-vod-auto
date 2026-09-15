// Public programmatic API. Keep this surface small and documented:
// deep imports into dist/* are not supported.
export {
  buildFullVodPath,
  chooseFormat,
  parseInput,
  parseMasterManifest,
  resolveM3U8,
  ResolveError,
  VOD_DOMAINS,
} from "./resolver.js";
export { parseLiveChannel } from "./live/channel.js";
export { resolveLiveM3U8 } from "./live/resolver.js";
export type { LiveResolveResult } from "./live/resolver.js";
export type {
  ParsedInput,
  PlaylistFormat,
  ResolveOptions,
  ResolveResult,
  TrackerProvider,
} from "./types.js";
