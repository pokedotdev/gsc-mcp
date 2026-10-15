# Privacy Policy

_Last updated: 2026-10-15_

gsc-mcp is an open source tool that lets AI agents read Google Search Console data on behalf of the person who runs it.

## Data accessed

When you connect a Google account, gsc-mcp requests these permissions:

- `openid` and `email`: to identify which Google account was connected.
- `https://www.googleapis.com/auth/webmasters.readonly`: read-only access to the Search Console data of the
  properties that account can already access.

gsc-mcp never requests write access and cannot modify your Search Console properties.

## How data is used

Search Console data is fetched only when an agent you run calls one of the tools, and it is returned only to that
agent. It is not used for advertising, profiling, or any other purpose.

## Storage

- **Local version:** OAuth refresh tokens and account emails are stored only on your computer, in
  `~/.config/gsc-mcp/accounts.json`, readable only by your user. No data is sent to the authors of gsc-mcp or to any
  third party other than Google.
- Search Console data is not persisted; it may be cached in memory for a few minutes while the server runs.

## Sharing

Data is not sold or shared with third parties. Data is exchanged only with Google APIs and with the AI agent you
connect to the server.

## Revoking access

Run `gsc-mcp auth remove <alias>` to delete the stored credentials and revoke the token at Google. You can also
revoke access at any time from https://myaccount.google.com/permissions.

## Google API Services User Data Policy

gsc-mcp's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including
the Limited Use requirements.

## Contact

Questions about this policy: pokedotdev@gmail.com
