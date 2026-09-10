# VOD discovery and channel listing improvements

Status: implemented in the TypeScript CLI (September 2026). The Python pipeline
mirror remains pending.

Implemented: exact timestamp sources (TwiTracker, StreamerVitals, SullyGnome),
bounded timestamp window fallback, multi-quality domain probing with GET
fallback and alias domains, per-channel domain ordering, the `list` command
with `--url`/`--watch`/`--probe`, and structured error codes. Pending: the
Python mirror, the optional browser fallback for Cloudflare-protected
trackers, and storyboard-domain discovery.

This document analyses how the resolver finds Twitch VODs today, records
measurements taken against the live services, and proposes a discovery pipeline
that finds every VOD Twitch still stores. It also proposes a `list` command for
recent channel streams, including hidden ones.

## Current pipeline

The TypeScript CLI (`cli/src/resolver.ts`) resolves three kinds of input:

1. **Numeric VOD ID / `twitch.tv/videos/ID`** — GraphQL
   `videoPlaybackAccessToken`, then `https://usher.ttvnw.net/vod/{id}.m3u8`.
   This is the reliable path: metadata, token and manifest come from Twitch.
2. **Canonical `video:channel_streamId_timestamp`** — computes the hidden media
   path `sha1(path)[:20] + "_" + path`, then probes
   `{domain}/{path}/chunked/index-dvr.m3u8` with `HEAD` against 12 hard-coded
   CloudFront domains, in parallel. Formats are probed afterwards on the first
   matching domain.
3. **Tracker URL / bare stream ID** — obtains the stream start time from
   SullyGnome (`standardsearch` + paginated channel tables), then goes through
   path 2.

`cli/src/chat/twitch.ts` already knows how to map a stream ID to a VOD ID: it
scans `user.videos` and matches the stream ID and start time parsed from
`seekPreviewsURL`. This logic is only used for chat today.

The Python pipeline duplicates path 1 and 2 in `m3u8_resolver.py`, uses Helix in
`twitch_api.py`, and scrapes TwitchTracker/StreamsCharts in `monitor.py`.

## Measurements (September 2026)

### Domain behaviour

Collected 60 recent archive VODs across 12 channels and probed every hidden path
against the 12 configured domains plus five extra CloudFront domains and
`vod-secure`, `vod-metro`, `vod-pop-secure`.

- Only four distribution groups served all 60 VODs: `ds0h3roq6wcgc` +
  `d2nvs31859zcd8`, `d2vi6trrdongqn`, `d1m7jfoe9zdc1j` and `d3fi1amfgojobc`.
- `vod-secure`, `vod-metro` and `vod-pop-secure` served exactly the same paths
  as `ds0h3roq6wcgc`/`d2nvs31859zcd8` (aliases). They are useful redundancy but
  not extra coverage.
- The five extra CloudFront domains served zero paths.
- **The host of `seekPreviewsURL` equals the domain that serves the media in
  60 of 60 cases.** Public metadata reveals the correct domain without probing.
- The path SHA-1 does not predict the distribution.
- Distribution changes over time: recent VODs of `dralii` were on
  `d1m7jfoe9zdc1j`, VODs from a few days earlier on `d3stzm2eumvgb4`, which had
  served none of the 60 sampled paths from other channels. The full domain list
  must be kept as the final fallback.

### Timestamp precision is the real failure mode

The reported case `video:dralii_321352284122_1788986400` was **not deleted**:

- The channel's VODs do not appear in GraphQL (`user.videos` returns zero
  archive VODs), so they are hidden or restricted, but the media exists.
- The provided timestamp (`2026-09-09T20:40:00Z`) was wrong. The real hidden
  path uses `2026-09-09T20:41:21Z`, an offset of **81 seconds**.
- Exact probing with the corrected timestamp resolves Source, 720p60, 480p30,
  360p30, 160p30 and audio.
- A bounded window search (timestamp ±300 s over five active domains, 6010
  requests) found the path at +81 s. This validates a window fallback, but it is
  expensive and should be a last resort.
- All eight most recent `dralii` streams were recovered the same way once their
  exact start times were known.

### Tracker durations are estimates

The recovered `dralii` VOD has 817 segments, no missing indices and a measured
media duration of **2h19m26s** (`#EXTINF` sum, with `PROGRAM-DATE-TIME` proving
there are no wall-clock gaps). Tracker pages disagree because they sample the
live API every few minutes: TwitchTracker reports 2h25m, StreamerVitals 2h18m
and TwiTracker 2h15m. `list --probe` therefore measures the real media duration
from the resolved playlist instead of trusting the sampled estimate.

Trackers expose exact start times with seconds, which removes the need to
guess:

- **TwiTracker** stream pages embed `datetime="2026-09-09T20:41:21.000Z"` in the
  HTML and the URL contains the Twitch stream ID
  (`https://twitracker.com/streamers/dralii/streams/321352284122`). Plain
  `fetch` works.
- **StreamerVitals** channel stream list embeds one `dateTime` per row with
  seconds and links to stream pages. Plain `fetch` works. It documents its data
  as observed through the official Twitch API.
- **SullyGnome** returns exact `startDateTime` values when its API is reachable,
  but the channel-table endpoint is currently behind a Cloudflare challenge for
  automated requests.
- TwitchTracker page HTML contains exact `created_at` in its ECS meta, but the
  pages are Cloudflare-protected; a browser fallback is required there.

