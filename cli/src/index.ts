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
export type {
  ParsedInput,
  PlaylistFormat,
  ResolveOptions,
  ResolveResult,
  TrackerProvider,
} from "./types.js";
