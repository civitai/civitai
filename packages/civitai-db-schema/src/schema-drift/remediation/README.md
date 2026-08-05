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

# Plan one relation against the live database, with a real orphan count. Read-only.
pnpm --filter @civitai/db-schema fk-remediate --measure --relation ImageTagForReview.imageId

# The whole sweep. ~27 anti-joins, several over tables with millions of rows — has to be
# asked for by name, and belongs on a clone rather than a database serving live reads.
pnpm --filter @civitai/db-schema fk-remediate --measure --all-relations
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

**Twelve** relations must never receive a foreign key, for reasons that live outside the
schema and that a purely action-derived planner cannot see.

The set is **derived, not handed** — twice over a primary source, because a list someone
gives you is not a population:

- **A. Deliberately dropped by a committed migration.** All 688 files under
  `prisma/migrations` scanned for `ADD`/`DROP CONSTRAINT` on each of the 37 expected
  constraint names, keeping those whose *last* recorded operation is a `DROP`. Three:
  **`Article.coverId`** (`20250614053144_remove_article_cover_id_fkey`, a migration whose
  entire content is that one drop); **`ImageConnection.imageId`** (dropped by
  `20240307231126_nsfw_level_update_queue` — the same migration that drops the four
  `CollectionItem` keys and introduces `JobQueue`, i.e. the deliberate replacement of
  FK-enforced cleanup with an application-level queue); and **`TagsOnImageNew.imageId`**,
  which is a *different* migration pair — the table did not exist in 2024, and its key was
  added by `20250303170613_tags_on_image_new` and dropped by
  `20250314203912_drop_tags_on_image`, one day after the trigger took over.

  🔴 **What the criterion actually depends on.** Applied literally to every constraint name
  in the schema it returns eight, not three; it narrows to three only in conjunction with
  the live catalog, i.e. restricted to relations that are *also* currently missing their
  foreign key. A `RENAME CONSTRAINT` is invisible to a last-operation timeline (one did
  occur, `ModelHash.modelVersionId`, and was filtered out by the catalog restriction rather
  than by the method noticing it), and the scan assumes Prisma's `<Table>_<column>_fkey`
  naming — six foreign keys here do not follow it, one of them inside the 37.
- **B. Rebuilt by a CTAS.** `recreateRankTable` rebuilds a rank table with
  `CREATE TABLE "<X>Rank_New" AS SELECT * FROM "<X>Rank_Live"` → `DROP` → rename, and a CTAS
  copies no constraints — so a foreign key added there is gone at the next refresh,
  silently. A constraint that can be added and cannot be kept is *recurring* drift, which is
  worse than permanent drift. All **nine** `*Rank` relations.
- **C. Enforced by a trigger instead.** `TagsOnImageNew.imageId` again, independently: the
  live `after_image_delete_trigger` body is
  `DELETE FROM "TagsOnImageNew" WHERE "imageId" = OLD.id`.

Two of those went missing from earlier revisions of this list, both because it was taken as
given rather than derived: `ArticleRank.articleId` (the brief named six rank relations; the
mechanism is table-shaped, not action-shaped, and `ArticleRank` is one of only two whose
refresh is still uncommented) and `ImageConnection.imageId`. `QuestionRank.questionId` and
`AnswerRank.answerId` are listed as defence in depth — they are backed by views today, so
the planner already refuses them three times over, but each of those protections is
incidental and one of them, `NoAction`, is exactly what #3589 removed from the other seven.

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

| code                        | meaning                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `missing-index`             | no index whose **leading** key columns are the referencing columns    |
| `index-coverage-unknown`    | the catalog carried no index list, so absence could not be established |
| `orphan-count-not-measured` | orphans have not been counted                                        |
| `constraint-validity-unknown` | a constraint exists but the catalog carried no `convalidated` data |

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
INSERT INTO "fk_remediation_backup"."T_c_orphans" ("c1", "c2", …)
SELECT "c1", "c2", … FROM moved;

-- 4. add without scanning, under a BOUNDED lock wait
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE "T" ADD CONSTRAINT "T_c_fkey" FOREIGN KEY ("c") REFERENCES "R"("id")
  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
COMMIT;

