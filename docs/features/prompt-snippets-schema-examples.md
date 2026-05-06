# Prompt Snippets — Populated Table Examples

**Status:** draft for DB review
**Companion docs:**

- [prompt-snippets.md](./prompt-snippets.md) (product/UX plan)
- [prompt-snippets-schema.md](./prompt-snippets-schema.md) (schema spec — authoritative)

Concrete walkthrough of the unified wildcard schema, populated with real content from [fullFeatureFantasy v3.0](https://civitai.com/models?type=Wildcards). Row IDs are illustrative. Two tables: `WildcardSet`, `WildcardSetCategory`. No separate `PromptSnippet` table — user personal content lives in User-kind `WildcardSet`s alongside imported System-kind content. No DB join table for "user has loaded this set" — load state lives in the form's localStorage and is snapshotted into workflow metadata at submit time.

---

## Scenario

Three actors:

- **Alice** (`userId: 1001`). New to the snippet system. Will create personal snippets and load a wildcard model.
- **Bob** (`userId: 2042`). Power user, already loads other wildcard models. Will load `fullFeatureFantasy v3.0` after Alice imports it.
- **`fullFeatureFantasy v3.0`** (`ModelVersion.id: 458231`, type `Wildcard`). 59 `.txt` files, ~1,850 values total.

For tractable examples we focus on a handful of representative categories from fullFeatureFantasy.

---

## Stage 1 — Initial state (before Alice does anything)

Three System-kind sets imported by other users earlier. No User-kind sets shown yet.

### `WildcardSet` (existing rows)

| id | kind | modelVersionId | modelName | versionName | ownerUserId | name | auditStatus | isInvalidated | totalValueCount |
|----|----|----|----|----|----|----|----|----|----|
| 3 | System | 301004 | DarkFantasyChars | v1.2 | null | null | Clean | false | 310 |
| 12 | System | 401876 | MedievalEnvironments | v2.1 | null | null | Mixed | false | 904 |
| 16 | System | 412009 | AnimeExpressions | v1.0 | null | null | Clean | false | 128 |

### `WildcardSetCategory` (sample from existing System-kind sets)

| id | wildcardSetId | name | values (preview) | valueCount | auditStatus | nsfwLevel |
|----|----|----|----|----|----|----|
| 201 | 3 | character | `["elven ranger in forest green", "dwarven warrior with braided beard", ...]` | 42 | Clean | 1 |
| 202 | 3 | weapon | `["{2.0::greatsword\|1.5::longsword\|...}"]` | 1 | Clean | 1 |
| 215 | 12 | tavern | `["cozy medieval tavern with roaring fireplace", ...]` | 65 | Clean | 1 |
| 401 | 16 | face_expression | `["soft smile, relaxed eyes", ...]` | 24 | Clean | 1 |

`nsfwLevel` values follow the existing Civitai bitwise convention. `1` is a placeholder for "SFW only" — actual bit values are defined elsewhere.

### Bob's loaded sets (client-side only)

Bob's form has `wildcardSetIds: [3, 12, 16]` in localStorage (the list of System-kind sets he's loaded via "create" buttons on wildcard model pages). No DB rows track this — the sets are public, server-side authorization is implicit. Alice's form has no localStorage list yet (she'll get one when her User-kind set is created in Stage 2).

---

## Stage 2 — Alice's first snippet save creates her User-kind set

Alice browses the picker for a `#character` reference, sees a value she likes from somewhere else, and clicks "Save to my snippets." Since she's never saved before, the service lazily creates a User-kind set for her, then a category in it.

