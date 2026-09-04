# YouTube OAuth troubleshooting

YouTube integration belongs to the optional legacy dashboard. The M3U8 CLI
does not need Google or Twitch API credentials.

## `403 access_denied`

If the Google OAuth consent screen is in testing mode, add the YouTube account
under **Google Cloud Console → OAuth consent screen → Audience → Test users**.
Also confirm that the project has the YouTube Data API v3 enabled and includes
the `youtube.upload` scope.

## `invalid_grant`

The saved refresh token has expired or was revoked. Start the YouTube OAuth
flow again from the dashboard and replace the old credentials file. The video
file itself is not the cause of this error.

## Redirect URI mismatch

The callback configured in Google Cloud must exactly match the URI shown by the
dashboard. Scheme, host, port, path, and trailing slash all matter.

## Credential files

Never commit these files:

- `client_secret.json`
- `youtube_credentials.pkl`
- `.env`

They grant access to your Google project or YouTube account.