-- 5. validate, as a SEPARATE statement
ALTER TABLE "T" VALIDATE CONSTRAINT "T_c_fkey";
```

Six things about these are load-bearing:

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
- **The lock wait on step 4 is bounded.** `ADD CONSTRAINT ... FOREIGN KEY` takes
  `ACCESS EXCLUSIVE` on the referencing table and `SHARE ROW EXCLUSIVE` on the **referenced**
  one. `NOT VALID` keeps the *scan* off the hot path, but the statement still has to
  *acquire* those locks — so it queues behind any in-flight transaction on either table, and
  every query arriving after it queues behind the ALTER. On `Image` (the most-referenced
  table here, and 21 of these relations point at it) an unbounded wait is a site stall.
  `SET LOCAL` keeps the setting from leaking onto a pooled connection. A `lock_timeout`
  expiry is the *desired* failure — nothing changed, and the executor retries it (5 times by
  default). Only SQLSTATE `55P03` is retried; every other error is re-raised untouched.
- **The backup INSERT names its columns.** `IF NOT EXISTS` reuses a backup table an earlier
  run created, so if the source table has since gained or lost a column, `SELECT t.*` either
  errors on the count or writes each value into its neighbour's column. Naming them makes a
  stale backup fail loudly on the missing name instead.

## 🔴 An interrupted run, and why `convalidated` is read

There is no `ADD CONSTRAINT ... IF NOT EXISTS` in Postgres, and these statements autocommit.
A run that dies between step 4 and step 5 leaves a constraint that is **present and only
half-enforcing**: it constrains new and changed rows and has never checked the ones already
there.

Any catalog read filtering on `contype = 'f'` alone — which is what the drift detector does
— reports that as an ordinary foreign key. So the relation would come back `satisfied`,
execution would refuse with "no actionable relation", and the campaign could never finish
it, with the detector calling it clean the whole time.

**This is the expected outcome, not an edge case.** `VALIDATE CONSTRAINT` scans the whole
table and a statement-timeout ceiling applies, so validation will be killed on the large
tables in this backlog (`Collection` 16.9M, `TagsOnImageVote` 12M, `ImageEngagement` 5.9M,
`ImageTool` 5.7M). A pooler's `query_timeout` overrides anything a client `SET`s, so this
tool **cannot raise that ceiling and does not try**.

What it does instead is read `pg_constraint.convalidated` and treat "exists" as three states:

| `constraintValidity` | outcome            | what runs                                    |
| -------------------- | ------------------ | -------------------------------------------- |
| `validated`          | `satisfied`        | nothing                                      |
| `not-valid`          | `needs-validation` | `VALIDATE` alone — `ADD` is **not** reissued |
| `unknown`            | `satisfied` + prerequisite | nothing, and it says the state is unestablished |
| `absent`             | the ordinary path  | all five steps                               |

`VALIDATE` is itself resumable: a failed or timed-out `VALIDATE` leaves the constraint
`NOT VALID` and changes nothing else, so it can be retried as many times as needed. If it
cannot complete inside the ceiling at all, the honest answer is that the constraint stays
`NOT VALID` — enforcing going forward, never verified backwards — and that is visible in
every subsequent plan rather than hidden.

## Tests

`__tests__/harness.test.ts` exists because the headline claim of this module is a **zero**:
"planning the `SetNull` relations emits no `DELETE`". A zero from an instrument that has
never been shown to produce anything else is a fact about the instrument. Every assertion
helper is exercised there against an input it must report on and one it must not, and
`production-plan.test.ts` runs the `Cascade` set through the *same* plan and the *same*
helper as a positive control. The pair is the evidence; neither half is.

## Limitations

Things this tool does **not** consider. None of them are checked, so their absence from a
plan is not evidence that they are fine.

- **Triggers.** The tool has no trigger awareness at all. It reads `pg_catalog` for tables,
  columns, constraints and indexes, and nothing else. That matters in both directions: a
  trigger may already enforce what a constraint would (`TagsOnImageNew` is the known case,
  and it is on the never-add list for that reason — but it is on the list because someone
  looked, not because the tool detected it), and a trigger may make the remediation itself
  fail. `ImageResourceNew` has an `AFTER DELETE … FOR EACH ROW` trigger that runs
  `REFRESH MATERIALIZED VIEW CONCURRENTLY`, which cannot run inside a transaction, so a
  qualifying batch would error with SQLSTATE 25001. **`ImageResourceNew.imageId` is in the
  Cascade set and this is not guarded.** Detection was deliberately not implemented: the
  committed programmability files have already drifted from what is deployed, so a check
  built from them would assert something unverifiable. **Before remediating any relation,
  read the triggers on its table.**
- **Rules, deferred constraints, inheritance and partitioning.** Not read.
- **Whether the orphan rows should be removed at all.** A `READY` outcome means the
  mechanics are safe, not that the change is correct. Whether a referenced entity is
  soft-deleted rather than gone, and whether an application-level cleanup already owns the
  relation, are product questions this tool cannot answer.
- **`VALIDATE CONSTRAINT` completing.** See above — it can be killed by a statement
  timeout the tool cannot raise. The state is then resumable and visible, not finished.
- **Replication lag and downstream consumers.** A large batched DELETE generates WAL.
- **Scale.** The end-to-end exercise behind this module ran against a disposable local
  PostgreSQL with fixtures of a few thousand rows: **no concurrent load, no connection
  pooler, no index bloat, no replication, and nothing resembling the 120M-row `Image`
  table** most of these relations reference. What it established is transaction, lock and
  catalog *semantics* — not timings, not lock-queue behaviour under real traffic, and not
  how long a `VALIDATE` takes on a large table. Treat every duration and batch count here
  as unmeasured at production scale.
- **Whether the catalog is current.** With `--catalog` it is a snapshot, and a snapshot
  captured before `convalidated` was collected cannot establish that any constraint is
  actually enforcing — which the report now says out loud rather than counting as enforced.