```ts
await prisma.$transaction(async (tx) => {
  // 1. Find or create the user's default "My snippets" set
  let userSet = await tx.wildcardSet.findFirst({
    where: { kind: 'User', ownerUserId: 1001, name: 'My snippets' }
  });

  if (!userSet) {
    userSet = await tx.wildcardSet.create({
      data: {
        kind: 'User',
        ownerUserId: 1001,
        name: 'My snippets',
        auditStatus: 'Pending',
        totalValueCount: 0,
      }
    });
    // No DB join table — the user's User-kind set is always implicitly loaded.
    // The form discovers it on mount via getMySnippetSet().
  }

  // 2. Create a new category with the saved value (or append to an existing category — User-kind values are mutable)
  await tx.wildcardSetCategory.create({
    data: {
      wildcardSetId: userSet.id,
      name: 'character',
      values: ['blonde hair, green tunic, pointed ears, pointed cap, determined expression'],
      valueCount: 1,
      auditStatus: 'Pending',
      nsfwLevel: 0,
    }
  });

  await tx.wildcardSet.update({
    where: { id: userSet.id },
    data: { totalValueCount: { increment: 1 } }
  });
});
```

### `WildcardSet` — new row 30 (Alice's User-kind set)

| id | kind | modelVersionId | modelName | versionName | ownerUserId | name | auditStatus | totalValueCount |
|----|----|----|----|----|----|----|----|----|
| 30 | User | null | null | null | 1001 | "My snippets" | Pending | 1 |

### `WildcardSetCategory` — new row 700

| id | wildcardSetId | name | values | valueCount | auditStatus | nsfwLevel |
|----|----|----|----|----|----|----|
| 700 | 30 | character | `["blonde hair, green tunic, pointed ears, pointed cap, determined expression"]` | 1 | Pending | 0 |

The user's User-kind set is implicitly loaded — the form discovers it on mount and treats it as always present in the resolver's set pool. No row written to a join table. Alice's form has no other localStorage `wildcardSetIds` yet.

If Alice later saves more `character` values, the service appends to row 700's `values` array (User-kind categories are mutable). Each mutation triggers a per-category re-audit.

After audit (next stage of background work), category 700 transitions to `Clean` with an `nsfwLevel` set, and `WildcardSet 30` rolls up to `Clean`.

---

## Stage 3 — Alice loads fullFeatureFantasy v3.0 (first-import)

Alice clicks "create" on the fullFeatureFantasy v3.0 wildcard model page. Nobody has imported this version before, so the service does the full extraction. The returned `WildcardSet.id` goes into her form's localStorage `wildcardSetIds`.

```ts
const setId = await prisma.$transaction(async (tx) => {
  const existing = await tx.wildcardSet.findUnique({
    where: { modelVersionId: 458231 }
  });

  if (existing) return existing.id;   // No DB write — client adds to localStorage

  const files = await extractWildcardZip(458231);
  const totalValueCount = files.reduce((n, f) => n + f.lines.length, 0);

  const set = await tx.wildcardSet.create({
    data: {
      kind: 'System',
      modelVersionId: 458231,
      modelName: 'fullFeatureFantasy',
      versionName: 'v3.0',
      sourceFileCount: files.length,
      totalValueCount,
      auditStatus: 'Pending',
    }
  });

  for (const [i, f] of files.entries()) {
    await tx.wildcardSetCategory.create({
      data: {
        wildcardSetId: set.id,
        name: f.name.replace(/\.txt$/, ''),
        values: f.lines,                  // text[]
        valueCount: f.lines.length,
        displayOrder: i,
        auditStatus: 'Pending',
        nsfwLevel: 0,
      }
    });
  }

  return set.id;
});
// Post-commit: enqueue audit job for setId; client updates localStorage wildcardSetIds.
```

### `WildcardSet` — new row 17 (System-kind)

| id | kind | modelVersionId | modelName | versionName | ownerUserId | name | auditStatus | sourceFileCount | totalValueCount |
|----|----|----|----|----|----|----|----|----|----|
| 17 | System | 458231 | fullFeatureFantasy | v3.0 | null | null | Pending | 59 | 1847 |

### `WildcardSetCategory` — 59 new rows (representative sample)

Each row's `values` is a Postgres `text[]` (one entry per non-empty line in the source `.txt`). `auditStatus` is `Pending` until the audit job runs.

