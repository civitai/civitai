---
name: metabase
description: Create and manage Metabase questions, dashboards, and public links. Use when the user wants to build metrics dashboards, create saved questions with SQL queries, or share analytics publicly.
---

# Metabase Skill

Create questions, dashboards, and public links on Civitai's Metabase instance.

## Running Commands

```bash
node .claude/skills/metabase/metabase.mjs <command> [options]
```

**A value that starts with `--` needs `--flag=value`.** Every flag except `--required` and `--json` takes a
value, and a bare `--flag` (or one whose value begins with `--`) is an error rather than a silent `true`.
This bites most often with SQL opening on a `--` comment line:

```bash
--query="-- daily totals
SELECT ..."
```

`create-question` reads the card back after creating it and fails if the stored SQL is not what was sent.

## Commands

### run-query — Ad-hoc SQL query

```bash
node .claude/skills/metabase/metabase.mjs run-query --database 3 --query "SELECT count() FROM views"
```

### create-question — Saved question with optional variables

Variables are auto-detected from `{{variable}}` syntax in the query, or can be specified explicitly.

```bash
# Auto-detected variables
node .claude/skills/metabase/metabase.mjs create-question \
  --name "Challenge Review Purchases" \
  --database 3 \
  --collection 232 \
  --query "SELECT * FROM buzzTransactions WHERE description LIKE 'Challenge review:%' AND toDate(date) >= {{start_date}}" \
  --description "Tracks guaranteed review buzz purchases"

# Explicit variable definitions (for types like date, number, etc.)
node .claude/skills/metabase/metabase.mjs create-question \
  --name "User Activity" \
  --database 3 \
  --query "SELECT * FROM views WHERE userId = {{user_id}}" \
  --variables '{"user_id":{"id":"user_id","name":"user_id","display-name":"User ID","type":"number"}}'
```

**Variable types:** `text`, `number`, `date`, `date/single`, `date/range`, `date/month-year`, `date/quarter-year`, `date/relative`, `date/all-options`

### run-card — Run a SAVED question, with its parameters

`run-query` runs ad-hoc SQL, which does **not** tell you whether a saved card works: a card
whose parameters are mis-wired stores the right SQL and still returns nothing. Run the card
itself to check.

```bash
node .claude/skills/metabase/metabase.mjs run-card --id 3301 --params '{"from":"2026-09-09","to":"2026-10-01"}'
node .claude/skills/metabase/metabase.mjs run-card --id 3303          # no parameters
```

Names in `--params` are `{{variable}}` names; an unknown one is an error rather than a
silently ignored filter.

### update-question — Change SQL, display, description, or archive it

```bash
# Replace the SQL (reads the card back and fails if the stored query differs)
node .claude/skills/metabase/metabase.mjs update-question --id 123 --query "SELECT 1"   --variables '{"from":{"id":"f","name":"from","display-name":"From","type":"date"}}'

# Description, or retire a superseded card
node .claude/skills/metabase/metabase.mjs update-question --id 123 --description "..."
node .claude/skills/metabase/metabase.mjs update-question --id 123 --archived true

# Change to bar chart
node .claude/skills/metabase/metabase.mjs update-question --id 123 --display bar

# Change to line chart with custom settings
node .claude/skills/metabase/metabase.mjs update-question --id 123 --display line \
  --visualization '{"graph.dimensions":["date"],"graph.metrics":["count"]}'
```

**Pass real SQL as `--query-file`, not `--query`.** A query with a comment header does not survive a
shell argument intact, and a swallowed value is parsed as boolean `true` — which writes a card with no
query and reports success. `create-question` and `run-query` take `--query-file` too.

An empty or whitespace-only `--query-file` is refused, because a file's emptiness is invisible to the
caller — the program opened it, not them. An inline `--query "   "` is still accepted: it was typed
deliberately by someone who can see what they typed.

A write that contains a `{{snippet: ...}}` reference also verifies the snippet tag landed, not just the
SQL. The two fail independently: a dropped tag leaves the query byte-identical and the card unrunnable.

Write a reference as `{{snippet: name}}`. `{{snippet:name}}` is fine — Metabase normalises it — but a
space *before* the colon is not normalised and needs a tag named literally `snippet : name`, so a card
written that way cannot run. That spelling is refused rather than written.

🔴 **A comment line whose only content is `--` breaks parameter binding for the whole query** on the
ClickHouse driver: every variable fails with *"we got more parameters than we can handle"*, which points
at neither the line nor the cause. **Indentation does not save it** — an indented `--`, the usual form
inside a CTE, breaks binding the same way. A trailing space or tab is the fix.

`create-question`, `update-question`, `run-query`, `create-snippet` and `update-snippet` all refuse text
containing one. **No test can catch this**: the query runs clean until a variable is *bound*, so an
unparameterised run and a card that merely exists both look correct. The guard is the only check that
reaches it.

**Display types:** `table`, `bar`, `line`, `area`, `pie`, `scalar`, `row`, `funnel`, `map`, `scatter`, `waterfall`, `combo`, `smartscalar`, `progress`, `gauge`, `pivot`

