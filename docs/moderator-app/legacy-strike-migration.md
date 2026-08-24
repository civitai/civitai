# Legacy strikes → `UserStrike`

Closes the "two strike systems" decision open since 2026-08-17. `d0820283c0` had already moved the
**write** to the main app's `UserStrike`; the ~12.9k historical rows in the moderator database's
`UserStrikes` were the half left undecided. The moderation team settled it 2026-08-21: **migrate them and
only write there going forward.**

## The shape of the migration

One script: `apps/moderator/moderator-db/migrate-legacy-strikes.ts`.

```bash
pnpm exec tsx --env-file=apps/moderator/.env apps/moderator/moderator-db/migrate-legacy-strikes.ts
pnpm exec tsx --env-file=apps/moderator/.env apps/moderator/moderator-db/migrate-legacy-strikes.ts --apply
```

Dry run by default — it reads both databases, resolves every row, and prints what `--apply` would write.
`--apply` writes and then runs the verification pass in the same process; a failed check exits non-zero.

It is idempotent. Each imported row carries `retool:UserStrikes:<id>` at the head of `internalNotes`, and
a run imports only ids not already present under **either** import marker (see the Correction below), so
a partial failure resumes rather than duplicating.

**Dry run against the live databases, 2026-08-21:**

```text
12902 legacy strikes; 0 already imported.
Would import 12902 (4001 attributed to a moderator, 0 skipped — account gone).
```

Every row has a surviving account, so nothing is dropped. Roughly 8,900 import unattributed — that is the
Retool display-name problem below, not a failure.

**This was five hand-written `.sql` files first, and that was the wrong shape.** It existed only because
the moderator database had no schema and no generated types: a CSV export, a staging schema created
inside the main production database, and raw SQL over identifiers nothing typechecked. Now that the
database is introspected into `apps/moderator/src/lib/server/moderator-db/types.ts` and reachable from
Kysely, the whole thing is one typed script against both connections — no CSVs, no staging schema in
prod, and every column name checked at build time by `pnpm run typecheck:scripts`.

The typing paid for itself immediately: the hand-written types had `UserStrikes.userId`, `createdBy` and
`reason` as nullable, so the SQL defended against nulls that the real schema does not permit.

## The one thing that matters

Imported rows land **`Expired`, `points = 0`, `expiresAt = createdAt`**.

That is the whole design, and it is not a shortcut. `evaluateStrikeEscalation` sums points over
`status = 'Active' AND "expiresAt" > NOW()`; at `INDEFINITE_MUTE_POINTS` it mutes with no end date.
Importing 12.9k historical strikes as Active would mute a large share of the accounts in that table the
next time anything re-evaluated them — an enforcement action nobody took, on evidence up to four years
old, delivered as a typed notification to each of them.

So the migration preserves **history**, not enforcement state:

- a moderator opening an account sees its past strikes in one list, with dates and reasons
- the escalation ladder counts only what the current system has issued

`verify()` re-reads the imported rows and fails the run if any is countable, automatically after
`--apply`. It sees only the rows **this** script inserted — see the Correction below for what that
misses.

## What is lost, and why

| Field | Outcome |
| --- | --- |
| Reason category | Every row imports as `ManualModAction`. The legacy table had one free-text column and no category; the text becomes `description`. |
| Issuing moderator | Set only where `createdBy` matches a Civitai username exactly. The column holds Retool display names historically and usernames since the port, and a fuzzy match would credit the wrong person — worse than crediting nobody. The run reports how many resolved. |
| Rows with no account | Skipped and counted. Nothing can display a strike against an account that does not exist. |

## Rolling back

There is no separate rollback script: the marker identifies exactly what the migration inserted, and
strikes issued by the app carry no such marker.

```sql
DELETE FROM "UserStrike" WHERE "internalNotes" LIKE 'retool:UserStrikes:%';
```

The source `UserStrikes` table is never modified by any of this, so the history is always recoverable
by re-running the import.

⚠️ **Since the 2026-08-24 cleanup this is no longer a return to the previous state.** The first-pass
copies that used to sit beside these rows are gone, so running the `DELETE` now leaves `UserStrike` with
no Retool-era history at all until the import is re-run.

## Sequencing — one deploy, and the script whenever

**There is no ordering requirement.** Deploy this and run the script before it, after it, next week, or
per-environment on different days. Two properties make that true:

- **The script writes nothing new to the schema.** Only existing columns and existing enum values
  (`ManualModAction`, `Expired`), so the currently-deployed build already understands every row it
  writes. There is no expand/contract step and no migration file.
