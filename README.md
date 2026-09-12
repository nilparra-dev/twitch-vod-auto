# Twitch VOD M3U8

Resolve public and hidden Twitch VODs to playable M3U8 URLs, list a channel's
recent streams (including hidden ones), archive chat replays, and stream
recovered video with synchronized chat in a local browser player. Paste a VOD
ID, a tracker URL, or a canonical `video:...` target. The resolver finds the
available qualities and prints the URL without downloading the video.

> This project is in beta. Twitch and third-party tracker changes may break
> resolution without warning.

## Quick start

Requires Node.js 22 or newer. No installation is needed.

```bash
npx twitch-vod-m3u8@beta 2434567890
```

Hidden stream ID with a channel:

```bash
npx twitch-vod-m3u8@beta 51582913581 --channel xqc
```

Tracker URL:

```bash
npx twitch-vod-m3u8@beta "https://twitchtracker.com/xqc/streams/51582913581"
```

Canonical hidden-VOD target:

```bash
npx twitch-vod-m3u8@beta "video:xqc_51582913581_1721686515"
```

Open the best quality in VLC:

```bash
npx twitch-vod-m3u8@beta URL_OR_ID --open vlc
```

Archive the available chat replay:

```bash
npx twitch-vod-m3u8@beta chat https://www.twitch.tv/videos/VOD_ID --output downloads/chat.json
```

Watch a recovered VOD with synchronized chat in a local player:

```bash
npx twitch-vod-m3u8@beta watch URL_OR_ID
```

Download a VOD as a single file:

```bash
npx twitch-vod-m3u8@beta download URL_OR_ID
```

List recent streams of a channel, including hidden ones, and open one directly:

```bash
npx twitch-vod-m3u8@beta list xqc
npx twitch-vod-m3u8@beta list xqc --watch 1
```

## Supported input

- A numeric public Twitch VOD ID.
- A `twitch.tv/videos/...` URL.
- A TwitchTracker stream URL.
- A Streams Charts stream URL.
- A SullyGnome stream URL.
- A canonical `video:channel_streamId_startTimestamp` target.

A hidden stream ID alone does not include its channel or exact start time.
Pass `--channel`, use a tracker URL, or provide the canonical target.

## CLI options

```text
-q, --quality <quality>      Select a quality; defaults to best
--channel <channel>          Channel for a hidden stream ID
--timestamp-window <secs>    Seconds searched around an approximate timestamp (default 120)
--all                        Print every available quality
--json                       Print structured JSON
--copy                       Copy the selected URL to the clipboard
--open [player]              Open VLC, MPV, IINA, or PotPlayer
-h, --help                   Show help
-v, --version                Show the version
```

The default output is a single URL, so it works well in scripts:

```bash
vlc "$(npx twitch-vod-m3u8@beta URL_OR_ID)"
```

Public Twitch manifest URLs contain short-lived playback credentials. Run the
resolver again if a public URL expires.

## Listing channel streams

`list` combines Twitch's public archive with tracker stream history that
includes the exact start second, so hidden or sub-only VODs are listed even
when Twitch does not show them:

```bash
npx twitch-vod-m3u8@beta list xqc
npx twitch-vod-m3u8@beta list xqc --probe
npx twitch-vod-m3u8@beta list xqc --target 1
npx twitch-vod-m3u8@beta list xqc --url 2 --quality 720p60
npx twitch-vod-m3u8@beta list xqc --watch 2
npx twitch-vod-m3u8@beta list xqc --limit 30 --json
```

Each row shows the start time in UTC, duration, stream ID, the sources that
found it, and the title. With a row number, `--target` prints the canonical
`video:...` target, `--url` prints the playable URL and `--watch` opens the
local player for that stream. The hidden target is computed automatically from
the exact stream ID and start second, so no manual timestamp is needed. `--all`
walks every public archive page. `--probe` checks media availability, reports
the serving domain and measures the exact media duration from the playlist;
without `--probe`, durations are tracker estimates. If a tracker or the Twitch
archive fails, the command prints the source error as a warning instead of
silently reporting "no streams".

Options:

```text
--limit <n>                 Rows to show (default 15, max 2000)
--all                       Walk every Twitch archive page
--probe                     Check media availability and show the domain
--target <n>                Print the canonical video: target for row n
--download <n>              Download stream n as a single file
--url <n>                   Print the playable URL for row n
--watch <n>                 Open the local player for row n
--no-open                   With --watch, do not open a browser
-q, --quality <quality>     Quality for --download/--url (default best)
--timestamp-window <secs>   Search window for approximate timestamps
--json                      Print structured JSON
```

