# Security

## Supported usage

The CLI runs locally. It sends requests only to Twitch playback services,
Twitch VOD CDN domains, tracker sites, and Twitch's chat GraphQL endpoint when
you archive a chat replay. It does not require account cookies or OAuth
credentials.

The `watch` command starts a local player server. That server binds to
`127.0.0.1`, uses a random capability path, checks Host and Origin, only
proxies media URLs on Twitch's CDN allowlist, and never exposes playback
credentials to the browser. Do not expose it to a network.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that exposes credentials or
allows remote code execution. Use GitHub's private security advisory feature
for this repository instead.

Include the affected version, operating system, reproduction steps, impact,
and any suggested mitigation. Remove playback tokens, cookies, local paths,
and personal information from logs.

## Secrets

These files are ignored by Git and must remain private:

- `.env`
- `client_secret*.json`
- exported browser cookies

Public Twitch playback URLs can contain short-lived signed tokens. Treat them
as temporary credentials and avoid posting them in issues.
