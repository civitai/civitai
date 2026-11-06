---
name: site-alert
description: Post, edit, extend, end and list site alerts — the incident banners shown at the top of civitai.com pages that match a path. Use when a feature is broken or degraded and visitors on its pages should be told, or to lift or check such a notice.
---

# Site alerts

A site alert is a strip at the top of every page whose path matches one of its globs, for a set
time. Moderators manage the same alerts at `/moderator/site-alerts`.

## Setup

The script uses the `mod-actions` skill's configuration: a moderator's API key in
`.claude/skills/mod-actions/.env` (see that skill's `.env.example`). `CIVITAI_API_URL` picks the
site; it defaults to production, so set it to your dev server while testing.

## Commands

```bash
node .claude/skills/site-alert/site-alert.mjs <command> [id] [options]
```

| Command | What it does |
|---------|--------------|
| `list` | Every alert, active and ended in the last 7 days |
| `active` | What the public endpoint serves now (no key needed) |
| `post --title <t> --hours <n>` | Post an alert |
| `edit <id>` | Change copy, severity, paths, domains or dismissibility |
| `extend <id> --minutes <n>` (or `--hours`) | Push the end time out |
| `end <id>` | End it now |

Options: `--message`, `--severity info|warning|outage|resolved` (default `warning`),
`--paths "/a,/b/**"`, `--domains all|blue|green|red`, `--starts <iso>`, `--dismissible` /
`--not-dismissible` (outages default to not dismissible), `--dry-run`, `--json`.

## Paths

Globs against the page path; the query string is ignored and case does not matter.

- `*` matches exactly one segment: `/models/*/edit` matches `/models/12/edit`, not `/models/edit`.
- `**` matches any number of segments, including none: `/generate/**` matches `/generate`.
- No paths means every page. There are no regexes, and `*` inside a segment is rejected.

An alert runs for at most 7 days and must have an end time. A scheduled alert (`--starts`) is in
the public response before it starts, so do not schedule copy that must stay private until then.

## Example

```bash
node .claude/skills/site-alert/site-alert.mjs post --severity outage \
  --title "Model upload is broken" \
  --message "We know about it and a fix is rolling out." \
  --paths "/models/create,/models/*/wizard,/models/*/model-versions/**" --hours 2

node .claude/skills/site-alert/site-alert.mjs end 12
```

Visitors see a change on their next action on the site (any request to the API), not instantly.
