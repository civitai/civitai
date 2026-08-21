# Retool database cutover

How the moderation tables stop living in Retool's Postgres and start living in the moderator database.
Subtask `868kn67aq`.

**This is not a copy job — the copy already happened.** Every table named by the ticket already exists in
the moderator database with its schema and most of its rows. What is left is a delta, a sequence
problem, and one collision that has already occurred.

**Nothing here is applied automatically.** Per the repo's database rule, a human runs the SQL. The
scripts are committed at [`apps/moderator/moderator-db/cutover/`](../../apps/moderator/moderator-db/cutover/).

---

## The two databases — now one

| | Points at | Holds |
| --- | --- | --- |
| `MODERATOR_DATABASE_URL` | the moderator database (18.4) | the moderation tables **and** the xguard-lab tables |
| ~~`RETOOL_DATABASE_URL`~~ | ~~Retool's own Postgres (15.18)~~ | **Retired 2026-08-21.** Gone from `.env.example`; `getModeratorDb()` reads `MODERATOR_DATABASE_URL`. |

They were different instances and the app used to write to Retool's. As of 2026-08-21 it does not: one
variable serves both uses, which is what the rest of this document was planning for.

`MODERATOR_DATABASE_URL` is already the xguard lab's connection string, and the xguard tables
(`label_def`, `eval_run`, `human_judgement`, …) live in that same database. So the two uses converge
rather than conflict: after cutover one variable serves both, and `RETOOL_DATABASE_URL` is retired.
`.env.example` still shows a local `xguard_lab` default for that variable, which is fine for local dev
but is not what a deployed environment should carry.

## What is actually drifting

Measured 2026-08-11. Row counts, and the delta against Retool:

| Table | Moderator DB | Retool | Delta | Notes |
| --- | ---: | ---: | ---: | --- |
| `UserNotes` | 56,341 | 56,579 | **+240** | 2 of these collide — see below |
| `ReToolActions` | 131,047 | 131,267 | +220 | |
| `UserStrikes` | 12,774 | 12,804 | +30 | |
| `Mods_TaskTimers` | 18,603 | 18,625 | **+22** | *not in the handover's list* |
| `FrontPageTimers` | 66,662 | 66,680 | **+18** | *not in the handover's list* |
| `RatingChanges` | 363,465 | 363,472 | +7 | |
| `ModelNotes` | 932 | 935 | +3 | |
| `User` | 25,359 | 25,360 | +1 | flag table; id semantics differ, see below |
| `BuzzCodes` | 294 | 294 | 0 | agreed drop |
| `ModerationImageHelp` | 37 | 37 | 0 | |
| `ModerationSHA` | 29,766 | 29,766 | 0 | |
| `FrontPageTimers_catchup` | 27,692 | 27,692 | 0 | |
| `TimedMutes` | 0 | 0 | 0 | empty on both sides |

