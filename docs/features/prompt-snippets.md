# Prompt Snippets

A unified library of reusable prompt content for the image generator. Users reference saved values in prompts via `#category` syntax. Selecting multiple values per reference fans the submission out into a batch of workflow steps, one per expanded prompt. Content comes from two sources, treated uniformly: user-curated personal collections and read-only sets imported from wildcard-type models on Civitai.

## Status

Planning. Not yet implemented.

---

## Key concepts

- **WildcardSet** — the unified content table. Every set has a `kind`:
  - **System-kind:** content imported from a wildcard-type model. Globally cached, shared across all users who subscribe.
  - **User-kind:** owned by one user. Their personal collection, e.g. the default "My snippets" set.
- **WildcardSetCategory** — categories within a set (e.g. `character`, `setting`). Each category holds a JSONB array of plain string values. Values can be plain text or use Dynamic Prompts syntax (`{a|b}`, `__nested__`, weights).
- **UserWildcardSet** — per-user activation pointer. Decides which sets contribute to the user's current picker. Used for both kinds: subscription pointer for System-kind, auto-created owner pointer for User-kind. `isActive` flag governs picker visibility.
- **Reference syntax:**
  - `#category` — batch mode. Selecting multiple values fans out into combinations.
  - `#?category` — random-pick mode. One value picked per workflow step.

For Prisma definitions, queries, indexes, and migration plan, see [prompt-snippets-schema.md](./prompt-snippets-schema.md). For a populated walkthrough using real wildcard-model content, see [prompt-snippets-schema-examples.md](./prompt-snippets-schema-examples.md).

---

## Resolved design decisions

- **Default selection = full pool.** When a user references `#category` without explicitly selecting values, the resolver uses every clean value across the user's active sets. Users opt into narrower selections deliberately.
- **Categories are immutable post-create.** Both kinds. Editing a category means creating a new one (with appended suffix, or a fresh name). System-kind reflects the source model's content; User-kind enforces the same rule for consistency and audit simplicity.
- **One audit verdict per category.** Audit runs across all values in a category and produces a single `Clean | Dirty` outcome. Dirty categories are excluded from generation pools entirely. No per-value audit.
- **NSFW classification is per-category.** Audit also produces an `nsfwLevel` (bitwise, following Civitai convention). The site router uses this to decide whether the category appears on `.com` (SFW) vs `.red` (NSFW) vs both.
- **Combination cap:** 10 per submission. Over-cap fan-out is randomly sampled with a seeded PRNG; user can reroll.
- **No-repeat rule.** When a category appears multiple times in one prompt, no single combination reuses the same value across slots.
- **Syntax:** `#category` (batch) and `#?category` (random-pick). Server resolves these against the user's active sets; unmatched `#tokens` pass through to the existing textual-inversion parser.
- **Determinism:** the existing generation-form `seed` drives all snippet randomness (cap sampling + `#?` picks). Same seed + same payload = byte-identical expanded prompts.
- **Submission audit:** snippet content is pre-audited at category creation. The user's literal template text (outside any `#reference`) is audited at submission. Composed prompt goes to external moderation as part of the normal submission flow.

---

## Data model

See [prompt-snippets-schema.md](./prompt-snippets-schema.md) for full Prisma definitions, indexes, and CHECK constraints. Quick summary:

- `WildcardSet` — `kind: System | User` discriminator. System-kind has `modelVersionId`, `modelName`, `versionName`. User-kind has `ownerUserId`, `name`. Audit aggregate, invalidation flags, denormalized `totalValueCount`.
- `WildcardSetCategory` — `name CITEXT`, `values JSONB string[]`, per-category `auditStatus`, `nsfwLevel` (bitwise int), `valueCount`.
- `UserWildcardSet` — `(userId, wildcardSetId, isActive)`. Activation pointer for both kinds.

There is no separate `PromptSnippet` table. User personal content is a User-kind `WildcardSet` whose categories live in the same table as System-kind imported content.

---

## Syntax and parsing

**Trigger characters:**

- `#` — batch mode. `#category` references the category for cartesian-product fan-out.
- `#?` — random-pick mode. `#?category` picks one value per workflow step.

**Grammar:** trigger + identifier matching `[A-Za-z][A-Za-z0-9_]*`. Categories are matched case-insensitively (citext storage preserves original casing for display).

