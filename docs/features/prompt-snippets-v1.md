# Prompt Snippets — v1 Plan

**Status:** v1 scope, ready for build planning.
**Companion docs (deeper detail / future scope):**

- [prompt-snippets.md](./prompt-snippets.md) — full product/UX vision (includes post-v1 picker UX)
- [prompt-snippets-schema.md](./prompt-snippets-schema.md) — schema spec (authoritative for table definitions)
- [prompt-snippets-schema-examples.md](./prompt-snippets-schema-examples.md) — populated table walkthrough
- [prompt-snippets-provisioning-job.md](./prompt-snippets-provisioning-job.md) — server job that creates `WildcardSet` rows from published wildcard models
- [prompt-snippets-nested-resolution.md](./prompt-snippets-nested-resolution.md) — **post-v1**, kept for when nested resolution lands

This doc is the slim, opinionated v1 scope. Anything not listed in §3 is **deferred** (see §4 for the deferred list).

---

## 1. The feature in one paragraph

Users reference reusable prompt content in their generator prompts via `#category` syntax (e.g. `"A #character walking through #setting"`). At submission time the server expands those references using values from wildcard sets the user has loaded. v1 ships the slim shape: no per-value selection UI, no nested resolution, no cross-device library — just chip insertion, "include the whole category," and either single-step random-mode submissions (default) or batched cartesian fan-out.

---

## 2. Key concepts

- **WildcardSet** — global content table. Two kinds:
  - `kind = System`: imported from a Civitai wildcard-type model. Globally cached, shared across all users. Pre-provisioned on publish via the provisioning job (see [prompt-snippets-provisioning-job.md](./prompt-snippets-provisioning-job.md)). Immutable.
  - `kind = User`: owned by one user. Created lazily on first "save to my snippets." Mutable (CRUD on values, with re-audit on every change).
- **WildcardSetCategory** — categories within a set (e.g. `character`, `setting`). Each holds a `text[]` of value strings. Per-category audit + `nsfwLevel`.
- **No `UserWildcardSet` join table.** The user's own User-kind set is queryable by `ownerUserId`. Additional wildcard sets the user has loaded live in the form's localStorage (graph node state). Loaded-set IDs are validated server-side at submit time (System-kind = public; User-kind = `ownerUserId == submitter`).
- **`snippets` node in the generation-graph.** Inside `input` (the serialized graph), alongside the existing prompt, negativePrompt, resources, sampler, etc. nodes. Carries the user's wildcard-set IDs, mode, batchCount, and per-target reference state.
- **Single reference syntax.** `#category` everywhere. Imported wildcard files have source-file `__name__` rewritten to `#name` at import time.

---

## 3. v1 scope (what's IN)

### Schema

Three new tables, three enums, one CHECK constraint, citext extension. See [prompt-snippets-schema.md](./prompt-snippets-schema.md) for full Prisma definitions and indexes.

| Table | Purpose |
|---|---|
| `WildcardSet` | Global content. `kind: System \| User` discriminator. System-kind has `modelVersionId` FK; User-kind has `ownerUserId` FK + user-given `name`. Audit aggregate, `isInvalidated` flag. |
| `WildcardSetCategory` | Categories within a set. `name CITEXT`, `values text[]`, per-category `auditStatus` and `nsfwLevel`. System-kind is immutable; User-kind is mutable with re-audit on each change. |
| `PromptSnippet` | (Existing in feature plan, but *not in v1* — see §4.) Skipped: User-kind WildcardSet covers the same purpose. |

**Not in v1:** `UserWildcardSet` (deferred, see §4).

### Form behavior

- **Tiptap-based prompt + negativePrompt editors.** Same component on desktop and mobile. Chip rendering for `#category` references is consistent across surfaces.
- **Autocomplete on `#`.** Typing `#` opens a popover listing categories from the user's loaded wildcard sets. Selecting one inserts a `#category` chip into the editor. *The popover is for category discovery only — there's no per-value selection in v1.*
- **The chip is always minimal in v1** — `#character`, no verbose form, no popup, no drawer. Just the reference token.
- **Snippets node in the generation graph.** Carries `wildcardSetIds`, `mode`, `batchCount`, `targets`, optional `seed`. Each editor node has a dependency on the snippets node and reads its slice (`snippets.targets[<editorNodeName>]`) to render chips.
- **On form mount:**
  1. Fetch the user's own User-kind set ID via `getMyUserWildcardSet()` (lazy-creates on first call). Auto-prepend to `wildcardSetIds`.
  2. Read additional `wildcardSetIds` from localStorage (set IDs added via "create" clicks on wildcard model pages).
  3. Fetch full set details via `getWildcardSets({ ids })`. Server filters out IDs the user can't access (e.g. invalid User-kind ownership). Pruned IDs silently drop from form state.
  4. Render any chip in the prompts referencing a category that no longer resolves with a **red badge state** ("orphaned" — source set removed or category gone).
- **Adding a wildcard set:** clicking "create" on a wildcard model page adds that set's ID to the form's localStorage `wildcardSetIds`. No DB write. The set is immediately available for `#category` autocomplete.
- **User's own User-kind set is always loaded** — not opt-in.

