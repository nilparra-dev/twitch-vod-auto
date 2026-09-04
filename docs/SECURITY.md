# Security

## Supported usage

The CLI runs locally and sends requests only to Twitch playback services,
Twitch VOD CDN domains, and SullyGnome. It does not require account cookies or
OAuth credentials.

The optional dashboard should listen on `127.0.0.1` unless you have configured
authentication and understand the risks of exposing it to a network.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that exposes credentials or
allows remote code execution. Use GitHub's private security advisory feature
for this repository instead.

Include the affected version, operating system, reproduction steps, impact,
and any suggested mitigation. Remove playback tokens, cookies, local paths,
and personal information from logs.

## Secrets

The following files are ignored by Git and must remain private:

- `.env`
- `client_secret*.json`
- `youtube_credentials.pkl`
- browser cookies and exported cookie files

Public Twitch playback URLs can contain short-lived signed tokens. Treat them
as temporary credentials and avoid posting them in issues.