| id | wildcardSetId | name | values (preview) | valueCount | auditStatus | nsfwLevel |
|----|----|----|----|----|----|----|
| 601 | 17 | character | `["#character_f", "#character_m"]` | 2 | Pending | 0 |
| 602 | 17 | character_f | `["1girl, solo, #booru_looks_hair_length, #booru_looks_hair_style, #booru_looks_hair_color, {#booru_looks_hair_accessories\|}, #booru_looks_eye_color"]` | 1 | Pending | 0 |
| 603 | 17 | character_m | `["1boy, man, (muscular_male:0.6), (masculine:0.8), male_focus, solo, #booru_looks_hair_male, #booru_looks_hair_color, #booru_looks_eye_color,"]` | 1 | Pending | 0 |
| 620 | 17 | color | `["blackbluebrowndark_blue..."]` | 1 | Pending | 0 |
| 631 | 17 | elemental_types | `["fire", "water", "earth", "wind", "ice", "lightning", "nature", "light", "shadow", "lava", "storm", "crystal", "metal", "void", "cosmic", "arcane"]` | 16 | Pending | 0 |
| 635 | 17 | expressions | `["{3.0::serious\|3.0::determined\|2.5::smirk\|...}"]` | 1 | Pending | 0 |
| 654 | 17 | weapons_melee | `["{3.0::sword\|3.0::dagger\|...}"]` | 1 | Pending | 0 |
| 656 | 17 | weather_time | `["{1-2$$3.0::day\|3.0::night\|2.5::sun\|...}"]` | 1 | Pending | 0 |

Observations:

- Most categories contain a single line with internal Dynamic Prompts syntax (alternation/weights) → 1-element `text[]`. Resolver expands the syntax at gen time.
- `elemental_types.txt` is the simple-list outlier — 16 distinct values.
- Source-file `__character_f__` style refs are normalized to `#character_f` at import. The stored values shown above already reflect this. Resolution at generation time stays within set 17's scope.
- `color.txt` is malformed at source (no delimiters); audit won't reject this since it's not a policy violation, but it will produce a bad single value.

### Alice's localStorage update

The form's localStorage now reads `wildcardSetIds: [17]` (the new System-kind set). Alice's User-kind set 30 is implicitly loaded by the form on mount, so the resolver sees the union `{30, 17}` for this submission. No DB write was needed to track this.

---

## Stage 4 — Audit job runs