**Collision with existing `#textualInversion` syntax** is resolved at the server. Snippet expansion runs first and replaces any `#token` matching one of the user's accessible category names. Unmatched `#tokens` pass through to the textual-inversion parser unchanged. Edge case: a user with both a wildcard category named `foo` and a textual-inversion resource named `foo` will see the wildcard win — rare conflict, surface a warning if it ever happens.

**Parser:** new helper in [src/utils/prompt-helpers.ts](../../src/utils/prompt-helpers.ts), co-located with the existing `parsePromptResources`.

```ts
const snippetReferencePattern = /(#\??)([a-zA-Z][a-zA-Z0-9_]*)/g;
// Returns ordered list of references: [{ kind: 'batch' | 'random', category, position }]
```

**Slot-counting:** `"#character fights #character"` contains two batch slots for `character`. The no-repeat rule ensures the two slots within a single combination hold different values.

**Nested resolution:** values within a category may contain `__name__` references to other categories. These resolve at generation time within the source set's scope (System-kind nested refs stay inside the same WildcardSet; User-kind nested refs stay inside the same User-kind set). Recursion is bounded with a hard depth limit and cycle detection.

---

## Client UI

### User-kind set management

A library section in the user account (or a modal accessible from the generator) for managing User-kind WildcardSets:

- List sets owned by the user; create/delete sets; rename via `name` field.
- Within a set, list categories; create new categories with `(name, values[])` at create time.
- No edit affordances on existing categories. Delete + recreate to change content.
- A default User-kind set called "My snippets" is auto-created on first save.

### Wildcard model browsing — System content discovery

A new "Wildcards" tab in the resources picker (alongside LoRAs, embeddings):

- Browse Civitai wildcard-type models.
- Click "Add to my library" → creates a System-kind `WildcardSet` (extracts and caches content if not already cached) + a `UserWildcardSet` activation pointer for the user.
- Subsequent users adding the same model version get only a pointer (content is shared globally — see schema doc §6.1).

### Prompt input integration

Wrap the existing [InputPrompt.tsx](../../src/components/Generate/Input/InputPrompt.tsx) with an autocomplete-aware shell:

1. Watches the textarea for `#` or `#?` trigger characters.
2. Opens a positioned popover (Mantine `Popover` + `ScrollArea`) showing matching categories from the user's active sets, with source labels (e.g., "from My snippets" vs "from fullFeatureFantasy v3.0").
3. Arrow keys navigate, Enter inserts. Inserted text is plain `#category` (no rich tokenization) — survives copy/paste, preset save/load, server round-tripping.
4. Existing `#references` in the textarea are highlighted via lightweight overlay.

### Per-reference picker panel

Below the prompt input, a `SnippetReferencePanel` component:

- Lists each unique `#category` / `#?category` reference found in the prompt.
- For each reference: shows the merged pool of values across active sets, grouped by source (e.g. "From My Snippets," "From fullFeatureFantasy v3.0"). **No values selected = full pool used by default.** Users opt into narrower selections explicitly via per-source filter pills + per-row checkboxes.
- Search box per reference (filter values across sources within one category — handles large libraries).
- Per-row `⋯` menu for affordances like "Save to my snippets" (copies a value from a System-kind set into the user's User-kind set as a new category).
- Footer: combinations counter ("24 combinations → running 10, sampled by seed 847291"), reroll button when sampling is active, validation errors when slot count exceeds picked values.

### Form submission gate

Submit is disabled when:

- Any `#reference` is unresolved (no clean matching category exists).
- Any category has fewer picked values than its slot count in the prompt.
- Any active set's category referenced is `Dirty` or its set is `isInvalidated`.

Submit is enabled (with an info alert) when:

- Total cartesian combinations > 10 — alert reads *"N combinations — randomly running 10. [Reroll]"*.

---

## Submission payload

Extend the `generateFromGraph` call ([generationRequestHooks.ts:216-237](../../src/components/ImageGeneration/utils/generationRequestHooks.ts#L216-L237)) to include snippet context:

```ts
type GenerateFromGraphInput = {
  input: GraphInput;          // existing (already contains the form `seed`)
  civitaiTip, creatorTip, tags, remixOfId, buzzType;  // existing
  snippets?: {                // new
    references: {
      category: string;
      kind: 'batch' | 'random';
      // empty selections array = "use full pool" (default behavior)
      selections: { wildcardSetId: number; categoryId: number; valueIndex: number }[];
    }[];
  };
};
```

- Client does **not** expand. Server is the sole source of truth for permutation enumeration, cap enforcement, and seed-based sampling — keeps the cap un-spoofable.
- If `snippets` is omitted or empty, behavior is identical to today (literal prompt, no expansion).
- **Determinism:** the generation-form `seed` drives all snippet randomness. If the user requested `seed = -1`, the server resolves a random seed early and uses it for both image generation and snippet resolution. The resolved seed is the single record of reproducibility.
- **Reroll UX:** the picker panel's "reroll" button swaps the form's seed and re-requests a combination preview.

---

## Server resolution and step fan-out

Snippet expansion slots into [orchestration-new.service.ts](../../src/server/services/orchestrator/orchestration-new.service.ts) at `createStepInputs`, before per-step build:

```ts
async function expandSnippetsToPrompts(
  template: string,
  references: SnippetReference[],
  userId: number,
  seed: number,
): Promise<{ prompt: string; assignment: ResolvedAssignment }[]> {
  // 1. For each reference, fetch the merged pool (all active sets × matching category) — clean only,
  //    nsfwLevel-filtered for the request's site context.
  // 2. If reference.selections is empty, use the full pool. Otherwise restrict to selections.
  // 3. For batch refs (#): enumerate k-permutations per category, then cartesian-product across categories.
  //    If total > 10: Fisher-Yates shuffle keyed by seed, take first 10.
  // 4. For random-pick refs (#?): pick one value per workflow step using PRNG keyed by
  //    (seed, stepIndex, refPosition).
  // 5. Substitute values into template; recursively resolve any nested __name__ refs within source set scope.
  // 6. Return one expanded prompt + assignment per combination.
}
```

**Determinism contract:** sampling and random-pick are pure functions of `(seed, references, selections, template)`. Implementation uses a seeded PRNG (e.g. `mulberry32`); no wall-clock or process-level randomness.

**Workflow shape:** single `submitWorkflow()` call with all N steps. Same submission boundary, same buzz-accounting path.

**Step metadata:** each step records its resolved values (with `wildcardSetId`, `categoryId`, `valueIndex`, and the literal value text) for reproducibility and result-card display. Schema doc §4.4 has the JSON shape.

---

## Auditing

### Category-level, at create

Audit runs per-category when a `WildcardSetCategory` is created:

1. Read all values in the JSONB array.
2. Run audit rules across the values.
3. Produce one verdict (`Clean` or `Dirty`) plus an `nsfwLevel` classification.
4. Update the category row.
5. Roll up to the parent `WildcardSet.auditStatus` aggregate (`Clean` / `Mixed` / `Dirty`).

If a category is `Dirty`, it's excluded from generation pools entirely. There's no per-value exclusion — the category is the audit unit.

### Submission-time

1. Verify all referenced categories are `Clean` and not invalidated.
2. Audit the user's **literal template text** (`#references` stripped/replaced) via `auditPromptEnriched`. Catches problematic text outside any reference.
3. The composed prompt (after expansion) goes to external moderation as part of normal submission flow. No second local audit.

### Rule version drift

Background cron job re-audits affected categories when audit rule version bumps. Cheap (regex-based audit). During the window, affected categories are blocked from submission via the `Pending`/`Dirty` filter in the resolver query.

---

## Preset interaction

Presets snapshot the user's active sets at save time. `GenerationPreset.values` gains:

- `activeWildcardSetIds: number[]` — list of `UserWildcardSet.id`s that were active when the preset was saved.
- `prompt` continues to save with `#references` as literal text.

On load:

- The user's `UserWildcardSet.isActive` is updated to match the preset's snapshot (deactivate everything, then activate the listed IDs).
- If any IDs in the snapshot no longer exist, the preset load surfaces a warning and offers a "re-add these sets" shortcut for missing System-kind sets.
- For each `#reference` in the loaded prompt, the picker panel populates per-reference selection state. Defaults to "all selected" (full pool); user adjusts.

Future cross-user preset sharing: cross-user `#references` will be unresolved on the receiver's side. Acceptable — receiver fills with their own content.

---

## Implementation phases

Each phase is independently shippable. Backend phases ship before any client UI work.

### Phase 1 — schema + tRPC scaffolding (backend only)

- Prisma migration: `WildcardSet`, `WildcardSetCategory`, `UserWildcardSet` + 3 enums + CHECK constraint
- `wildcardSet` tRPC router (read endpoints + import for System-kind)
- Audit pipeline for categories (background job runner, creation-time hook)

No user-visible features. Validates the data model end-to-end via API testing.

### Phase 2 — System-kind import flow

- Wildcard-type model browsing (resources picker tab)
- "Add to library" creates `WildcardSet` (with first-import extraction + audit) + a `UserWildcardSet` pointer
- User can browse their imported sets in a library page
- Resolver query (read-only, returns merged-pool data for a `#category` lookup)

Users can subscribe to wildcard models but don't yet see them in the prompt UI.

### Phase 3 — User-kind set + snippet save

- `WildcardSet` `kind = User` creation flow (lazy on first save, "My snippets" default)
- "Save to my snippets" action from picker rows (creates new categories)
- User can create / delete sets, create / delete categories (no edits)

Users can manage personal content; no prompt integration yet.

### Phase 4 — prompt parsing + autocomplete

- `parsePromptSnippetReferences` in `prompt-helpers.ts`
- Autocomplete popover wrapping `InputPrompt` with source-grouped results
- Highlight `#references` in textarea

No submission changes yet — references behave as literal text server-side.

### Phase 5 — per-reference picker + batch math

- `SnippetReferencePanel` component
- Combinations counter, cap alert, reroll, validation
- Defaults = full pool

Pickers show in UI; selections aren't sent yet.

### Phase 6 — server expansion + step fan-out

- Augment `generateFromGraph` payload
- `snippetExpansion.ts` module in `server/services/orchestrator/`
- Hook into `createStepInputs`
- Step metadata records resolved values

First end-to-end working slice.

### Phase 7 — random-pick mode (`#?category`)

- Extend parser to recognize `#?` as a distinct kind
- Per-step seeded PRNG resolution in `expandSnippetsToPrompts`
- Picker panel adds "random pool" affordances (bulk select)

### Phase 8 — nested wildcard resolution

- Recursive `__name__` expansion within source-set scope (max depth + cycle detection)
- Transitive `Dirty` propagation: if a category references another `Dirty` category, mark this one `Dirty` too

---

## Random-pick mode

Two reference kinds share the same selection pool but differ in expansion semantics:

- **`#category` — batch mode.** Each reference slot uses one selected value; selections cartesian-product across categories into multiple workflow steps. *Fans out a batch.*
- **`#?category` — random-pick mode.** One value is randomly picked from the pool per workflow step and inserted into every `#?category` occurrence in that step. *Does not fan out.*

**Combined usage:** A prompt may mix both modes. Example: `"#character walking through #?setting"` with 3 characters and 5 settings → 3 workflow steps (one per character), each step's `#?setting` independently picks one of the 5 settings via seeded PRNG. Total images = 3 steps × `quantity` per step.

**Per-step, not per-image.** All images in a single workflow step share the same `#?` resolution. For per-image variance, set `quantity = 1` and rely on batch fan-out.

**Validation:** `#?category` requires at least one available value (after default = full pool rule applies). Same-category occurrences within a prompt share one pick per step.

**Shared selection pool with batch.** A prompt like `"#character fights #?character"` uses one selection set for `character` — batch slots iterate, random-pick slots draw from the same set. Separate per-reference pools is a v2 enhancement.

---

## Out of scope for v1

- Cross-user sharing of User-kind sets (a `Shared` or `Public` `kind` value would be additive when we want it)
- Editing existing categories' values (categories are immutable post-create)
- Per-snippet labels for User-kind sets (values are plain strings; users find content by reading + searching)
- Per-reference "shared pick" toggle (all `#character` occurrences get the same value within a combination)
- Per-reference separate selection pools (batch and random-pick drawing from different sets within the same category)
- Per-image random-pick resolution (currently per-step)
- Weight syntax for snippets (e.g., `#character:1.2`)
- Search indexes over wildcard content (Postgres GIN on JSONB `values` is an option later)

These are deliberately deferred. The schema accommodates them as additive changes later.
