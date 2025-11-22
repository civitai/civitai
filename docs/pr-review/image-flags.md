# Image Boolean Fields to Flags Migration - PR Review

This document summarizes the migration of Image boolean columns to use a single bitwise `flags` column for atomic operations and better performance.

## Summary of Changes

- **Data Storage**: Boolean fields (`hideMeta`, `minor`, `poi`, `acceptableMinor`, `nsfwLevelLocked`, `tosViolation`) are now stored as bits in a single `flags` integer column
- **Atomic Operations**: All flag updates now use SQL bitwise operations to prevent race conditions
- **New Helper**: Added `flagUpdate` fluent builder for atomic flag modifications

## ImageFlags Enum Reference

Location: `src/server/common/enums.ts`

| Flag | Value | Bit Position |
|------|-------|--------------|
| `nsfwLevelLocked` | 1 | 0 |
| `tosViolation` | 2 | 1 |
| `hideMeta` | 4 | 2 |
| `minor` | 8 | 3 |
| `poi` | 16 | 4 |
| `acceptableMinor` | 32 | 5 |
| `promptNsfw` | 64 | 6 |
| `resourcesNsfw` | 128 | 7 |
| `hasPrompt` | 8192 | 13 |
| `madeOnSite` | 16384 | 14 |

---

## New Utility: `flagUpdate` Helper

Location: `src/shared/utils/flags.ts:196-280`

A fluent builder for atomic flag updates using SQL bitwise operations:

```typescript
// Set a flag
await flagUpdate(dbWrite, 'Image', imageId)
  .set(ImageFlags.nsfwLevelLocked)
  .execute();

// Unset a flag
await flagUpdate(dbWrite, 'Image', imageId)
  .unset(ImageFlags.poi)
  .execute();

// Set flag to boolean value (avoids if/else)
await flagUpdate(dbWrite, 'Image', imageId)
  .setTo(ImageFlags.acceptableMinor, acceptableMinor)
  .execute();

// Toggle flag using XOR (no read required)
await flagUpdate(dbWrite, 'Image', imageId)
  .toggle(ImageFlags.poi)
  .execute();

// Bulk update multiple records
await flagUpdate(dbWrite, 'Image', [id1, id2, id3])
  .set(ImageFlags.poi)
  .execute();

// Combine multiple operations
await flagUpdate(dbWrite, 'Image', imageId)
  .set(ImageFlags.minor | ImageFlags.poi)
  .unset(ImageFlags.acceptableMinor)
  .execute();
```

**SQL Generated**: `UPDATE "Image" SET flags = ((flags | setMask) & ~unsetMask) # toggleMask`

---

## Files Changed

### Core Utilities

| File | Changes |
|------|---------|
| `src/shared/utils/flags.ts` | Added `flagUpdate` helper with `set`, `unset`, `setTo`, `toggle` methods |
| `src/server/utils/image-flags.ts` | `ImageFlagsBitmask` class for reading flags |

### Image Service

Location: `src/server/services/image.service.ts`

| Function | Line | Change |
|----------|------|--------|
| `bulkApproveImages` | ~379 | Uses bitwise SQL: `"flags" = "flags" & ~16` (unset poi) |
| `bulkApproveImages` | ~382 | Uses CASE with bitwise ops for minor flag based on nsfwLevel |
| `updateImageNsfwLevel` | ~4959 | Single raw SQL query with JSONB merge and `flags \| nsfwLevelLocked` |
| `updateImageAcceptableMinor` | ~5838 | Uses `flagUpdate.setTo()` |
| `toggleImageFlag` | ~6077 | Uses `flagUpdate.toggle()` with XOR (no read required) |
| `updateImagesFlag` | ~6091 | Uses `flagUpdate.setTo()` for bulk updates |
| `getAllImages` | ~1444 | Reads from `i.flags` with bitwise AND for boolean fields |
| `getImageModerationReviewQueue` | ~4613 | Reads from `i.flags` column |

### Other Services

| File | Function | Change |
|------|----------|--------|
| `src/server/services/report.service.ts:216` | Report handling | Uses `flagUpdate.unset(ImageFlags.nsfwLevelLocked)` |
| `src/server/services/image-scan-result.service.ts` | `handleImageAuditResult` | Atomic flag set for `minor` and `poi` after scan |
| `src/pages/api/mod/mark-poi-images-search.ts` | Bulk POI marking | Uses `flagUpdate.set(ImageFlags.poi)` |

### Search Indexes

| File | Changes |
|------|---------|
| `src/server/search-index/images.search-index.ts` | Reads flags with bitwise ops, filters by `tosViolation`, `minor`, `poi` |
| `src/server/search-index/metrics-images.search-index.ts` | Reads all flag values using bitwise AND |

### Selectors

| File | Changes |
|------|---------|
| `src/server/selectors/image.selector.ts` | Includes `flags: true` (used by `collection.utils.ts` for `hideMeta` check) |

---

## Pages & Components to Test

### 1. Image Moderation Queue
**Route**: `/moderator/images`

**What to check**:
- [ ] Images display with correct `minor`, `poi`, `acceptableMinor` flags
- [ ] Toggling `minor` flag works correctly
- [ ] Toggling `poi` flag works correctly
- [ ] Bulk flag updates work