### create-dashboard — New dashboard

```bash
node .claude/skills/metabase/metabase.mjs create-dashboard \
  --name "Challenge Metrics" \
  --collection 232 \
  --description "Overview of challenge engagement and revenue"
```

### add-to-dashboard — Add questions to a dashboard

```bash
# Add 3 cards in a 2-column layout
node .claude/skills/metabase/metabase.mjs add-to-dashboard \
  --dashboard 456 \
  --cards "101,102,103" \
  --cols 2
```

The `--cols` flag controls cards per row (default: 2). Uses Metabase's 24-column grid.

### add-dashboard-filter — Add interactive filters

```bash
node .claude/skills/metabase/metabase.mjs add-dashboard-filter \
  --dashboard 456 \
  --filtername "Date Range" \
  --filtertype "date/range" \
  --slug "date_range" \
  --target '[{"card_id":101,"target":["variable",["template-tag","start_date"]]}]'
```

### set-dropdown — Make a variable a dropdown list

Converts a `{{variable}}` template tag into a dropdown with a static list of values. The variable must already exist in the question's SQL query.

```bash
# Basic dropdown
node .claude/skills/metabase/metabase.mjs set-dropdown \
  --id 2608 \
  --variable period \
  --values "day,week,month,year" \
  --default day \
  --required

# Metric selector
node .claude/skills/metabase/metabase.mjs set-dropdown \
  --id 2608 \
  --variable as \
  --values "purchases,buzz,users" \
  --default purchases \
  --required
```

| Flag | Description |
|------|-------------|
| `--id` | Question (card) ID |
| `--variable` | Name of the `{{variable}}` in the SQL query |
| `--values` | Comma-separated list of allowed values |
| `--default` | Default selected value |
| `--required` | Make the filter required |

### set-date-picker — Make a variable a date picker

Converts a `{{variable}}` template tag into a date picker widget.

```bash
node .claude/skills/metabase/metabase.mjs set-date-picker \
  --id 2608 \
  --variable since \
  --default "2026-02-13" \
  --required
```

| Flag | Description |
|------|-------------|
| `--id` | Question (card) ID |
| `--variable` | Name of the `{{variable}}` in the SQL query |
| `--default` | Default date (YYYY-MM-DD) |
| `--required` | Make the filter required |

### set-parameters — Full parameter JSON (advanced)

Set all parameters at once with full Metabase parameter JSON. Use `get --type question --id <id>` to see the current parameter structure.

```bash
node .claude/skills/metabase/metabase.mjs set-parameters \
  --id 2608 \
  --parameters '[{"slug":"as","type":"string/=","values_source_type":"static-list",...}]'
```

### share — Generate public link

```bash
# Share a question
node .claude/skills/metabase/metabase.mjs share --type question --id 101

# Share a dashboard
node .claude/skills/metabase/metabase.mjs share --type dashboard --id 456
```

### list — Browse a collection

```bash
node .claude/skills/metabase/metabase.mjs list --collection 232
node .claude/skills/metabase/metabase.mjs list --collection 232 --type question
```

### search — Find questions/dashboards

```bash
node .claude/skills/metabase/metabase.mjs search --query "challenge" --type question
```

### get — View full details

```bash
node .claude/skills/metabase/metabase.mjs get --type question --id 101
node .claude/skills/metabase/metabase.mjs get --type dashboard --id 456
```

### Snippets — one derivation shared by many cards

A snippet is text pasted into `{{snippet: <name>}}` at run time, so several cards can share one
expression instead of each carrying a copy that drifts.

```bash
node .claude/skills/metabase/metabase.mjs list-snippets [--json]
node .claude/skills/metabase/metabase.mjs create-snippet --name "image engine" \
  (--file engine.sql | --content "SQL") [--description "..."]
node .claude/skills/metabase/metabase.mjs update-snippet --id 1 \
  [--file engine.sql | --content "SQL"] [--name "..."] [--description "..."]
```

Each write reads the snippet back and reports only on the fields it actually sent — a metadata-only
update says "stored description matches", never "content matches", because it did not send content and
did not check it.

🔴 **Snippet text is the one place the `--` guard could not otherwise reach.** A snippet is substituted
verbatim into every card that references it, and those cards' own SQL may contain nothing but
`{{snippet: name}}` — so a bare `--` inside a snippet body breaks binding everywhere it is used and no
per-card check can see it. `create-snippet` and `update-snippet` guard their content for that reason.

**A snippet takes no parameters** — it is literal substitution, not a function. So a fragment can only
reference bare column names, and a card using it must select from the table with **no alias** on those
columns.

Referencing one from a card is handled for you: both `create-question` and `update-question` scan the
SQL for `{{snippet: ...}}` and add the matching template tag, because a card missing that tag fails at
run time with `missing required parameters` and the auto-detect for ordinary `{{variable}}` syntax does
not match a name containing a colon. A reference to a snippet that does not exist is refused before
anything is written.

### list-collections / list-databases

