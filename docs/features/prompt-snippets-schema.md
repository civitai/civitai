# Prompt Snippets — Database Schema Spec

**Status:** draft for DB review
**Companion doc:** [prompt-snippets.md](./prompt-snippets.md) (product/UX plan)

This doc specifies the database changes required to ship the Prompt Snippets feature, including wildcard-set subscriptions from wildcard-type models. Written for DB review — feature context is summarized in §1 but the full product plan lives in the companion doc.

---

## 1. Feature context (for grounding)

Users reference reusable prompt segments in image-generation prompts via `#category` syntax (e.g. `"A #character walking through #setting"`). Two sources of content feed these references:

1. **Personal snippets** — user-owned editable text values organized by category.
2. **Wildcard-set subscriptions** — read-only pointers to content extracted from wildcard-type models (model type `Wildcard`) that ship `.txt` files using Dynamic Prompts / A1111 syntax.

When a reference has multiple values selected (across sources), the generator fans out into a batch of workflow steps (cartesian product, cap 10 combinations, seeded random sampling when over cap).

Wildcard-set content is **cached globally** — one extracted copy per model version, shared across all users. User ownership lives in a pointer table.

---

## 2. Principles

- **One canonical copy per source.** Wildcard-set content is global, pointed to by users. User snippets are user-owned.
- **Immutable wildcard content.** Users do not edit imported wildcard values. Customization path is "copy value into personal snippets."
- **Per-value audit on wildcard sets.** Some wildcard values may fail audit; the rest of the set remains usable. Audit is centralized, not per-user.
- **Model-version pinning for reproducibility.** Pointers target a specific `ModelVersion`, not a model — users don't get silent updates.
- **Graceful degradation on source removal.** Global set invalidation doesn't drop user pointers; it flags them and excludes the set from generation pools.
- **Submission metadata captures full reproducibility.** The workflow step records which snippet/wildcard values were selected so results can be regenerated.

---

## 3. Entity overview

```
                              ┌─────────────────────────────────┐
                              │           WildcardSet           │
                              │             (new)               │
┌─────────────────┐ ◀──────── │  kind: System | User            │
│  ModelVersion   │ 1:1 (opt) │   - System sets: ownedBy zip    │
│   (existing)    │           │   - User sets:   ownedBy user   │
└─────────────────┘           └────────────────┬────────────────┘
                                                │ 1:N
                                                ▼
                              ┌─────────────────────────────────┐
                              │     WildcardSetCategory         │
                              │           (new)                 │
                              │   values: JSONB string[]        │
                              │   audit + nsfwLevel here        │
                              └─────────────────────────────────┘

┌─────────────────────┐       ┌──────────────────────────────────┐
│   User (existing)   │◀──────│       UserWildcardSet            │ ──→ WildcardSet
│                     │ 1:N   │            (new)                 │   (per-user pointer
│                     │       │   isActive flag for picker scope │    for both kinds)
└─────────────────────┘       └──────────────────────────────────┘
```

**New tables:** `WildcardSet`, `WildcardSetCategory`, `UserWildcardSet`.
**Modified tables:** none (existing `GenerationPreset.values` JSON gets a new optional key, no schema change).

**Key shape decisions:**

- **One unified content table.** `WildcardSet` covers both globally-shared content imported from wildcard-type models (`kind = System`) and user-owned personal collections (`kind = User`). The discriminator + nullable owner/model FKs differentiate them; the resolver and picker treat them uniformly.
- **Values are inline JSONB string arrays.** No separate value table. Audit and site-availability flags live on the category. Categories are the atomic unit of audit + visibility — if a category fails audit it disappears from generation pools entirely; if it passes, its `nsfwLevel` controls whether it shows on .com (SFW) vs .red (NSFW) vs both.
- **`UserWildcardSet` is the activation/scoping mechanism for both kinds.** Owners of User-kind sets get a `UserWildcardSet` row pointing at their own set; subscribers to System-kind sets get a row pointing at the system set. `isActive` controls whether the set contributes to picker results regardless of kind.

---

## 4. Table specs

### 4.1 `WildcardSet` — global cached or user-owned wildcard collection

The unified content table. Two kinds:

- **`kind = System`** — one record per `ModelVersion` of type `Wildcard`. Created on first user import; shared by all subsequent importers. Immutable after import.
- **`kind = User`** — owned by one user. Created lazily (first time the user saves a personal snippet) or explicitly. The contained categories are immutable after create — users add new categories or new sets, they don't edit existing ones.

```prisma
model WildcardSet {
  id                  Int                  @id @default(autoincrement())

  kind                WildcardSetKind                            // discriminator

  // System-kind only (null for User-kind):
  modelVersionId      Int?                 @unique
  modelVersion        ModelVersion?        @relation(fields: [modelVersionId], references: [id], onDelete: Restrict)
  modelName           String?              // denormalized e.g. "fullFeatureFantasy"
  versionName         String?              // denormalized e.g. "v3.0"
  sourceFileCount     Int?                 // number of .txt files in the source zip

  // User-kind only (null for System-kind):
  ownerUserId         Int?
  owner               User?                @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  name                String?              @db.Citext // user-given display name e.g. "My snippets"

  // Shared:
  // Aggregate audit — derived from WildcardSetCategory.auditStatus rollup.
  // "Clean" = all categories clean; "Mixed" = some dirty (still usable, dirty categories excluded);
  // "Dirty" = all categories dirty (set unusable until re-audit); "Pending" = not yet audited.
  auditStatus         WildcardSetAuditStatus @default(Pending)
  auditRuleVersion    String?
  auditedAt           DateTime?

  // Invalidation — flagged if a System-kind set's source model is unpublished for policy reasons,
  // or if a User-kind set's content is administratively suspended. Pointers remain but the set
  // is excluded from generation pools.
  isInvalidated       Boolean              @default(false)
  invalidationReason  String?
  invalidatedAt       DateTime?

  totalValueCount     Int                  // denormalized sum of all category value counts
  createdAt           DateTime             @default(now())
  updatedAt           DateTime             @updatedAt

  categories          WildcardSetCategory[]
  userSubscriptions   UserWildcardSet[]    // per-user activation pointers (both kinds)

  @@index([kind])
  @@index([ownerUserId])
  @@index([auditStatus])
  @@index([isInvalidated])
}

enum WildcardSetKind {
  System
  User
}

enum WildcardSetAuditStatus {
  Pending
  Clean
  Mixed
  Dirty
}
```

**Field notes:**

- **Kind invariant.** Exactly one of `(modelVersionId, ownerUserId)` is non-null per row, determined by `kind`. Enforced via a CHECK constraint at migration time (see §8).
- `modelVersionId` is `@unique` (only enforced when non-null) because we never create two System-kind sets for the same version. Concurrent first-import is handled by the service layer (see §6.1).
- `onDelete: Restrict` on `modelVersion` — a `ModelVersion` hard-delete is blocked until dependent System-kind sets are invalidated first. `onDelete: Cascade` on `owner` — deleting a user removes their User-kind sets and their categories.
- `modelName` / `versionName` are denormalized for picker rendering on System-kind sets without JOINs through the models tables.
- `name` (User-kind only) is `citext` — case-insensitive, preserves user's casing for display. No global uniqueness; multiple users can have a set called "My snippets," and one user can have several sets like "Characters" and "characters" treated as the same name within their own scope.
- `totalValueCount` is denormalized for quick "38 values · 3 sources" displays.

### 4.2 `WildcardSetCategory` — categories within a wildcard set, values inline

One row per `.txt` file in the source zip (e.g. `character.txt` → one category). The category's values are stored directly on this row as a `JSONB` array — no separate value table. Audit and site-availability flags live here so that a category is the atomic unit of "is this content allowed to be used."

