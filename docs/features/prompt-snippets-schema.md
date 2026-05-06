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
                              │   values: text[]                │
                              │   audit + nsfwLevel here        │
                              └─────────────────────────────────┘
```

**New tables:** `WildcardSet`, `WildcardSetCategory`. (Two new tables.)
**Modified tables:** none (existing `GenerationPreset.values` JSON and `Workflow.metadata.params` JSON gain conventional keys, no schema change).

**Key shape decisions:**

- **One unified content table.** `WildcardSet` covers both globally-shared content imported from wildcard-type models (`kind = System`) and user-owned personal collections (`kind = User`). The discriminator + nullable owner/model FKs differentiate them; the resolver treats them uniformly.
- **Values are an inline Postgres `text[]` column.** No separate value table, no JSONB. Audit and site-availability flags live on the category. Categories are the atomic unit of audit + visibility — if a category fails audit it disappears from generation pools entirely; if it passes, its `nsfwLevel` controls whether it shows on .com (SFW) vs .red (NSFW) vs both.
- **No `UserWildcardSet` join table.** A user's loaded wildcard sets aren't persisted in a DB join table. Their own User-kind set is queryable directly via `WildcardSet WHERE kind = 'User' AND ownerUserId = ?`. Additional sets they've loaded (via "create" buttons on wildcard model pages) live in the form's localStorage — the generation-graph carries those IDs at submission time. Server validates: System-kind sets are public; User-kind sets check `ownerUserId == submitter`.

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

One row per `.txt` file in the source zip (e.g. `character.txt` → one category). The category's values are stored directly on this row as a Postgres `text[]` column — no separate value table, no JSONB structure. Audit and site-availability flags live here so that a category is the atomic unit of "is this content allowed to be used."

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
  // For User-kind sets, this column is mutable (users add, remove, edit, reorder values);
  // each mutation triggers an audit re-run for the category. For System-kind sets, the column
  // is set at import and never modified (the source model version is immutable).
  values            String[]                @db.Text

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
- `values` is a Postgres `text[]`, e.g. `{"fire","water","earth", ...}` for `elemental_types`, or `{"{3.0::serious|3.0::determined|...}"}` for a single-line weighted-alternation file. Empty source lines are dropped at import. Order is preserved via array position. Identifier for re-edit / metadata uses the literal value string, not the array index — index isn't stable under reorder.
- **Audit is one verdict per category, not per value.** If any line in the category fails audit, the whole category becomes `Dirty` and is excluded from resolution. Authors curate categories as cohesive lists; partial use after a partial-audit-fail isn't a workflow we want to support, and per-line audit columns aren't needed.
- `nsfwLevel` follows the existing Civitai bitwise NSFW convention so the site router can filter categories using the same logic it already uses for images, models, etc. A category with `nsfwLevel = 0` (unrated) is treated as not-yet-available pending classification.
- `valueCount` is denormalized for picker headers — derivable from `array_length(values, 1)` but cached to avoid the function call on hot reads.
- Cascades from `WildcardSet` — deleting a set deletes its categories.

### 4.3 Metadata conventions (no schema change)

Existing JSON blobs gain new conventional keys. **No per-step snippet metadata** — steps remain ignorant of snippets and look identical to no-snippet steps once expansion is done.

**`GenerationPreset.values`** — gains `wildcardSetIds: number[]`. When a preset is saved, we snapshot which `WildcardSet.id`s are loaded. On load, those get re-applied to the form state (with a warning if any have since been removed or invalidated). No DB change; just a new key convention.

**`Workflow.tags`** — when a submission uses snippets, the `wildcards` tag is added to the workflow's existing tags array. Serves as an analytics filter (`workflow.tags @> '{wildcards}'`) and as a quick test for "did this generation use snippets?" without parsing the metadata blob.

**Workflow metadata** — gains a single `snippets` object holding everything. One record per workflow, not per step. The shape uses a generic `targets` map keyed by target ID (e.g. `prompt`, `negativePrompt`) rather than hard-coded keys, so new target types (e.g. a future `musicDescription` editor node) can be added without schema changes.

```jsonc
{
  // workflow.metadata
  "params": {
    "prompt": "A #character ...",          // existing — graph form data lives under params
    "negativePrompt": "...",               // existing
    "seed": 847291,                        // existing
    /* ... other graph form fields ... */
    "snippets": {
      "wildcardSetIds": [490, 491],        // WildcardSet IDs loaded at submit time
      "mode": "random",                    // "batch" | "random" — defaults to "random"
      "batchCount": 1,                     // defaults to 1 (single step)
      "targets": {
        "prompt": [
          {
            "category": "character",
            "selections": [
              { "categoryId": 700, "in": ["blonde hair, green tunic, pointed ears...", "young man, green hat..."], "ex": [] },
              { "categoryId": 401, "in": ["#hero"], "ex": [] }
            ]
          },
          {
            "category": "setting",
            "selections": []               // empty array = "default to full pool"
          }
        ],
        "negativePrompt": [
          { "category": "bad_anatomy", "selections": [] }
        ]
        // future: "musicDescription": [...] — no schema change required
      }
    }
  },
  "tags": [..., "wildcards"]
}
```

`snippets` lives under `workflow.metadata.params` because all graph-form data (except resources) is persisted there — same place as `prompt`, `negativePrompt`, `seed`, etc. The `tags` array stays at the top of `workflow.metadata` since it's workflow-level metadata, not graph form data.

Top-level fields under `snippets`:

- `wildcardSetIds` — snapshot of the `WildcardSet.id`s loaded into the form at submit time. Includes both the user's own User-kind set (always loaded) and any System-kind sets the user added via the "create" button on wildcard model pages. Required for reproducibility of default-pool resolutions; the loaded set list could change between submission and re-resolution. Same convention as `GenerationPreset.values.wildcardSetIds`.
- `mode` — `"batch"` runs unique cartesian-product combinations across the user's selections; `"random"` runs independent random samples per step. Single value applies across all targets. **Defaults to `"random"`** when omitted.
- `batchCount` — number of workflow steps to fan out into. In batch mode, this caps the cartesian product (sample with seeded PRNG if more combinations are available than `batchCount`). In random mode, this is the number of independent random draws. **Defaults to `1`** when omitted.
- `targets` — keyed map of resolution contexts. Key is an arbitrary string identifier (e.g. `prompt`, `negativePrompt`); value is an array of references. Each target maintains its own state — a `#character` reference in `prompt` is independent of a `#character` reference in `negativePrompt`. Cartesian math at resolve time multiplies across **all targets simultaneously**: a step gets one substituted output per target, drawn together from the combined cartesian space.

