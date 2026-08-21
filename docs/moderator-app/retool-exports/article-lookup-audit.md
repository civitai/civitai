# Article Lookup — coverage classification

All 3 queries in the export, bucketed per the migration skill's §2. Small enough that the whole app
fits on one screen, which is why this file is short rather than absent — the gate applies at every size.

## Classification of all 3

| Query | Bucket | Notes |
| --- | --- | --- |
| `FindArticle` | **port** | `SELECT * FROM "Article" WHERE id = ?` — the article row |
| `ArticleMetrics` | **port** | `SELECT * FROM "ArticleMetric" WHERE "articleId" = ?` — one row per timeframe |
| `query1` | **plumbing** | Not functionality. A ClickHouse `information_schema` scratch query with the literal placeholder `table_name = 'your_table'` left in — someone's schema-poking experiment, saved into the app. Nothing surfaces it. |

2 ported, 1 plumbing, 0 blocked. No `retool_db` queries, so no moderator-database or attribution
concerns; both ported queries are read-replica reads, so the page is read-only and needs no action gate
beyond the page grant.

## One thing this export cannot tell us

**It was extracted on 2026-08-06, before `extract.mjs` learned to emit widget option sets**, so it has
no "tabs & option sets" section. The component histogram shows `ContainerWidget2: 1` and
`TabsWidget2: 1` — a tab container whose labels are invisible here. That is the exact blind spot that
left 97 User Lookup queries unported.

Judged low risk **at this size and stated rather than assumed**: 3 queries, 2 tables, and
`TableWidget2: 2` — one table per query. There is no room for a hidden capability, because there are
no hidden queries for a hidden tab to run. In every re-extracted export so far the bare `tabs1
[TabsWidget2]` has held Retool's meaningless `Tab 1 / Tab 2 / Tab 3` defaults, with the real labels on
the `ContainerWidget2`; here that is most likely `Article` / `Metrics`.

Re-extract when the raw export is to hand and confirm. If it turns out to carry a third tab, this file
is where the correction goes.

## Deliberate additions beyond the export

Retool's `FindArticle` took a raw id only. The port also accepts a full article URL, matching Image
Lookup — a moderator working from a report has a link, not an id, and pasting it was already the
established behaviour on the neighbouring page.

`SELECT *` is not ported literally. `Article.content` is the full article body and would dominate the
payload for no moderation value; the port selects the fields a moderator acts on and links out to the
article itself for the body.