### Canonical target

`target` computes the exact `video:channel_streamId_startTimestamp` target
without resolving media. It works even when Twitch does not list the VOD, as
long as a tracker knows the start second. `id` is an alias:

```bash
npx twitch-vod-m3u8@beta target xqc
npx twitch-vod-m3u8@beta target xqc STREAM_ID
npx twitch-vod-m3u8@beta target xqc STREAM_ID --timestamp 1788986481
```

Without a stream ID it uses the channel's most recent stream. The result can be
passed straight to the resolver, `watch`, or `--url`.

## Programmatic use

The package can also be imported as an ES module:

```js
import { chooseFormat, resolveM3U8 } from "twitch-vod-m3u8";

const result = await resolveM3U8("https://twitchtracker.com/xqc/streams/51582913581");
const selected = chooseFormat(result.formats, "720p60");

console.log(selected.url);
```

`parseInput`, `buildFullVodPath`, `parseMasterManifest`, `VOD_DOMAINS`,
`ResolveError` and the result types are exported too. `resolveM3U8` accepts
`{ channel, timeoutMs, timestampWindow, signal, fetch }` as an optional second
argument. Hidden results include a `timestamp` report with the requested and
actually used second, whether it was corrected, and which source provided it.
`ResolveError.code` distinguishes `NOT_FOUND`, `TIMESTAMP_UNAVAILABLE`,
`CHANNEL_REQUIRED` and the other failure modes.

## Hidden VOD limits

