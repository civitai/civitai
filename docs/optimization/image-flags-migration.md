# Image Boolean Fields to Flags Migration

## Overview

This document describes the work required to fully migrate Image boolean columns to use the bitwise `flags` column. Currently, reads have been migrated to use flags, but writes still update the individual boolean columns (which are synced to flags via database trigger).

## ImageFlags Enum Reference

Location: `src/server/common/enums.ts:217-232`

```typescript
export enum ImageFlags {
  nsfwLevelLocked = 1 << 0,  // 1
  tosViolation = 1 << 1,     // 2
  hideMeta = 1 << 2,         // 4
  minor = 1 << 3,            // 8
  poi = 1 << 4,              // 16
  acceptableMinor = 1 << 5,  // 32
  promptNsfw = 1 << 6,       // 64
  resourcesNsfw = 1 << 7,    // 128

  // Trigger driven flags
  hasPrompt = 1 << 13,       // 8,192
  madeOnSite = 1 << 14,      // 16,384
}
```

## Current State

### Reads (Completed)

The following files have been updated to READ from flags using bitwise operations:

| File | Description |
|------|-------------|
| `src/server/services/image.service.ts` | Main image queries use flags for SELECT and WHERE |
| `src/server/search-index/metrics-images.search-index.ts` | Search index uses flags |
| `src/server/search-index/images.search-index.ts` | Search index uses flags |
| `src/server/redis/caches.ts` | `imageMetaCache` uses flags for hideMeta check |

### Writes (Need Migration)

The following locations write to boolean columns and need to be updated:

---

## Write Locations to Migrate

### 1. Raw SQL Updates in `image.service.ts`

#### Location: `src/server/services/image.service.ts:379`
**Function:** `bulkApproveImages`
**Current:**
```sql
"poi" = false,
```
**Change to:**
```sql
"flags" = "flags" & ~16,  -- Unset poi flag (16)
```

#### Location: `src/server/services/image.service.ts:382`
**Function:** `bulkApproveImages`
**Current:**
```sql
"minor" = CASE WHEN "nsfwLevel" >= 4 THEN FALSE ELSE TRUE END,
```
**Change to:**
```sql
"flags" = CASE
  WHEN "nsfwLevel" >= 4 THEN "flags" & ~8   -- Unset minor flag (8)
  ELSE "flags" | 8                           -- Set minor flag (8)
END,
```

---

### 2. Prisma Updates - nsfwLevelLocked

#### Location: `src/server/services/image.service.ts:4959`
**Function:** `updateImageNsfwLevel`
**Current:**
```typescript
data: { nsfwLevel, nsfwLevelLocked: true, metadata: updatedMetadata },
```
**Change to:** Use raw SQL or add flags update:
```typescript
// Option A: Raw SQL
await dbWrite.$executeRaw`
  UPDATE "Image"
  SET "nsfwLevel" = ${nsfwLevel},
      "flags" = "flags" | ${ImageFlags.nsfwLevelLocked},
      "metadata" = ${updatedMetadata}::jsonb
  WHERE id = ${id}
`;

// Option B: Prisma with additional flags update (if trigger removed)
// Would need custom Prisma extension or raw query
```

#### Location: `src/server/services/report.service.ts:216`
**Function:** Report handling
**Current:**
```typescript
dbWrite.image.update({ where: { id }, data: { nsfwLevelLocked: false } }),
```
**Change to:**
```typescript
dbWrite.$executeRaw`
  UPDATE "Image"
  SET "flags" = "flags" & ~${ImageFlags.nsfwLevelLocked}
  WHERE id = ${id}
`
```

---

### 3. Prisma Updates - acceptableMinor

#### Location: `src/server/services/image.service.ts:5838-5841`
**Function:** `updateImageAcceptableMinor`
**Current:**
```typescript
const image = await dbWrite.image.update({
  where: { id },
  data: { acceptableMinor },
});
```
**Change to:**
```typescript
await dbWrite.$executeRaw`
  UPDATE "Image"
  SET "flags" = CASE
    WHEN ${acceptableMinor} THEN "flags" | ${ImageFlags.acceptableMinor}
    ELSE "flags" & ~${ImageFlags.acceptableMinor}
  END
  WHERE id = ${id}
`;
const image = await dbRead.image.findUnique({ where: { id } });
```

---

### 4. Dynamic Flag Toggle Functions

#### Location: `src/server/services/image.service.ts:5992-6009`
**Function:** `toggleImageFlag`
**Current:**
```typescript
export const toggleImageFlag = async ({ id, flag }: ToggleImageFlagInput) => {
  const image = await dbRead.image.findUnique({
    where: { id },
    select: { [flag]: true },
  });

  if (!image) throw throwNotFoundError();

  await dbWrite.image.update({
    where: { id },
    data: { [flag]: !image[flag] },
  });
  // ...
};
```
**Change to:**
```typescript
const flagMap: Record<string, number> = {
  minor: ImageFlags.minor,
  poi: ImageFlags.poi,
};

export const toggleImageFlag = async ({ id, flag }: ToggleImageFlagInput) => {
  const flagValue = flagMap[flag];
  if (!flagValue) throw throwBadRequestError(`Invalid flag: ${flag}`);

  // Check current flag state using bitwise AND
  const image = await dbRead.$queryRaw<{ hasFlag: boolean }[]>`
    SELECT ("flags" & ${flagValue}) != 0 AS "hasFlag"
    FROM "Image"
    WHERE id = ${id}
  `;

  if (!image.length) throw throwNotFoundError();

  const currentValue = image[0].hasFlag;

  // Toggle the flag
  if (currentValue) {
    await dbWrite.$executeRaw`
      UPDATE "Image" SET "flags" = "flags" & ~${flagValue} WHERE id = ${id}
    `;
  } else {
    await dbWrite.$executeRaw`
      UPDATE "Image" SET "flags" = "flags" | ${flagValue} WHERE id = ${id}
    `;
  }
  // ...
};
```