Background worker processes all `Pending` categories with `wildcardSetId IN (17, 30)` (both Alice's set and the new System-kind set). Audit produces a per-category verdict + `nsfwLevel`.

Suppose 6 of fullFeatureFantasy's 59 categories fail audit (e.g. `character_f` flagged for `1girl`-related rules), and Alice's `character` category passes.

| WildcardSetCategory.id | name | auditStatus | nsfwLevel | auditNote |
|----|----|----|----|----|
| 700 | character (Alice's) | Clean | 1 | — |
| 601 | character | Clean | 1 | — |
| 602 | character_f | **Dirty** | 0 | "matches rule: implicit-age/1girl-combined" |
| 603 | character_m | Clean | 1 | — |
| 631 | elemental_types | Clean | 1 | — |
| 635 | expressions | Clean | 1 | — |
| 654 | weapons_melee | Clean | 1 | — |
| 656 | weather_time | Clean | 1 | — |

The set-level rollups update:

| WildcardSet.id | name | auditStatus |
|----|----|----|
| 17 | fullFeatureFantasy v3.0 | **Mixed** (some categories dirty) |
| 30 | "My snippets" | **Clean** |

`Mixed` means the set is still usable — clean categories contribute to pools, dirty categories are excluded. The resolver's `auditStatus = 'Clean'` filter on `WildcardSetCategory` automatically handles this.

---

## Stage 5 — Alice writes a prompt and submits

Alice's prompt:

```
A #character wearing armor, wielding #weapons_melee,
with #expressions expression in #weather_time weather,
featuring #elemental_types magic — dramatic composition, 8k
```

She doesn't make explicit selections — defaults apply. Loaded sets contributing to her prompt:

- **Set 30** (User-kind, "My snippets") — implicitly loaded; has category `character` (Alice's saved Zelda value)
- **Set 17** (System-kind, fullFeatureFantasy v3.0) — loaded via "create" button; has all the referenced categories

### Resolver query for `#character`

Single unified query (no separate path for personal snippets); authorization happens inline via `kind`/`ownerUserId`:

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
       ws.name          AS "userSetName",
       ws."ownerUserId"
FROM "WildcardSet" ws
  JOIN "WildcardSetCategory" wsc  ON wsc."wildcardSetId" = ws.id
WHERE ws.id = ANY(ARRAY[30, 17])         -- the wildcardSetIds from submission
  AND (ws.kind = 'System' OR ws."ownerUserId" = 1001)   -- inline authorization
  AND ws."isInvalidated" = false
  AND wsc.name = 'character'
  AND wsc."auditStatus" = 'Clean'
  AND (wsc."nsfwLevel" & 1) <> 0;   -- SFW context
```

Returns 2 rows for `#character`:

- `categoryId: 700`, `setId: 30`, `setKind: User` — Alice's personal snippet (1 value: "blonde hair, green tunic...")
- `categoryId: 601`, `setId: 17`, `setKind: System` — fullFeatureFantasy's character category (2 values: `#character_f`, `#character_m`). Note `#character_f` will fail nested resolution at gen time because category 602 is Dirty — only `#character_m` will produce content.

### Merged pools per category (after applying defaults = full pool)

| Reference | From My Snippets (set 30) | From fullFeatureFantasy v3.0 (set 17) | Total clean values |
|----|----|----|----|
| `#character` | 1 (Alice's Zelda) | 2 (`#character_f`*, `#character_m`) | 3 |
| `#weapons_melee` | 0 | 1 (weighted alternation) | 1 |
| `#expressions` | 0 | 1 | 1 |
| `#weather_time` | 0 | 1 | 1 |
| `#elemental_types` | 0 | 16 | 16 |

\* `#character_f` resolves to nothing at gen time (category 602 is Dirty) but the value is still in the pool — the dirtiness only matters when the nested ref tries to expand. Implementation may want to surface this proactively in audit.

Cartesian: `3 × 1 × 1 × 1 × 16 = 48 combinations` → over the 10-cap → seeded random sampling down to 10.

### Submission payload (client → server)

Alice has nothing in her negative prompt for this submission, so `negativePrompt` is an empty array. The `snippets` data is a node inside the generation-graph (carried by `input` alongside prompt, negativePrompt, resources, etc.), not a sibling of `input`. `mode` and `batchCount` default to `"random"` and `1` and can be omitted; she's left them at the defaults:

```jsonc
{
  "input": {
    "seed": 847291,
    "quantity": 4,
    "prompt": "A #character wearing armor, wielding #weapons_melee, with #expressions expression in #weather_time weather, featuring #elemental_types magic — dramatic composition, 8k",
    "negativePrompt": "low quality, blurry",
    /* ... other graph nodes (resources, sampler, etc.) ... */
    "snippets": {
      "wildcardSetIds": [30, 17],
      // mode and batchCount omitted — defaults to "random" / 1
      "targets": {
        "prompt": [
          { "category": "character",        "selections": [] },
          { "category": "weapons_melee",    "selections": [] },
          { "category": "expressions",      "selections": [] },
          { "category": "weather_time",     "selections": [] },
          { "category": "elemental_types",  "selections": [] }
        ],
        "negativePrompt": []
      }
    }
  },
  /* ... existing top-level fields like civitaiTip, tags, remixOfId, buzzType ... */
}
```

`selections: []` means "use full pool" — the default. On the client, the `snippets` object is the serialized form of a dedicated node in the generation-graph; each editor node (prompt, negativePrompt) has a dependency on the snippets node and re-renders its chips by reading `input.snippets.targets[<ownNodeName>]`.

### Workflow metadata (one record for the whole batch)

```jsonc
{
  // workflow.metadata
  "params": {
    "prompt": "A #character wearing armor, ...",     // existing — graph form data
    "negativePrompt": "low quality, blurry",         // existing
    "seed": 847291,                                  // existing
    /* ... other graph form fields ... */
    "snippets": {
      "wildcardSetIds": [30, 17],                    // Alice's User-kind set + fullFeatureFantasy load
      // mode and batchCount omitted — defaults: "random" / 1
      "targets": {
        "prompt": [
          { "category": "character",       "selections": [] },   // [] = full pool default
          { "category": "weapons_melee",   "selections": [] },
          { "category": "expressions",     "selections": [] },
          { "category": "weather_time",    "selections": [] },
          { "category": "elemental_types", "selections": [] }
        ],
        "negativePrompt": []
      }
    }
  },
  "tags": [..., "wildcards"]              // workflow.tags gets the 'wildcards' marker
}
```

`snippets` lives at `workflow.metadata.params.snippets` — same place as the prompt, negativePrompt, seed, and other graph form data. `wildcardSetIds` snapshots which sets contributed to the default pools. Without it, re-resolving this submission later would consult Alice's *current* loaded sets, which may have changed.

With defaults (`mode: "random"`, `batchCount: 1`), Alice's submission produces a single step with one random draw per reference from the merged pools. Had she switched `mode` to `"batch"` and bumped `batchCount` to `10`, the resolver would compute the cartesian total (3 × 1 × 1 × 1 × 16 = 48) and sample 10 of the 48 combinations using the form's seed.

Alice didn't make explicit picks (defaults applied) so every `selections` array is empty. Had she explicitly included, say, just her saved Zelda value for `#character`, that entry's `selections` would read `[{ "categoryId": 700, "in": ["blonde hair, green tunic, ..."], "ex": [] }]`. Conversely, if she wanted to *exclude* `#character_f` from the fullFeatureFantasy pool while keeping the rest of the default behavior, she would record `[{ "categoryId": 601, "in": [], "ex": ["#character_f"] }]`. `categoryId` is the canonical source pointer (the parent `wildcardSetId` is reachable through the FK on `WildcardSetCategory`).

The `wildcards` tag on `workflow.tags` lets analytics/admin queries filter for snippet-using submissions without parsing the metadata blob.

### Step metadata (per image, one of the 10 sampled steps)

Vanilla — looks identical to a no-snippet step. The snippet substitution has already happened server-side.

```jsonc
{
  "params": {
    "prompt": "A blonde hair, green tunic, pointed ears, pointed cap, determined expression wearing armor, wielding sword, with serious expression in day weather, featuring lightning magic — dramatic composition, 8k",
    "negativePrompt": "..."
  }
}
```

The orchestrator processes this step as it would any other — no awareness of where the prompt came from.

---

## Stage 6 — Alice saves a preset

`GenerationPreset.values` gains a key recording loaded sets:

```jsonc
{
  "prompt": "A #character wearing armor, ...",
  "seed": -1,
  "quantity": 4,
  "wildcardSetIds": [30, 17]
}
```

Loading the preset:

1. Form's snippets node hydrates `wildcardSetIds: [30, 17]` from the preset values into its localStorage state.
2. Form fetches `getWildcardSets({ ids: [30, 17] })` to validate authorization (System sets are public; User sets must match the requester) and get set details for the picker.
3. Any IDs not authorized (e.g., a User-kind set that's been deleted, or a System-kind set since invalidated) are silently dropped from the form state and surfaced as a warning chip in the picker.

Crucially, no DB rows are mutated by preset load — only form state changes.

---

## Stage 7 — Bob loads fullFeatureFantasy

Bob clicks "create" on the fullFeatureFantasy v3.0 wildcard model page. The lookup finds existing `WildcardSet 17` and returns its ID — no DB write needed. Bob's form's localStorage moves from `wildcardSetIds: [3, 12, 16]` to `[3, 12, 16, 17]`.

Zero re-extraction, zero re-audit, zero new rows. Content sharing pays off.

---

## Edge case examples

### Dirty category excluded automatically

Category 602 (`character_f`) is `Dirty`. The resolver's `auditStatus = 'Clean'` filter excludes it transparently. When `#character_f` is encountered during nested resolution at gen time, it fails to find a clean source and emits the literal text (or skips, depending on resolver policy). Alice's prompts skew toward `#character_m`.

### Set invalidation

Mods unpublish fullFeatureFantasy v3.0 for policy reasons:

```sql
UPDATE "WildcardSet"
SET "isInvalidated" = true,
    "invalidationReason" = 'Model removed: MOD-12834',
    "invalidatedAt" = NOW()
WHERE id = 17;
```

Resolver filter `ws."isInvalidated" = false` excludes the set immediately. Alice and Bob still have ID 17 in their localStorage `wildcardSetIds`; the picker shows a warning badge until they remove it.

### Audit rule version bump

```sql
SELECT id FROM "WildcardSetCategory"
WHERE "auditRuleVersion" IS NULL OR "auditRuleVersion" != '2026-05-01-r1';
```

Re-audit job sweeps affected categories and updates verdicts. Set-level aggregate is recomputed afterward.

### User deletes their User-kind set

```sql
DELETE FROM "WildcardSet" WHERE id = 30 AND "ownerUserId" = 1001;
```

Cascades through:

- `WildcardSetCategory` (Alice's `character` category, id 700) — deleted

Other users are unaffected. Workflow metadata for past submissions still references the deleted set ID; consumers should handle missing references gracefully ("snippet source no longer available"). Step prompts already contain the substituted text, so they continue to render fine.

---

## Row counts at the end of the scenario

| Table | Row count |
|----|----|
| `WildcardSet` | 5 (3 pre-existing System + 1 new System + 1 Alice User-kind) |
| `WildcardSetCategory` | ~104 (44 pre-existing + 59 fullFeatureFantasy + 1 Alice's "character") |

At projected year-one scale (§7 of schema spec): ~5k System sets, ~100k–500k User sets, ~500k–1M categories. No join table.

---

## Takeaways for DB review

1. **Single content table for both kinds.** System-kind and User-kind sets share `WildcardSet` and `WildcardSetCategory` schemas. The `kind` discriminator + nullable `(modelVersionId, ownerUserId)` distinguishes them. CHECK constraint enforces the invariant.
2. **Values inline as Postgres `text[]`.** `WildcardSetCategory.values` is a `text[]` column. No separate value table, no JSONB. Per-category audit; the category is the atomic unit of allow/deny.
3. **Resolver is a single query** across `WildcardSet → WildcardSetCategory`. Authorization is inline (`kind = 'System' OR ownerUserId = ?`). No DB join table; loaded-set tracking lives in the form's localStorage and is snapshotted into workflow metadata.
4. **Most write pressure is at System-kind first-import** (one bulk transaction per imported model version). User-kind writes are infrequent (one row per user save). Steady-state writes negligible.
5. **Snippet metadata lives on the workflow, not the step.** One `snippetSelections` record per submission captures the user's picks. Each step's metadata is vanilla — just the substituted prompt — so the orchestrator processes snippet-driven steps identically to ordinary steps. Reproduction is anchored on `(seed, prompt template, snippetSelections)`.
6. **System-kind categories are immutable; User-kind categories are mutable.** Source-zip-derived content never changes; user-owned categories support full CRUD on values with each mutation triggering a per-category re-audit. Selections are identified by `value` text (stable under reorder, breaks only on edit/delete — handled gracefully via picker orphan state).