- **The display was import-aware while both stores were read.** `strikeCountsByUserIds` subtracted the
  legacy ids already carrying a marker in `UserStrike`, so a part-migrated environment never showed a
  strike twice and never dropped one. That second reader was retired 2026-08-21 (see below), so the live
  list is now the only place strikes appear.

The marker protocol both sides share is `src/lib/legacy-strike-import.ts`, covered by
`src/lib/__tests__/legacy-strike-import.test.ts`. If the writer and the readers ever disagree nothing
errors — an account's history is simply listed twice — which is why it is one definition with tests
rather than a string in two files.

### Retiring the legacy read

Done, 2026-08-21 (`2b7639a3ab`). `getUserStrikes`, `legacyStrikeCount` and the panels that rendered them
are gone. `strikeCountsByUserIds` stays: the shared-IP and shared-link panels are the only place their
number appears and have no live-strike reader beside them, so it must keep subtracting.

## Correction — an earlier import this document did not know about (2026-08-24)

The idempotency claim above is true only of **this** script's own marker. A **first** import pass
had already copied the same legacy rows into `UserStrike`, marked `Imported from Retool strike #<id>. Issued
by: …`, and the version that ran on 2026-08-21 could not see that marker — so it duplicated all 12,381 of them.
`alreadyImported()` now consults both, so a re-run resumes rather than re-importing.

The two passes disagree on exactly the property this document calls "the one thing that matters": the
first-pass rows are **Active, 1 point, 365-day lifetime**, so they DO count on the escalation ladder.
Measured against production 2026-08-24 **before the cleanup below**: 3,895 still Active across 3,452
accounts, 414 accounts at 2+ points and 36 at 3+ almost entirely on imported points. Those rows are now
deleted — see The cleanup, and [strike-rules.md](strike-rules.md) §10 item 7.

`verify()` did not catch this because it only re-reads the rows **this** script inserted. Its
dupes check compares second-pass markers against each other, so a duplicate wearing the other pass's
marker is invisible to it — the check proves the script did not run twice, not that a legacy strike
appears once.

### The cleanup

`apps/moderator/moderator-db/remove-duplicate-legacy-strikes.ts`, dry-run by default:

```bash
pnpm exec tsx --env-file=apps/moderator/.env apps/moderator/moderator-db/remove-duplicate-legacy-strikes.ts
pnpm exec tsx --env-file=apps/moderator/.env apps/moderator/moderator-db/remove-duplicate-legacy-strikes.ts --apply
```

It deletes a first-pass row only when a second-pass row holds the same legacy strike id, so the account
keeps its history — on the better copy, which has the real description text, un-shifted timestamps and
resolved attribution. Unpaired rows are reported and kept. Live dry run 2026-08-24: **every one of
them paired, 0 unpaired**.

It does not unmute anyone. `reportStrandedMutes` names, at the end of an `--apply` run, every account
left over-punished on points the delete removed — muted with no points left, or still indefinitely muted
below 3 — so a moderator can act from Mod Studio, which refreshes the session too. A raw `UPDATE` here
would leave them muted in their live session.

## Status

- [ ] Applied to **preview**
- [x] Applied to **production** — 2026-08-21. 12,902 rows across 10,690 accounts, matching `UserStrikes`
      exactly, no marker twice. Checked against the main database rather than trusting the script's own
      `verify()`: 0 non-Expired, 0 with points, 0 with `expiresAt <> createdAt`, 0 countable by
      escalation (`Active AND expiresAt > NOW()`).
- [x] **Duplicate first-pass rows deleted** — 2026-08-24, 12,381 rows. Verified against the main
      database rather than the script's own `verify()`: 0 first-pass rows left, history rows and
      account count unchanged at 12,902 / 10,690, escalation-countable rows down from 3,936 to 41.
      Separately confirmed from the pre-delete snapshot that all of them are preserved on the SAME
      account — 0 cross-account mispairings. Accounts at 2+ points went 414 → 2, at 3+ 36 → 0.
      `reportStrandedMutes` named 2 accounts (7874835, 8394294); both hold 1 point with a
      `muteExpiresAt` within 24h, so the hourly `process-timed-unmutes` job clears them with the
      session refresh — no manual unmute needed. Worth confirming they cleared after 2026-08-25.
- [ ] Legacy read retired — optional cleanup, no longer a correctness problem. The double-reporting
      this bullet used to describe is gone: the User Lookup badge reads "all-time" and `AccountHistory`
      lists one store, so nothing claims a separate Retool era any more. What remains is
      `strikeCountsByUserIds` still cross-querying the moderator database and subtracting every id back
      out — one indexed query that now always contributes 0, kept because the rollback above would put
      those rows back.