```prisma
model WildcardSetCategory {
  id                Int                     @id @default(autoincrement())
  wildcardSetId     Int
  wildcardSet       WildcardSet             @relation(fields: [wildcardSetId], references: [id], onDelete: Cascade)

  name              String                  @db.Citext // e.g. "character" — citext makes comparisons and the unique constraint case-insensitive; original filename casing is preserved for display

  // Values are an ordered array of strings — one entry per non-empty line in the source .txt.
  // Each string preserves Dynamic Prompts alternation/weight syntax literally
  // (`{a|b|c}`, `{1-2$$a|b}`, `N.0::name`); the resolver expands those at generation time.
  // Nested references are normalized at import: source-file `__name__` is rewritten to `#name`
  // so the stored values use a single reference syntax everywhere in our system.
  values            Json                    @db.JsonB

  // Denormalized count for fast displays ("24 values") without parsing the JSON.
  valueCount        Int

  // Audit applies to the category as a whole. If audit fails, the category is excluded
  // from generation pools globally — Dirty categories don't get returned by the resolver.
  auditStatus       CategoryAuditStatus     @default(Pending)
  auditRuleVersion  String?
  auditedAt         DateTime?
  auditNote         String?                 // populated when Dirty — which rule matched

  // NSFW classification — bitwise flags following the existing Civitai NsfwLevel convention
  // (see docs/features/bitwise-flags.md). The site router uses this to decide whether the
  // category is offered on .com (SFW) vs .red (NSFW) vs both. Set during import/audit; can
  // be overridden by moderators. 0 = unrated (treated as not-yet-available).
  nsfwLevel         Int                     @default(0)

  displayOrder      Int                     @default(0)
  createdAt         DateTime                @default(now())
  updatedAt         DateTime                @updatedAt

  @@unique([wildcardSetId, name])
  @@index([wildcardSetId])
  @@index([wildcardSetId, auditStatus])     // resolver: clean categories per set
  @@index([auditStatus])                    // background audit / re-audit job
}

enum CategoryAuditStatus {
  Pending
  Clean
  Dirty
}
```

**Field notes:**

- `name` uses the PostgreSQL `citext` type — case-insensitive comparisons and unique constraint automatically. Stores the source filename's casing as-is; the picker can render it directly, and prompts match it regardless of how the user types `#Character` vs `#character`. Removes the need for a separate `displayName` column.
- `values` is a JSONB array of strings, e.g. `["fire", "water", "earth", ...]` for `elemental_types`, or `["{3.0::serious|3.0::determined|...}"]` for a single-line weighted-alternation file. Empty source lines are dropped at import. Order is preserved via array position.
- **Audit is one verdict per category, not per value.** If any line in the category fails audit, the whole category becomes `Dirty` and is excluded from resolution. Authors curate categories as cohesive lists; partial use after a partial-audit-fail isn't a workflow we want to support, and per-line audit columns aren't needed.
- `nsfwLevel` follows the existing Civitai bitwise NSFW convention so the site router can filter categories using the same logic it already uses for images, models, etc. A category with `nsfwLevel = 0` (unrated) is treated as not-yet-available pending classification.
- `valueCount` is denormalized for picker headers — derivable from `jsonb_array_length(values)` but cached to avoid the function call on hot reads.
- Cascades from `WildcardSet` — deleting a set deletes its categories.

### 4.3 `UserWildcardSet` — per-user activation pointer

Each row = "this user has this wildcard set active in their picker." Used for both `kind = System` (subscribed to a shared set) and `kind = User` (using their own owned set). When a user creates a User-kind set, a `UserWildcardSet` row is auto-created so the resolver doesn't need a special-case query path.

```prisma
model UserWildcardSet {
  id              Int         @id @default(autoincrement())
  userId          Int
  user            User        @relation(fields: [userId], references: [id], onDelete: Cascade)

  wildcardSetId   Int
  wildcardSet     WildcardSet @relation(fields: [wildcardSetId], references: [id], onDelete: Cascade)

  nickname        String?     // optional user rename for display (overrides set's own name in their picker)
  isActive        Boolean     @default(true)
  sortOrder       Int         @default(0)
  addedAt         DateTime    @default(now())

  @@unique([userId, wildcardSetId])
  @@index([userId, isActive])  // primary resolver query: "what sets does this user have active?"
  @@index([wildcardSetId])     // occasional: "who has this set active?" for invalidation fan-out
}
```

**Field notes:**