**Affected functions**: `getImageModerationReviewQueue`, `toggleImageFlag`, `updateImagesFlag`

---

### 2. Image Detail / NSFW Level Updates
**Route**: `/images/{imageId}` (moderator view)

**What to check**:
- [ ] Setting NSFW level locks the `nsfwLevelLocked` flag
- [ ] NSFW level reason is saved in metadata
- [ ] Moderator can unlock NSFW level via report handling

**Affected functions**: `updateImageNsfwLevel`

---

### 3. Bulk Image Approval
**Route**: Moderator bulk actions

**What to check**:
- [ ] Bulk approve correctly unsets `poi` flag
- [ ] Bulk approve sets/unsets `minor` flag based on nsfwLevel (>= 4 = not minor)

**Affected functions**: `bulkApproveImages`

---

### 4. Image Acceptable Minor Toggle
**Route**: Moderator image review

**What to check**:
- [ ] Toggling `acceptableMinor` flag works
- [ ] Flag persists after page refresh

**Affected functions**: `updateImageAcceptableMinor`

---

### 5. Image Search Results
**Route**: `/images` (search page)

**What to check**:
- [ ] Images with `tosViolation` flag are excluded
- [ ] Images with `minor` flag are filtered for non-authenticated users
- [ ] Images with `poi` flag are filtered appropriately
- [ ] `hideMeta` flag hides generation metadata
- [ ] `hasMeta` computed correctly from `hasPrompt && !hideMeta`
- [ ] `onSite` computed correctly from `madeOnSite` flag

**Affected functions**: `getAllImages`, search index queries

---

### 6. Collection Items
**Route**: `/collections/{collectionId}`

**What to check**:
- [ ] Article cover images show `hasMeta` correctly based on `hideMeta` flag
- [ ] Cover image metadata visibility respects flags

**Affected components**: `src/components/Collections/collection.utils.ts`

---

### 7. Image Scan Results (Automated)
**Route**: Internal webhook

**What to check**:
- [ ] When image scan detects `minor`, flag is set atomically
- [ ] When image scan detects `poi`, flag is set atomically
- [ ] Race conditions don't cause flag overwrites

**Affected functions**: `handleImageAuditResult` in `image-scan-result.service.ts`

---

### 8. Report Handling
**Route**: `/moderator/reports`

**What to check**:
- [ ] When a report is actioned, `nsfwLevelLocked` can be unset
- [ ] Flag update doesn't affect other flags

**Affected functions**: Report service image handling

---

## SQL Patterns Used

### Reading flags (bitwise AND)
```sql
-- Check if flag is set
(i.flags & 8) != 0 AS minor

-- Check if flag is NOT set
(i.flags & 4) = 0  -- hideMeta not set
```

### Setting flags (bitwise OR)
```sql
UPDATE "Image" SET flags = flags | 16  -- Set poi (16)
```

### Unsetting flags (bitwise AND NOT)
```sql
UPDATE "Image" SET flags = flags & ~8  -- Unset minor (8)
```

### Toggling flags (bitwise XOR)
```sql
UPDATE "Image" SET flags = flags # 16  -- Toggle poi (PostgreSQL XOR)
```

### Conditional flag setting
```sql
UPDATE "Image" SET flags = CASE
  WHEN "nsfwLevel" >= 4 THEN flags & ~8   -- Unset minor
  ELSE flags | 8                           -- Set minor
END
```

---

## Quick Smoke Test Steps

1. **Toggle minor flag** on an image in moderation queue - verify it toggles without affecting other flags
2. **Toggle poi flag** on same image - verify minor flag unchanged
3. **Set NSFW level** on an image - verify `nsfwLevelLocked` flag is set
4. **Bulk approve images** - verify poi unset, minor set based on nsfwLevel
5. **Search images** - verify filtering by minor/poi/tosViolation works
6. **Check collection** - verify article cover image `hasMeta` respects `hideMeta` flag
7. **Upload image** - after scan, verify minor/poi flags set if detected

---

## Type Changes

### `GetAllImagesRaw`
Added `flags: number` to the raw query result type.

### `GetImageModerationReviewQueueRaw`
Added `flags: number` to the raw query result type.

### Query Results
Boolean fields are now computed from flags in SELECT:
```typescript
{
  flags: number;
  hideMeta: boolean;      // (flags & 4) != 0
  minor: boolean;         // (flags & 8) != 0
  poi: boolean;           // (flags & 16) != 0
  acceptableMinor: boolean; // (flags & 32) != 0
  hasMeta: boolean;       // (flags & 8192) != 0 AND (flags & 4) = 0
  onSite: boolean;        // (flags & 16384) != 0
}
```

---

## Migration Status

- [x] All reads migrated to use `flags` column
- [x] All writes migrated to use atomic bitwise operations
- [x] `flagUpdate` helper implemented with `set`, `unset`, `setTo`, `toggle`
- [x] Race conditions eliminated in flag updates
- [ ] **Pending**: Remove boolean columns from Prisma schema (after backfill verification)
- [ ] **Pending**: Drop boolean columns from database
- [ ] **Pending**: Remove sync trigger (if exists)

See `docs/optimization/image-flags-migration.md` for full migration plan.
