# Local VOD archive and replay

The primary use case is watching a finished broadcast that is hidden or no longer
listed on Twitch. Recoverable video and available chat are separate resources.
Neither one should be a prerequisite for archiving or replaying the other.

## Stage 1: chat archive engine

Implemented in `cli/src/chat/`:

- `twitch.ts`: GraphQL metadata, exact stream-to-VOD discovery, retry handling,
  cursor pagination and checked overlapping offset fallback.
- `model.ts`: normalized messages, boundary validation and structured errors.
- `archive.ts`: versioned manifest, page journal, deduplication, cancellation,
  recovery and streamed JSON export without replacing existing output files.
- `command.ts`: `twitch-m3u8 chat TARGET --output chat.json` and JSON automation.

The engine does not invoke TwitchDownloader, request a playback token or require
a playable video. TwitchDownloader was used as a protocol reference; this is an
independent implementation. Chat replay uses the internal
`VideoCommentsByOffsetOrCursor` operation, which can change independently of the
public Helix API.

GraphQL VOD metadata can expose the original stream ID and start epoch in its
seek-preview CDN path. This enables an exact match for accessible records; it is
not a way to list all deleted/hidden VODs. Missing metadata is not an automatic
reason to skip a chat request when the actual VOD ID is already known.

The current journal retains the cursor chain and normalized messages. The local
player builds a time index over the final JSON export; emote image assets remain
a future stage. The export
preserves `createdAt` as returned by Twitch; synchronization must use
`offsetSeconds`, since wall-clock timestamps are not always reliable.

## Stage 2: local replay

Implemented in `frontend/src/replay/` and used by the standalone `replay.html`
entry, which the `watch` command also serves. The page requires only the built
static assets, with no backend or account login. It accepts a local
browser-playable video and an optional exported chat JSON. Selection is explicit;
it makes no automatic claim that two files describe the same broadcast. Changing
video clears that association.

`archive.ts` scans UTF-8 JSON in 256 KB chunks, validates normalized messages using
the CLI's shared schema parser, and builds byte-range/time entries. `chat.worker.ts`
indexes and queries the file off the main thread. At most 80 messages are returned
for playback; message bodies are read on demand. Search scans in batches and caps
results at 100, with cancellation for changed queries. Current safety limits are
4 GB, two million entries and 1 MB per message/metadata block. The index is rebuilt
when a file is selected; it is not persisted yet.

The media element is the clock. Pause, seeks, playback-rate changes and buffering
determine chat progression. Seeking backwards reconstructs the message window,
and obsolete worker replies are ignored. Manual offset adjustment supports trimmed
videos; the last playback position is saved by file name, size and modification
time when browser storage is available.

Layout: large video, responsive chat sidebar, source chat metadata and theater
mode with Escape. Search results and message timestamps seek the video. Users can
scroll back, then resume following. The player uses a compact Twitch-like layout
with charcoal surfaces, restrained purple accents and a fixed chat panel.

`VideoControls.tsx` owns the custom controls and listens to native media events.
It supports play/pause, mute, volume, buffered progress, seeking, fullscreen and
keyboard shortcuts. Audio preferences survive a source or quality change.
The video element still owns decoding and time; no separate playback clock runs.

Chat layout has an explicit height chain, zero minimum sizes on flex/grid children,
and an absolutely positioned scrolling log inside a bounded window. Message content
cannot contribute to page height. Mobile uses a separately bounded chat panel.
The browser regression loads 2,000 messages with long paragraphs and verifies that
document and panel height stay constant as playback advances. It also checks
custom controls, search, manual scroll/follow, theater and mobile overflow.
Run `npm --prefix frontend run test:browser` after installing Chromium with
`npx --prefix frontend playwright install chromium`. CI runs this regression.

This stage plays local video files with native browser codecs. Image caching for emotes/badges, persistent
indexes and an adjustable sidebar are still pending. Missing chat, invalid JSON,
or unavailable images must not prevent local video playback. Badges currently
appear in username tooltips; emotes retain their text representation.

