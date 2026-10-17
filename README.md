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
| `compare_periods` | Totals and biggest winners/losers vs. the previous period or year over year, by item or by group |
| `find_opportunities` | Striking-distance and low-CTR query/page pairs, ranked by potential extra clicks |
| `detect_cannibalization` | Queries where several pages of the site compete |
| `page_report` | One URL or a section (prefix/regex): totals vs. previous period, devices, queries and top pages |
| `query_report` | One query or a family of queries: which pages rank and how clicks are split among them |
| `aggregate` | Server-side grouping with regex rewrites, merged URL variants and week/month time grains |
| `search_analytics` | Raw performance data grouped by any dimensions, inline or exported to a file |
| `inspect_url` | Index status, canonicals, last crawl and rich results of a URL |
| `inspect_urls` | Index status of up to 100 URLs as one table with the issues that need attention |
| `list_sitemaps` | Submitted sitemaps with submitted URLs, warnings and errors |

The tools are designed to keep agent contexts small:

- **Server-side analysis.** The analysis tools and `aggregate` return compact tables instead of thousands of rows.
  `aggregate` covers custom analyses: e.g. merge `/page/N/` pagination, group pages by section, extract product
  versions from queries, or roll daily data up to weeks.
- **Bounded responses.** Tables are cut to fit the response (`GSC_MCP_MAX_OUTPUT_CHARS`, 40000 characters by
  default) and say in `truncated` how many rows and how much traffic were left out. When a request hits its row
  limit, `coverage` tells which share of the period's clicks the rows hold.
- **File output.** `output: "file"` writes up to 100000 rows as CSV, TSV or JSON Lines for the agent to process with
  its own tools, and returns the path and a short preview.
- **Relative URLs.** Pages on the site's main origin are shown as paths (`/blog/post/`); filters and page parameters
  accept them too, including `in`/`notIn` lists.
- **Caching.** Results are cached in memory for 15 minutes and, when finalized, on disk across sessions (a week for
  periods that ended more than 10 days ago, 6 hours for recent ones). Large result sets are paginated in parallel
  and long requests report MCP progress.

Branded queries (inferred from the domain, extendable with `brandTerms`) and sitelinks are excluded from
opportunity and cannibalization analysis. Google leaves anonymized queries out of query rows and of per-page
device and query breakdowns; `page_report` reports how much of the totals its breakdowns cover.

`site` accepts a domain (`example.com`), a URL or an exact property (`sc-domain:example.com`); the server picks the
matching property and the account with the highest permission on it. Tools that take a page URL without `site`
prefer the domain property, so every tool reports comparable numbers.

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

Cached results and exported files live in `~/.cache/gsc-mcp/` (`$GSC_MCP_CACHE_DIR` or `$XDG_CACHE_HOME`), readable
only by the user. Expired entries and exports older than 7 days are deleted when the server starts.

```sh
pnpm gsc-mcp cache clear             # delete cached results and exports
```

| Variable | Default | Effect |
|---|---|---|
| `GSC_MCP_DISK_CACHE` | `on` | `off` keeps results only in memory |
| `GSC_MCP_MAX_OUTPUT_CHARS` | `40000` | Characters of table rows per response |

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
