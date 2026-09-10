# Automation guide

The CLI is the simplest way to resolve a Twitch VOD without downloading it:

```bash
npx twitch-vod-m3u8@beta URL_OR_ID
```

## Script-friendly output

The default command writes one selected M3U8 URL to stdout. Progress and errors
go to stderr, which makes command substitution safe:

```bash
URL=$(npx twitch-vod-m3u8@beta 2434567890)
vlc "$URL"
```

Use JSON when another program needs metadata and every available quality:

```bash
npx twitch-vod-m3u8@beta URL_OR_ID --json
```

Use `--all` for tab-separated quality and URL pairs:

```bash
npx twitch-vod-m3u8@beta URL_OR_ID --all
```

## Hidden VODs

The most reliable input is a canonical target:

```text
video:channel_streamId_startTimestamp
```

Tracker URLs are more convenient because the resolver can look up the start
time through SullyGnome. That lookup depends on a third-party service and can
fail because of rate limits, anti-bot protection, or missing history.

For unattended jobs, store the canonical target once it has been resolved.
It contains everything needed to probe Twitch's VOD CDN again.

## Exit behavior

- Exit code `0`: a playlist was resolved.
- Exit code `1`: invalid input, unavailable media, network failure, or player
  launch failure.

Do not parse human-readable error text. Use `--json` for structured successful
results and the process exit code for failure handling.