### Submission shape

The `snippets` data lives inside `input` (the serialized generation-graph), as one node alongside the others.

```ts
type SnippetReference = {
  category: string;
  // empty selections array = "use full pool" (the v1 default)
  selections: { categoryId: number; in: string[]; ex: string[] }[];
};

// Lives inside the generation-graph, carried by `input`
type SnippetsNode = {
  wildcardSetIds: number[];   // set IDs active at submit time
  mode?: 'batch' | 'random';  // default 'random'
  batchCount?: number;        // default 1
  seed?: number;              // optional; only present if user hit "preview"
  targets: Record<string, SnippetReference[]>;
  // Conventional target keys for v1: 'prompt', 'negativePrompt'.
};
```

**Selection semantics (`in`/`ex`):**

- Both empty → use full pool from this source category.
- `in` only → strict whitelist; use only those values.
- `ex` only → full pool minus those values.
- Both set → `in − ex`. (If a value is in both, `ex` wins.)

In v1, **selections are typically `[]`** — the picker UI for picking individual values isn't built yet. Users effectively always use the full pool. The `in`/`ex` shape is forward-looking for when we add granular selection.

**Mode + batchCount defaults:**

- `mode` defaults to `'random'` — each submission produces independent random picks per step.
- `batchCount` defaults to `1` — single workflow step per submission.
- Together: the default v1 submission is "one workflow step with one random sample per `#category` reference."

**`snippets.seed` (preview only):**

- Only present in submission if the user hit the "preview" button before submitting.
- Used by the resolver so client-side preview and server-side resolution produce identical expansions.
- **Not persisted** to `workflow.metadata.params.snippets` — remixes intentionally don't lock the same random picks.
- Distinct from the image-gen `seed` from `seedNode` in generation-graph sub-graphs.

### Workflow metadata

Persisted at `workflow.metadata.params.snippets` — same place as other graph form data (prompt, negativePrompt, image-gen seed, etc.). The `seed` field from the submission is **dropped at persistence time** so remixes get fresh randomness.

```jsonc
{
  // workflow.metadata
  "params": {
    "prompt": "A #character ...",
    "negativePrompt": "...",
    "seed": 847291,                       // image-gen seed (existing)
    /* ... other graph form fields ... */
    "snippets": {
      "wildcardSetIds": [490, 491],
      "mode": "random",                   // or "batch" if user opted in
      "batchCount": 1,                    // or higher for batch mode
      "targets": {
        "prompt": [
          { "category": "character", "selections": [] },
          { "category": "setting",   "selections": [] }
        ],
        "negativePrompt": []
      }
      // Note: no "seed" field here even if the submission had one
    }
  },
  "tags": [..., "wildcards"]
}
```

`wildcards` tag is added to `workflow.tags` whenever the submission carried a `snippets` node. Cheap analytics filter ("did this generation use snippets?").

### Server resolution

- For each `#category` reference in each target's template:
  1. Look up matching categories across `wildcardSetIds`. Filter by `auditStatus = 'Clean'` and `nsfwLevel` matching the request site context.
  2. If `selections` is empty, use the full merged pool from those categories.
  3. If `selections` is non-empty, apply `in`/`ex` per source category to filter.
- Resolve mode:
  - **`random` (default):** for each of `batchCount` steps, pick one value per reference using PRNG keyed by `(seed ?? generationSeed, stepIndex, targetId, refPosition)`.
  - **`batch`:** enumerate cartesian across all targets' references, sample down to `batchCount` if over via Fisher-Yates keyed by `(seed ?? generationSeed)`.
- Substitute values into each target's template literally. **No nested expansion** in v1 — values containing `#name` or `__name__` references substitute as-is. (This is a v1 limitation; some imported wildcard models that rely on nested resolution will produce literal `#refs` in the final prompt. See §4.)
- Return one record per step: `{ targetId → substitutedString }`. Each step's `params.prompt` and `params.negativePrompt` get those values.

### Step metadata

Vanilla. Each step's `params.prompt` / `params.negativePrompt` already contain the fully substituted text. The orchestrator doesn't see the snippets node.

### Provisioning + audit

- **Provisioning job** (see [prompt-snippets-provisioning-job.md](./prompt-snippets-provisioning-job.md)) creates `WildcardSet` (kind: System) + `WildcardSetCategory` rows when a wildcard-type model version is published. Reconciliation job catches missed publishes. Backfill on initial deploy.
- **Audit pipeline** runs per-category. On creation (System-kind import; User-kind value mutation), category is `Pending` until the audit job processes it. Verdict is `Clean` or `Dirty`; `nsfwLevel` is set on `Clean`. Re-runs on rule-version bumps. **No transitive propagation** through nested refs in v1.

### Implementation phases

Independently shippable. Backend phases first.

