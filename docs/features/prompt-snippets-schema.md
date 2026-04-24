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
┌─────────────────────┐       ┌─────────────────────┐
│   ModelVersion      │◀──────│   WildcardSet       │   Global content
│   (existing)        │ 1:1   │   (new)             │   (shared across users)
└─────────────────────┘       └──────────┬──────────┘
                                          │ 1:N
                                          ▼
                              ┌─────────────────────┐
                              │ WildcardSetCategory │
                              │   (new)             │
                              └──────────┬──────────┘
                                          │ 1:N
                                          ▼
                              ┌─────────────────────┐
                              │  WildcardSetValue   │
                              │    (new)            │
                              └──────────▲──────────┘
                                          │ N:1
                                          │
┌─────────────────────┐       ┌──────────┴──────────┐
│   User (existing)   │◀──────│  UserWildcardSet    │   Per-user pointer
│                     │ 1:N   │    (new)            │   (subscription)
└─────────┬───────────┘       └─────────────────────┘
          │ 1:N
          │
          ▼
┌─────────────────────┐
│   PromptSnippet     │   User-owned editable content
│      (new)          │
└─────────────────────┘
```

**New tables:** `WildcardSet`, `WildcardSetCategory`, `WildcardSetValue`, `UserWildcardSet`, `PromptSnippet`.
**Modified tables:** none (existing `GenerationPreset.values` JSON gets a new optional key, no schema change).

---

## 4. Table specs

### 4.1 `WildcardSet` — global cached wildcard-model content

One record per `ModelVersion` of type `Wildcard`. Created on first user import; shared by all subsequent importers.

```prisma
model WildcardSet {
  id                  Int                  @id @default(autoincrement())
  modelVersionId      Int                  @unique
  modelVersion        ModelVersion         @relation(fields: [modelVersionId], references: [id], onDelete: Restrict)

  // Denormalized display fields (snapshotted at import). Saves a JOIN per picker render.
  modelName           String               // e.g. "fullFeatureFantasy"
  versionName         String               // e.g. "v3.0"

  // Aggregate audit — derived from WildcardSetValue.auditStatus rollup.
  // "Clean" = all values clean; "Mixed" = some dirty (still usable, dirty values excluded);
  // "Dirty" = all values dirty (set unusable until re-audit); "Pending" = not yet audited.
  auditStatus         WildcardSetAuditStatus @default(Pending)
  auditRuleVersion    String?
  auditedAt           DateTime?

  // Set becomes invalidated if model is unpublished for policy reasons.
  // Existing UserWildcardSet pointers remain but get a warning state.
  isInvalidated       Boolean              @default(false)
  invalidationReason  String?
  invalidatedAt       DateTime?

  // Content extraction metadata.
  sourceFileCount     Int                  // number of .txt files in the source zip
  totalValueCount     Int                  // denormalized sum of all category value counts
  createdAt           DateTime             @default(now())
  updatedAt           DateTime             @updatedAt

  categories          WildcardSetCategory[]
  userSubscriptions   UserWildcardSet[]

  @@index([auditStatus])
  @@index([isInvalidated])
}

enum WildcardSetAuditStatus {
  Pending
  Clean
  Mixed
  Dirty
}
```

**Field notes:**

- `modelVersionId` is `@unique` because we never create two `WildcardSet`s for the same version. Concurrent first-import is handled by the service layer (see §6.1).
- `onDelete: Restrict` on `modelVersion` — we don't want a `ModelVersion` deletion to cascade through user pointers. If a version is hard-deleted, it should be blocked until dependent sets are invalidated first.
- `modelName` / `versionName` are denormalized because the picker renders these constantly and we don't want JOINs through the models tables on every autocomplete call.
- `totalValueCount` is denormalized for quick "38 values · 3 sources" displays in the picker header.

### 4.2 `WildcardSetCategory` — categories within a wildcard set

One row per `.txt` file in the source zip (e.g. `character.txt` → one category).

```prisma
model WildcardSetCategory {
  id              Int                  @id @default(autoincrement())
  wildcardSetId   Int
  wildcardSet     WildcardSet          @relation(fields: [wildcardSetId], references: [id], onDelete: Cascade)

  name            String               @db.Citext // e.g. "character" — case-insensitive via citext; matches `#category` token regardless of case
  valueCount      Int                  // denormalized count of WildcardSetValue rows in this category
  displayOrder    Int                  @default(0)
  createdAt       DateTime             @default(now())

  values          WildcardSetValue[]

  @@unique([wildcardSetId, name])
  @@index([wildcardSetId])
}
```

**Field notes:**

- `name` uses the PostgreSQL `citext` type — case-insensitive comparisons and unique constraint automatically. Stores the source filename's casing; the picker can display it as-is, and prompts match it regardless of how the user typed `#Character` vs `#character`. Removes the need for a separate `displayName` column.
- `valueCount` is denormalized for autocomplete displays ("24 values"). Maintained by application code at import and when per-value audit updates.
- Cascades from `WildcardSet` — deleting a set deletes its categories.