```bash
node .claude/skills/metabase/metabase.mjs list-collections
node .claude/skills/metabase/metabase.mjs list-databases
```

## Databases

| ID | Name | Engine | Notes |
|----|------|--------|-------|
| 3 | ClickHouse | clickhouse | Analytics, events, buzz transactions |
| 2 | Prod | postgres | Main application database |
| 35 | Buzz DB | postgres | Buzz-specific database |

## Key Collections

| ID | Name |
|----|------|
| 232 | Challenges |
| 100 | Buzz Analytics |
| 102 | Daily Analytics |
| 430 | Community Analytics |
| 331 | Feature Performance |
| 530 | Revenue |
| 133 | Social Metrics |
| 106 | System Performance |

## Workflow: Build a Question with Dropdowns

```bash
# 1. Create the question with {{variables}} in SQL
node .claude/skills/metabase/metabase.mjs create-question \
  --name "My Metric" \
  --database 3 \
  --collection 232 \
  --display bar \
  --query "SELECT date_trunc({{period}}, date) AS period, CASE WHEN {{as}} = 'count' THEN count()::Int64 WHEN {{as}} = 'sum' THEN sum(amount)::Int64 END AS total FROM buzzTransactions WHERE date >= {{since}} GROUP BY period ORDER BY period"

# 2. Configure dropdowns and date pickers
node .claude/skills/metabase/metabase.mjs set-dropdown --id <id> --variable as --values "count,sum" --default count --required
node .claude/skills/metabase/metabase.mjs set-dropdown --id <id> --variable period --values "day,week,month,year" --default day --required
node .claude/skills/metabase/metabase.mjs set-date-picker --id <id> --variable since --default "2026-01-01" --required

# 3. Share publicly
node .claude/skills/metabase/metabase.mjs share --type question --id <id>
```

## Workflow: Build a Dashboard End-to-End

```bash
# 1. Create questions (see above for dropdown setup)
node .claude/skills/metabase/metabase.mjs create-question --name "Daily Revenue" --database 3 --collection 530 --query "SELECT toDate(date) as day, sum(amount) FROM buzzTransactions GROUP BY day ORDER BY day DESC LIMIT 30"

# 2. Create dashboard
node .claude/skills/metabase/metabase.mjs create-dashboard --name "Revenue Overview" --collection 530

# 3. Add questions to dashboard
node .claude/skills/metabase/metabase.mjs add-to-dashboard --dashboard <id> --cards "<q1>,<q2>,<q3>" --cols 3

# 4. Share publicly
node .claude/skills/metabase/metabase.mjs share --type dashboard --id <id>
```

## How Dropdowns Work

Metabase has two layers for variables in native queries:

1. **Template tags** — defined in `dataset_query.native.template-tags`. These create the `{{variable}}` placeholders in the SQL. Set via `--variables` on `create-question`.

2. **Parameters** — defined in the top-level `parameters` array on the card. These control the **UI widget** (text input, dropdown, date picker). Set via `set-dropdown`, `set-date-picker`, or `set-parameters`.

By default, `{{variable}}` template tags render as plain text inputs. To make them dropdowns:
- Use `set-dropdown` to configure a static list of values
- Use `set-date-picker` to configure a date picker widget
- Each command reads the existing template tag ID and wires it up correctly

**Important:** Each call to `set-dropdown` or `set-date-picker` preserves other existing parameters. You can call them one at a time.

## MBQL 4 vs MBQL 5 — the shape a GET returns is not the shape a PUT accepts

A `GET /card/:id` returns MBQL 5: `dataset_query` has `stages` and `lib/type`, the SQL lives
at `stages[0].native` as a string, and `template-tags` is an **array** of records. A write
must send the MBQL 4 shape — `{database, type: 'native', native: {query, 'template-tags'}}`
with tags as an **object keyed by name**. Spreading what a GET returned into a PUT is
rejected with `MBQL 4 keys like :type, :query, or :native are not allowed in MBQL 5 queries
with :lib/type`.

The array-vs-object half is the one that bites quietly: looking a tag up by name on the
array finds nothing, and `set-dropdown` / `set-date-picker` then report
`Template tag "from" not found ... Available tags: 0, 1` — which reads as a missing variable
rather than a wrong shape. Every command here normalises both shapes; new ones must too.

Related: `POST /dashboard/:id/cards` no longer exists. Dashcards are written by PUTting the
whole `dashcards` array back to `/dashboard/:id`, with a negative placeholder `id` on each
new entry.

## Tips

- Always specify `--collection` when creating questions/dashboards to keep things organized
- Use `--display` with `update-question` or `create-question` to set chart type
- Variables in queries (`{{var}}`) are auto-detected — no need to manually define simple text variables
- For date/number variables, use `--variables` with explicit type definitions
- After creating a question, use `set-dropdown` and `set-date-picker` to configure widgets
- The `add-to-dashboard` command auto-positions cards in a grid layout
- Public links work for both questions and dashboards
- Use `[[AND col < {{optional_var}}]]` syntax for optional filters (omitted when empty)
