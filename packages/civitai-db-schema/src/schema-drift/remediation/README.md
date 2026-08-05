# Foreign-key remediation planner

The drift detector one directory up reports which declared foreign keys the database does
not enforce. This turns one of those findings into a plan: clear the orphan rows that
prevent the constraint, then add and validate it — and, more often, **refuse**.

It reuses the detector's parser, types and catalog reader. It adds one catalog fact the
detector does not need: ordinary (non-unique) indexes.

## Run it

```bash
# Plan offline against a captured catalog. Reads nothing, writes nothing.
pnpm --filter @civitai/db-schema fk-remediate --catalog captured.json

# Plan against the live database, with real orphan counts. Read-only.
pnpm --filter @civitai/db-schema fk-remediate --measure

# Plan one relation.
pnpm --filter @civitai/db-schema fk-remediate --measure --relation ImageTagForReview.imageId
```

A relation is named `Model.column` — `Club.coverImageId`, not `Club.coverImage` — because
that is how every audit, migration and constraint name spells it.

The connection comes from `DATABASE_URL`. Nothing about where a database lives is baked
into this tool, and nothing about it should be added.

**The default is a dry run and it issues no statement at all** — not even the read-only
count. `--measure` adds the counts; `--apply` is the only thing that writes, and it
additionally requires exactly one `--relation`, a live connection (not `--catalog`), and
`--measure`. "It only ran the safe ones" is a claim someone then has to verify; a dry run
that issues nothing needs no such claim.

## 🔴 The bug this exists to remove

The predecessor was written for `CollectionItem`, whose four relations all declare
`onDelete: Cascade`. It hardcoded `ON DELETE CASCADE` and its cleanup step **deleted**
orphan rows. That was correct there and is not correct in general.

Of the 37 declared-but-unenforced relations, 15 are `SetNull`. Pointed at those as written,
the cleanup step deletes roughly **23,500 live rows** — 610 articles, 519 user accounts,
591 user profiles, 21,815 threads — where the schema asks only for a cover-image reference
to be cleared. Those are the "broken cover image" relations the remediation backlog
nominates as the natural starting point, so the most dangerous step is also the recommended
first one.

Here the strategy is **derived from the relation's declared `onDelete`**, in one function
(`strategyForAction`), with no flag, no override and no default:

| declared `onDelete`  | orphan remediation                                       |
| -------------------- | -------------------------------------------------------- |
| `Cascade`            | batched `DELETE` — the row should already be gone         |
| `SetNull`            | batched `UPDATE … SET col = NULL` — the **reference** is the thing being cleaned up, not the row |
| `NoAction`/`Restrict`| **refused.** The schema says the parent delete should *fail*; no cleanup follows from that |
| anything else        | **refused.** Fail closed rather than guess a strategy      |

## What it refuses, and why

Each refusal has its own code, so a test can assert *which* guard fired rather than that
something did.

| code                              | meaning                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `excluded`                        | on the never-add list below                                                              |
| `action-forbids-mutation`         | `NoAction` / `Restrict`                                                                  |
| `unknown-action`                  | `SetDefault`, or a value that is not a referential action at all                          |
| `set-null-on-not-null-column`     | declared `SetNull`, column is `NOT NULL` — the **declaration** is wrong, not the data     |
| `table-not-in-catalog`            | the referencing table is a view, or absent                                               |
| `column-not-in-catalog`           | the referencing column is absent, so the `NOT NULL` guard could not be evaluated          |
| `referenced-table-not-in-catalog` | `REFERENCES` would not resolve                                                           |
| `constraint-name-taken`           | the conventional name already names a different constraint on that table                  |
| `identifier-too-long`             | a generated name exceeds 63 bytes, which Postgres **truncates** rather than rejecting     |

Guards **accumulate** rather than short-circuit. A planner that returned at the first
refusal would make every later guard unreachable for that input, and a guard that cannot be
reached cannot be tested — it would survive a mutation by dying to its neighbour.

A refused relation's plan shows the read-only count **and nothing else**. Printing the
`DELETE` it declined to run would put the exact statement this module exists to prevent
into a copy-pasteable plan.

### The never-add list (`exclusions.ts`)

Nine relations must never receive a foreign key, for reasons that live outside the schema
and that a purely action-derived planner cannot see:

- **`TagsOnImageNew.imageId`** — enforcement is the live `after_image_delete_trigger`, whose
  body is `DELETE FROM "TagsOnImageNew" WHERE "imageId" = OLD.id`. The constraint was
  dropped on purpose one day after that trigger took over.
- **`Article.coverId`** — removed by `20250614053144_remove_article_cover_id_fkey`, a
  migration whose entire content is that one `DROP CONSTRAINT`.
- **all seven `*Rank` relations** — `recreateRankTable` rebuilds a rank table with
  `CREATE TABLE "<X>Rank_New" AS SELECT * FROM "<X>Rank_Live"` → `DROP` → rename. A CTAS
  copies no constraints, so a foreign key added there is gone at the next refresh, silently.
  A constraint that can be added and cannot be kept is *recurring* drift — worse than
  permanent drift.

