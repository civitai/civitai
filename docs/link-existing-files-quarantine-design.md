# Quarantine replaced files (30-day grace) — design

_Adjusts PR #286 (Dedupe Model Resources / Link Existing Files). ClickUp epic [868k69041](https://app.clickup.com/t/868k69041)._

## Problem

Today, when a linked component is created with a `replaceFileId`, the redundant local file is
**hard-deleted immediately**: `addLinkedComponent` (`model-version.service.ts:2214`) calls
`deleteFile`, which deletes the `ModelFile` row and fire-and-forget deletes the S3 object. This is
irreversible — a bad match, a wrong dedupe pair, or an operator mistake loses the original bytes with
no recovery.

The bulk dedupe job (`dedupe-official-uploads.ts:105`) passes `replaceFileId` too, so these
irreversible deletions happen at **backfill volume**, not just on occasional user clicks.

## Goal

Replace the immediate delete with a **30-day quarantine**: on link, the redundant file is flagged and
hidden (bytes retained); a daily job purges the S3 object after 30 days and keeps the row marked
`dataPurged`; a restore path can bring the file back during the window.

## Non-goals

- No new quarantine table and no `dbKV` list. `KeyValue.set` is a full-JSONB overwrite (no atomic
  append, no prefix scan) → lost-write races + O(n²) growth at backfill volume. Ruled out.
- Restore does **not** auto-remove the linked component (`RecommendedResource`) — that stays the
  existing link-removal flow. Restore only un-flags the file.
- No retroactive recovery of files already hard-deleted before this ships.

## Approach

Flag in place on `ModelFile`, reusing the existing `dataPurged` + `visibility` machinery and mirroring
the `delete-old-training-data.ts` sweep. One new nullable column carries the whole lifecycle.

### New column

```prisma
model ModelFile {
  // ...
  replacedAt DateTime?   // set when replaced by a linked component; null = active
  @@index([replacedAt])
}
```

`replacedAt` does triple duty: **read-path filter** (`null` = active), **sweep age key**, and
**restore signal**. Additive, safe migration. Edit `prisma/schema.full.prisma`, then
`pnpm run db:generate`; the SQL is applied manually (see below) — we do **not** run
`prisma migrate deploy`.

### Lifecycle

| State | `replacedAt` | `visibility` | `dataPurged` | S3 object | Restorable |
|---|---|---|---|---|---|
| Active | `null` | (unchanged) | `false` | present | n/a |
| Quarantined (0–30d) | set | `Private` | `false` | present | ✅ |
| Purged (>30d) | set | `Private` | `true` | deleted | ❌ |

### 1. Link time — flag instead of delete

In `addLinkedComponent`'s `replaceFileId` branch (`model-version.service.ts:2214`), replace the
`deleteFile(...)` call with a flag update:

```
UPDATE "ModelFile"
SET "replacedAt" = now(),
    "visibility" = 'Private',
    "metadata" = jsonb_set(... 'replacedBy', { recommendedResourceId, at, priorVisibility })
WHERE id = replaceFileId
```

- No S3 delete, no row delete.
- Stash `metadata.replacedBy = { recommendedResourceId, at, priorVisibility }` so restore can revert
  `visibility` exactly and reference the link.
- Bust `filesForModelVersionCache` for the version.
- Keep the existing pre-write validation in `addLinkedComponent` (never flag a primary/Training Data
  file).

### 2. Hide quarantined rows from component lists

Because the row now persists, every **version file-list** read must exclude `replacedAt IS NOT NULL`.
Add the filter (ideally via a shared `activeModelFileWhere = { dataPurged: false, replacedAt: null }`
fragment) at:

- `fetchModelFilesForCache` (`model-file.service.ts:30`) — the hot chokepoint feeding
  download / generation / resource-data. **Currently filters nothing** → must add `replacedAt: null`.
