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
a run imports only what is not already marked, so a partial failure resumes rather than duplicating.

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

`verify()` re-reads the imported rows and fails the run if any is countable. It is the gate, not a
formality, and it runs automatically after `--apply`.

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

The source table is never modified by any of this, so a rollback loses nothing.

## Sequencing — one deploy, and the script whenever

**There is no ordering requirement.** Deploy this and run the script before it, after it, next week, or
per-environment on different days. Two properties make that true:

- **The script writes nothing new to the schema.** Only existing columns and existing enum values
  (`ManualModAction`, `Expired`), so the currently-deployed build already understands every row it
  writes. There is no expand/contract step and no migration file.
- **The display is import-aware.** `getUserStrikes` and `strikeCountsByUserIds` subtract the legacy ids
  already carrying a marker in `UserStrike`, so each strike is counted on exactly one side:

  | State | Live list | "Plus N from the Retool era" |
  | --- | --- | --- |
  | Before the import | strikes issued since the cutover | N = all legacy rows |
  | Part-way through | + what has landed | N = the remainder |
  | After the import | everything | line disappears (N = 0) |

The marker protocol both sides share is `src/lib/legacy-strike-import.ts`, covered by
`src/lib/__tests__/legacy-strike-import.test.ts`. If the writer and the readers ever disagree nothing
errors — an account's history is simply listed twice — which is why it is one definition with tests
rather than a string in two files.

### Retiring the legacy read

Optional cleanup, not a required second deploy. Once the import has run everywhere, `getUserStrikes`,
`strikeCountsByUserIds`, `legacyStrikeCount` and the collapsed count beneath `StrikeList` can all go.
Until then they cost one indexed query and are what makes an un-migrated environment still show history.

## Status

- [ ] Applied to **preview**
- [ ] Applied to **production**
- [ ] Legacy read retired (after both of the above)
