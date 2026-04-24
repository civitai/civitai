# Prompt Snippets

A reusable text-fragment library for the image generator. Users save perfected prompt segments (subjects, settings, lighting, moods, characters, etc.) under named categories, then reference them in prompts via a wildcard syntax. Selecting multiple values for a reference fans the submission out into a batch of workflow steps, one per expanded prompt.

## Status

Planning. Not yet implemented.

---

## Design decisions (settled)

- **Per-snippet model:** each snippet is a single named piece of text grouped under a user-defined **category**. Category is the wildcard token; name is human-readable. Example: category = `character`, name = `Zelda`, value = `a young woman with blonde hair, pointed ears, green tunic, pointed cap...`.
- **Expansion is server-side.** Client submits the template prompt plus the picked snippet ids. Server performs the cartesian expansion and creates N `StepInput` objects — one per expanded prompt — in a single workflow. This leverages the existing multi-step support at [orchestration-new.service.ts:488-609](../../src/server/services/orchestrator/orchestration-new.service.ts#L488-L609).
- **Batch unit:** each combination = one workflow step. Existing `quantity` field (images per step) is unchanged.
- **Combination cap:** 10 per submission.
- **No-repeat rule:** when a category appears multiple times in one prompt, a single combination may not reuse the same snippet-value across those slots. Expansion is k-permutations of n (where k = reference count, n = picked values).
- **Over-cap behavior:** accept submission, randomly sample 10 unique combinations. UI shows a clear alert ("24 combinations — randomly running 10") with a **reroll** control to resample.
- **Pre-audit snippets at creation** — block save if audit fails, store audit verdict + rule version on the record. Do not re-audit snippet content at submission. Submission audit only inspects the user's literal (template-side) text; the external moderation tool handles the composed prompt.
- **Presets and snippets are separate features.** Presets saving the prompt save `#references` as literal text; at load time, any reference whose category no longer exists in the user's library is shown as an unresolved reference chip.

---

## Resolved decisions

- **Syntax:** `#category` with server-side namespace resolution (unmatched `#tokens` pass through to the existing textual-inversion parser). See *Syntax and parsing* below.
- **Seeded sampling and random-pick:** both use the existing generation-form `seed`. Same `seed` + same payload = same sampled combinations and same `#?` picks. No separate sampling seed is introduced; the form's seed is the single source of determinism.
- **Literal-prompt audit at submission:** kept for v1. Snippet content is pre-audited at creation and not re-audited; the user's template (text outside any `#reference`) is audited on submit. Revisit if external moderation is confirmed to cover Civitai-specific policy terms.
- **Random-pick mode (`#?category`):** in scope as Phase 6. See *Random-pick mode* below.

---

## Data model

### `PromptSnippet` (new Prisma model)

Follows the [GenerationPreset](../../prisma/schema.prisma) shape for consistency.

```prisma
model PromptSnippet {
  id               Int      @id @default(autoincrement())
  userId           Int
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  category         String   // wildcard token, e.g. "character". Indexed with userId.
  name             String   // human-readable title, e.g. "Zelda". Unique per (userId, category).
  value            String   // the prompt text that substitutes in
  description      String?

  auditStatus      SnippetAuditStatus @default(Pending) // Pending | Clean | Dirty | NeedsRecheck
  auditRuleVersion String?            // which audit-ruleset version produced the verdict
  auditedAt        DateTime?

  sortOrder        Int      @default(0)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@unique([userId, category, name])
  @@index([userId, category])
}

enum SnippetAuditStatus {
  Pending
  Clean
  Dirty
  NeedsRecheck
}
```

**Notes:**

- `category` is a free-form string chosen by the user at save time. We don't pre-seed categories — users discover their own organization. A small "common categories" suggestion list in the save modal is fine UX but non-authoritative.
- `auditStatus = Dirty` snippets are retained (so the user can edit them) but cannot be referenced in a submission. Prompts containing a reference to a dirty snippet are rejected server-side.
- `auditStatus = NeedsRecheck` is set by a background job when rules update; treated as `Pending` for submission purposes until the job re-audits.

### Prisma migration

Standard `prisma migrate dev` — new table, one enum, no data backfill.

---

## Syntax and parsing

**Trigger:** `#category`.

**Collision with existing `#textualInversion` syntax** is resolved on the server. Snippet expansion runs first and replaces any `#token` that matches a snippet category owned by the submitting user. Unmatched `#tokens` pass through to the existing downstream parsers (textual inversion resource extraction, etc.) unchanged. Edge case: a user who owns both a snippet category `foo` and a textual-inversion resource `foo` will see the snippet win — this conflict is user-created and expected to be rare; we can add a "shadowed resource" warning in the snippet manager if it becomes an issue.

**Grammar:** `#` + identifier matching `[A-Za-z][A-Za-z0-9_]*`. Categories are case-insensitive on lookup, stored lowercase.

**Parser:** new helper in [src/utils/prompt-helpers.ts](../../src/utils/prompt-helpers.ts), co-located with the existing `parsePromptResources`.

```ts
// new regex
const snippetReferencePattern = /#([a-zA-Z][a-zA-Z0-9_]*)/g;

export const parsePromptSnippetReferences = (value: string): string[] => { ... };
// returns ordered list of referenced categories (with duplicates preserved for slot-counting)

export const expandPromptSnippets = (
  template: string,
  assignments: Record<string, string[]>, // category -> ordered list of values for each slot in that combination
): string => { ... };
```

**Slot-counting:** a prompt like `"#character fights #character"` contains two `#character` slots. Expansion must produce one value per slot; the no-repeat rule ensures the two slots within a single combination hold different values.

---

## Client UI

### Snippet library (CRUD)

Mirrors the preset pattern:

- **Save dialog:** `src/components/Generation/Snippet/SaveSnippetModal.tsx`. Fields: category (autocomplete against user's existing categories + allow new), name, value, optional description. On save, shows inline audit result — if dirty, displays the offending rule and blocks save until the user edits.
- **Manage dialog / drawer:** `src/components/Generation/Snippet/ManageSnippetsModal.tsx`. Groupable by category, filter by name, edit/delete/reorder within a category. Dirty snippets flagged visually.

### Prompt input integration

Wrap the existing [InputPrompt.tsx](../../src/components/Generate/Input/InputPrompt.tsx) with an autocomplete-aware shell that:

1. Watches the textarea for the `#` trigger character and the token that follows. The popover only opens if the character was typed outside an existing resource reference (e.g., not inside a `<lora:...>` block).
2. Opens a positioned popover (Mantine `Popover` + `ScrollArea`) listing the user's snippet categories, filtered by the partial token. Arrow keys navigate, Enter inserts.
3. After insertion, the text `#category` is plain text in the textarea (no rich tokenization) — simpler to implement and survives copy/paste, preset save/load, and server round-tripping.
4. Highlights existing `#references` in the textarea using a lightweight overlay (match behavior of existing `<lora:...>` highlighting if any — to confirm during implementation).

### Per-reference picker panel

Below the prompt input, a new `SnippetReferencePanel` component:

- Lists each unique `#category` found in the prompt (with slot count: `#character ×2`).
- For each, shows the user's snippets in that category as checkbox chips with the snippet name; clicking expands to preview the value.
- Footer row: **combinations counter** (e.g. *"24 combinations → 10 will run (randomly sampled)"*), a **reroll** button when sampling is active, and a **validation error** if selection is insufficient (e.g. "`#character` appears 2× — pick at least 2 snippets").
- If a category in the prompt is unknown (typo, or snippet deleted since typing), it shows as an unresolved chip with a "create snippet" shortcut.

### Form submission gate

Submit is disabled when:

- Any `#reference` in the prompt is unresolved (no snippets exist in that category).
- Any category has fewer picked values than its slot count in the prompt.
- Any picked snippet has `auditStatus = Dirty`.

Submit is enabled (with an info alert) when:

- Total cartesian combinations > 10 — alert reads *"N combinations — randomly running 10. [Reroll]"*.

---

## Submission payload

Extend the `generateFromGraph` call at [generationRequestHooks.ts:216-237](../../src/components/ImageGeneration/utils/generationRequestHooks.ts#L216-L237) to include snippet context. The tRPC input currently is `z.any()` ([orchestrator.router.ts:337-380](../../src/server/routers/orchestrator.router.ts#L337-L380)), so the change is client-side payload shape + server-side handler reading it.

```ts
type GenerateFromGraphInput = {
  input: GraphInput;          // existing (already contains the form `seed`)
  civitaiTip, creatorTip, tags, remixOfId, buzzType;  // existing
  snippets?: {                // new
    references: { category: string; snippetIds: number[] }[];
  };
};
```

- Client does **not** expand. Server is the sole source of truth for permutation enumeration, cap enforcement, and sampling — this keeps the cap un-spoofable.
- If `snippets` is omitted or empty, behavior is identical to today.
- **Determinism:** the existing generation-form `seed` drives all snippet-related randomness (cap sampling + `#?` picks). No new seed is introduced. If the user requested `seed = -1`, the server resolves a random seed early and uses it for both image generation and snippet resolution so the resolved seed is the single record of reproducibility.
- **Reroll UX:** the picker panel's "reroll" button changes the form's seed (or resolves a new random one) and re-requests the combination preview. Same seed always yields the same sample.

---

## Server expansion and step fan-out

Snippet expansion slots into [orchestration-new.service.ts](../../src/server/services/orchestrator/orchestration-new.service.ts) at `createStepInputs` (around line 574), **before** the existing per-step build.

```ts
// new helper in a sibling file, e.g. orchestrator/snippetExpansion.ts
async function expandSnippetsToPrompts(
  template: string,
  references: { category: string; snippetIds: number[] }[],
  userId: number,
  seed: number, // resolved form seed — drives cap sampling AND #? picks
): Promise<{ prompt: string; assignment: Record<string, string[]> }[]> {
  // 1. Load all referenced snippets. Verify ownership. Reject if any Dirty.
  // 2. Parse template to count slots per category for `#category` batch refs,
  //    and note which category slots are `#?category` random-pick refs.
  // 3. For batch refs: enumerate k-permutations per category, then cartesian-product across categories.
  // 4. If total batch combinations > 10: Fisher-Yates shuffle keyed by `seed`, take first 10.
  // 5. For each resulting combination, resolve `#?category` refs by picking one snippet
  //    from the category's selected set using a PRNG keyed by (seed, stepIndex, referencePosition).
  // 6. Substitute values into template, return one expanded prompt + assignment per combination.
}
```

**Determinism contract:** the sampling and random-pick must be pure functions of `(seed, references, snippetIds, template)`. Implementation uses a seeded PRNG (e.g. `mulberry32` / `xorshift`); no wall-clock or process-level randomness. Re-submitting the same payload with the same seed yields byte-identical expanded prompts and assignments.

The result (an array of prompts) then drives N parallel calls to the existing step-builder:

```ts
// inside createStepInputs, after expandSnippetsToPrompts
const expansions = await expandSnippetsToPrompts(...);
const steps = await Promise.all(
  expansions.map((e) => buildStepFromPrompt({ ...baseParams, prompt: e.prompt }))
);
return steps;
```

**Workflow shape:** a single `submitWorkflow()` call with all N steps — same submission boundary, same buzz-accounting path, no change to downstream consumers of the workflow record.

**Metadata:** each step records its `assignment` (the snippet ids and values used) in the step metadata so result cards can label which combination produced each image.

---

## Auditing

### Creation-time

On snippet create/update:

1. Call `auditPromptEnriched` on the snippet value.
2. If clean → `auditStatus: Clean`, store current rule version.
3. If dirty → reject the save with the matching rule returned to the client for display. The snippet is not persisted (or is persisted with `Dirty` and hidden from pickers — TBD during impl; I lean "reject the save" for simpler mental model).

### Submission-time

1. Verify all referenced snippets are owned by the submitter and have `auditStatus: Clean`.
2. Audit the user's **template** prompt (with `#references` stripped or replaced with harmless placeholders) via `auditPromptEnriched`. This catches problematic text the user typed outside any snippet.
3. The **composed** prompt (after expansion) goes to the external moderation tool as part of the normal submission flow. No second local audit pass over the composition.

### Rule version drift

Background cron job `reauditSnippets`:

- Runs when the `auditPromptEnriched` rule version bumps.
- Scans `PromptSnippet` rows where `auditRuleVersion != current`, re-audits in batches, updates `auditStatus` + `auditRuleVersion`.
- During the window between rule bump and job completion, affected snippets are treated as `NeedsRecheck` → blocked from submission. The job should be fast (audit is cheap regex) so the window is minutes.

---

## Preset interaction

Presets live in [generation-preset.router.ts](../../src/server/routers/generation-preset.router.ts). They save a `values` JSON blob that may contain `prompt`.

- **Save:** no change. If the saved prompt contains `#references`, they save as literal text. The preset does not snapshot the snippet values; it snapshots only the references.
- **Load:** when a preset is loaded into the form, parse the prompt for `#references` and populate the reference picker panel. For each category:
  - If the user has snippets in that category: show the picker with **no** values pre-selected (user chooses what to include). Optionally, pre-select the most-recently-used value as a sensible default.
  - If the user has no snippets in that category: show an unresolved reference chip with a "create snippet" shortcut.
- **Share a preset (future):** presets are per-user today, but if sharing is ever added, cross-user `#references` will always be unresolved on the receiver's side. That's acceptable — the receiver sees the structure and fills with their own snippets.

---

## Implementation phases

Each phase is independently shippable.

### Phase 1 — snippet library only (no prompt integration)

- Prisma model + migration + enum
- tRPC router (`promptSnippet`): `getOwn`, `getByCategory`, `create`, `update`, `delete`, `reorder`
- Save / manage modals in `src/components/Generation/Snippet/*`
- Entry point: a "Snippets" button in the generator form header, next to Presets

This ships a usable feature (organized library of prompt fragments the user can copy/paste manually) without any generator-side changes.

### Phase 2 — prompt parsing + autocomplete

- Add `parsePromptSnippetReferences` and `expandPromptSnippets` to `prompt-helpers.ts`
- Build the autocomplete popover wrapping `InputPrompt`
- Highlight `#references` in the textarea

No submission changes yet — references still behave as literal text server-side.

### Phase 3 — per-reference picker + batch math

- `SnippetReferencePanel` component
- Combination counter, cap alert, reroll control, validation
- Still no server submission changes — pickers exist in UI but selections aren't sent

### Phase 4 — server expansion + step fan-out

- Augment `generateFromGraph` payload
- `snippetExpansion.ts` module in `server/services/orchestrator/`
- Hook into `createStepInputs`
- Step metadata records the assignment

First end-to-end working slice.

### Phase 5 — auditing completeness

- Pre-audit on snippet save
- `SnippetAuditStatus` blocking at submit
- Background `reauditSnippets` cron
- Literal-prompt audit at submission

### Phase 6 — random-pick mode (`#?category`)

Adds A1111-style wildcard picking: `#?category` resolves to one randomly chosen snippet value per workflow step, instead of fanning the submission out into a batch. See *Random-pick mode* below for semantics.

- Extend `parsePromptSnippetReferences` to recognize `#?` as a distinct reference kind.
- In `expandSnippetsToPrompts`, resolve `#?` refs per-step using a seeded PRNG keyed by `(seed, stepIndex, referencePosition)`.
- Picker panel adds a "random pool" section for `#?` references with bulk-select affordances (*Select all*, *Select none*) since random-pick users typically want wide pools.
- Step metadata records the `#?` picks so a result card can show which value was chosen for each image.

---

## Random-pick mode

Two reference kinds share the same `#category` selection pool but differ in expansion semantics:

- **`#category` — batch mode.** Each reference slot uses a selected snippet value; selections cartesian-product across categories into multiple workflow steps. *Fans out a batch.*
- **`#?category` — random-pick mode.** One snippet is randomly picked from the selected pool per workflow step and inserted into every `#?category` occurrence in that step. *Does not fan out.*

**Combined usage:** a prompt may mix both modes. Example: `"#character walking through #?setting"` with 3 characters and 5 settings picked → 3 workflow steps (one per character), each step's `#?setting` independently resolves to one of the 5 settings via seeded PRNG. Total images = 3 steps × `quantity` per step.

**Per-step, not per-image.** Inside a single workflow step (which produces `quantity` images), all images share the same `#?` resolution. Users who want per-image variance should set `quantity = 1` and rely on batch fan-out. This keeps the one-prompt-per-step contract intact and avoids orchestration changes.

**Validation:** `#?category` requires at least 1 selected snippet in that category. Same-category occurrences share one pick per step — so `"#?character vs #?character"` in random-pick mode always substitutes the same character into both slots within a given step (intentional — use batch mode if different values are wanted).

**Shared selection pool with batch mode.** A prompt like `"#character fights #?character"` uses a single selection set for the `character` category: batch slots iterate through selections, random-pick slots draw from the same set. If users want different pools for different reference kinds, that's a v2 enhancement (separate per-reference selections).

---

## Out of scope for v1

- Shared public snippets / a snippet marketplace
- Nested snippets (a snippet's value containing `#references` to other snippets)
- Per-reference "shared pick" toggle (all `#character` occurrences get the same value within a combination)
- Per-reference separate selection pools (batch and random-pick drawing from different sets within the same category)
- Per-image random-pick resolution (currently per-step)
- Weight syntax for snippets (e.g., `#character:1.2`)

All deliberately deferred until the v1 shape is validated.
