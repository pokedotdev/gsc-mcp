# gsc-mcp

Read-only [MCP](https://modelcontextprotocol.io) server for Google Search Console, with support for multiple
Google accounts and properties. Built with [Effect](https://effect.website) v4.

## Layout

```
packages/core   Runtime-agnostic services, schemas, errors and MCP tools
apps/local      Local adapter: stdio transport, file-based account store, CLI
```

## Tools

| Tool | Description |
|---|---|
| `list_accounts` | Connected Google accounts |
| `list_sites` | Every property reachable through the accounts, with permission levels |
| `search_analytics` | Clicks, impressions, CTR and position grouped by query, page, country, device, date… |
| `inspect_url` | Index status, canonicals, last crawl and rich results of a URL |

`site` accepts a domain (`example.com`), a URL or an exact property (`sc-domain:example.com`); the server picks the
matching property and the account with the highest permission on it.

All access is read-only: the only Search Console scope requested is `webmasters.readonly`.

## Setup

Requires Node.js 24+ and pnpm.

```sh
pnpm install
```

### 1. Google Cloud OAuth client

1. Create a Google Cloud project and enable the **Google Search Console API**.
2. Configure the OAuth consent screen (External) and add the scopes `openid`, `email` and
   `https://www.googleapis.com/auth/webmasters.readonly`.
3. **Publish the app ("In production").** In "Testing" mode Google expires refresh tokens after 7 days.
   An unverified app shows a warning on sign-in, which is fine for personal use (up to 100 users).
4. Create an OAuth client of type **Desktop app** and download its JSON.

```sh
pnpm gsc-mcp auth client ~/Downloads/client_secret_XXXX.json
```

Alternatively set `GSC_MCP_CLIENT_ID` and `GSC_MCP_CLIENT_SECRET`.

### 2. Connect accounts

```sh
pnpm gsc-mcp auth add personal
pnpm gsc-mcp auth add agency --login-hint me@agency.com
pnpm gsc-mcp auth list
pnpm gsc-mcp auth remove agency      # also revokes the token at Google
```

Credentials are stored in `~/.config/gsc-mcp/` (`$GSC_MCP_CONFIG_DIR` or `$XDG_CONFIG_HOME` are honored)
with `0600` permissions.

### 3. Register the MCP server

Claude Code:

```sh
claude mcp add gsc -- node /absolute/path/to/gsc-mcp/apps/local/src/main.ts serve
```

Other clients:

```json
{
  "mcpServers": {
    "gsc": {
      "command": "node",
      "args": ["/absolute/path/to/gsc-mcp/apps/local/src/main.ts", "serve"]
    }
  }
}
```

## Development

```sh
pnpm check   # type check (TypeScript 7)
pnpm test    # vitest
```

Node runs the TypeScript sources directly (type stripping), so there is no build step.
