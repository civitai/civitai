# Retool → moderator database cutover

One-off SQL that moves the moderation tables off Retool's Postgres. Run by hand, in order — this repo
never auto-applies migrations.

**Read [`docs/moderator-app/retool-db-cutover.md`](../../../../docs/moderator-app/retool-db-cutover.md)
first.** It carries the measured state, why the delta is computed the way it is, and the open questions.
These files are the mechanism; that document is the reasoning.

| File | Runs against | Writes? |
| --- | --- | --- |
| `01-export-from-retool.sql` | Retool | no — CSVs out |
| `02-stage-load.sql` | moderator DB | staging schema only |
| `03-merge.sql` | moderator DB | **yes** — the only step that touches `public` |
| `04-verify.sql` | moderator DB | no — the gate |
| `05-rollback.sql` | moderator DB | **yes** — undoes `03` |

```bash
psql "$RETOOL_DATABASE_URL"    -v ON_ERROR_STOP=1 -f 01-export-from-retool.sql
psql "$MODERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f 02-stage-load.sql
psql "$MODERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f 03-merge.sql
psql "$MODERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f 04-verify.sql
```

Steps 1 and 2 write nothing you cannot throw away; step 3 is the commitment. All four run from this
directory, because the `\copy` paths are relative to the working directory.

**A non-zero exit from `04-verify.sql` means stop.** It fails on an unresolved id conflict, a staged row
that did not land, a remapped row that did not survive, or a sequence that could re-issue a live id.

**Freeze Retool writes between step 1 and the app being repointed.** Anything written to Retool after the
export is not in the CSVs.
