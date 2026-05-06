# Prompt Snippets

A unified library of reusable prompt content for the image generator. Users reference saved values in prompts via `#category` syntax. Selecting multiple values per reference fans the submission out into a batch of workflow steps, one per expanded prompt. Content comes from two sources, treated uniformly: user-curated personal collections and read-only sets imported from wildcard-type models on Civitai.

## Status

Planning. Not yet implemented. **For the trimmed v1 scope** (what actually ships first vs what's deferred), see [prompt-snippets-v1.md](./prompt-snippets-v1.md). This doc is the full long-term design — items not in v1 are flagged inline as "post-v1."

---

## Key concepts

- **WildcardSet** — the unified content table. Every set has a `kind`:
  - **System-kind:** content imported from a wildcard-type model. Globally cached, shared across all users who load it.
  - **User-kind:** owned by one user. Their personal collection, e.g. the default "My snippets" set. Always implicitly loaded by the user's own form on mount.
- **WildcardSetCategory** — categories within a set (e.g. `character`, `setting`). Each category holds a Postgres `text[]` of plain string values. Values can be plain text, use Dynamic Prompts alternation/weight syntax (`{a|b}`, `{1-2$$a|b}`, `N.0::name`), or — post-v1 — contain nested `#name` references to other categories within the same set. For User-kind sets the array is mutable (add, edit, reorder, remove); for System-kind sets it's immutable from the source zip.
- **No DB join table for "loaded sets."** The user's User-kind set is always implicitly loaded; additional System-kind sets are loaded by clicking a "create" button on a wildcard model page. The list of loaded set IDs lives in the form's localStorage, and is snapshotted as `wildcardSetIds` into workflow metadata at submit time. Server-side authorization is implicit by `kind`: System-kind sets are public; User-kind set IDs must match `ownerUserId == submitter`.
- **Reference syntax:** `#category` is the only reference syntax. Whether the submission expands as a batch (cartesian fan-out) or random sampling (independent picks per step) is a form-level mode toggle, not a per-reference syntax.

For Prisma definitions, queries, indexes, and migration plan, see [prompt-snippets-schema.md](./prompt-snippets-schema.md). For a populated walkthrough using real wildcard-model content, see [prompt-snippets-schema-examples.md](./prompt-snippets-schema-examples.md).

---

## Resolved design decisions

- **Default selection = full pool.** When a user references `#category` without explicitly selecting values, the resolver uses every clean value across the user's active sets. Users opt into narrower selections deliberately.
- **System-kind categories are immutable; User-kind categories are mutable.** The source zip behind a System-kind set never changes (model versions are themselves immutable on Civitai), so its categories are read-only after import. User-kind categories support full CRUD on their values — add, edit, reorder, remove — with each mutation triggering a per-category re-audit.
- **One audit verdict per category.** Audit runs across all values in a category and produces a single `Clean | Dirty` outcome. Dirty categories are excluded from generation pools entirely. No per-value audit.
- **NSFW classification is per-category.** Audit also produces an `nsfwLevel` (bitwise, following Civitai convention). The site router uses this to decide whether the category appears on `.com` (SFW) vs `.red` (NSFW) vs both.
- **Combination cap:** 10 per submission. Over-cap fan-out is randomly sampled with a seeded PRNG; user can reroll.
- **No-repeat rule.** When a category appears multiple times in one prompt, no single combination reuses the same value across slots.
- **Syntax:** `#category` is the single reference syntax. Server resolves these against the user's active sets; unmatched `#tokens` pass through to the existing textual-inversion parser.
- **Mode is per-submission, not per-reference.** The form has a `snippetMode` toggle (`batch` | `random`) that governs how the submission expands. Batch mode runs unique cartesian-product combinations across selections; random mode runs independent random samples per step. **Default: `random`** (single random draw per step is the most common case).
- **`batchCount` is user-configurable.** Number of workflow steps to fan out into. In batch mode it caps the cartesian product (sample with seeded PRNG when over-available); in random mode it's the number of independent draws. **Default: `1`** (single step, no fan-out).
- **Determinism:** the existing generation-form `seed` drives all snippet randomness (cap sampling and random-mode picks). Same seed + same payload = byte-identical expanded prompts.
- **Submission audit:** snippet content is pre-audited at category creation. The user's literal template text (outside any `#reference`) is audited at submission. Composed prompt goes to external moderation as part of the normal submission flow.

---

## Data model

See [prompt-snippets-schema.md](./prompt-snippets-schema.md) for full Prisma definitions, indexes, and CHECK constraints. Quick summary:

- `WildcardSet` — `kind: System | User` discriminator. System-kind has `modelVersionId`, `modelName`, `versionName`. User-kind has `ownerUserId`, `name`. Audit aggregate, invalidation flags, denormalized `totalValueCount`.
- `WildcardSetCategory` — `name CITEXT`, `values text[]`, per-category `auditStatus`, `nsfwLevel` (bitwise int), `valueCount`.

Two new tables — no DB join table for "loaded sets." There is no separate `PromptSnippet` table either. User personal content is a User-kind `WildcardSet` whose categories live in the same table as System-kind imported content.

---

## Syntax and parsing

**Trigger character:** `#category`. The behavior of the submission (cartesian fan-out vs random sampling) is governed by the `snippetMode` form toggle, not by the prompt syntax.

**Grammar:** `#` + identifier matching `[A-Za-z][A-Za-z0-9_]*`. Categories are matched case-insensitively (citext storage preserves original casing for display).

**Collision with existing `#textualInversion` syntax** is resolved at the server. Snippet expansion runs first and replaces any `#token` matching one of the user's accessible category names. Unmatched `#tokens` pass through to the textual-inversion parser unchanged. Edge case: a user with both a wildcard category named `foo` and a textual-inversion resource named `foo` will see the wildcard win — rare conflict, surface a warning if it ever happens.

**Parser:** new helper in [src/utils/prompt-helpers.ts](../../src/utils/prompt-helpers.ts), co-located with the existing `parsePromptResources`.

```ts
const snippetReferencePattern = /#([a-zA-Z][a-zA-Z0-9_]*)/g;
// Returns ordered list of references: [{ category, position }]
```

**Slot-counting:** `"#character fights #character"` contains two batch slots for `character`. The no-repeat rule ensures the two slots within a single combination hold different values.

**Nested resolution (post-v1):** values within a category may contain `#name` (or, for source-file compatibility, `__name__`) references to other categories. v1 does *not* expand these — top-level `#category` resolution happens, but tokens inside a category value are passed through literally. The future iteration that lands nested resolution will accept both `#name` and `__name__` interchangeably. See [prompt-snippets-nested-resolution.md](./prompt-snippets-nested-resolution.md) for the full algorithm (when it ships).

---

## Client UI

### User-kind set management

A library section in the user account (or a modal accessible from the generator) for managing User-kind WildcardSets:

- List sets owned by the user; create/delete sets; rename via `name` field.
- Within a set, list categories; create new categories with `(name, values[])` at create time.
- No edit affordances on existing categories. Delete + recreate to change content.
- A default User-kind set called "My snippets" is auto-created on first save.

### Wildcard model browsing — System content discovery

The wildcard model page (existing model detail surface, filtered to `modelType: Wildcard`) gets a **"create"** button on the version row:

- Click "create" → ensures a System-kind `WildcardSet` exists for that `ModelVersion` (extracts and caches content on first import; no-op if already cached) and returns the `WildcardSet.id`. The form's localStorage adds the ID to its `wildcardSetIds` list so the set is immediately loaded into the generator.
- Subsequent users clicking "create" on the same model version get the existing set ID — no DB rows written, content is shared globally (see schema doc §6.1).
- v1 deliberately avoids a separate "library" picker tab in the resources strip — discovery happens by browsing wildcard model pages, the same surface as any other model type.

### Prompt input integration

Wrap the existing [InputPrompt.tsx](../../src/components/Generate/Input/InputPrompt.tsx) with an autocomplete-aware shell:

1. Watches the textarea for the `#` trigger character.
2. Opens a positioned popover (Mantine `Popover` + `ScrollArea`) showing matching categories from the user's active sets, with source labels (e.g., "from My snippets" vs "from fullFeatureFantasy v3.0").
3. Arrow keys navigate, Enter inserts. Inserted text is plain `#category` (no rich tokenization) — survives copy/paste, preset save/load, server round-tripping.
4. Existing `#references` in the textarea are highlighted via lightweight overlay.

### Per-reference picker panel

Below the prompt input, a `SnippetReferencePanel` component.

**v1 behavior (ships first).** The picker shows the count of available values per reference and provides the mode toggle (Batch | Random) + `batchCount` input + Preview button. **Every `#reference` defaults to the full clean pool from `wildcardSetIds`** — there is no per-value picker UI in v1. If the user wants a narrower pool they can either narrow which sets they have loaded (toggle off a System-kind set on its model page) or, for explicit excludes, use the `ex` field via the Preview/inspect surface (TBD design).

**Post-v1 (the V8 desktop / R2 mobile design).** Lists each unique `#category` reference found in the prompt with full picker affordances:

- For each reference: shows the merged pool of values across loaded sets, grouped by source (e.g. "From My Snippets," "From fullFeatureFantasy v3.0"). **No values selected = full pool used by default.** Users opt into narrower selections explicitly via per-source filter pills + per-row checkboxes.
- Selections are recorded as `in` (explicit includes) and `ex` (explicit excludes) per source category. When both are empty for every selection on a reference, the reference defaults to the full clean pool.
- Search box per reference (filter values across sources within one category — handles large libraries).
- Per-row `⋯` menu for affordances like "Save to my snippets" (copies a value from a System-kind set into the user's User-kind set as a new category).
- Footer: combinations counter ("24 combinations → running 10, sampled by seed 847291"), reroll button when sampling is active, validation errors when slot count exceeds picked values.

**Preview button (v1).** Both v1 and post-v1 surface a Preview action that returns a single resolved-prompt sample. Clicking Preview generates an ephemeral `seed` value sent on the `snippets` payload (`snippets.seed`); the seed is **only** used for the preview rendering and is **not persisted** to workflow metadata. The form's existing top-level `seed` is the source of truth for actual generation.

### Form submission gate

Submit is disabled when:

- Any `#reference` is unresolved (no clean matching category exists).
- Any category has fewer picked values than its slot count in the prompt.
- Any active set's category referenced is `Dirty` or its set is `isInvalidated`.

Submit is enabled (with an info alert) when:

- Total cartesian combinations > 10 — alert reads *"N combinations — randomly running 10. [Reroll]"*.

### Mobile

Same components, same data, same Tiptap-based prompt editor — adapted for touch and a small screen by:

- **Progressive chip disclosure.** In the prompt input, references default to the minimal form (`#character`). After the user taps a chip for the first time, it expands to the verbose form (`#character · 6 selected`). This keeps the prompt clean by default and only adds visual weight to references the user has explicitly curated.
- **Slim bottom drawer for the picker.** Tapping a chip slides up a focused picker drawer covering the bottom ~65% of the screen. There is no scrim — the prompt remains fully visible above the drawer so the user keeps full context while editing selections. The drawer holds the same source-grouped list, source-filter pills, search input, and per-row "Save to My Snippets" overflow action as the desktop popover.
- **Stripped chrome.** No screen header, sources strip, or always-on reference panel — the chips in the prompt are the only entry point to the picker.

Mockup: [docs/working/mockups/prompt-snippets-mobile/r2-slim-bottom-drawer.html](../working/mockups/prompt-snippets-mobile/r2-slim-bottom-drawer.html). Two phone frames showing the before-tap (minimal chips, no drawer) and after-tap (verbose chip + drawer open) states.

---

## Submission payload

Extend the `generateFromGraph` call ([generationRequestHooks.ts:216-237](../../src/components/ImageGeneration/utils/generationRequestHooks.ts#L216-L237)) so the **graph itself carries a new `snippets` node** alongside the existing prompt, negativePrompt, and other nodes. The submission's outer shape is unchanged — the snippets data lives inside `input` (the serialized generation-graph / ecosystem-graph), not as a sibling field.

```ts
type SnippetReference = {
  category: string;
  // empty selections array = "use full pool" (default behavior, scoped to wildcardSetIds).
  // value text is the stable identifier — survives reorder, breaks only on edit/delete.
  selections: {
    categoryId: number;
    in: string[];   // explicit includes (empty when only excludes are used)
    ex: string[];   // explicit excludes (empty when only includes are used)
  }[];
};

// New node inside the generation-graph. Lives next to the existing prompt/negativePrompt/
// resources/sampler/etc. nodes. Form serializes it into `input` along with all other graph nodes.
type SnippetsNode = {
  wildcardSetIds: number[];        // WildcardSet IDs loaded at submit time
                                   // (always includes the user's User-kind set + any System-kind sets they've loaded)
  mode?: 'batch' | 'random';       // optional; defaults to 'random'
  batchCount?: number;             // optional; defaults to 1
  seed?: number;                   // PREVIEW ONLY — sent when the user hits Preview, not persisted
                                   // to workflow metadata. The form's top-level `seed` is the
                                   // source of truth for actual generation.
  targets: Record<string, SnippetReference[]>;
  // Conventional target keys for v1: 'prompt', 'negativePrompt'. Each value is a
  // SnippetReference[] (no wrapper object). Empty target = [].
  // Future editor nodes (e.g. 'musicDescription') just add their own key.
};

type GenerateFromGraphInput = {
  input: GraphInput;          // existing — now includes a SnippetsNode alongside other nodes
  civitaiTip, creatorTip, tags, remixOfId, buzzType;  // existing, unchanged
};

// Each editor node (prompt, negativePrompt, …) has a dependency on the SnippetsNode and reads
// its target slice (snippets.targets[editorNodeName]) to render chips. Mode and batchCount are
// submission-level; per-reference kind doesn't exist.
//
// On submission, the server adds the `wildcards` tag to workflow.tags so the workflow is
// queryable as a snippet-using submission ("did this generation use snippets?") without
// parsing the metadata blob.
```

- Client does **not** expand. Server is the sole source of truth for permutation enumeration, cap enforcement, and seed-based sampling — keeps the cap un-spoofable.
- If `snippets` is omitted or empty, behavior is identical to today (literal prompt, no expansion).
- **Determinism:** the generation-form `seed` drives all snippet randomness. If the user requested `seed = -1`, the server resolves a random seed early and uses it for both image generation and snippet resolution. The resolved seed is the single record of reproducibility.
- **Reroll UX:** the picker panel's "reroll" button swaps the form's seed and re-requests a combination preview.

---

## Server resolution and step fan-out

Snippet expansion slots into [orchestration-new.service.ts](../../src/server/services/orchestrator/orchestration-new.service.ts) at `createStepInputs`, before per-step build:

```ts
async function expandSnippetsToTargets(input: {
  templates: Record<string, string>;          // keyed by target ID (e.g. { prompt, negativePrompt })
  wildcardSetIds: number[];
  targets: Record<string, SnippetReference[]>; // same keys as templates
  mode: 'batch' | 'random';
  batchCount: number;
  seed: number;
}): Promise<Array<Record<string, string>>> {  // each combination = a record { targetId → substituted text }
  // 1. For each reference across all targets, fetch the merged pool from
  //    wildcardSetIds × matching category — clean only, nsfwLevel-filtered for the site context.
  // 2. If reference.selections is empty, use the full pool. Otherwise restrict to selections.
  // 3. Resolve mode (single mode applies across all targets):
  //    - "batch": enumerate k-permutations per category across ALL target references,
  //      then cartesian-product. If total > batchCount, Fisher-Yates shuffle keyed by seed,
  //      take first batchCount.
  //    - "random": for each of batchCount steps, pick one value per reference (across all targets)
  //      using PRNG keyed by (seed, stepIndex, targetId, refPosition).
  // 4. For each resulting combination, substitute values into each target's template;
  //    recursively resolve any nested #name refs within source set scope.
  // 5. Return one record per combination — keys are target IDs, values are the substituted text.
}
```

The cartesian space is unified across **all targets**. A single combination produces substituted text for every target simultaneously (e.g., one `prompt` AND one `negativePrompt`). References on any target contribute to the total combination count multiplicatively. Adding a new target (e.g. `musicDescription`) automatically participates in the cartesian without resolver code changes.

**Determinism contract:** all randomness (over-cap sampling, random-mode picks, nested-ref alternation) is a pure function of `(seed, wildcardSetIds, references, selections, template)`. Implementation uses a seeded PRNG (e.g. `mulberry32`); no wall-clock or process-level randomness.

**Workflow shape:** single `submitWorkflow()` call with all N steps. Same submission boundary, same buzz-accounting path.

**Where the data lives:**

- **Workflow metadata** gets a single `snippets` object (per submission) containing `wildcardSetIds`, `mode`, `batchCount`, and a keyed `targets` map (with conventional keys `prompt` and `negativePrompt` in v1). Used to reload picker state on re-edit and to show "this batch ran with character: Zelda, Link" in run summaries. See schema doc §4.4 for the full shape.
- **Workflow.tags** gains a `wildcards` entry whenever snippets were used in the submission. Cheap analytics signal + queryable filter ("did this generation use snippets?") without parsing the metadata blob.
- **Step metadata stays vanilla.** Each step's `params.prompt` and `params.negativePrompt` already contain the fully substituted text. The orchestrator processes snippet-driven steps identically to ordinary steps — no new step-level fields, no awareness of where the prompt came from.

Reproduction of any specific step's expansion is recoverable on demand from `(seed, target templates, snippets)` — re-running the resolver gives byte-identical results. We don't duplicate the per-step expansion tree on every step.

### Generation-graph node behavior (client)

The `snippets` object lives as a dedicated node in the generation graph that `GenerationForm` builds. Three behaviors worth calling out:

1. **Editor nodes have a dependency on the snippets node.** Each editor node (prompt, negativePrompt, and any future targets) reads `snippets.targets[<ownNodeName>]` to render its Tiptap chips with their current selection state. When the snippets node updates (a chip is tapped, mode flips, a set is added), the dependent editor nodes re-render.

2. **Auto-prune on access loss.** When the form mounts (or after a preset/remix load), the form fetches `getWildcardSets({ ids: snippets.wildcardSetIds })`. The server returns only the IDs the user is authorized for (System-kind = public, User-kind = `ownerUserId == requester`) and that haven't been invalidated. Any IDs missing from the response are silently pruned from the snippets node's `wildcardSetIds`, plus any selections referencing categories from those sets (across every target). The user starts with a clean, valid state; no errors at submit time from stale references.

3. **Red-badge state for orphaned references.** A `#category` chip in any editor is "orphaned" when it references a category that no longer resolves against any active set (the user removed the source set, the set was invalidated, or the category itself is Dirty). The Tiptap chip renders with a red badge in this case to flag "no corresponding snippet to use." The user can either re-add the source set (if they removed it) or delete the reference from the editor. Submit is blocked while any orphaned chips exist in any target.

---

## Auditing

### Category-level, at create

Audit runs per-category when a `WildcardSetCategory` is created:

1. Read all values in the `text[]` array.
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

Presets snapshot the user's loaded sets at save time. `GenerationPreset.values` gains:

- `wildcardSetIds: number[]` — list of `WildcardSet.id`s that were loaded when the preset was saved (always includes the user's User-kind set + any System-kind sets they had loaded).
- `prompt` continues to save with `#references` as literal text.

On load:

- The form's `wildcardSetIds` (in localStorage) is hydrated from the preset's snapshot. No DB rows are touched.
- The form fetches `getWildcardSets({ ids })` to validate authorization and resolve display info; any IDs the user is no longer authorized for (e.g., a User-kind set was deleted, or a System-kind set was invalidated) are silently dropped and surfaced as a warning chip.
- For each `#reference` in the loaded prompt, the picker panel populates per-reference selection state. Defaults to "all selected" (full pool); user adjusts.

Future cross-user preset sharing: cross-user `#references` will be unresolved on the receiver's side. Acceptable — receiver fills with their own content.

---

## Implementation phases

Each phase is independently shippable. Backend phases ship before any client UI work.

### Phase 1 — schema + tRPC scaffolding (backend only)

- Prisma migration: `WildcardSet`, `WildcardSetCategory` + 3 enums + CHECK constraint
- `wildcardSet` tRPC router (read endpoints + import for System-kind)
- Audit pipeline for categories (background job runner, creation-time hook)

No user-visible features. Validates the data model end-to-end via API testing.

### Phase 2 — System-kind import flow

- "Create" button on wildcard model version pages (existing model detail surface, filtered to `modelType: Wildcard`)
- Click "create" runs first-import extraction + audit if needed and returns the `WildcardSet.id`; the form's localStorage adds the ID to its `wildcardSetIds` immediately
- `getWildcardSets({ ids })` tRPC query for hydrating form state on mount/preset-load/remix (server returns only sets the user is authorized for: System-kind = public, User-kind = `ownerUserId == requester`)

Users can load wildcard models into the generator but don't yet see them in the prompt UI.

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

### Phase 6 — server expansion + step fan-out (both modes)

- Augment `generateFromGraph` payload (snippet selections, mode, batchCount, wildcardSetIds)
- `snippetExpansion.ts` module in `server/services/orchestrator/` — handles both batch and random modes uniformly
- Hook into `createStepInputs`
- Workflow metadata records the snippet inputs; step metadata stays vanilla (substituted prompt only)

First end-to-end working slice.

### Phase 7 — nested wildcard resolution (post-v1)

- Recursive `#name` expansion within source-set scope (max depth + cycle detection); the resolver also accepts the source-file form `__name__` interchangeably with `#name`
- Transitive `Dirty` propagation: if a category references another `Dirty` category, mark this one `Dirty` too

### Phase 8 — system default wildcard set

- Identify or create a Civitai-curated default `WildcardSet` (System-kind) for first-time users
- Mechanism: `isSystemDefault Boolean` flag on `WildcardSet` (or hardcoded ID — TBD)
- Form mount: when localStorage has no `wildcardSetIds`, initialize with the system default ID so the picker isn't empty for new users
- Schema impact is minor (one boolean column or none); product impact is curating the default content

---

## Submission modes

Mode is a per-submission toggle (`snippetMode`) on the form, not a per-reference syntax. The same selections produce different output behavior depending on mode:

- **`batch` mode.** Enumerate the cartesian product of selected values across references (with no-repeat for repeated category slots), then run `batchCount` of them. If the cartesian total exceeds `batchCount`, sample using the seeded PRNG; if fewer combinations are available, run all of them.
- **`random` mode.** Run `batchCount` independent steps. Each step picks one value per reference using a PRNG keyed by `(seed, stepIndex, refPosition)`. No cartesian enumeration; each step is an independent draw.

**Total images output:** `batchCount × quantity` (where `quantity` is the existing per-step images-per-workflow setting).

**Per-step, not per-image.** All images within a single workflow step share the same prompt. For per-image variance in random mode, set `quantity = 1` and increase `batchCount`.

**Same-category repeated slots in a single prompt** still follow the no-repeat rule in batch mode (a single combination uses different values for each slot of the same category). In random mode, all slots of the same category in one step share the same random pick (consistent with how a single random draw populates the prompt).

**Selection pool semantics are uniform across modes.** Empty `selections` for a reference means default-to-full-pool, computed from `wildcardSetIds`. Explicit `selections` restrict the pool. The mode just determines how the resolver enumerates and samples from the resulting pools.

---

## Out of scope for v1

- Cross-user sharing of User-kind sets (a `Shared` or `Public` `kind` value would be additive when we want it)
- A dedicated favorites feature/table — users implement "favorites" by saving values into a User-kind set named however they want ("Favorites", "My picks", etc.); no separate system needed
- Per-snippet labels for User-kind sets (values are plain strings; users find content by reading + searching)
- Per-reference mode override (whole submission is one mode; mixing batch and random within a single prompt is not in v1)
- Per-image random-mode resolution (currently per-step — set `quantity = 1` and increase `batchCount` for per-image variance)
- Weight syntax for snippets (e.g., `#character:1.2`)
- Search indexes over wildcard content (Postgres GIN on the `text[]` `values` column is an option later)

These are deliberately deferred. The schema accommodates them as additive changes later.
