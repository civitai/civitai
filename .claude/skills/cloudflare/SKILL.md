---
name: cloudflare
description: Query Cloudflare HTTP analytics AND manage security rules across zones. Traffic investigation (top IPs, paths, user agents, bot scores, timelines, scrape analysis) plus export and port of Custom Rules + Rate Limit Rules between zones (e.g. civitai.com -> civitai.red).
---

# Cloudflare Analytics + Rule Management

Query Cloudflare HTTP traffic analytics and manage security rules (Custom Rules, Rate Limit Rules) across zones. The `CF_API_TOKEN` in `.env` needs **Zone Analytics: Read** for analytics, and **Zone WAF: Edit** for rule management.

## Running Commands

```bash
node .claude/skills/cloudflare/query.mjs <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `top-clients` | Top IPs by request count |
| `top-paths` | Top request paths |
| `top-agents` | Top user agents |
| `timeline` | Requests per minute timeline (bar chart) |
| `ip <addr>` | Full breakdown for a specific IP (paths, UAs, statuses, geo) |
| `scrape` | Full scrape analysis — top IPs, paths, UAs + detail on high-volume IPs |
| `bot-scores` | Bot score distribution |
| `bot-clients` | Top clients with low bot scores (likely bots) |
| `firewall` | Recent firewall/WAF events |
| `rate-limits` | Current rate limit rules |
| `waf-rules` | Current WAF custom rules |
| `list-zones` | List all accessible zones (id, name, plan) |
| `export-rules <zone>` | Dump Custom Rules + Rate Limit Rules from a zone |
| `port-rules` | Copy rules between zones (dry-run by default) |

### Flags

| Flag | Description |
|------|-------------|
| `--start`, `--from` | Start time: relative (`-1h`, `-2d`, `-30m`), time (`16:41`), or ISO datetime |
| `--end`, `--to` | End time (default: now) |
| `--limit` | Max results (default: 20) |
| `--path` | Filter by path pattern using SQL LIKE (`/api/%`, `/api/trpc/%`) |
| `--ip` | Filter by client IP |
| `--score` | Max bot score for `bot-clients` (default: 10) |
| `--source`, `--target` | Zone name or id (used by `port-rules`) |
| `--phase` | `custom`, `ratelimit`, or `all` (default) for rule commands |
| `--out` | Write `export-rules` output to a JSON file |
| `--skip-disabled` | When porting, skip rules with `enabled: false` |
| `--skip-hosts` | Comma-separated list of hosts; rules referencing them are skipped |
| `--rewrite-host FROM:TO` | Replace `"FROM"` with `"TO"` in rule expressions during port |
| `--only` | Comma-separated substrings; only port rules whose description matches |
| `--pro-compat` | Strip Enterprise-only syntax to fit Pro/Free target zones (see below) |
| `--apply` | Actually write. Without this, `port-rules` is a dry run |

### Examples

```bash
# Full scrape analysis for a time window
node .claude/skills/cloudflare/query.mjs scrape --start "2026-03-24 16:41" --end "2026-03-24 19:08"

# Top IPs hitting API endpoints in the last 2 hours
node .claude/skills/cloudflare/query.mjs top-clients --start -2h --path "/api/%"

# What paths is a specific IP hitting?
node .claude/skills/cloudflare/query.mjs ip 1.2.3.4 --start -6h

# Traffic timeline for API/trpc routes
node .claude/skills/cloudflare/query.mjs timeline --start -1h --path "/api/trpc/%"

# Find likely bots (low bot score) hitting API
node .claude/skills/cloudflare/query.mjs bot-clients --start -3h --score 5 --path "/api/%"

# Top user agents on search-related paths
node .claude/skills/cloudflare/query.mjs top-agents --start -2h --path "/api/trpc/image%"

# Check current rate limit rules
node .claude/skills/cloudflare/query.mjs rate-limits

# List all zones (id, name, plan)
node .claude/skills/cloudflare/query.mjs list-zones

# Export civitai.com rules (custom + rate limit) to a file
node .claude/skills/cloudflare/query.mjs export-rules civitai.com --out com-rules.json

# Dry-run a port from civitai.com to civitai.red — preview only
node .claude/skills/cloudflare/query.mjs port-rules \
  --source civitai.com --target civitai.red \
  --skip-disabled \
  --skip-hosts api.civitai.com,metrics.civitai.com,education.civitai.com,image.civitai.com,meilisearch-v1-9.civitai.com,meilisearch-v1-6.civitai.com,meilisearch-metrics.civitai.com \
  --rewrite-host civitai.com:civitai.red \
  --pro-compat