### 4.3 `WildcardSetValue` — individual values within a category

One row per line in the source `.txt` file. The value text preserves Dynamic Prompts syntax (`{a|b|c}`, `__nested__`, weights) literally — expansion happens at generation time in the resolver.

```prisma
model WildcardSetValue {
  id                Int                 @id @default(autoincrement())
  categoryId        Int
  category          WildcardSetCategory @relation(fields: [categoryId], references: [id], onDelete: Cascade)

  value             String              @db.Text   // raw line from source .txt, may contain A1111 syntax
  auditStatus       ValueAuditStatus    @default(Pending)
  auditRuleVersion  String?
  auditedAt         DateTime?
  auditNote         String?             // populated when Dirty — which rule matched

  // Source line index in the original file — useful for update diffs later.
  sourceLineIndex   Int

  createdAt         DateTime            @default(now())

  @@index([categoryId])
  @@index([categoryId, auditStatus]) // picker fetches clean values for a category
}

enum ValueAuditStatus {
  Pending
  Clean
  Dirty
}
```

**Field notes:**

- `value` is `@db.Text` because some wildcard lines can be long (weighted alternation with 40+ options).
- `sourceLineIndex` lets us produce a meaningful diff when a new model version is imported — we can tell the user "added 5, removed 2 vs v3.0."
- `(categoryId, auditStatus)` composite index serves the primary picker query: `SELECT * WHERE categoryId = ? AND auditStatus = 'Clean'`.
- No per-user data here. Dirty values are globally dirty; no user-specific suppression at this level.

### 4.4 `UserWildcardSet` — user's pointer/subscription