#### Location: `src/server/services/image.service.ts:6011-6029`
**Function:** `updateImagesFlag`
**Current:**
```typescript
export const updateImagesFlag = async ({
  ids,
  flag,
  value,
}: Pick<ToggleImageFlagInput, 'flag'> & { ids: number[]; value: boolean }) => {
  if (ids.length === 0) return false;

  await dbWrite.image.updateMany({
    where: { id: { in: ids } },
    data: { [flag]: value },
  });
  // ...
};
```
**Change to:**
```typescript
export const updateImagesFlag = async ({
  ids,
  flag,
  value,
}: Pick<ToggleImageFlagInput, 'flag'> & { ids: number[]; value: boolean }) => {
  if (ids.length === 0) return false;

  const flagValue = flagMap[flag];
  if (!flagValue) throw throwBadRequestError(`Invalid flag: ${flag}`);

  if (value) {
    await dbWrite.$executeRaw`
      UPDATE "Image" SET "flags" = "flags" | ${flagValue}
      WHERE id IN (${Prisma.join(ids)})
    `;
  } else {
    await dbWrite.$executeRaw`
      UPDATE "Image" SET "flags" = "flags" & ~${flagValue}
      WHERE id IN (${Prisma.join(ids)})
    `;
  }
  // ...
};
```

---

## Schema Changes Required

### 1. Remove Boolean Columns from Prisma Schema

Location: `prisma/schema.prisma` (Image model, around lines 656-657, 723-724)

Remove these fields after migration is complete:
```prisma
// Remove these from Image model:
hideMeta            Boolean         @default(false)
minor               Boolean         @default(false)
poi                 Boolean         @default(false)
acceptableMinor     Boolean         @default(false)
nsfwLevelLocked     Boolean         @default(false)
tosViolation        Boolean         @default(false)
```

### 2. Database Migration

Create migration to:
1. Ensure all data is synced to flags column (run backfill if needed)
2. Drop the boolean columns
3. Drop the sync trigger (if exists)

```sql
-- Migration: Remove boolean columns from Image table
-- IMPORTANT: Verify backfill is complete before running

-- Drop columns
ALTER TABLE "Image" DROP COLUMN IF EXISTS "hideMeta";
ALTER TABLE "Image" DROP COLUMN IF EXISTS "minor";
ALTER TABLE "Image" DROP COLUMN IF EXISTS "poi";
ALTER TABLE "Image" DROP COLUMN IF EXISTS "acceptableMinor";
ALTER TABLE "Image" DROP COLUMN IF EXISTS "nsfwLevelLocked";
ALTER TABLE "Image" DROP COLUMN IF EXISTS "tosViolation";

-- Drop sync trigger if exists
DROP TRIGGER IF EXISTS image_flags_sync_trigger ON "Image";
DROP FUNCTION IF EXISTS sync_image_flags();
```

---

## Additional Files to Check

These files reference the boolean columns but may be for other tables (Model, not Image):

| File | Line | Notes |
|------|------|-------|
| `src/server/services/model-flag.service.ts:55-57` | Model table, not Image |
| `src/server/services/model.service.ts:332-343` | Model table, not Image |
| `src/server/services/model.service.ts:1688` | Model table, not Image |
| `src/server/metrics/model.metrics.ts:377,478,510` | Review/Comment tosViolation, not Image |

---

## Backfill Scripts

Existing backfill scripts that should be removed after migration:

| File | Purpose |
|------|---------|
| `scripts/backfill-image-flags.js` | Backfills flags from boolean columns |
| `src/pages/api/admin/temp/backfill-image-flags.ts` | Admin endpoint for backfill |

---

## Migration Steps

1. **Verify backfill completion** - Ensure all images have flags synced
2. **Update write operations** - Convert all Prisma/SQL writes to use flags
3. **Test thoroughly** - Verify all flag operations work correctly
4. **Remove boolean column references** - Update any remaining reads
5. **Create database migration** - Drop boolean columns
6. **Remove backfill scripts** - Clean up temporary code
7. **Update Prisma schema** - Remove boolean fields from model

---

## Testing Checklist

- [ ] `bulkApproveImages` correctly unsets poi/minor flags
- [ ] `updateImageNsfwLevel` correctly sets nsfwLevelLocked flag
- [ ] `updateImageAcceptableMinor` correctly toggles acceptableMinor flag
- [ ] `toggleImageFlag` correctly toggles minor/poi flags
- [ ] `updateImagesFlag` correctly bulk updates minor/poi flags
- [ ] Report handling correctly unsets nsfwLevelLocked flag
- [ ] Search indexes correctly read from flags
- [ ] Image queries correctly filter by flags
