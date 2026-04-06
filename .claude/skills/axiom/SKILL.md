---
name: axiom
description: Query Axiom logs and datasets using APL (Axiom Processing Language). Use when investigating production errors, debugging webhook failures, checking log patterns, or analyzing system behavior.
allowed-tools: Bash, Read
---

# Axiom

Query Axiom datasets using APL (Axiom Processing Language). Supports log search, aggregation, field analysis, and time-based filtering.

## Setup

Create `.env` in this skill directory:

```
AXIOM_TOKEN=xaat-your-token-here
AXIOM_ORG_ID=civitai-cxe5
AXIOM_DATASTREAM=civitai-prod
AXIOM_DOMAIN=api.axiom.co
```

Token needs **read/query** permissions (the project .env token is ingest-only).

## Quick Reference

```bash
SKILL_DIR=".claude/skills/axiom"

# List available datasets
node "$SKILL_DIR/axiom.mjs" datasets

# Run an APL query
node "$SKILL_DIR/axiom.mjs" query "['civitai-prod'] | where name == 'nowpayments-webhook' | take 10" --format legacy --json

# Search logs with filters
node "$SKILL_DIR/axiom.mjs" query "['civitai-prod'] | where name == 'some-service' and type == 'error' | project _time, message, error | sort by _time desc | take 50" --start "2026-03-01T00:00:00Z" --end "2026-04-01T00:00:00Z" --format legacy --json

# Count errors by message
node "$SKILL_DIR/axiom.mjs" query "['civitai-prod'] | where name == 'my-service' | summarize count() by message | order by count_ desc" --start "2026-03-01T00:00:00Z" --format legacy --json

# Top values for a field
node "$SKILL_DIR/axiom.mjs" query "['civitai-prod'] | where type == 'error' | summarize count() by name | order by count_ desc | take 20" --format legacy --json
```

## Commands

| Command | Description |
|---------|-------------|
| `datasets` | List all available datasets |
| `dataset-info <name>` | Get info about a specific dataset |
| `query "<APL>"` | Run any APL query |
| `search <dataset> --where "..."` | Search with filters |
| `count <dataset> --where "..." --by <field>` | Count/aggregate |
| `tail <dataset>` | Most recent events |
| `top <dataset> <field>` | Top values for a field |

## Important Notes

- **Use `--format legacy --json`** for reliable output. The tabular format can return empty rows for some queries.
- **Time ranges**: Use `--start` and `--end` flags with ISO 8601 timestamps, or use `ago()` in APL (e.g., `_time > ago(24h)`).
- **Field paths**: Log data is under the `data.` prefix in legacy format. Use field names directly in APL (e.g., `name`, `message`, `type`).
- **Summarize queries**: Return results in `buckets.series[].groups[]` in legacy format, not in `matches[]`.

## Known Datasets

| Dataset | Description |
|---------|-------------|
| `civitai-prod` | Main production logs (services, webhooks, jobs) |
| `civitai-stage-new` | Staging environment |
| `civitai-next` | Next.js application logs |
| `webhooks` | Webhook event tracking |
| `clickhouse` | ClickHouse integration errors |
| `notifications` | Notification service logs |
| `orchestration-otlp` | Orchestration telemetry |
| `python-worker` | Python worker process logs |

## Common Log Names (civitai-prod)

Services log with a `name` field. Common ones:

- `nowpayments-webhook` — NowPayments IPN webhook handler
- `nowpayments-service` — NowPayments deposit processing
- `reconcile-nowpayments-job` — Reconciliation cron job

## APL Cheatsheet

```
# Filter
| where name == "value"
| where field contains "substring"
| where field matches regex "pattern"

# Time range
| where _time > ago(7d)
| where _time between (datetime(2026-03-01) .. datetime(2026-03-31))

# Aggregate
| summarize count() by field
| summarize avg(duration), max(duration) by name
| summarize count() by bin(_time, 1h)

# Sort and limit
| sort by _time desc
| take 50
| order by count_ desc

# Select fields
| project _time, name, message, error

# Extend (computed columns)
| extend duration_ms = duration / 1000
```

## When to Use

- Investigating production errors or webhook failures
- Checking if a specific service is logging errors
- Analyzing error patterns over time
- Debugging payment/deposit processing issues
- Monitoring reconciliation job health
- Verifying deployment behavior changes