## Stage 3: npm launcher and streaming replay

Implemented in `cli/src/watch/`. The current user preference is streaming a
finished broadcast without first downloading the video. Permanent video archiving
is a later stage. Recovery uses the existing hidden M3U8 resolver and remaining
CDN media even when the public VOD page is absent.

`twitch-m3u8 watch [TARGET]` opens the bundled page on loopback. Node serves assets,
chat ranges and registered media behind a random capability path. Host/Origin
checks and a CDN allowlist restrict access. Manifests, nested URIs, keys and init
maps are rewritten; redirects are checked. Segment responses stream with
backpressure and disconnect cancellation. Playlist reads are limited to 8 MB.
Missing unmuted segments retry the matching muted resource without shifting time.
The previous media registry remains available during a source change, bounded to
two generations, so in-flight requests do not fail during reconnection.

The frontend uses hls.js with bounded forward/back buffers and native HLS fallback.
The local server permits data media for hls.js's empty WebVTT track. Video quality,
reconnection and playback position share the native video clock. The remote chat
reader uses the same worker/index as local files and verifies Content-Range.
Chat downloads run independently, use exact identity matching and reuse cached
exports or resumable journals. Missing chat does not stop video playback.

`npm pack` builds the CLI and `dist/player` before packing. Published users need
only Node and a browser. License notices for bundled dependencies are included.
The static preview remains a file player; remote streaming requires the npm
launcher.

## Validation

Automated protocol and filesystem tests cover exact identity matching, graph/API
failures, overlapping pagination, dense-second stalls, duplicates, deleted users,
interruption recovery, output collisions and concurrent writers. Run `npm test`
and `npm run typecheck` for the CLI.

Manual read-only API validation on 2026-09-05 matched
`video:xqc_321192454233_1788467377` to VOD `2864434763`. Cursor requests failed with
`IntegrityCheckFailed`, while same-second offset queries returned overlapping
pages. A complete available replay from VOD `2277656159` was saved with 509 unique
messages over 12 pages. This validates those examples, not universal recovery of
deleted or hidden chats.

A real interruption/resume check on xQc's VOD saved 305 messages in 10 pages,
then resumed to 580 messages in 20 pages. Both deliberate stops retained a
`partial` archive with `CANCELLED` recorded. The 34 automated CLI tests and
TypeScript checking passed; `npm pack --dry-run` includes the chat modules and
this plan, with no runtime dependencies added. No npm release was published.

The player adds 12 automated tests for index construction, UTF-8/chunk boundaries,
equal-time messages, backwards seeks, invalid archives, search, stale replies,
clock/offset behavior, chat failure independence and resource cleanup. The full
CLI suite also passes, along with the frontend lint, type and build checks.

Chromium validation exercised an actual local MP4, the real 509-message CLI
export, pause, 2x playback, backwards seeks, timestamp search, sync adjustment,
theater/Escape and a 390 px mobile viewport. The built page runs under the
player's Content-Security-Policy without browser errors or external requests.
Fonts are emitted as local files so small subsets do not violate `font-src 'self'`.

A second browser check indexed 100,000 messages in an 18.6 MB JSON in about 0.85
seconds on the development machine, rendered a maximum of 80 messages, searched
near the end and recovered from malformed input. This is a local observation,
not a performance guarantee. Reloading and reselecting the same video restored
the saved position. Emote image validation belongs to a following stage.

Stage 3 browser validation played a real 32,306-second recovered xQc VOD through
the Node media proxy, sought to 120 seconds, changed quality, reconnected while
retaining position and loaded chat through range requests. The browser fetched
16 media resources during this check, without downloading the full video, and
reported no HTTP failures or page errors after the fixes. Automated server tests
cover capability/Host/Origin checks, CDN/redirect validation, manifest rewriting,
muted fallback, byte ranges, generation isolation and video/chat independence.
