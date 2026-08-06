# Retiring `Availability.EarlyAccess` on model versions

Gating moved to the `PaidAccess` table. `ModelVersion.availability = 'EarlyAccess'` is a leftover from
before that cutover — nothing writes it any more, but several readers still branch on it, and while any row
carries it those branches stay load-bearing.

Not a Prisma migration. Run the SQL by hand and delete this file when the last step lands.

## Where things stand

Verified 2026-08-05:

|                                                       | count                               |
| ----------------------------------------------------- | ----------------------------------- |
| Model versions with `availability = 'EarlyAccess'`    | **0** — step 2 run 2026-08-05 ✅    |
| …permanent gate (`endsAt IS NULL`) — never expires    | 16                                  |
| …timed, still active — clears itself on expiry        | 130                                 |
| …timed, already expired — should have cleared, didn't | 6                                   |
| …not `Published` — the job skips these                | 9                                   |
| Rows with no gate at all                              | **0** ✅ _(285 cleared 2026-08-05)_ |

**No writer remains.** `early_access_trigger.sql` would set it, but that trigger is **not installed** — only
`trigger_comic_chapter_early_access_ends_at` exists, and comics are a separate entity. `earlyAccessConfig`,
which fed it, has no remaining writer either.

**Step 1 is done** (in `process-ending-early-access.ts`): the republish now clears `availability` only when
it is `EarlyAccess`, instead of forcing `'Public'` unconditionally. Unrelated to the retirement but found on
the way — **13 gated versions are `Private`**, and an expiring gate would have published them. They escape
today only because all 13 gates are permanent and never reach that query.

---

## Step 2 — clear the remaining 152 — DONE 2026-08-05 (verified 0 rows)

The 130 active timed gates will clear themselves as they expire, but there's no reason to wait, and the 16
permanent ones never will.

Safe because gating no longer depends on this column: `hasEntityAccess` computes `paidGatedIds` from
`PaidAccess` and gates on that independently, so these versions stay gated after the update.

Count first — expect 152:

```sql
SELECT count(*) FROM "ModelVersion" WHERE "availability" = 'EarlyAccess';
```

Then:

```sql
UPDATE "ModelVersion" mv
SET "availability" = 'Public'
WHERE mv."availability" = 'EarlyAccess'
  -- Never publish something the creator made Private. No row matches this today (all 13 Private gated
  -- versions are already excluded by the filter above) — it's here so a re-run after new data can't.
  AND mv."availability" <> 'Private';
```

Verify — expect `0`:

```sql
SELECT count(*) FROM "ModelVersion" WHERE "availability" = 'EarlyAccess';
```

**Bust caches after this.** The update is a direct write, so the main app's model-version caches won't see
it. `POST /api/v1/model-versions/bust-cache` with the affected ids, or accept up to a day of staleness.

---

## Step 3 — remove the readers

Only after step 2 verifies `0`. Each is safe on its own once no row carries the value; do them in any order.

### 3a. — the writePaidAccessForModelVersion reconciliation is already removed (safe now that the count is 0)

### 3a. `process-ending-early-access.ts` — drop the reconciliation pass

The second `UPDATE` exists solely to un-strand rows left at `EarlyAccess` by something re-setting it after
republish. Nothing re-sets it any more, so it can only ever match zero rows. Delete the whole `reconciled`
query and fold `republished` into `updated`.

While there, the `CASE` added in step 1 can collapse back to nothing — with no row carrying `EarlyAccess`,
the job should stop touching `availability` altogether and only bump `publishedAt`.

### 3b. `common.service.ts` — simplify `isOpenAccess`

```ts
const isOpenAccess = (entityId, availability) =>
  OPEN_ACCESS_AVAILABILITY.some((a) => a === availability) && !paidGatedIds.has(entityId);
```

The `availability` half is what excluded `EarlyAccess`; with no such rows it only ever excludes `Private`.
Worth keeping — but the comment above it claiming gated-ness "comes from `PaidAccess`, not `availability`"
becomes true rather than aspirational, and should say so.

### 3c. `model.service.ts:1082` — drop the `|| mv.availability === 'EarlyAccess'`

Harmless either way; it treats the value as visible alongside `Public`.

### 3d. Delete `prisma/programmability/early_access_trigger.sql`

Not installed in prod, and it would write the value if anyone ever applied it. Removing it is the point of
the exercise — leaving it is how the column comes back.

Check nothing re-creates it:

```sql
SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE '%early_access%';
-- expect only: trigger_comic_chapter_early_access_ends_at
```

### 3e. `model_availability_trigger.sql`

```sql
UPDATE "ModelVersion" SET availability = 'Public'
WHERE "modelId" = NEW.id AND availability != 'EarlyAccess';
```

The exclusion becomes a no-op. Removing it needs a migration to replace the function, so it's the one piece
worth deferring until something else touches that trigger.

---

## Not in scope

`ComicChapter` still uses `Availability.EarlyAccess` legitimately — `comics.router.ts` writes it and
`trigger_comic_chapter_early_access_ends_at` is live. **Do not remove the enum value itself.**