The resolver follows the path calculation used by
[`twitch-dlp`](https://github.com/DmitryScaletta/twitch-dlp). A hidden VOD cannot
be recovered when Twitch no longer stores its media fragments. Common reasons
include:

- The retention period has ended.
- The broadcaster deleted the VOD manually.
- Past broadcasts were disabled for the channel.
- The channel is suspended.
- The recorded start time is wrong beyond what the search window covers.

Tracker sites may also block automated requests. When exact sources are
unavailable, the resolver falls back to a bounded second-by-second search
around the provided timestamp (`--timestamp-window`, default 120). A canonical
`video:...` target therefore works with an approximate start time close to the
real one. Probe results are memoized per media URL for ten minutes within the
same process, so `list --probe` and repeated programmatic calls do not re-ask
the same missing paths; transient CDN failures are never cached.

## Downloading VODs

`download` saves the selected quality as a single file without external tools:

```bash
npx twitch-vod-m3u8@beta download 2434567890
npx twitch-vod-m3u8@beta download "video:xqc_51582913581_1721686515" -q 720p60 -o clip.ts
npx twitch-vod-m3u8@beta download 51582913581 --channel xqc
npx twitch-vod-m3u8@beta download 2434567890 --output-dir "D:\VODs"
npx twitch-vod-m3u8@beta list xqc --download 1
```

Segments are fetched in parallel and written in order, so an interrupted
download keeps a `.part` file and resumes when you run the same command again.
Some encoders leave frames with the MPEG-TS "no timestamp" sentinel, in the
PES header (PTS/DTS) or in the PCR; the downloader rewrites both in place,
because players such as VLC take the values literally and jump the media clock
to ~26.5 hours.
Output defaults to `downloads/<id>.ts` in the current directory; existing files
and partial downloads are never overwritten without `--force`. `-o` sets an
exact file path, while `--output-dir` sets only the folder and keeps the
generated name (`<id>.mp4` with `--remux`); the two options cannot be combined.
A file ending in `.mp4` or `--remux` converts to
MP4 with ffmpeg (`-c copy`, no re-encode, `+faststart`), checks the result
duration with ffprobe, and accepts `--ffmpeg-path <file>` or the
`TWITCH_VOD_M3U8_FFMPEG` environment variable; without ffmpeg the `.ts` file
plays in VLC, MPV and most editors. `--install-ffmpeg` downloads a pinned LGPL
static build from BtbN into `~/.cache/twitch-vod-m3u8/ffmpeg/`, verifies its
published SHA-256 and reuses it. macOS is not covered by the pinned matrix yet;
use Homebrew there or `--ffmpeg-path`.
`--engine ffmpeg` skips the concatenation: ffmpeg downloads the validated
playlist directly and stream-copies it, which avoids the per-segment boundary
artifacts of the native engine. It downloads sequentially (slower) and cannot
resume. Every segment URL and redirect must stay on
Twitch's media domains, and an oversized segment aborts instead of filling the
disk.

## Chat archiving

The bundled chat downloader archives the chat replay independently of video
playback or downloads:

```bash
npx twitch-vod-m3u8@beta chat https://www.twitch.tv/videos/VOD_ID --output downloads/chat.json
```

For a hidden stream, pass a canonical target or tracker URL:

```bash
npx twitch-vod-m3u8@beta chat "video:CHANNEL_STREAM_ID_START_TIMESTAMP" --output downloads/chat.json
npx twitch-vod-m3u8@beta chat STREAM_ID --channel CHANNEL --output downloads/chat.json
```

From a source checkout, replace `npx twitch-vod-m3u8@beta` with
`node dist/cli.js` after `npm run build`.

This command archives chat independently of video playback or downloads. It
looks for an exact stream ID/channel match in accessible GraphQL VOD metadata,
also checking the start timestamp for canonical targets. Discovery checks up to
2,000 channel VODs. It does not guess a VOD based on a nearby date, and cannot
enumerate every hidden or deleted VOD. If discovery fails but you know the real
VOD ID, use `https://www.twitch.tv/videos/ID` explicitly. A stream ID is not a VOD
ID. The existing numeric-input heuristic treats IDs longer than ten digits as
stream IDs; a Twitch video URL always means a VOD ID.

The downloader refuses VODs that Twitch reports as recording or processing. If
metadata has disappeared, it still tries the chat endpoint using the known VOD
ID. A recoverable M3U8 does not imply recoverable chat, and an inaccessible chat
does not prevent using the existing video resolver.

Messages, user colors, badge IDs, emote fragments, deleted-user messages and
VOD-relative timestamps are retained. The local player below can read these
exports. Emote image downloads are planned in
[the archive/player roadmap](https://github.com/nilparra-dev/twitch-vod-auto/blob/main/docs/ARCHIVE_PLAYER_PLAN.md).
The JSON format is our versioned format, not a TwitchDownloader-compatible export.

Downloads save committed pages in `downloads/chat.json.archive/pages.jsonl` and
a bounded resume checkpoint in `checkpoint.json`. Repeat the same command and
output path after a network failure or Ctrl+C to resume; the checkpoint lets a
large archive continue without re-reading committed pages. Keep the `.archive`
directory until you have a finished JSON. A truncated final journal line is
discarded on recovery; corrupt committed pages cause an error. Messages are
streamed by page and only recent message IDs are kept for deduplication, so data
that repeats far in the past fails as out of order instead of being silently
merged. Existing output files are never overwritten.

The archive uses an exclusive lock to prevent concurrent writers. A lock left by
a crashed process is detected by PID and hostname and recovered automatically; a
lock from another host, or from a live process, still blocks. Atomic JSON
publication uses a hard link on the output filesystem when available, and falls
back to an exclusive copy on filesystems without hard-link support.

Twitch's internal API may reject cursor requests. In that case the downloader
queries the last saved second again, verifies overlap, and deduplicates message
IDs. It never advances by one second to escape a crowded page: an unresolvable
overlap or pagination loop leaves a partial archive instead of silently skipping
messages. A saved cursor may also expire; failures remain resumable but recovery
depends on Twitch still serving the necessary history.

`manifest.json` reports `partial`, `complete`, `empty`, `unavailable`, or `failed`.
`complete` means the end of the **available replay** was reached, not proof that
every original live message still exists. An empty API response is explicitly
reported as `empty`. Null responses and GraphQL errors are not treated as empty
chat. `--json` emits a structured result or error for automation; diagnostics go
to stderr in the normal mode. Failure exits with code 1; cancellation exits 130.

## Browser player

The `watch` command bundles the player and its Node server in the npm package:

```bash
npx twitch-vod-m3u8@beta watch
npx twitch-vod-m3u8@beta watch "video:CHANNEL_STREAM_ID_START_TIMESTAMP"
```

The command opens a local web page. Paste a supported URL or target, or pass it
on the command line. Keep the terminal open while watching; Ctrl+C stops it.
Video loads from Twitch's remaining CDN fragments as needed. It does not require
a downloaded VOD, Python, FFmpeg, a dashboard account or a Twitch embed.

```bash
npx twitch-vod-m3u8@beta watch TARGET --quality 720p60
npx twitch-vod-m3u8@beta watch STREAM_ID --channel CHANNEL
npx twitch-vod-m3u8@beta watch TARGET --chat downloads/chat.json
npx twitch-vod-m3u8@beta watch TARGET --no-chat --no-open --port 5174
```

`--chat` explicitly pairs your export with the selected video. Otherwise the
launcher tries to recover chat using the exact VOD identity, independently of
playback. Completed chats and resumable journals are cached under
`~/.cache/twitch-vod-m3u8/chat/`. A failed chat download does not stop the video.
No full video is written to disk. Streaming still requires Internet access and
the CDN fragments to exist; it is not a permanent offline archive.

Choose quality, change speed or reconnect an expired source from the toolbar.
Quality changes and reconnection retain the saved playback position. When a
playlist references a missing `-unmuted.ts` segment, the server tries the matching
`-muted.ts` fragment. Missing fragments are reported; they are not silently skipped.

The server binds to `127.0.0.1`, uses a random session path, checks Host and Origin,
and only proxies registered Twitch media resources. It rewrites child playlists,
keys and initialization segments, validates redirects and supports byte ranges.
Media bodies stream with backpressure and cancellation; a stalled upstream is
aborted only when no data arrives, so slow segments are not cut off. Chat is read
by ranges. The browser receives local media URLs instead of Twitch playback
credentials.

To build an installable package, run `npm pack`. Its `prepack` step builds the CLI
and the standalone page. After installing that tarball, use `twitch-m3u8 watch`.
The published package includes the web assets and third-party license notices;
end users do not need the source checkout or frontend build tools.

Keyboard shortcuts work anywhere on the page: `K` play/pause, left and right
arrows seek 10 seconds, `M` mutes, `F` toggles fullscreen and `Escape` exits
theater mode. Shortcuts are ignored while typing in an input.

### Local file mode

The player is also a standalone static page that needs no server beyond the one
serving the files:

```bash
npm --prefix frontend install
npm --prefix frontend run build
npm --prefix frontend run preview -- --host 127.0.0.1 --port 5173
```

Open `http://127.0.0.1:5173/replay.html`. Choose a local video, then optionally
select the `chat.json` exported by the CLI. Both files stay in your browser and
are never uploaded. The preview server must stay running to serve the player
assets.

The player supports browser-playable video files, such as H.264/AAC MP4 or WebM.
Remote HLS streaming uses the npm `watch` server described above. Local M3U8
files are not supported. Unsupported codecs are reported without discarding the
chat.

Chat follows the media clock during playback, pause, buffering, seeks and speed
changes. Click a message timestamp to seek, search messages or users across the
archive, or adjust the chat offset for trimmed videos. A positive offset shows
later chat. Theater mode supports Escape; the last playback position is restored
when the same video file is selected again, if browser storage is available.

The compact player has custom play/pause, volume, seek, speed, theater and
fullscreen controls. Chat stays inside a bounded panel as messages arrive, with
manual scroll and a Follow replay button. On mobile it moves below the video.
The browser regression checks this with 2,000 messages and long paragraphs.

The video and chat are paired explicitly by your file selection; the selected
chat's VOD ID and title are shown for verification. Changing video clears the chat
association. Missing, malformed or partial chat does not prevent video playback.
Emotes are currently shown as text, with badge names available on the username's
tooltip. Image caching and permanent offline video archiving remain future work.

Large chat JSON files are scanned in a Web Worker. The index stores byte ranges
and timestamps, not the complete message bodies. Playback reads at most 80
messages into the rendered window; scrolling back pauses following until you
select Follow replay. Search scans the archive in order, with several range reads
in flight, and returns the first 100 matches. The current limits are 4 GB per
file, two million messages and 1 MB per message or metadata block. Select the
final `.json` export, not the internal `pages.jsonl` journal. A damaged or
unsupported archive produces a visible error.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
node dist/cli.js --help
```

The package has no runtime dependencies. `npm test` compiles the TypeScript
source and runs the resolver tests with Node's built-in test runner.
`npm run test:package` rebuilds the package, packs it without running lifecycle
scripts, installs the tarball into a temporary directory and checks the CLI, the
bundled player assets and the public API.

The player lives in `frontend/`:

```bash
npm --prefix frontend install
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run test:browser
```

`npm --prefix frontend run build` writes the standalone player to
`dist/player`, which `npm run build:package` also produces before packing. The
browser regression needs Chromium; install it once with
`npx --prefix frontend playwright install chromium`.

### Releasing

```bash
npm version prerelease --preid=beta
npm run build:package
npm run test:package
npm publish
npm dist-tag add twitch-vod-m3u8@<version> latest
```

`publishConfig` publishes to the `beta` tag by default, so
`npx twitch-vod-m3u8@beta` always tracks the newest prerelease. Move `latest`
explicitly when the default `npx twitch-vod-m3u8` install should point to the
new version; until there is a stable release, both channels can track the
newest beta.

## Responsible use

Only access content you own or are authorized to view. You are responsible for
following Twitch's terms and the laws that apply to you.

## License

[MIT](LICENSE)