**`seed` for preview only.** A `seed` field may appear on `snippets` when the user clicks the **Preview** button to see what an expansion looks like before submitting. The preview seed is used by the resolver to produce a deterministic sample and **is not persisted** to the workflow metadata — the workflow's existing top-level `seed` is the source of truth for actual generation. v1 includes the preview button.

**Conventional target keys for v1:** `prompt` and `negativePrompt`. Future targets are additive — implementers iterate `Object.keys(snippets.targets)` and process each one's reference array.

Per-reference shape (entries in each target array):

- `category` — the prompt-side reference name (e.g., `#character` → `"character"`).
- `selections` — the user's explicit picks, grouped by source category. Empty array = default-to-full-pool was used (the pool is computed from `wildcardSetIds`). Concrete entries record:
  - `categoryId` — the canonical source category. The `wildcardSetId` is reachable via the FK on `WildcardSetCategory`, so we don't store it twice.
  - `in` — the array of value strings the user **explicitly included** from this source. Empty when only excludes are used. Strings within the array are unique (app-level enforcement).
  - `ex` — the array of value strings the user **explicitly excluded** from this source's pool. Empty when only includes are used. When both `in` and `ex` are empty for every selection on a reference (or `selections` itself is `[]`), the reference defaults to the full clean pool.

Anything derivable is intentionally not stored:

- The `cartesianTotal` ("48 possible combinations") is a one-line computation from the union of references across all `snippets.targets[*]` + the corresponding template strings at display time.
- `sampledTo` is just `batchCount`.

**Identifier choice — value text, not index.** `in` and `ex` record literal value strings rather than array indices because User-kind values can be reordered, edited, added, and removed by their owner; the index is unstable, the text is mostly stable (explicit edit or removal still orphans the reference, which we handle gracefully). System-kind values never change, but using the same identifier convention keeps the resolver simple.

**Implementation note:** on the client, the entire `snippets` payload lives as a dedicated node in the existing generation graph used by `GenerationForm`. Each editor node (prompt, negativePrompt, and any future targets) has a dependency on the snippets node and reads from `snippets.targets[<editorNodeName>]` to render chips with their current selection state. The snippets node auto-prunes references whose `wildcardSetIds` the user no longer has access to (server returns the validated subset on form mount). Tiptap chips referencing pruned/invalidated sets render in a **red badge state** in the editor to flag "no corresponding snippet to use" — the user can either re-add the source set or delete the reference from the editor.

