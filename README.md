# Twitch VOD M3U8

Resolve public and hidden Twitch VODs to playable M3U8 URLs. Paste a VOD ID,
a tracker URL, or a canonical `video:...` target. The tool finds the available
qualities and prints the URL without downloading the video.

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
-q, --quality <quality>  Select a quality; defaults to best
--channel <channel>      Channel for a hidden stream ID
--all                    Print every available quality
--json                   Print structured JSON
--copy                   Copy the selected URL to the clipboard
--open [player]          Open VLC, MPV, IINA, or PotPlayer
-h, --help               Show help
-v, --version            Show the version
```

The default output is a single URL, so it works well in scripts:

```bash
vlc "$(npx twitch-vod-m3u8@beta URL_OR_ID)"
```

Public Twitch manifest URLs contain short-lived playback credentials. Run the
resolver again if a public URL expires.

## Hidden VOD limits

The resolver follows the path calculation used by
[`twitch-dlp`](https://github.com/DmitryScaletta/twitch-dlp). A hidden VOD cannot
be recovered when Twitch no longer stores its media fragments. Common reasons
include:

- The retention period has ended.
- The broadcaster deleted the VOD manually.
- Past broadcasts were disabled for the channel.
- The channel is suspended.
- The recorded start time is wrong.

Tracker sites may also block automated requests. If a tracker URL fails, try a
canonical `video:...` target with the exact UTC start timestamp.

## Local dashboard

The repository still includes the original FastAPI and React dashboard. Its
**Watch VOD** page exposes the same resolver through a browser.

```bash
python -m pip install -e ".[dev]"
cd frontend
npm install
npm run build
cd ..

# Set local dashboard credentials, then start it.
set ADMIN_PASSWORD=change-me
set ALLOW_RANDOM_ADMIN_PASSWORD=true
python -m uvicorn dashboard:app --port 8080
```

Open `http://localhost:8080`.

## CLI development

```bash
npm install
npm test
npm run typecheck
npm run build
node dist/cli.js --help
```

The package has no runtime dependencies. `npm test` compiles the TypeScript
source and runs the resolver tests with Node's built-in test runner.

## Dashboard development

```bash
python -m pip install -e ".[dev]"
ruff check .
ruff format --check .
python -m pytest

cd frontend
npm ci
npm run lint
npm test
npm run build
```

## Responsible use

Only access content you own or are authorized to view. You are responsible for
following Twitch's terms and the laws that apply to you.

## License

[MIT](LICENSE)
