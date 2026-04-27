# Prompt Snippets — Populated Table Examples

**Status:** draft for DB review
**Companion docs:**
- [prompt-snippets.md](./prompt-snippets.md) (product/UX plan)
- [prompt-snippets-schema.md](./prompt-snippets-schema.md) (schema spec — authoritative)

Concrete walkthrough of the wildcard-set + personal-snippet schema, populated with real content from [fullFeatureFantasy v3.0](https://civitai.com/models?type=Wildcards). Row IDs are illustrative. All `category`/`name` columns use the PostgreSQL `citext` type — stored values preserve their original casing but comparisons and unique constraints are case-insensitive.

---

## Scenario

Three actors:

- **Alice** (`userId: 1001`). Has a few of her own hand-crafted prompt snippets. Has never imported any wildcard models. About to import `fullFeatureFantasy v3.0` for the first time on Civitai.
- **Bob** (`userId: 2042`). Power user, subscribed to 3 other wildcard sets previously. Will also subscribe to `fullFeatureFantasy v3.0` after Alice imports it.
- **`fullFeatureFantasy v3.0`** (`ModelVersion.id: 458231`, type `Wildcard`). 59 `.txt` files, ~1,850 values total.

For tractable examples, we focus on 8 representative categories.

---

## Stage 1 — Before Alice clicks "Add set"

### `WildcardSet` (global, shared)

Three sets already imported by other users earlier:

| id | modelVersionId | modelName | versionName | auditStatus | isInvalidated | sourceFileCount | totalValueCount | createdAt |
|----|----|----|----|----|----|----|----|----|
| 3 | 301004 | DarkFantasyChars | v1.2 | Clean | false | 14 | 310 | 2026-01-18 |
| 12 | 401876 | MedievalEnvironments | v2.1 | Mixed | false | 22 | 904 | 2026-02-11 |
| 16 | 412009 | AnimeExpressions | v1.0 | Clean | false | 8 | 128 | 2026-03-02 |

No row for fullFeatureFantasy yet.

### `WildcardSetCategory` (sample — a few from the three existing sets)

| id | wildcardSetId | name | valueCount | displayOrder |
|----|----|----|----|----|
| 201 | 3 | character | 42 | 0 |
| 202 | 3 | weapon | 18 | 1 |
| 215 | 12 | tavern | 65 | 3 |
| 216 | 12 | castle | 88 | 4 |
| 401 | 16 | face_expression | 24 | 0 |
| 402 | 16 | body_pose | 16 | 1 |

### `WildcardSetValue` (sample — values pointing to those categories)

| id | categoryId | value (preview) | auditStatus | sourceLineIndex |
|----|----|----|----|----|
| 12001 | 201 | `elven ranger in forest green` | Clean | 0 |
| 12002 | 201 | `dwarven warrior with braided beard` | Clean | 1 |
| 18040 | 215 | `cozy medieval tavern with roaring fireplace` | Clean | 0 |
| 22500 | 401 | `soft smile, relaxed eyes` | Clean | 0 |

### `UserWildcardSet` (Bob's existing pointers)

| id | userId | wildcardSetId | nickname | isActive | sortOrder | addedAt |
|----|----|----|----|----|----|----|
| 88 | 2042 | 3 | null | true | 0 | 2026-02-14 09:12:00 |
| 89 | 2042 | 12 | "Medieval env" | false | 1 | 2026-02-20 14:08:22 |
| 104 | 2042 | 16 | null | true | 2 | 2026-03-10 19:44:01 |

Alice has none yet.

### `PromptSnippet` (Alice's personal editable snippets)

| id | userId | category | name | value | auditStatus | auditRuleVersion | sortOrder |
|----|----|----|----|----|----|----|----|
| 412 | 1001 | character | "Zelda" | "blonde hair, green tunic, pointed ears, pointed cap, determined expression" | Clean | 2026-04-01-r3 | 0 |
| 413 | 1001 | character | "Link" | "young man, green hat and tunic, sword and shield, Hylian ears" | Clean | 2026-04-01-r3 | 1 |
| 414 | 1001 | setting | "Forest Cabin" | "wooden cabin in dense forest, moss, dappled sunlight, quiet" | Clean | 2026-04-01-r3 | 0 |
| 415 | 1001 | setting | "Cyberpunk Street" | "neon-lit alley, rain-slicked pavement, holographic signs, futuristic" | Clean | 2026-04-01-r3 | 1 |

---

## Stage 2 — Alice clicks "Add set" → fullFeatureFantasy v3.0

First-import transaction. Values are inserted in two passes: categories first (so their IDs exist for the values' FK), then values as a single bulk insert.

```ts
await prisma.$transaction(async (tx) => {
  const existing = await tx.wildcardSet.findUnique({ where: { modelVersionId: 458231 } });
  if (existing) {
    await tx.userWildcardSet.create({ data: { userId: 1001, wildcardSetId: existing.id, isActive: true } });
    return;
  }

  const files = await extractWildcardZip(458231);
  const totalValueCount = files.reduce((n, f) => n + f.lines.length, 0);

  // 1. Set
  const set = await tx.wildcardSet.create({
    data: {
      modelVersionId: 458231,
      modelName: "fullFeatureFantasy",
      versionName: "v3.0",
      auditStatus: "Pending",
      sourceFileCount: files.length,
      totalValueCount,
    }
  });

  // 2. Categories — createMany isn't enough because we need the IDs for values.
  //    Insert one at a time (or use createManyAndReturn on newer Prisma).
  const categories = [];
  for (const [i, f] of files.entries()) {
    const cat = await tx.wildcardSetCategory.create({
      data: {
        wildcardSetId: set.id,
        name: f.name.replace(/\.txt$/, ""),
        valueCount: f.lines.length,
        displayOrder: i,
      }
    });
    categories.push({ ...cat, lines: f.lines });
  }

  // 3. Values — one bulk insert
  await tx.wildcardSetValue.createMany({
    data: categories.flatMap(c =>
      c.lines.map((line, idx) => ({
        categoryId: c.id,
        value: line,
        sourceLineIndex: idx,
        auditStatus: "Pending",
      }))
    )
  });

  // 4. Alice's pointer
  await tx.userWildcardSet.create({
    data: { userId: 1001, wildcardSetId: set.id, isActive: true }
  });
});

// Post-commit: enqueue audit job for set.id
```

**Concurrency note:** two users racing the first-import both try to create a `WildcardSet` with the same `modelVersionId`. The `@unique(modelVersionId)` constraint means one succeeds, one gets a unique-violation error — caught by the service and retried as the "existing" branch. Clean.

### `WildcardSet` — new row (id 17)

| id | modelVersionId | modelName | versionName | auditStatus | isInvalidated | sourceFileCount | totalValueCount | createdAt |
|----|----|----|----|----|----|----|----|----|
| 17 | 458231 | fullFeatureFantasy | v3.0 | **Pending** | false | 59 | 1847 | 2026-04-24 12:33:07 |

### `WildcardSetCategory` — 59 new rows (representative sample)

One row per `.txt` file. `name` uses the `citext` type — stores the filename as-is (minus extension), compared case-insensitively. `valueCount` is denormalized for display.

| id | wildcardSetId | name | valueCount | displayOrder |
|----|----|----|----|----|
| 601 | 17 | character | 2 | 0 |
| 602 | 17 | character_f | 1 | 1 |
| 603 | 17 | character_m | 1 | 2 |
| 620 | 17 | color | 1 | 14 |
| 631 | 17 | elemental_types | 16 | 22 |
| 635 | 17 | expressions | 1 | 25 |
| 654 | 17 | weapons_melee | 1 | 48 |
| 656 | 17 | weather_time | 1 | 50 |

(…51 more category rows omitted)

### `WildcardSetValue` — 1,847 new rows (representative sample)

Each value references its category via `categoryId`. Notice how the 16 `elemental_types` values all share `categoryId: 631` — no string duplication.

**From `character.txt`** (categoryId 601; 2 lines, both nested references):

| id | categoryId | value | auditStatus | sourceLineIndex |
|----|----|----|----|----|
| 30401 | 601 | `__character_f__` | Pending | 0 |
| 30402 | 601 | `__character_m__` | Pending | 1 |

**From `character_f.txt`** (categoryId 602; complex template):

| id | categoryId | value | auditStatus | sourceLineIndex |
|----|----|----|----|----|
| 30403 | 602 | `1girl, solo, __booru_looks_hair_length__, __booru_looks_hair_style__, __booru_looks_hair_color__, {__booru_looks_hair_accessories__\|}, __booru_looks_eye_color__` | Pending | 0 |

**From `character_m.txt`** (categoryId 603):

| id | categoryId | value | auditStatus | sourceLineIndex |
|----|----|----|----|----|
| 30404 | 603 | `1boy, man, (muscular_male:0.6), (masculine:0.8), male_focus,  solo, __booru_looks_hair_male__, __booru_looks_hair_color__, __booru_looks_eye_color__,` | Pending | 0 |

**From `color.txt`** (categoryId 620; malformed source — one long line without delimiters):

| id | categoryId | value | auditStatus | sourceLineIndex |
|----|----|----|----|----|
| 30431 | 620 | `blackbluebrowndark_bluedark_browndark_greendark_orangedark_purpledark_redgraygreenlight_bluelight_brownlight_greenpurpleredpinkorangewhiteyellow` | Pending | 0 |

**From `elemental_types.txt`** (categoryId 631; simple one-value-per-line list):

| id | categoryId | value | auditStatus | sourceLineIndex |
|----|----|----|----|----|
| 30445 | 631 | `fire` | Pending | 0 |
| 30446 | 631 | `water` | Pending | 1 |
| 30447 | 631 | `earth` | Pending | 2 |
| 30448 | 631 | `wind` | Pending | 3 |
| 30449 | 631 | `ice` | Pending | 4 |
| 30450 | 631 | `lightning` | Pending | 5 |
| 30451 | 631 | `nature` | Pending | 6 |
| 30452 | 631 | `light` | Pending | 7 |
| 30453 | 631 | `shadow` | Pending | 8 |
| 30454 | 631 | `lava` | Pending | 9 |
| 30455 | 631 | `storm` | Pending | 10 |
| 30456 | 631 | `crystal` | Pending | 11 |
| 30457 | 631 | `metal` | Pending | 12 |
| 30458 | 631 | `void` | Pending | 13 |
| 30459 | 631 | `cosmic` | Pending | 14 |
| 30460 | 631 | `arcane` | Pending | 15 |

All 16 point to the same `categoryId: 631`. This is the win of the normalized schema vs. having 16 copies of `"elemental_types"` in a `categoryName` column.

**From `expressions.txt`** (categoryId 635; weighted alternation):

| id | categoryId | value | auditStatus | sourceLineIndex |
|----|----|----|----|----|
| 30512 | 635 | `{3.0::serious\|3.0::determined\|2.5::smirk\|2.5::smile\|2.5::light_smile\|2.0::angry\|2.0::grin\|2.0::frown\|1.5::evil_smile\|1.5::confident\|1.0::smug\|1.0::happy\|1.0::sad\|1.0::worried\|0.8::shouting\|0.8::laughing\|0.8::crying\|0.8::scared\|0.8::surprised\|0.8::annoyed\|0.8::crazy_smile\|0.8::grimace\|0.5::bored\|0.5::tired\|0.5::embarrassed\|0.5::nervous\|0.3::expressionless\|0.3::deadpan\|0.3::crazy_eyes}` | Pending | 0 |

**From `weapons_melee.txt`** (categoryId 654):

| id | categoryId | value | auditStatus | sourceLineIndex |
|----|----|----|----|----|
| 30607 | 654 | `{3.0::sword\|3.0::dagger\|2.5::katana\|2.5::axe\|2.5::staff\|2.0::greatsword\| ... 35 more options ... \|0.3::beam_saber}` | Pending | 0 |

**From `weather_time.txt`** (categoryId 656; weighted multi-pick):

| id | categoryId | value | auditStatus | sourceLineIndex |
|----|----|----|----|----|
| 30742 | 656 | `{1-2$$3.0::day\|3.0::night\|2.5::sun\|2.5::moon\|2.0::cloudy_sky\| ... \|0.3::rainbow}` | Pending | 0 |

**Key observations:**

1. **Each file line = one `WildcardSetValue` row**, regardless of whether the line itself has internal A1111 syntax. `expressions.txt` has a single line with 29 weighted alternatives inside — that's 1 row in the DB, expanded by the resolver at generation time.
2. **Nested references** (`__character_f__`) resolve at generation time. `character.txt` values point to other categories in the same set. The resolver looks up `character_f` via `WildcardSetCategory.name = 'character_f'` within `wildcardSetId = 17` first, then falls back to the user's other active sets / personal snippets.
3. **Malformed content** (`color.txt`) passes through unchanged. Audit won't catch this. Could warrant a lint pass in a later version.

### `UserWildcardSet` — Alice's new pointer

| id | userId | wildcardSetId | nickname | isActive | sortOrder | addedAt |
|----|----|----|----|----|----|----|
| 491 | 1001 | 17 | null | true | 0 | 2026-04-24 12:33:08 |

---

## Stage 3 — Audit job runs

Background worker processes `wildcardSetId = 17`. Per-value audit (~1,847 regex-based audits, a few ms each, ~3–5s wall-clock).

Imagine 6 of the 1,847 values flag the current rule version (`2026-04-01-r3`). Post-audit:

| WildcardSetValue.id | value (preview) | auditStatus | auditNote |
|----|----|----|----|
| 30403 | `1girl, solo, __booru_looks_hair_length__, ...` | **Dirty** | "matches rule: implicit-age/1girl-combined" |
| 30402, 30404, 30445–30460, 30512, 30607, 30742 | (others shown above) | Clean | — |

`WildcardSet` row update:

| id | auditStatus | auditRuleVersion | auditedAt |
|----|----|----|----|
| 17 | **Mixed** | 2026-04-01-r3 | 2026-04-24 12:33:12 |

`Mixed` = set usable, just with 6 values excluded from pools automatically via the `auditStatus = 'Clean'` filter in the resolver.

**Note:** `WildcardSetCategory.valueCount` is **not** decremented when values go Dirty. It reflects total rows in the category (for admin/audit transparency), not clean-only rows. The resolver computes clean counts per-query. If we want a "clean count" for display, we add a derived column or a small aggregate query.

---

## Stage 4 — Alice builds a prompt

Alice types:

```
A #character wearing armor, wielding #weapons_melee,
with #expressions expression in #weather_time weather,
featuring #elemental_types magic — dramatic composition, 8k
```

Defaults to all (no explicit selections). Active sources: her personal snippets + fullFeatureFantasy v3.0.

### Resolver query for `#character`

Three-table JOIN through pointer → set → category → value:

```sql
-- Personal snippets (unchanged)
SELECT id, name, value, 'snippet' AS source, 'Alice' AS sourceLabel
FROM "PromptSnippet"
WHERE "userId" = 1001
  AND category = 'character'
  AND "auditStatus" = 'Clean';
-- Returns: id 412 (Zelda), id 413 (Link)

-- Wildcard values via active sets
SELECT wsv.id, wsc.name AS categoryName, wsv.value,
       ws."modelName" || ' ' || ws."versionName" AS sourceLabel,
       'wildcardSet' AS source
FROM "UserWildcardSet" uws
  JOIN "WildcardSet" ws           ON uws."wildcardSetId" = ws.id
  JOIN "WildcardSetCategory" wsc  ON wsc."wildcardSetId" = ws.id
  JOIN "WildcardSetValue" wsv     ON wsv."categoryId" = wsc.id
WHERE uws."userId" = 1001
  AND uws."isActive" = true
  AND ws."isInvalidated" = false
  AND wsc.name = 'character'
  AND wsv."auditStatus" = 'Clean';
-- Returns: id 30401 (`__character_f__` — from category 601)
--          id 30402 (`__character_m__` — from category 601)
```

### Merged pools per category

| Reference | My snippets | fullFeatureFantasy v3.0 | Total pool |
|----|----|----|----|
| `#character` | 2 (Zelda, Link) | 2 (`__character_f__`, `__character_m__`) | 4 |
| `#weapons_melee` | 0 | 1 | 1 |
| `#expressions` | 0 | 1 | 1 |
| `#weather_time` | 0 | 1 | 1 |
| `#elemental_types` | 0 | 16 | 16 |

Cartesian: `4 × 1 × 1 × 1 × 16 = 64` → sampled to 10 via seed 847291.

### Submission payload

```jsonc
{
  "promptDoc": { /* Tiptap doc JSON */ },
  "promptTemplate": "A #character wearing armor, wielding #weapons_melee, with #expressions expression in #weather_time weather, featuring #elemental_types magic — dramatic composition, 8k",
  "references": [
    { "nodeId": "r-abc1", "category": "character", "selections": [] },
    { "nodeId": "r-abc2", "category": "weapons_melee", "selections": [] },
    { "nodeId": "r-abc3", "category": "expressions", "selections": [] },
    { "nodeId": "r-abc4", "category": "weather_time", "selections": [] },
    { "nodeId": "r-abc5", "category": "elemental_types", "selections": [] }
  ],
  "seed": 847291,
  "quantity": 4
}
```

### Workflow step metadata (one of the 10 sampled steps)

Stored on the existing step metadata JSON. Each resolved wildcard value records `wildcardSetId`, `categoryId`, and `valueId` so the full path is traceable later without JOINs:

```jsonc
{
  "snippetReferences": [
    {
      "nodeId": "r-abc1",
      "category": "character",
      "resolvedValue": {
        "source": "snippet",
        "snippetId": 412,
        "value": "blonde hair, green tunic, pointed ears, pointed cap, determined expression"
      }
    },
    {
      "nodeId": "r-abc2",
      "category": "weapons_melee",
      "resolvedValue": {
        "source": "wildcardSet",
        "wildcardSetId": 17,
        "categoryId": 654,
        "valueId": 30607,
        "value": "{3.0::sword|3.0::dagger|..."
      }
    },
    {
      "nodeId": "r-abc3",
      "category": "expressions",
      "resolvedValue": {
        "source": "wildcardSet",
        "wildcardSetId": 17,
        "categoryId": 635,
        "valueId": 30512,
        "value": "{3.0::serious|3.0::determined|..."
      }
    },
    {
      "nodeId": "r-abc4",
      "category": "weather_time",
      "resolvedValue": {
        "source": "wildcardSet",
        "wildcardSetId": 17,
        "categoryId": 656,
        "valueId": 30742,
        "value": "{1-2$$3.0::day|3.0::night|..."
      }
    },
    {
      "nodeId": "r-abc5",
      "category": "elemental_types",
      "resolvedValue": {
        "source": "wildcardSet",
        "wildcardSetId": 17,
        "categoryId": 631,
        "valueId": 30445,
        "value": "fire"
      }
    }
  ],
  "samplingSeed": 847291,
  "cartesianTotal": 64,
  "sampledTo": 10
}
```

The `wildcardSetId` + `categoryId` + `valueId` triple makes it trivial to trace the value back through the hierarchy without JOINs when reviewing a historical generation.

---

## Stage 5 — Alice saves a preset

`GenerationPreset.values` gains:

```jsonc
{
  "prompt": "A #character wearing armor, ...",
  "seed": -1,
  "quantity": 4,
  "activeWildcardSetIds": [491]
}
```

Load flow:
1. Read `activeWildcardSetIds: [491]`.
2. `UPDATE "UserWildcardSet" SET "isActive" = false WHERE "userId" = 1001`.
3. `UPDATE "UserWildcardSet" SET "isActive" = true WHERE "userId" = 1001 AND id IN (491)`.
4. If any IDs are missing, surface a warning with a "re-add fullFeatureFantasy v3.0" shortcut.

---

## Stage 6 — Bob subscribes

Bob clicks "Add set" → fullFeatureFantasy v3.0. The first-import transaction finds `WildcardSet` already exists (set.id = 17), skips the extract-and-audit path, and just writes a pointer:

| id | userId | wildcardSetId | nickname | isActive | sortOrder | addedAt |
|----|----|----|----|----|----|----|
| 492 | 2042 | 17 | "FFv3" | true | 3 | 2026-04-25 08:17:33 |

Bob immediately has access to all 1,841 clean values (1,847 total − 6 dirty). Zero content duplication; his pointer just joins through the global cache on resolve.

---

## Edge case examples

### Dirty value auto-excluded

No additional writes happen for affected prompts — the resolver's `WHERE wsv."auditStatus" = 'Clean'` predicate filters Dirty values out transparently. If Alice's `#character_f` expansion now only has 0 clean values (the 1 row is Dirty), the nested `__character_f__` reference returns empty at expansion time. Alice's prompts still work but skew toward `__character_m__`.

### Set invalidation

Moderator unpublishes fullFeatureFantasy v3.0 for policy reasons:

```sql
UPDATE "WildcardSet"
SET "isInvalidated" = true,
    "invalidationReason" = 'Model removed: MOD-12834',
    "invalidatedAt" = NOW()
WHERE id = 17;
```

Alice's pointer (id 491) stays. The resolver filters `ws."isInvalidated" = false`, so the set contributes nothing. Alice sees a warning badge on the set in her library.

### Audit rule version bump

Audit rules update from `2026-04-01-r3` → `2026-05-01-r1`. Background job scans:

```sql
SELECT wsv.id
FROM "WildcardSetValue" wsv
  JOIN "WildcardSetCategory" wsc ON wsc.id = wsv."categoryId"
WHERE wsc."wildcardSetId" = 17
  AND (wsv."auditRuleVersion" IS NULL OR wsv."auditRuleVersion" != '2026-05-01-r1');
```

Re-audits each row and updates status. Aggregates `WildcardSet.auditStatus` afterward.

### Category with zero clean values — implications

If a category's only row goes Dirty (e.g. `character_f`'s single row), the category effectively disappears from pools until re-audit. The picker could either:
- Hide the category (cleaner UX)
- Show it with a "0 values available" warning chip

Open question for the UX pass — not a schema-level concern. The DB handles it either way.

---

## Row counts at the end of the scenario

| Table | Row count |
|----|----|
| `WildcardSet` | 4 (3 pre-existing + 1 new) |
| `WildcardSetCategory` | ~103 (44 pre-existing + 59 new for fullFeatureFantasy) |
| `WildcardSetValue` | ~3,190 (1,343 pre-existing + 1,847 new) |
| `UserWildcardSet` | 5 (3 Bob + 1 Alice on import + 1 Bob on Stage 6) |
| `PromptSnippet` | 4 (Alice's personal, unchanged) |

At projected year-one scale (§7 of schema spec): ~5k sets, ~250k categories, ~7.5M values, ~300k–1M pointers, ~500k–5M personal snippets.

---

## Takeaways for DB review

1. **Write pressure at first-import is bursty:** one set, ~59 categories, ~1,850 values. `createMany` on values is fine; categories need per-row inserts (or `createManyAndReturn` on newer Prisma) to get FK IDs for values.
2. **Read pressure is steady and cache-friendly:** resolver runs on every prompt autocomplete. Expected ~30–100 rows typical. Hot indexes: `(userId, isActive)` on pointers, `(wildcardSetId, name)` on categories, `(categoryId, auditStatus)` on values.
3. **Audit writes are infrequent.** Set at import, updated only on rule-version bumps.
4. **Most variety lives inside individual value text, not across rows.** A typical `#category` may have 1–2 rows whose values are complex A1111 templates. The resolver handles expansion at gen time.
5. **Content sharing works:** Alice's first import serves Bob (and everyone else) for free. Storage scales with model-versions, not users.