What's intentionally not stored anywhere on the workflow or step:

- Per-step picks — fully reproducible from `(seed, prompt templates, snippets)`. Re-running the resolver gives identical expansions.
- Nested expansion trees — same reasoning. Recoverable on demand.
- `samplingSeed` — the form's existing `seed` field is the single source of truth for randomness.

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

---

## 6. Key operations and query patterns

### 6.1 First-import of a wildcard model (System-kind)

Atomic transaction. Fewer rows now that values live inline on categories — one insert per category, one bulk transaction per set.

```
BEGIN
  SELECT id FROM WildcardSet WHERE modelVersionId = ? AND kind = 'System'
  IF found: -- no-op server-side; client adds found.id to localStorage wildcardSetIds
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
        values = lines,            -- text[], normalized to `#name`
        valueCount = length(lines),
        displayOrder,
        auditStatus = 'Pending',
        nsfwLevel = 0
      )
    -- client adds new.id to localStorage wildcardSetIds
COMMIT
-- Then: enqueue audit job for the new WildcardSet
```

In v1, no DB join table records "user has loaded this set." When the user clicks "create" on a wildcard model page, the server returns the resolved `WildcardSet.id` and the form's localStorage tracks the loaded list. Server-side authorization at submission time relies on `kind`: System-kind sets are public; User-kind set IDs must match `ownerUserId == submitter`.

Concurrency: two users hitting first-import for the same model version at once — the `(modelVersionId)` unique constraint makes one of them lose with a unique-violation; we catch it in the service layer and retry the "find existing" path.

### 6.1a User-kind set creation and snippet save

User-kind sets and their categories are mutable: users can add values, edit them, reorder them, and remove them at any time. The first time a user clicks "Save to my snippets" (from a wildcard picker row, or via a "create snippet" form), the service ensures a User-kind set exists for them; subsequent saves either append to an existing category or create a new one.

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
    -- The user's User-kind set is always implicitly loaded — no extra tracking needed.
    -- The form discovers it via getMySnippetSet() on mount.

  -- Find or create the category, then append the value
  SELECT id, values FROM WildcardSetCategory WHERE wildcardSetId = ? AND name = ?
  IF not found:
    INSERT WildcardSetCategory (
      wildcardSetId,
      name = '<chosen category, e.g. "character">',
      values = ARRAY[newValue]::text[],
      valueCount = 1,
      auditStatus = 'Pending',
      nsfwLevel = 0
    )
  ELSE:
    -- Append to existing values array; enforce uniqueness within category at the app level
    -- (block exact duplicates with a friendly error).
    UPDATE WildcardSetCategory
      SET values = array_append(values, newValue),
          valueCount = valueCount + 1,
          auditStatus = 'Pending'                  -- re-audit on any mutation
      WHERE id = ?

  UPDATE WildcardSet.totalValueCount += new values added
COMMIT
-- Enqueue audit for the affected WildcardSetCategory
```

Other mutations follow the same pattern — `array_remove(values, target)`, in-place reorder via `UPDATE ... SET values = ARRAY[...]`, etc. Every mutation flips `auditStatus` back to `Pending` and enqueues a re-audit; until the audit completes the category temporarily isn't selectable, but its existing references in past workflows continue to work because past prompts already have substituted text in their step metadata.

### 6.2 Resolver: get content for a `#category` reference