🔴 **`onDelete` used to carry some of this signal and no longer does.** Before
`fix(schema): correct 8 referential actions that misdescribe the database` (#3589), the
seven rank relations and `TagsOnImageNew.imageId` resolved to `NoAction` / `Restrict`, so an
action-aware planner refused them for free. #3589 corrected all eight to `Cascade` —
correctly, since that is the semantics the trigger and the rebuild job implement. The effect
here is that eight relations moved from "refused by the action guard" to "looks like an
ordinary cascade delete". **This list is now the only thing standing between them and an
`ADD CONSTRAINT`.**

The brief for this module named **six** rank relations, from an audit that grouped them by
declared action. The mechanism is not action-shaped — `recreateRankTable` rebuilds the
*table* — so all seven are excluded. `ArticleRank` is one of only two rank tables whose
refresh is still uncommented in `src/server/metrics/*.metrics.ts`, which makes it among the
most exposed, not the least. `exclusions.test.ts` pins that departure so it cannot be
silently reverted.

## Prerequisites (blocked, not refused)

| code                     | meaning                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `missing-index`          | no index whose **leading** key columns are the referencing columns    |
| `index-coverage-unknown` | the catalog carried no index list, so absence could not be established |
| `orphan-count-not-measured` | orphans have not been counted                                      |

Postgres does not index a foreign key for you, and it can only use an index for a predicate
on its **leading** key columns — so an index on `(userId, imageId)` does nothing for a
delete cascading on `imageId`. That is `ImageEngagement`, 5.9M rows. `Collection.imageId` is
16.9M with no index at all. Both would turn every `Image` delete into a sequential scan.

The check applies to `SetNull` as well as `Cascade`: a parent delete has to *find* the
referencing rows to null them, exactly as it does to delete them.

`index-coverage-unknown` is deliberately not the same value as `not-covered`. A catalog
captured without index data cannot tell "there is no index" from "we did not look";
collapsing the two would either block every relation or wave every relation through. A
*unique* index does count as coverage, since a unique index is an index — which is why a
positive answer is trustworthy against the committed snapshot while a negative one is not.

## The statements

```sql
-- 1. count (read-only)
SELECT count(*) FROM "T" t
 WHERE t."c" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "R" r WHERE r."id" = t."c");

-- 2. backup destination
CREATE SCHEMA IF NOT EXISTS "fk_remediation_backup";
CREATE TABLE IF NOT EXISTS "fk_remediation_backup"."T_c_orphans" (LIKE "T");

-- 3. remediate, batched, repeat until it affects 0 rows
WITH doomed AS (SELECT t.ctid FROM "T" t WHERE … LIMIT 5000),
     moved  AS (DELETE FROM "T" t USING doomed d WHERE t.ctid = d.ctid RETURNING t.*)
INSERT INTO "fk_remediation_backup"."T_c_orphans" SELECT * FROM moved;

-- 4. add without scanning
ALTER TABLE "T" ADD CONSTRAINT "T_c_fkey" FOREIGN KEY ("c") REFERENCES "R"("id")
  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

-- 5. validate, as a SEPARATE statement
ALTER TABLE "T" VALIDATE CONSTRAINT "T_c_fkey";
```

Four things about these are load-bearing:

- **The backup is not a preceding statement.** The `DELETE … RETURNING` feeds the `INSERT`
  directly, so there is no interleaving in which rows are gone and not preserved — a crash
  between two statements cannot lose them because there are not two statements. `ctid` is
  safe for the same reason: every sub-statement of one statement sees one snapshot, so a
  `ctid` selected by the CTE cannot have been recycled by the time the `DELETE` resolves it.
  The same idiom split across two statements would not be safe.
- **`SET NULL` gets a backup too.** Nulling a column destroys the old value.
- **`NOT VALID` and `VALIDATE` are separate.** `ADD CONSTRAINT … NOT VALID` takes a brief
  `ACCESS EXCLUSIVE` to write the catalog row and returns; `VALIDATE CONSTRAINT` scans under
  `SHARE UPDATE EXCLUSIVE`, so reads and writes continue. A plain `ADD CONSTRAINT` holds
  `ACCESS EXCLUSIVE` for the whole scan. Note the lock is taken on the **referenced** table
  too — a long-scanning form blocks writes to `Image`, not only to the referencing table.
- **`IS NOT NULL` in the predicate.** A NULL reference is not an orphan, it is an absent
  one, and a foreign key permits it. Counting NULLs would inflate every count and make a
  `SetNull` remediation set columns that are already NULL.

## Tests

`__tests__/harness.test.ts` exists because the headline claim of this module is a **zero**:
"planning the `SetNull` relations emits no `DELETE`". A zero from an instrument that has
never been shown to produce anything else is a fact about the instrument. Every assertion
helper is exercised there against an input it must report on and one it must not, and
`production-plan.test.ts` runs the `Cascade` set through the *same* plan and the *same*
helper as a positive control. The pair is the evidence; neither half is.