- **Pointer for both kinds.** For System-kind, the user explicitly added the set (subscription). For User-kind, the row is auto-created when the user creates the set; deactivating it hides the set from the picker without deleting it. Deleting a User-kind set cascades through this row.
- Cascades on both sides. Deleting a user drops their pointers; deleting a `WildcardSet` drops all dependent pointers (including the owner's pointer for User-kind).
- `(userId, isActive)` is the hottest index — every prompt's autocomplete fetch uses it.
- No audit fields here; the authoritative audit lives on the `WildcardSet` and its categories.

### 4.4 Metadata conventions (no schema change)

Two existing JSON blobs gain new conventional keys.

**`GenerationPreset.values`** — gains `activeWildcardSetIds: number[]`. When a preset is saved, we snapshot which `UserWildcardSet.id`s are active. On load, those get reactivated (with a warning if any have since been removed from the library). No DB change; just a new key convention.

**Workflow step metadata** (`GenerationStep.metadata` or equivalent — wherever step metadata JSON lives today) gains a `snippetReferences` array per step, recording exactly which values were used:

```jsonc
{
  "snippetReferences": [
    {
      "category": "character",
      "referencePosition": 0,
      "resolvedValues": [
        { "wildcardSetId": 42, "categoryId": 991, "valueIndex": 2, "value": "blonde hair, green tunic, pointed ears..." },
        { "wildcardSetId": 17, "categoryId": 631, "valueIndex": 5, "value": "lightning" }
      ]
    }
  ],
  "samplingSeed": 847291,
  "cartesianTotal": 3648,
  "sampledTo": 10
}
```

The source identifier is always `(wildcardSetId, categoryId, valueIndex)` — pointing into the JSONB `values` array on `WildcardSetCategory`. Both User-kind and System-kind sets share this shape; consumers can look up `WildcardSet.kind` if they need to distinguish (e.g., to label "from your library" vs "from a model"). Categories are immutable post-create, so the index is stable. The literal `value` text is also recorded for human-readable history.

---

## 5. Indexes summary

| Table | Index | Purpose |
|---|---|---|
| `WildcardSet` | `(modelVersionId)` unique | Idempotent first-import lookup (System-kind) |
| `WildcardSet` | `(kind)` | Filter by kind in admin/listing queries |
| `WildcardSet` | `(ownerUserId)` | List a user's owned User-kind sets |
| `WildcardSet` | `(auditStatus)` | Background audit job scans |
| `WildcardSet` | `(isInvalidated)` | Admin queries; invalidation fan-out |
| `WildcardSetCategory` | `(wildcardSetId, name)` unique | Resolver: get category X in set Y |
| `WildcardSetCategory` | `(wildcardSetId)` | List all categories in a set |
| `WildcardSetCategory` | `(wildcardSetId, auditStatus)` | Resolver: clean categories per set |
| `WildcardSetCategory` | `(auditStatus)` | Background audit / re-audit job |
| `UserWildcardSet` | `(userId, wildcardSetId)` unique | Enforce one pointer per user/set |
| `UserWildcardSet` | `(userId, isActive)` | Primary resolver query per user |
| `UserWildcardSet` | `(wildcardSetId)` | Fan-out when invalidating a set |

---

## 6. Key operations and query patterns

### 6.1 First-import of a wildcard model (System-kind)

Atomic transaction. Fewer rows now that values live inline on categories — one insert per category, one bulk transaction per set.

```
BEGIN
  SELECT id FROM WildcardSet WHERE modelVersionId = ? AND kind = 'System'
  IF found: create UserWildcardSet (userId, wildcardSetId=found.id, isActive=true)
  ELSE:
    INSERT WildcardSet (
      kind = 'System',
      modelVersionId, modelName, versionName,
      sourceFileCount, totalValueCount,
      auditStatus = 'Pending'
    )
    FOR each .txt file:
      lines = read non-empty lines from file
      lines = normalizeNestedRefs(lines)   -- rewrite source-file `__name__` to `#name`
      INSERT WildcardSetCategory (
        wildcardSetId,
        name,                      -- citext, preserves source filename casing
        values = jsonb(lines),     -- JSONB array of strings, normalized to `#name`
        valueCount = length(lines),
        displayOrder,
        auditStatus = 'Pending',
        nsfwLevel = 0
      )
    INSERT UserWildcardSet (userId, wildcardSetId, isActive=true)
COMMIT
-- Then: enqueue audit job for the new WildcardSet
```

Concurrency: two users hitting first-import for the same model version at once — the `(modelVersionId)` unique constraint makes one of them lose with a unique-violation; we catch it in the service layer and retry the "find existing" path.

### 6.1a User-kind set creation and snippet save

User-kind sets are created lazily. The first time a user clicks "Save to my snippets" (from a wildcard picker row, or via a "create snippet" form), the service ensures a User-kind set exists for them and adds a category to it.

```
BEGIN
  -- Find or create the user's default set
  SELECT id FROM WildcardSet WHERE kind = 'User' AND ownerUserId = ? AND name = 'My snippets'
  IF not found:
    INSERT WildcardSet (
      kind = 'User',
      ownerUserId, name = 'My snippets',
      totalValueCount = 0, auditStatus = 'Pending'
    )
    INSERT UserWildcardSet (userId = ownerUserId, wildcardSetId = new.id, isActive = true)

  -- Find or create the category
  SELECT id, values FROM WildcardSetCategory WHERE wildcardSetId = ? AND name = ?
  IF not found:
    INSERT WildcardSetCategory (
      wildcardSetId,
      name = '<chosen category, e.g. "character">',
      values = jsonb([newValue]),     -- single-element array on creation
      valueCount = 1,
      auditStatus = 'Pending',
      nsfwLevel = 0
    )
  ELSE:
    -- Categories are immutable post-create per the agreed model.
    -- Adding a new value to an existing category creates a NEW category
    -- (e.g. "character" → "character-2") OR the user picks a different name.
    -- We surface this to the user at save time rather than mutating in place.
    REJECT or PROMPT for new category name

  UPDATE WildcardSet.totalValueCount += new values added
COMMIT
-- Enqueue audit for the new WildcardSetCategory
```

This preserves the immutability invariant: existing categories never change. If a user wants to grow their character collection, they're either creating a new category (e.g. `characters_v2`) or starting fresh. UX-side, we'll need to make this clear in the "save to my snippets" flow — either auto-name new categories as `<base>-N`, or prompt the user.

> **Open product question:** is per-category immutability the right semantic for User-kind sets, or do we want categories to grow over time as users save more values? Strict immutability matches System-kind (which is desirable for uniformity) but creates UX friction for the iterative-saving workflow. See §9 open question 5.

### 6.2 Resolver: get active content for a `#category` reference

Given `userId`, `category='character'`, and the request's site context (SFW vs NSFW expressed as a `requiredNsfwMask` int), fetch everything selectable. With the unified design, this is a **single query** — no separate path for personal snippets:

```sql
SELECT wsc.id           AS "categoryId",
       wsc.name         AS "categoryName",
       wsc.values       AS "values",
       wsc."valueCount" AS "valueCount",
       wsc."nsfwLevel"  AS "nsfwLevel",
       ws.id            AS "setId",
       ws.kind          AS "setKind",
       ws."modelName",
       ws."versionName",
       ws.name          AS "userSetName",   -- non-null for User-kind sets
       ws."ownerUserId"
FROM "UserWildcardSet" uws
  JOIN "WildcardSet" ws           ON uws."wildcardSetId" = ws.id
  JOIN "WildcardSetCategory" wsc  ON wsc."wildcardSetId" = ws.id
WHERE uws."userId" = ?
  AND uws."isActive" = true
  AND ws."isInvalidated" = false
  AND wsc.name = 'character'
  AND wsc."auditStatus" = 'Clean'
  AND (wsc."nsfwLevel" & ?) <> 0;   -- bitwise filter: category overlaps with required site rating
```

The picker UI groups results by `setKind` for display ("From My Snippets" for User-kind, "From fullFeatureFantasy v3.0" for System-kind), but storage and querying are uniform.

**Indexes carrying this query:** `(userId, isActive)` on `UserWildcardSet`, `(wildcardSetId, name)` + `(wildcardSetId, auditStatus)` on `WildcardSetCategory`. Two-table-FK-walk; well-indexed three-table joins at this scale are sub-millisecond.

**Expected result size:** ~3–20 category rows (one per active set that has the category). The app unpacks `values` arrays in code to produce the picker's flat list.

### 6.3 Audit job — category-level

Triggered on WildcardSet creation and when audit rules version bumps. Audit is per-category: read all values from the JSONB array, run audit rules across them, produce one verdict for the whole category. If any line fails, the category is `Dirty`.

```
FOR each WildcardSetCategory WHERE wildcardSetId = ?
  AND (auditStatus = 'Pending' OR auditRuleVersion != currentRuleVersion):
    lines = parse JSONB values array
    verdict, nsfwLevel, note = runAudit(lines)
    UPDATE WildcardSetCategory
      SET auditStatus = verdict,
          nsfwLevel = nsfwLevel,
          auditRuleVersion = currentRuleVersion,
          auditedAt = NOW(),
          auditNote = note

-- After all categories processed:
  Recompute WildcardSet.auditStatus aggregate (Clean | Mixed | Dirty)
  UPDATE WildcardSet SET auditStatus, auditRuleVersion, auditedAt
```

The audit service produces both the pass/fail verdict and the `nsfwLevel` classification in one pass. A category that fails outright is marked `Dirty` (excluded everywhere); a category that passes gets a `nsfwLevel` reflecting its content rating, and the site router decides where it shows. Runs as a background worker, ~one category per regex pass — finishes a typical 60-category set well under a minute.

### 6.4 Set invalidation

For System-kind sets, when a model is unpublished for policy:

```
UPDATE "WildcardSet" SET isInvalidated = true, invalidationReason = ?, invalidatedAt = NOW()
WHERE modelVersionId = ?;
```

For User-kind sets, when a moderator suspends a user's content:

```
UPDATE "WildcardSet" SET isInvalidated = true, invalidationReason = ?, invalidatedAt = NOW()
WHERE id = ? AND kind = 'User';
```

Downstream: resolver filters `isInvalidated = false`, so content is immediately excluded from pools. Users keep their pointers but see a warning badge. Admin tooling can force-hard-delete a User-kind set (cascade through `UserWildcardSet` and `WildcardSetCategory`) if we need to purge content entirely; System-kind sets shouldn't be hard-deleted because we can't be sure all submission-history references are no longer needed.

### 6.5 Preset save / load

**Save:**
```
const activeSetIds = await prisma.userWildcardSet.findMany({
  where: { userId, isActive: true }, select: { id: true }
});
preset.values = { ...otherValues, activeWildcardSetIds: activeSetIds.map(s => s.id) };
```

**Load:**
```
const targetIds = preset.values.activeWildcardSetIds ?? [];
await prisma.userWildcardSet.updateMany({
  where: { userId },
  data: { isActive: false }
});
await prisma.userWildcardSet.updateMany({
  where: { userId, id: { in: targetIds } },
  data: { isActive: true }
});
// Report any targetIds that no longer exist to the client for warning UI
```

---

## 7. Estimated data volumes

Educated guesses based on current Civitai scale; DB reviewer should sanity-check.

| Table | Per unit | Estimated total at year 1 |
|---|---|---|
| `WildcardSet` (System-kind) | ~1 per imported model version | ~5k rows |
| `WildcardSet` (User-kind) | ~1–3 per active snippet user | ~100k–500k rows |
| `WildcardSetCategory` | System: ~50 per set, ~6KB JSONB. User: ~5 per set, smaller JSONB | ~500k–1M rows |
| `UserWildcardSet` | ~3–10 per active user (subscriptions + own User-kind sets) | ~500k–2M rows |

`WildcardSetCategory` total storage is dominated by System-kind sets (~1.5GB across 250k rows from imported wildcard models). User-kind categories are typically smaller — fewer values per category, shorter values — and add negligible storage compared to System-kind. Postgres TOAST handles the larger JSONB blobs automatically.

Write pressure is at import time (one bulk transaction per System-kind set; one row at a time for User-kind set creation/category-add). Steady-state writes are negligible.

---

## 8. Migration plan

Single additive migration — no existing data needs to move. Requires the standard PostgreSQL `citext` extension for case-insensitive name columns.

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE "WildcardSetKind" AS ENUM ('System', 'User');
CREATE TYPE "WildcardSetAuditStatus" AS ENUM ('Pending', 'Clean', 'Mixed', 'Dirty');
CREATE TYPE "CategoryAuditStatus" AS ENUM ('Pending', 'Clean', 'Dirty');

CREATE TABLE "WildcardSet" (...);              -- has `kind`, nullable model FKs, nullable owner FK, `name CITEXT`
CREATE TABLE "WildcardSetCategory" (...);      -- has `values JSONB`, `auditStatus`, `nsfwLevel`, `name CITEXT`
CREATE TABLE "UserWildcardSet" (...);          -- per-user activation pointer for both kinds

ALTER TABLE "WildcardSet" ADD CONSTRAINT wildcard_set_kind_owner_check CHECK (
  (kind = 'System' AND "modelVersionId" IS NOT NULL AND "ownerUserId" IS NULL) OR
  (kind = 'User'   AND "modelVersionId" IS NULL     AND "ownerUserId" IS NOT NULL)
);

CREATE UNIQUE INDEX ... ;  -- per index table in §5
CREATE INDEX ... ;
```

No data backfill. No existing columns modified. `CREATE EXTENSION IF NOT EXISTS` is idempotent.

**Rollback story:** drop the 3 tables + 3 enums. Leave the `citext` extension in place. Existing generation, preset, and model flows are untouched by this migration (the metadata JSON conventions in §4.4 are additive and ignored by pre-feature code).

---

## 9. Open questions for DB review

1. **`WildcardSetCategory.values` as JSONB vs `text[]`.** Postgres `text[]` would also work and is slightly more constrained (always array-of-string). JSONB is more flexible if we later want to attach per-value metadata. Preference?
2. **JSONB read patterns.** Resolver fetches the whole `values` array per category and unpacks in app code. Alternative: server-side `jsonb_array_elements_text(values)` to unnest at query time. Either is fine at this scale; flagging in case there's a house preference.
3. **Denormalization of `valueCount` / `totalValueCount`.** Kept for read-path performance. `valueCount` is derivable from `jsonb_array_length(values)` — could be a generated column. Worth doing, or overkill?
4. **`nsfwLevel` set by audit pipeline vs explicit moderator action.** Current plan: audit produces a verdict + an inferred `nsfwLevel` based on content rules. Mods can override later. Is there a more rigorous classification process the team would want here (e.g., human-in-the-loop required before any non-zero rating)?
5. **User-kind category immutability vs. growth.** §6.1a's flow says categories are immutable post-create — adding a value means creating a new category (e.g. `character-2`). Strict but matches System-kind. Alternative: allow appending to a User-kind category's `values` JSONB. Less strict; complicates audit (re-audit on every append) and step-metadata stability (`valueIndex` shifts if we ever reorder). Preference?
6. **Global set deletion.** Current plan: `WildcardSet` rows are never hard-deleted; `isInvalidated` handles policy-driven removals. Do we want a separate `deletedAt` for a softer concept, or is hard-delete-with-cascade acceptable for User-kind sets specifically (since we won't have step-history risk for personal content)?
7. **Audit rule version as a string.** Letting the audit service own the versioning scheme. Alternative: a dedicated `AuditRuleset` table and FK to it. Simpler-as-string for v1?
8. **CHECK constraint enforcement.** The `(kind, modelVersionId, ownerUserId)` invariant is enforced via a single CHECK constraint at migration time. Worth reviewing whether this is the right level of enforcement, or whether we'd prefer a partial unique index approach or trigger-based.
9. **Default User-kind set name.** New users get a User-kind set called "My snippets" lazily created on first save. Hardcoded? Localizable? Prompted? Probably hardcoded for v1 with a per-user rename allowed via `name`.

---

## 10. Out of scope for v1

- Search indexes over snippet/wildcard content (we defer to straightforward WHERE clauses until scale warrants — Postgres GIN on the JSONB `values` column is an option later).
- Cross-user sharing of User-kind sets (a "Shared" or "Public" `kind` value would be additive when we want it).
- Wildcard set version-diff storage (immutable JSONB makes diffing a future concern).
- Per-line audit results within a category (audit is atomic at the category level).
- Set favoriting, tagging, or grouping beyond `sortOrder`.
- Editing existing categories' values (categories are immutable post-create).
- Per-snippet labels for User-kind sets (values are plain strings; users find content by reading + searching).

These are deliberately punted — the schema above accommodates them as additive changes later.