## Proposed pipeline

Resolve in a cascade, cheapest and most reliable source first:

1. **Known VOD ID**: current GraphQL token + usher path. On failure, if
   `video(id)` metadata still exposes `seekPreviewsURL`, derive the hidden path
   and probe that exact domain before giving up.
2. **Canonical or stream-id input → exact timestamp first**:
   - stream-id input: TwiTracker stream page (stream ID is in the URL);
   - canonical input: StreamerVitals channel list matched by nearest time
     around the provided timestamp, then TwiTracker if stream ID mapping is
     available;
   - SullyGnome when reachable (exact, direct stream ID match);
   - the provided timestamp stays as the anchor for all sources.
   Then probe the hidden path with the exact second.
3. **Bounded window fallback** when no exact timestamp source answers:
   probe `provided_timestamp ± window` seconds, using active domains first and
   then the full list. Suggested default: `--timestamp-window 300`, `0`
   disables. Stop at the first match; probe `chunked` only during the search,
   then probe all formats on the found domain.
4. **CDN probing upgrades for every hidden path**:
   - detect the domain with several representative qualities (`chunked`,
     `720p60`, `480p30`, `audio_only`) instead of only `chunked`;
   - accept `HEAD` 200/206, fall back to `GET` with `Range: bytes=0-0`;
   - add `vod-secure`, `vod-metro`, `vod-pop-secure` as extra fallbacks;
   - order candidate domains by domains recently observed for that channel,
     then the full list; cache observations locally with a TTL.
5. **GraphQL discovery as an accelerator**, not a gate: when the VOD is listed,
   use its metadata (`seekPreviewsURL` gives the exact path and domain) and
   usher for playback. When it is not listed (hidden), continue with 2-4.

### Diagnostics

Return structured reasons instead of one generic message, both in human output
and `--json`:

- channel exists and has N archived VODs (or zero);
- path found at timestamp T (report the offset from the provided timestamp);
- path not served by any domain (with the list of domains checked);
- timestamp window probed with no result;
- timestamp source unavailable (Cloudflare, timeout).

## New command: `twitch-m3u8 list`

List a channel's recent streams, including hidden ones, without credentials:

```
twitch-m3u8 list <channel> [--limit N] [--json] [--all] [--probe]
twitch-m3u8 list <channel> --target N | --url N | --watch N
twitch-m3u8 target <channel> [stream-id] [--timestamp SECONDS] [--json]
```

`list --target N` and the `target` command print the canonical
`video:channel_streamId_startTimestamp` target computed from the exact start
second; `--url` and `--watch` resolve it.

Data sources combined per stream:

- Twitch GraphQL archive VODs (VOD ID, title, duration, status, exact path and
  domain from `seekPreviewsURL`);
- tracker stream lists (StreamerVitals, TwiTracker, SullyGnome) with exact
  start times and Twitch stream IDs, which cover streams that Twitch does not
  list;
- `--probe` verifies CDN availability and reports the working hidden target.

This gives scripts a supported way to find stream IDs and exact timestamps
before resolving, and directly answers "list the channel's recent VODs".

## Work items

| Priority | Item | Main files |
| --- | --- | --- |
| P0 | Exact timestamp sources (TwiTracker, StreamerVitals, SullyGnome chain) | new `cli/src/twitch/timestamps.ts` |
| P0 | Canonical/stream-id resolution uses exact timestamp before probing | `cli/src/resolver.ts` |
| P0 | Bounded timestamp window fallback with early stop | `cli/src/resolver.ts`, `cli/src/cli.ts` |
| P0 | Multi-quality domain detection, GET fallback, alias domains | `cli/src/resolver.ts` |
| P1 | `list` command with tracker merge, `--json`, `--probe` | `cli/src/cli.ts`, new `cli/src/list.ts` |
| P1 | Cache observed domains per channel with TTL | new `cli/src/twitch/domains.ts` |
| P1 | Structured errors and `--json` diagnostics | `cli/src/resolver.ts`, `cli/src/cli.ts` |
| P2 | Storyboard-domain discovery when metadata is available | `cli/src/resolver.ts` |
| P2 | Mirror the pipeline in Python (domains, timestamps, probe) | `m3u8_resolver.py`, `monitor.py` |
| P2 | Opt-in integration test recovering a hidden VOD by timestamp | `cli/test/` |

## Risks and mitigations

- **Third-party tracker availability**: TwiTracker and StreamerVitals are not
  official. Treat them as best-effort sources, cache results, and keep the
  window search as a fallback that needs no third party.
- **Request volume**: window search is linear in seconds. Bound it, start with
  active domains, and stop at the first match.
- **GraphQL integrity checks**: the chat client already falls back to offset
  pagination. Keep queries small and versioned.
- **Cloudflare on trackers**: never make a tracker the only source.
- **Deleted media**: state clearly that missing media cannot be reconstructed;
  the tool reports what it checked.

## Test plan

- Unit: path hashing, multi-quality domain detection, timestamp window, exact
  timestamp parsing from tracker HTML fixtures, domain priority ordering.
- Fixtures: manifests, GraphQL responses and tracker HTML captured from live
  calls (TwiTracker, StreamerVitals).
- Opt-in integration: recover a known hidden VOD using a fixture or a live
  stream whose timestamp is off by a minute; assert the reported offset.
  Never part of `npm test` or CI by default.