The resolver receives `wildcardSetIds` from the submission payload (sourced from the form's localStorage state, snapshotted into workflow metadata). It validates each ID server-side via `kind` (System sets are public; User sets must match `ownerUserId == submitter`), then fetches the matching categories.

Given `userId`, `wildcardSetIds`, `category='character'`, and the request's site context (SFW vs NSFW expressed as a `requiredNsfwMask` int):

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
FROM "WildcardSet" ws
  JOIN "WildcardSetCategory" wsc  ON wsc."wildcardSetId" = ws.id
WHERE ws.id = ANY(?)                       -- the wildcardSetIds from submission (pre-validated)
  AND (ws.kind = 'System' OR ws."ownerUserId" = ?)   -- authorization: System public, User owner-only
  AND ws."isInvalidated" = false
  AND wsc.name = 'character'
  AND wsc."auditStatus" = 'Clean'
  AND (wsc."nsfwLevel" & ?) <> 0;          -- bitwise filter: category overlaps with required site rating
```

Authorization happens inline via the `kind`/`ownerUserId` check — any submitted ID failing the predicate is silently dropped (the user revoked access, or the set was administratively reassigned, since the form state was saved).

The picker UI groups results by `setKind` for display ("From My Snippets" for User-kind, "From fullFeatureFantasy v3.0" for System-kind), but storage and querying are uniform.

**Indexes carrying this query:** primary key on `WildcardSet.id` (for the `= ANY(?)` lookup); `(ownerUserId)` on `WildcardSet` (for the User-kind authorization filter); `(wildcardSetId, name)` + `(wildcardSetId, auditStatus)` on `WildcardSetCategory`. Two-table-FK-walk, sub-millisecond at this scale.

**Expected result size:** ~3–20 category rows (one per loaded set that has the category). The app unpacks `values` arrays in code to produce the picker's flat list.

**Form mount behavior** (related, client-side): when `GenerationForm` mounts, it always loads the user's own User-kind set (`SELECT * FROM WildcardSet WHERE kind = 'User' AND ownerUserId = ?`), then reads any additional `wildcardSetIds` from localStorage and fetches the corresponding `WildcardSet` rows via a `getWildcardSets(ids: number[])` tRPC query. The server returns only sets the user is authorized for (System + own User-kind); missing IDs are silently stripped. If localStorage is empty (fresh session), the form initializes with just the user's User-kind set plus the platform's system default wildcard set (TODO — see §9 open question 5b).

### 6.3 Audit job — category-level

Triggered on WildcardSet creation, when audit rules version bumps, and (for User-kind) on every category mutation. Audit is per-category: read all values from the array, run audit rules across them, produce one verdict for the whole category. If any line fails, the category is `Dirty`.

```
FOR each WildcardSetCategory WHERE wildcardSetId = ?
  AND (auditStatus = 'Pending' OR auditRuleVersion != currentRuleVersion):
    lines = values   -- text[]
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

Downstream: resolver filters `isInvalidated = false`, so content is immediately excluded from pools. Clients with the set ID still in localStorage see a warning badge on the form. Admin tooling can force-hard-delete a User-kind set (cascade through `WildcardSetCategory`) if we need to purge content entirely; System-kind sets shouldn't be hard-deleted because we can't be sure all submission-history references are no longer needed.

### 6.5 Preset save / load

Active sets are part of the form's generation-graph state, so they snapshot/restore through the same path as the rest of the preset's `values` JSON. No DB writes flip activation state.

**Save:** the form serializes its current state (including the snippets node's `wildcardSetIds` from localStorage) into `preset.values`. No special preset-save code path for snippets:

```
preset.values = serializeFormState();  // includes wildcardSetIds, targets, mode, batchCount
```

**Load:** the form reads `preset.values` and applies it to its generation-graph state. The snippets node's `wildcardSetIds` is hydrated, then a follow-up `getWildcardSets(ids)` fetch validates authorization and returns the set details for the picker. IDs the user is no longer authorized for are silently dropped from the form state and surfaced as a warning chip.

```
applyFormState(preset.values);
const setDetails = await trpc.wildcardSet.getWildcardSets({ ids: form.wildcardSetIds });
form.wildcardSetIds = setDetails.map(s => s.id);  // dropped any not authorized
```

Same flow for **remix**: clicking remix on an old workflow loads `workflow.metadata.params.snippets.wildcardSetIds` (and the rest of the snippet metadata) into the form. The form's local state simply reflects what was loaded for that workflow.

---

## 7. Estimated data volumes

Educated guesses based on current Civitai scale; DB reviewer should sanity-check.

| Table | Per unit | Estimated total at year 1 |
|---|---|---|
| `WildcardSet` (System-kind) | ~1 per imported model version | ~5k rows |
| `WildcardSet` (User-kind) | ~1 per active snippet user | ~100k–500k rows |
| `WildcardSetCategory` | System: ~50 per set, ~6KB text[]. User: ~5 per set, smaller text[] | ~500k–1M rows |

`WildcardSetCategory` total storage is dominated by System-kind sets (~1.5GB across 250k rows from imported wildcard models). User-kind categories are typically smaller — fewer values per category, shorter values — and add negligible storage compared to System-kind. Postgres TOAST handles longer array entries automatically; `text[]` storage is more compact than the equivalent JSONB shape would have been.

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
CREATE TABLE "WildcardSetCategory" (...);      -- has `values text[]`, `auditStatus`, `nsfwLevel`, `name CITEXT`

ALTER TABLE "WildcardSet" ADD CONSTRAINT wildcard_set_kind_owner_check CHECK (
  (kind = 'System' AND "modelVersionId" IS NOT NULL AND "ownerUserId" IS NULL) OR
  (kind = 'User'   AND "modelVersionId" IS NULL     AND "ownerUserId" IS NOT NULL)
);

CREATE UNIQUE INDEX ... ;  -- per index table in §5
CREATE INDEX ... ;
```

No data backfill. No existing columns modified. `CREATE EXTENSION IF NOT EXISTS` is idempotent.

**Rollback story:** drop the 2 tables + 3 enums. Leave the `citext` extension in place. Existing generation, preset, and model flows are untouched by this migration (the metadata JSON conventions in §4.3 are additive and ignored by pre-feature code).

---

## 9. Open questions for DB review

1. **Denormalization of `valueCount` / `totalValueCount`.** Kept for read-path performance. `valueCount` is derivable from `array_length(values, 1)` — could be a generated column. Worth doing, or overkill?
2. **`nsfwLevel` set by audit pipeline vs explicit moderator action.** Current plan: audit produces a verdict + an inferred `nsfwLevel` based on content rules. Mods can override later. Is there a more rigorous classification process the team would want here (e.g., human-in-the-loop required before any non-zero rating)?
3. **Global set deletion.** Current plan: `WildcardSet` rows are never hard-deleted; `isInvalidated` handles policy-driven removals. Do we want a separate `deletedAt` for a softer concept, or is hard-delete-with-cascade acceptable for User-kind sets specifically (since we won't have step-history risk for personal content)?
4. **Audit rule version as a string.** Letting the audit service own the versioning scheme. Alternative: a dedicated `AuditRuleset` table and FK to it. Simpler-as-string for v1?
5. **CHECK constraint enforcement.** The `(kind, modelVersionId, ownerUserId)` invariant is enforced via a single CHECK constraint at migration time. Worth reviewing whether this is the right level of enforcement, or whether we'd prefer a partial unique index approach or trigger-based.
6. **Default User-kind set name.** New users get a User-kind set called "My snippets" lazily created on first save. Hardcoded? Localizable? Prompted? Probably hardcoded for v1 with a per-user rename allowed via `name`.
7. **Re-audit cadence on User-kind mutations.** Every value add/edit/remove flips the category to `Pending` and enqueues a re-audit. For an active user editing rapidly, this could mean many re-audit jobs queued in seconds. Coalesce with debounce? Or just let the queue handle it (audit is fast)?

### TODO items

- **5b. System default wildcard set.** When `GenerationForm` mounts and no `wildcardSetIds` exists in localStorage (fresh session, cleared cache), the form should fall back to a Civitai-curated default set so the snippet picker isn't empty for first-time users. Mechanism TBD: a designated `WildcardSet` row with a special flag (`isSystemDefault Boolean`?) or hardcoded ID. Scope: identify or create the default content; add the boolean column or config; surface in the form's initial state.
- **5c. `getResourceData` integration for Wildcard models.** When a user adds a Wildcard-type model via the resource picker in `GenerationForm`, the existing `getResourceData` helper needs to return the corresponding `WildcardSet.id` so the form can add it to its `wildcardSetIds`. Today `getResourceData` returns model/lora info; extending it to recognize `Wildcard` model type and return the resolved set ID is a focused client+server change.
- **5d. Migration ordering.** Schema changes during the design phase (dropping `isActive`, etc.) should each ship as a separate Prisma migration if any of them lands in production before the next change. Worth flagging up front so we don't end up with a single mega-migration that's hard to roll back.

---

## 10. Out of scope for v1

- Search indexes over snippet/wildcard content (we defer to straightforward WHERE clauses until scale warrants — Postgres GIN on `text[]` columns is an option later).
- Cross-user sharing of User-kind sets (a "Shared" or "Public" `kind` value would be additive when we want it).
- Wildcard set version-diff storage (System-kind sets are immutable; diffing User-kind history is future concern).
- Per-line audit results within a category (audit is atomic at the category level).
- A dedicated favorites feature/table — favoriting is implemented by copying values into a User-kind set named however the user wants ("Favorites", "My picks", etc). No separate UI layer required.
- Per-snippet labels for User-kind sets (values are plain strings; users find content by reading + searching).

These are deliberately punted — the schema above accommodates them as additive changes later.