- `model.selector.ts:143` files `where` (currently `dataPurged: false`).
- `model.service.ts` `dataPurged: false` sites (≈3).
- `model-version.controller.ts` `loadModelVersion` (line ~147) — the `files` select used by public `getById` and owner-edit; add `where: { replacedAt: null }` (found during the Task 3 audit; not in the original audit list).

Covered **for free** by the `visibility = 'Private'` flip (these already `filter(visibility === Public)`):

- `model-search.service.ts:222`, `api/v1/model-versions/[id].ts:201`, `api/v1/models/[id].ts:105`.

### 3. Download safety

`file.service.ts:292`/`:299` already force `visibility = Public` for non-owner/non-mod, so the
`Private` flip blocks public download during quarantine. Mods retain download (needed to verify a file
before restore). No new download gate required.

### 4. Sweep job (new, daily)

New job mirroring `delete-old-training-data.ts`:

```
SELECT id, url FROM "ModelFile"
WHERE "replacedAt" < now() - interval '30 days'
  AND "dataPurged" IS NOT TRUE
→ deleteModelFileObject(url)   -- refcount-guarded (NOT raw deleteObject)
→ UPDATE "ModelFile" SET "dataPurged" = true WHERE id = ...
```

- Use `deleteModelFileObject` (refcount-guarded), **not** the raw `deleteObject` that
  `delete-old-training-data` uses — a replaced host file's url could theoretically be shared; don't
  leak-delete a still-referenced object.
- Keep the row (Option B): `dataPurged = true` leaves a permanent "replaced by a link" audit trail.
- Register in `src/pages/api/webhooks/run-jobs/[[...run]].ts`. 30-day window as a constant (follows
  `delete-old-training-data` precedent).

### 5. Restore endpoint (in scope)

tRPC mutation `restoreReplacedFile({ fileId })` (sibling of the link mutations on the model-file /
model-version router).

- **Guard**: **moderator-only**. The risky case is the official/system bulk-dedupe mistake, and
  restore reverts a moderation-adjacent action; keep it off the owner surface.
- **Precondition**: `replacedAt IS NOT NULL AND dataPurged = false` → else `BAD_REQUEST` (already
  purged / not replaced).
- **Action**: set `replacedAt = null`, restore `visibility` from `metadata.replacedBy.priorVisibility`
  (default `Public`), clear `metadata.replacedBy`, bust `filesForModelVersionCache`,
  `preventReplicationLag`.
- Does **not** remove the `RecommendedResource` link — use the existing link-removal flow for that.

## Tradeoffs / call-outs

- **Deferred S3 savings**: the bulk dedupe job auto-switches to flag-mode, so backfill bytes are now
  **retained 30 days, not freed immediately**. Deliberate price of the backup window.
- **Blast radius is the read-path audit** (§2). Downloads/API/search are covered by the visibility
  flip; the internal cache + selectors need the `replacedAt: null` filter. Miss one and a redundant
  file reappears in a component list (correctness/UX, not a data-loss bug).

## Migration SQL (apply manually)

```sql
ALTER TABLE "ModelFile" ADD COLUMN "replacedAt" timestamptz;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ModelFile_replacedAt_idx"
  ON "ModelFile" ("replacedAt") WHERE "replacedAt" IS NOT NULL;
```

Surface to the user for manual apply to preview / staging / prod.

## Testing

- `addLinkedComponent` replaceFileId path: file flagged (`replacedAt` set, `visibility=Private`,
  `metadata.replacedBy` populated), **not** deleted, S3 untouched.
- Read paths: a quarantined file is absent from `fetchModelFilesForCache`, `getModelVersion` detail,
  and public API/search; still visible/downloadable to a mod.
- Sweep job: only rows `> 30d` and `dataPurged=false` are purged; S3 delete is refcount-guarded; row
  survives with `dataPurged=true`.
- Restore: succeeds while `dataPurged=false` (visibility reverts to prior); rejects once purged.