# Same thing, but actually write it (REPLACES target rulesets wholesale)
node .claude/skills/cloudflare/query.mjs port-rules \
  --source civitai.com --target civitai.red \
  --skip-disabled \
  --skip-hosts api.civitai.com,metrics.civitai.com,education.civitai.com,image.civitai.com,meilisearch-v1-9.civitai.com,meilisearch-v1-6.civitai.com,meilisearch-metrics.civitai.com \
  --rewrite-host civitai.com:civitai.red \
  --pro-compat \
  --apply

# Port only specific rules (match by description substring)
node .claude/skills/cloudflare/query.mjs port-rules \
  --source civitai.com --target civitai.red --phase ratelimit \
  --only "Global Limit,Rate limit trpc (No Regex)" \
  --rewrite-host civitai.com:civitai.red \
  --pro-compat --apply
```

## Porting Security Rules Between Zones

`port-rules` replaces the target zone's Custom Rules ruleset and/or Rate Limit Rules entrypoint with a filtered + transformed copy of the source zone's rules. It **overwrites** the target ruleset — existing rules on the target are wiped.

### What gets ported

The Cloudflare "Security Rules" surface maps to two phase entrypoints:

| Phase | UI name | Flag value |
|-------|---------|-----------|
| `http_request_firewall_custom` | Custom Rules | `--phase custom` |
| `http_ratelimit` | Rate Limit Rules | `--phase ratelimit` |

Managed Rules, IP Access Rules, Zone Lockdown, and User Agent Blocking are **not** ported.

### Filters

Without filters, every rule from the source is copied as-is.

- `--skip-disabled` drops rules where `enabled: false`.
- `--skip-hosts host1,host2` drops any rule whose expression literal-matches one of the listed hosts (useful for source-only subdomains that don't exist on the target zone).
- `--only pat1,pat2` keeps only rules whose description contains one of the given substrings.
- `--rewrite-host FROM:TO` rewrites `"FROM"` → `"TO"` inside rule expressions after the skip filter runs. Use this to point apex-host rules at the new zone (`civitai.com:civitai.red`).

### Pro-plan / Free-plan compatibility (`--pro-compat`)

Cloudflare Pro zones reject several Enterprise-only rule features that are commonly used on Business/Enterprise source zones. When the target zone plan is `pro` or `free`, `--pro-compat` is applied automatically; otherwise pass it explicitly. Transforms:

- **IP list exclusions**: `and not ip.src in {…}` / `and ip.src in {…}` clauses are stripped. Pro zones don't support `ip.src in` expressions in rate-limit rules.
- **Bot management checks**: `and not cf.bot_management.verified_bot` / `and cf.bot_management.verified_bot` clauses are stripped (Bot Management is an Enterprise feature).
- **Rate-limit period**: Pro only allows periods in `[10, 15, 20, 30, 40, 45, 60]` seconds. Rules with longer periods (e.g. 300s) are scaled to 60s and the `requests_per_period` is scaled proportionally to preserve the same req/s rate.
- **`requests_to_origin`**: stripped (Enterprise-only).

Each transform is reported in the dry-run output as a `~` line so you can review them before applying.

### Rule-count limits

Target zone plans cap the number of rules per phase. If the port exceeds the cap, Cloudflare returns `exceeded the maximum number of rules in the phase X: N out of M`. Common caps:

| Plan | Custom Rules | Rate Limit Rules |
|------|--------------|------------------|
| Free | 5 | 1 |
| Pro | 20 | 2 |
| Business | 100 | 15 |
| Enterprise | 1000+ | 1000+ |

Use `--only` or manually trim the source rule list if you hit the cap.

### Known constraints

- `ref` is stripped on write so rules are re-id'd on the target. This means subsequent ports between the same two zones replace wholesale, not diff-and-merge.
- Managed Rules, IP Access Rules, Zone Lockdown, User Agent Blocking, and legacy Firewall Rules are **not** ported.
- Account-scoped custom lists (e.g. `$attackers`, `$bandwidth_theft`) work across zones in the same account with no change.

## Investigation Workflow

For scraping investigations:

1. **Start broad**: `scrape --start ... --end ...` to see top IPs, paths, and UAs
2. **Identify suspects**: Look for IPs with disproportionate request counts
3. **Deep dive**: `ip <addr>` to see what specific IP is doing
4. **Check bots**: `bot-clients --score 5` to find CF-detected bots
5. **Timeline**: `timeline --ip <addr>` to see traffic pattern over time
6. **Review defenses**: `rate-limits` and `firewall` to see what's in place