1. **Phase 1 — schema + audit infra.** Migration. Audit job runner + creation-time hook. No user-visible features.
2. **Phase 2 — provisioning job.** Publish-time hook + reconciliation cron + backfill. After this, every published wildcard model has a `WildcardSet`.
3. **Phase 3 — User-kind set creation flow.** "Save to my snippets" action persists values into the user's own User-kind set (lazy create). CRUD endpoints for managing it.
4. **Phase 4 — form integration: graph node + autocomplete.** `snippets` node in the generation-graph, lazy-fetch user's own set on form mount, "create" button on wildcard models adds set IDs to localStorage, autocomplete-on-`#` insertion.
5. **Phase 5 — server expansion + step fan-out.** Resolver module. Hook into `createStepInputs`. Submission accepts `snippets` node; full-pool resolution; batch + random modes; `wildcards` tag added to workflow.tags.
6. **Phase 6 — preview button.** UI button + `snippets.seed` flow. Client and server agree on expansion via shared seed.

---

## 4. Out of scope for v1 (deferred to v2 / v3)

- **Nested wildcard resolution.** Values containing `#name` / `__name__` references that should recursively expand. Currently substituted literally. **When this lands (v2/v3), both `#name` and `__name__` syntaxes will be supported in nested positions** — `#name` for content authored in our system, `__name__` for compatibility with imported wildcard models that ship with the older Dynamic Prompts convention. See [prompt-snippets-nested-resolution.md](./prompt-snippets-nested-resolution.md) for the design.
- **Per-value selection UI** — drawer, popup, or otherwise. The `in`/`ex` shape exists in the schema but the picker UI to populate them is post-v1. v1 always uses full pools.
- **Mobile R2 + desktop V8 picker designs.** These represent the post-v1 picker UX (multi-source grouped popover, slim bottom drawer on mobile). The v1 chip is minimal — no popover, no drawer, no progressive disclosure.
- **Cross-device wildcard library sync.** Without `UserWildcardSet`, loaded set IDs live only in the device's localStorage. A user moving between devices has to click "create" again on the wildcard models they want loaded. Acceptable v1 trade-off; we can add `UserWildcardSet` back as additive if user feedback demands cross-device.
- **Favorites as a distinct feature.** Implemented for v1 by liking/favoriting the wildcard model itself (existing model-favorites flow) plus copying values into the user's own User-kind set. No new "favorites" table or UI.
- **Random-pick mode UX affordances beyond the simple toggle.** v1 offers a mode toggle (`batch` vs `random`) and a `batchCount` input. No "random pool with bulk-select" UX.
- **System default wildcard set.** A Civitai-curated default loaded for first-time users with empty libraries. v1 starts users with just their own User-kind set (empty until they save into it). Tracked as a TODO ([schema doc §9](./prompt-snippets-schema.md)).
- **Audit re-run debouncing.** Rapid User-kind mutations enqueue many audit jobs; v1 doesn't coalesce. Probably fine since audit is fast.
- **Cross-user sharing of User-kind sets.** A user can't share their personal snippet collection. Future "Shared" or "Public" `kind` value would be additive.
- **Wildcard set version-diff storage.** When a wildcard model publishes a new version, no diff between old and new is stored. Users can subscribe to the new version separately.
- **Set tagging, grouping, and library-page filters beyond `sortOrder`.** No UI for organizing many wildcard sets.
- **Per-snippet labels for User-kind sets.** Values are plain text strings; users find them via reading + searching. No alias / nickname system.
- **Search indexes over wildcard content.** Postgres GIN on `text[]` is an option later; v1 uses straightforward `WHERE` clauses.

---

## 5. Open questions / TODOs (carried over)

- **System default wildcard set** — mechanism for "first-time user" experience. Phase 8 of the long-term plan; not in v1.
- **`getResourceData` integration** — when adding a `Wildcard` model via the resource picker, return the matching `WildcardSet.id` so the form's snippets node can pick it up. v1 adds the equivalent via the "create" button flow on the wildcard model page; the resource-picker integration is a Phase-2 polish.
- **Audit-failure user notification** — when a wildcard model the user has loaded gets invalidated, do we notify them? v1 just reflects it on next page load (set details show "invalidated" via the auto-prune flow); explicit notifications are post-v1.
- **Cost model** — confirmed handled by the existing `whatif` query. Nothing new in v1.
- **Migration ordering** — schema changes ship as separate migrations if any land before others.

See [prompt-snippets-schema.md §9](./prompt-snippets-schema.md) for the full open-questions list against the DB design.

---

## 6. What ships at the end of v1

- A user can type `#` in their prompt and pick a category from a popover.
- The `#category` chip resolves at submit time using the full pool of values from the user's loaded wildcard sets (their own + any added via "create" on wildcard model pages).
- Default behavior is one random pick per reference per submission (`mode: 'random'`, `batchCount: 1`).
- Users can opt into batch mode + higher batch counts to fan out unique combinations across multiple workflow steps.
- A "preview" button shows the user how the prompt would resolve before submit.
- All snippet expansion happens server-side; steps look identical to no-snippet steps.
- Workflow metadata records which sets contributed and what mode/count was used; the `wildcards` tag flags snippet-using submissions.
- Per-category audit + `nsfwLevel` keep dirty content out of generation pools and route by site context.

What v1 doesn't ship: per-value picker UI, nested wildcard resolution, cross-device library sync, mobile drawer / desktop popover picker designs (those are V2 / future-target).