**Two tables were drifting that no earlier list mentioned**: `Mods_TaskTimers` and `FrontPageTimers`.
Both are read by the moderator dashboard (queue-lag indicators, the front-page sweep's resume point), so
losing their delta would make those screens quietly wrong rather than empty.

### The copy is otherwise clean

Below each table's watermark the two databases are **byte-identical** — verified by comparing
`md5(string_agg(row::text ORDER BY id))` on both sides, not just counts. So no row was edited in Retool
after the snapshot, and none was deleted. The delta is purely appended rows.

The one exception is `UserNotes`, and it is not an edit.

## The collision has already happened

The premise going in was that the moderator database had taken no writes, so its sequences would hand
out exactly the ids Retool had been assigning — and that copying the delta first would avoid the clash.

**The clash already occurred, twice.** On 2026-08-07 something wrote two `UserNotes` rows into the
moderator database, consuming ids 56342 and 56343 from its sequence. Retool independently assigned those
same two ids to two different notes. Both pairs exist; they are about different users.

The evidence that they are app writes rather than Retool rows: `lastUpdateBy` is a short Civitai
username (the moderator app writes `locals.user.username`) where Retool's rows carry a two-word display
name, and `lastUpdate` has millisecond precision where Retool's is whole seconds.

So the true snapshot watermark for `UserNotes` is **56341**, not its current `max(id)` of 56343, and the
delta is 240 rows rather than 238. Every other table's `max(id)` is a genuine watermark, and the
sequences sit exactly on it.

**The consequence for the plan**: id preservation is no longer universally possible. Two Retool rows
must be given new ids, and which row a moderator was looking at must stay answerable afterwards.

## How the scripts handle it

The pipeline does **not** compute a delta by watermark arithmetic. It exports whole tables from Retool,
stages them in the moderator database, and derives the delta there by anti-joining on the primary key.
That is more data over the wire — about 600K narrow rows in total, which is nothing — and it buys three
properties worth more than the bytes:

- **Idempotent.** Every insert is an anti-join, so re-running after a partial failure is the recovery
  path rather than a hazard.
- **Correct for `User`.** Its `id` is the Civitai `userId` for the legacy import rows and a sequence
  value for the rest, so `max(id)` is 11,157,960 while the sequence sits at 9,081. No watermark
  predicate can express "the new one"; an anti-join can.
- **Tolerant of more drift.** Retool keeps taking writes. Whatever it has when the export runs is what
  lands, with no boundary to recompute by hand.

Order per table: insert the rows whose id is free, advance the sequence past both sides, then re-id
whatever could not keep its id. The sequence step must sit in the middle — the remap draws fresh ids
from the sequence, so the sequence has to be past the rows just inserted or it hands one of them back.

### The remap, and what it refuses to do

A staged row whose id is taken locally is only re-idded when its `userId` differs from the local row's.
A different `userId` means two different subjects, so they are two records and both are kept.

Everything else — an id collision where the `userId` matches, i.e. a genuine disagreement about one
record — is written to `cutover.conflict_review` and **the verify step fails while that table has rows**.
The merge does not guess which side wins when both claim the same note about the same user; that is a
human's call. Today the table comes out empty and the remap is exactly the two rows above.

Sequences are set to `GREATEST(local max, Retool's position)`. For `User` that means the sequence lands
above the legacy `id = userId` rows rather than mirroring Retool's 9,081 — deliberately, because
mirroring Retool reproduces a latent bug Retool already has: its `User_id_seq` is at 9,081 while 42 rows
occupy ids in 9,083–95,258, so it will eventually issue an id that is already taken.

## Running it

```bash
cd apps/moderator/moderator-db/cutover

# 1. read-only, against Retool. Writes CSVs into the working directory.
psql "$RETOOL_DATABASE_URL" -v ON_ERROR_STOP=1 -f 01-export-from-retool.sql

# 2. staging only — nothing in `public` is touched. Safe to inspect and re-run.
psql "$MODERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f 02-stage-load.sql

# 3. the only step that writes. One transaction.
psql "$MODERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f 03-merge.sql

# 4. the gate. Non-zero exit means do not proceed.
psql "$MODERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f 04-verify.sql
```

Step 4 asserts that every Retool row is represented, that every remapped row is intact at its new id,
that no conflict is unresolved, and that no sequence can re-issue a live id. It does **not** compare
whole-table checksums: the target legitimately holds rows Retool never had, so equal checksums would be
the wrong assertion.

`05-rollback.sql` removes exactly what the merge inserted, using the pre-merge id snapshot step 2
captures. It refuses to run if it finds a row it cannot account for, so it cannot delete a write that
landed after cutover.

**Freeze Retool writes between step 1 and step 5.** Anything a moderator writes in Retool after the
export is not in the CSVs and will be stranded.

### These scripts have been exercised

The full pipeline was run against a throwaway PostgreSQL 18.4 instance (matching the target's version)
seeded with synthetic data reproducing the measured shape, including the two double-allocated ids.
Verified: the export/stage/merge sequence, the remap producing the correct two rows, merge idempotency
on re-run, verify passing on a good state and **failing with a non-zero exit** on an injected
same-`userId` conflict, rollback restoring the exact pre-merge state while leaving the app's own rows
untouched, and rollback refusing after a simulated post-cutover write.

> ⚠️ **Measured 2026-08-21: this pipeline HAS been run, at least through step 3.** The moderator
> database carries a populated `cutover` schema (12,902 staged `UserStrikes`, 57,914 staged `UserNotes`)
> with `cutover.id_remap` and `cutover.conflict_review` both empty, i.e. `04-verify.sql`’s first gate
> passes. Live `UserNotes` (58,226) exceeds the staged count, consistent with a completed merge plus
> later app writes. **The paragraph below is the pre-cutover state and is retained as the record of what
> was planned, not of what is true.** Confirm against the environment before running anything here again.

No statement in this pipeline has been run against Retool or the moderator database. Both were read
from only.

## After the data lands

1. ~~Point `getModeratorDb()` at `MODERATOR_DATABASE_URL`~~ **Done 2026-08-21** —
   `apps/moderator/src/lib/server/moderator-db.ts` reads it and `RETOOL_DATABASE_URL` is deleted.
2. Set `MODERATOR_DATABASE_URL` in every deployed environment. This replaces handover item 2, which asked
   for `RETOOL_DATABASE_URL` — that variable is retired by this cutover, not configured.
3. Turn Retool's write access off before anyone uses the app again, or the two diverge from that moment.
4. `DROP SCHEMA cutover CASCADE` once the remap has been read out of `cutover.id_remap` and recorded
   wherever it needs to live. **Do not drop it before that** — it is the only record of which Retool
   note is now under which id.

## `ModelNotes`

Migrate it. It is in the pipeline.

Nothing in the app reads it, so it is tempting to drop — but
the data was exported *into* Retool rather than produced by it, no Retool app writes it, and subtask
`868kn8aa0` asks for these notes surfaced on model pages with add/edit-own. Dropping 935 rows to save
copying 935 rows would only mean sourcing them again later.

It needs no type work: `ModelNotes` is introspected like every other table, with the live columns
`id, modelId, createdBy, createdAt, content`, all `NOT NULL` except `id`'s default.

## `ReToolActions` vs `ModActivity` — handover decision #9

**Recommendation: migrate it as a read-only archive, and do not merge it into `ModActivity`.**

131,267 rows of `Event / User / App / ActionType`, all free text, no foreign keys. The user id is
embedded in the `ActionType` string and Retool queried it with `LIKE '%' || userId || '%'` — which also
matches a substring of a longer id, so the join is not merely absent, it is unreliable.

Merging it into `ModActivity` would require inventing an `entityType`/`entityId` per row from parsed
text, and attributing each row to a moderator through the name mapping that only covers 72% by exact
match. Both inventions would be indistinguishable from real data afterwards. `ModActivity` is the
append-only audit trail the new app writes; polluting it with reconstructed history costs more than the
history is worth.

Keeping it as an archive preserves the pre-`ModActivity` record and keeps its uncertainty visible at the
point of use. `ModActivityPanel.svelte` already carries a comment saying Retool-era actions are not in
`ModActivity`; a link from there into the archive is the cheap version of "reconciled".

**Open question for a human**: whether the archive should be readable in the app at all, or just retained
in the database. Nothing reads it today.

## Open questions

1. **The two colliding `UserNotes` rows.** Which write created them, and was it deliberate? Something
   pointed the moderator app (or a script) at the moderator database on 2026-08-07, while
   `getModeratorDb()` still read `RETOOL_DATABASE_URL`. Worth knowing anyway, because whatever did it
   could do it again and produce more collisions. The scripts handle it either way.
2. **`spamWhitelist` / `deservedMute` live in two places** — as columns on `UserNotes` and as a whole
   `User` table in the same database. Which is authoritative is undecided, and the app reads neither.
3. **`BuzzCodes`** is at parity and confirmed unused. It is excluded from the merge. Drop it, or leave it
   — nobody has said which.
4. **`Mods_TaskTimers` and `FrontPageTimers` were never on the migration list** but are drifting and are
   read by the dashboard. Confirm they are meant to survive Retool rather than being Retool-only
   bookkeeping.
5. **Attribution is still by name.** This cutover moves the columns as they are; it does not apply the
   name → userId mapping in
   [`retool-exports/moderator-id-mapping.md`](retool-exports/moderator-id-mapping.md). That is a separate
   pass, and it is easier after the data is in one place.
6. **`User_id_seq` placement** — set above the legacy `id = userId` rows rather than mirroring Retool.
   Safe against all current data; flagged because it diverges from Retool deliberately.