Each row = "this user has access to this wildcard set." Ownership is only conceptual (users don't own content); `isActive` flips whether the set participates in the user's current generation context.

```prisma
model UserWildcardSet {
  id              Int         @id @default(autoincrement())
  userId          Int
  user            User        @relation(fields: [userId], references: [id], onDelete: Cascade)

  wildcardSetId   Int
  wildcardSet     WildcardSet @relation(fields: [wildcardSetId], references: [id], onDelete: Cascade)

  nickname        String?     // optional user rename for display
  isActive        Boolean     @default(true)
  sortOrder       Int         @default(0)
  addedAt         DateTime    @default(now())

  @@unique([userId, wildcardSetId])
  @@index([userId, isActive])  // primary resolver query: "what sets does this user have active?"
  @@index([wildcardSetId])     // occasional: "who subscribes to this set?" for invalidation fan-out
}
```

**Field notes:**

- Cascades on both sides. Deleting a user drops their subscriptions; deleting a `WildcardSet` (rare — happens if we ever purge a no-longer-used global set) drops dependent pointers.
- `(userId, isActive)` is the hottest index — every prompt's autocomplete fetch uses it.
- No audit fields here; the authoritative audit lives on the global set.

### 4.5 `PromptSnippet` — user's personal editable snippets

User-owned mutable content. Conceptually the "My snippets" default-active set in the UI, but stored separately from wildcard sets because the data shape and editability are different.

```prisma
model PromptSnippet {
  id                  Int                 @id @default(autoincrement())
  userId              Int
  user                User                @relation(fields: [userId], references: [id], onDelete: Cascade)

  category            String              @db.Citext // e.g. "character" — arbitrary, user-defined; citext gives case-insensitive matching and uniqueness
  name                String              @db.Citext // e.g. "Zelda"
  value               String              @db.Text
  description         String?

  auditStatus         SnippetAuditStatus  @default(Pending)
  auditRuleVersion    String?
  auditedAt           DateTime?

  sortOrder           Int                 @default(0)
  createdAt           DateTime            @default(now())
  updatedAt           DateTime            @updatedAt

  @@unique([userId, category, name])
  @@index([userId, category])   // primary picker query
  @@index([userId, auditStatus]) // for admin: "which of this user's snippets are dirty?"
}

enum SnippetAuditStatus {
  Pending
  Clean
  Dirty
  NeedsRecheck
}
```

**Field notes:**

- `category` and `name` both use `citext` — users typing "Character" or "character" get the same category, and "Zelda" vs "zelda" are treated as the same snippet within a category. Original casing is preserved for display.
- `category` is a free-form string the user chooses at save time. Not a FK — there's no "Categories" table. Users coin their own taxonomy.
- `(userId, category, name)` unique — a user can't have two snippets named "Zelda" in the category "character" (case-insensitive).
- `NeedsRecheck` is set by the re-audit background job (§6.4) and treated as `Pending` for resolution purposes.

### 4.6 Metadata conventions (no schema change)

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
        { "source": "snippet",     "snippetId": 421,    "value": "Zelda" },
        { "source": "wildcardSet", "valueId":   18927,  "value": "1girl, __character_f__" }
      ]
    }
  ],
  "samplingSeed": 847291,
  "cartesianTotal": 3648,
  "sampledTo": 10
}
```

This captures enough for a future "re-run this step" feature without requiring the global content to be immutable — if a wildcard value changes, we still know what was originally used.

---

## 5. Indexes summary

| Table | Index | Purpose |
|---|---|---|
| `WildcardSet` | `(modelVersionId)` unique | Idempotent first-import lookup |
| `WildcardSet` | `(auditStatus)` | Background audit job scans |
| `WildcardSet` | `(isInvalidated)` | Admin queries; invalidation fan-out |
| `WildcardSetCategory` | `(wildcardSetId, name)` unique | Resolver: get category X in set Y |
| `WildcardSetCategory` | `(wildcardSetId)` | List all categories in a set |
| `WildcardSetValue` | `(categoryId)` | List values in a category |
| `WildcardSetValue` | `(categoryId, auditStatus)` | Picker: fetch clean values only |
| `UserWildcardSet` | `(userId, wildcardSetId)` unique | Enforce no duplicate subscriptions |
| `UserWildcardSet` | `(userId, isActive)` | Primary resolver query per user |
| `UserWildcardSet` | `(wildcardSetId)` | Fan-out when invalidating a set |
| `PromptSnippet` | `(userId, category, name)` unique | Name collision prevention |
| `PromptSnippet` | `(userId, category)` | Picker query: user's snippets in category X |
| `PromptSnippet` | `(userId, auditStatus)` | Admin / background re-audit |

---

## 6. Key operations and query patterns

### 6.1 First-import of a wildcard model

Atomic transaction:

```
BEGIN
  SELECT id FROM WildcardSet WHERE modelVersionId = ?
  IF found: create UserWildcardSet (userId, wildcardSetId=found.id, isActive=true)
  ELSE:
    INSERT WildcardSet (modelVersionId, modelName, versionName, sourceFileCount, totalValueCount, auditStatus='Pending')
    FOR each .txt file:
      INSERT WildcardSetCategory (wildcardSetId, name, valueCount, displayOrder)
      FOR each non-empty line:
        INSERT WildcardSetValue (categoryId, value, sourceLineIndex, auditStatus='Pending')
    INSERT UserWildcardSet (userId, wildcardSetId, isActive=true)
COMMIT
-- Then: enqueue audit job for the new WildcardSet
```

Concurrency: two users hitting first-import for the same model version at once — the `(modelVersionId)` unique constraint makes one of them lose with a unique-violation; we catch it in the service layer and retry the "find existing" path.

### 6.2 Resolver: get active content for a `#category` reference

Given `userId` and `category='character'`, fetch everything selectable:

```sql
-- User's personal snippets
SELECT id, name, value, 'snippet' as source, auditStatus
FROM "PromptSnippet"
WHERE userId = ? AND category = 'character' AND auditStatus = 'Clean';

-- Values from active wildcard sets
SELECT wsv.id, wsc.name as categoryName, wsv.value, ws.id as setId, ws.modelName, ws.versionName, 'wildcardSet' as source, wsv.auditStatus
FROM "UserWildcardSet" uws
  JOIN "WildcardSet" ws ON uws.wildcardSetId = ws.id
  JOIN "WildcardSetCategory" wsc ON wsc.wildcardSetId = ws.id
  JOIN "WildcardSetValue" wsv ON wsv.categoryId = wsc.id
WHERE uws.userId = ?
  AND uws.isActive = true
  AND ws.isInvalidated = false
  AND wsc.name = 'character'
  AND wsv.auditStatus = 'Clean';
```

The second query is the expensive one. Indexes `(userId, isActive)` on `UserWildcardSet` and `(wildcardSetId, name)` on `WildcardSetCategory` and `(categoryId, auditStatus)` on `WildcardSetValue` should keep it bounded. Expected result size: ~30–100 rows typical, maybe 1000+ for power users with many large sets active.

### 6.3 Audit job — value-level

Triggered on WildcardSet creation and when audit rules version bumps:

```
FOR each WildcardSetValue WHERE categoryId IN (SELECT id FROM WildcardSetCategory WHERE wildcardSetId = ?)
  AND (auditStatus = 'Pending' OR auditRuleVersion != currentRuleVersion):
    run audit
    UPDATE WildcardSetValue SET auditStatus, auditRuleVersion, auditedAt, auditNote

-- After all values processed:
  Recompute WildcardSet.auditStatus aggregate (Clean | Mixed | Dirty)
  UPDATE WildcardSet SET auditStatus, auditRuleVersion, auditedAt
```

Runs as a background worker. Batch size tuned so a single set's audit finishes in under ~30s.

### 6.4 Set invalidation (model unpublished for policy)

```
UPDATE "WildcardSet" SET isInvalidated = true, invalidationReason = ?, invalidatedAt = NOW()
WHERE modelVersionId = ?;
```

Downstream: resolver already filters `isInvalidated = false`, so content is immediately excluded from pools. Users keep their pointers but see a warning badge in the library. Admin tooling can force-hard-delete (cascade through `UserWildcardSet`) if we need to purge.

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
| `WildcardSet` | ~1 per imported model version | ~5k rows |
| `WildcardSetCategory` | ~50 per set | ~250k rows |
| `WildcardSetValue` | ~30 per category | ~7.5M rows |
| `UserWildcardSet` | ~3 per active snippet user | ~300k–1M rows |
| `PromptSnippet` | variable per user | ~500k–5M rows |

`WildcardSetValue` at 7.5M rows is the biggest table but still well within Postgres comfort zone with the proposed indexes. Main write pressure is at import time (bulk insert on first-import of a popular model); steady-state writes are negligible.

---

## 8. Migration plan

Single additive migration — no existing data needs to move. Requires the standard PostgreSQL `citext` extension for case-insensitive category/name columns.

```
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE "WildcardSetAuditStatus" AS ENUM ('Pending', 'Clean', 'Mixed', 'Dirty');
CREATE TYPE "ValueAuditStatus" AS ENUM ('Pending', 'Clean', 'Dirty');
CREATE TYPE "SnippetAuditStatus" AS ENUM ('Pending', 'Clean', 'Dirty', 'NeedsRecheck');

CREATE TABLE "WildcardSet" (...);
CREATE TABLE "WildcardSetCategory" (...);
CREATE TABLE "WildcardSetValue" (...);
CREATE TABLE "UserWildcardSet" (...);
CREATE TABLE "PromptSnippet" (...);

CREATE UNIQUE INDEX ... ;  -- per index table in §5
CREATE INDEX ... ;
```

No data backfill. No existing columns modified. `CREATE EXTENSION IF NOT EXISTS` is idempotent — if `citext` is already enabled on the cluster (common; it's a contrib extension), the statement is a no-op.

**Rollback story:** drop the 5 tables + 3 enums. Leave the `citext` extension in place — other features may adopt it, and dropping it requires no dependencies to exist against it. Existing generation, preset, and model flows are untouched by this migration (the metadata JSON conventions in §4.6 are additive and ignored by pre-feature code).

---

## 9. Open questions for DB review

1. **`WildcardSetValue.value` type.** `@db.Text` chosen for unbounded length. Some values (weighted alternation) can realistically hit 2-3KB. Any concern about TOAST overhead given we're fetching many per picker call?
2. **Denormalization of `valueCount` / `totalValueCount`.** Kept for read-path performance; updated in app code at import and on per-value audit flips. Would a generated column (or a trigger) be preferred for consistency guarantees?
3. **Global set deletion.** Current plan: `WildcardSet` rows are never hard-deleted; `isInvalidated` handles policy-driven removals. Do we want a separate `deletedAt` for a softer concept, or is hard-delete-with-cascade acceptable if reviewed case-by-case?
4. **Partitioning `WildcardSetValue`?** At 7.5M rows with mostly append-only writes, probably not needed for v1, but worth noting if we think read patterns justify it.
5. **Audit rule version as a string.** Letting the audit service own the versioning scheme. Alternative: a dedicated `AuditRuleset` table and FK to it. Simpler-as-string for v1?
6. **Snippet category as free-form string vs FK to a categories table.** Current plan: free-form string, users coin their own. Alternative: a `SnippetCategory` FK table for normalization + autocomplete against existing categories. Simpler-as-string for v1; we can add a table later if we want cross-user category discovery.

---

## 10. Out of scope for v1

- Search indexes over snippet/wildcard content (we defer to straightforward WHERE clauses until scale warrants).
- Cross-user snippet discovery (public snippet library).
- Wildcard set version-diff storage (we keep `sourceLineIndex` for future use).
- Set favoriting, tagging, or grouping beyond `sortOrder`.
- A dedicated `SnippetCategory` normalization table.

These are deliberately punted — the schema above accommodates them as additive changes later.
