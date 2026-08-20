# Retool app inventories

Generated summaries of the Retool apps being migrated into `apps/moderator` — every query with its SQL
or endpoint, the `{{ }}` bindings it depends on, and a component-type histogram.

**These are the spec.** Retool's layout and component tree are not ported; the queries are what the tool
actually does.

| App | Inventory | Queries |
| --- | --- | --- |
| User Lookup v2 | [user-lookup-v2.md](user-lookup-v2.md) | 170 |
| Moderation Status | [moderation-status.md](moderation-status.md) | 77 |
| Bulk Image Manager | [bulk-image-manager.md](bulk-image-manager.md) | 40 |
| User Reports | [user-reports.md](user-reports.md) | 34 |
| Chat Audit | [chat-audit.md](chat-audit.md) | 20 |
| Front Page Audit | [front-page-audit.md](front-page-audit.md) | 16 |
| Bulk Ban | [bulk-ban.md](bulk-ban.md) | 15 |
| Image Lookup | [image-lookup.md](image-lookup.md) | 10 |
| Article Lookup | [article-lookup.md](article-lookup.md) | 3 |
| Workflows (2) | raw only — see [raw/README.md](raw/README.md) | 2 SQL |

Exports are attached to the **ClickUp subtasks of 868kkxqpn**, one per app — that is where to get them,
not a local folder.

Progress against these lives in
[`.claude/skills/retool-migration/MIGRATIONS.md`](../../../.claude/skills/retool-migration/MIGRATIONS.md).

[**retool-db-tables.md**](retool-db-tables.md) covers the other half of the migration: which tables in
Retool's own Postgres these apps actually depend on (7 of 43), and what has to move.
[**moderator-id-mapping.md**](moderator-id-mapping.md) maps Retool's free-text moderator names to real
user ids — needed before 69,100 notes and strikes can keep their attribution.

## The raw exports ARE here now — sanitized

This changed once Retool access started going away. [`raw/`](raw/) holds all nine app exports plus the
two workflow exports, because the inventories are lossy: they render what the extractor knows how to
render, and the extractor has twice been wrong about what mattered.

> **The originals contain live credentials.** `User Lookup v2.json` carried an
> `Authorization: Bearer <token>` header **seven times**. Every committed copy is redacted.

**Read [`raw/README.md`](raw/README.md) before touching anything in that directory.** The rule it sets
is not optional: never overwrite one with a fresh download, sanitize first, verify no secret-shaped
strings survive, and only then commit. A token in git history is disclosed permanently and deleting the
file afterwards does not undo it.

The inventories are generated FROM the sanitized files, so regenerate rather than hand-editing — or a
redacted export quietly grows an unredacted inventory beside it.

## Getting a fresh export

Ask the moderation team, or export from Retool directly (app → ⋯ → Export). A fresh download is
**unsanitized**: keep it outside the repo (`~/Downloads/Retool/`) and sanitize before it comes near a
commit.

## Regenerating an inventory

```bash
cd .claude/skills/retool-migration && npm install   # once per checkout
node extract.mjs "<path>/User Lookup v2.json" > docs/moderator-app/retool-exports/user-lookup-v2.md
```

Re-run and commit the diff whenever a fresh export arrives — the diff shows exactly what the moderation
team changed, which the raw JSON cannot.

## Why a decoder is needed at all

`page.data.appState` is **transit-js** encoded (`~#iR` tag, `["^ ", k, v, …]` maps, `^N`
back-references), not plain JSON. `JSON.parse` alone returns an opaque blob. See
[`extract.mjs`](../../../.claude/skills/retool-migration/extract.mjs).
