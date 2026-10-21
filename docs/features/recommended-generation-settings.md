# Turbo LoRAs and the Turbo picker

> Status: **PR 1 merged (#6350), PR 2 merged (#6463), resource data shape and weight split built on `feat/generation-resource-settings`, unmerged** (2026-10-20). Agreed in the 2026-10-19 sync
> and refined with Briant the same day. Also covers where the MOSS Turbo toggle's
> default LoRA lives.

## What was decided

- A **LoRA** version can be a **Turbo variant**. The checkbox is its own section,
  shown for LORA, LoCon and DoRA only, and only in an ecosystem that opted in (below).
  On, it reveals the turbo settings, prefilled from the ecosystem's turbo defaults:
  min, max and default for steps and CFG, all **required**, entered in that order.
  A non-turbo LoRA has no steps or CFG fields at all, and nothing is applied from an
  ordinary LoRA in the generator.
- A **checkpoint** version may name a **default turbo LoRA** for the generator's
  Turbo picker, over the ecosystem default. The reference survives the LoRA
  being unpublished or edited: the editor shows that state under the card, and
  the generator falls back to the ecosystem default until the LoRA is usable
  again. Only a reference to a deleted version is dropped on save. Recommended steps and CFG on checkpoints
  are deferred (Briant, 2026-10-19): with Turbo off the ecosystem defaults apply.
- The generator gets a **Turbo picker** outside the resources list: a checkbox and
  the turbo LoRA it uses. Change opens the same resource modal the resources node
  uses, filtered to turbo LoRAs, since new turbo LoRAs appear often. The card shows
  only while Turbo is on, and a turbo LoRA keeps its strength slider (Briant,
  2026-10-20: users do set it). The pick is client memory: it never rides the
  request, and Turbo off means no turbo LoRA in `resources`.
- Ranges are **advisory**. Sliders keep their full range and paint the turbo LoRA's
  range as a zone (green inside, yellow outside), with no fill bar.
- Precedence: turbo LoRA (when on) > ecosystem defaults.
- No resolution-dependent step counts. MOSS stays one ecosystem; turbo-as-ecosystem
  is revisited with the next ecosystem.

## Data

- **No new column.** Everything lives in `ModelVersion.settings`, the JSON column
  `recommendedSettingsSchema` already parses and that already holds LoRA-only data
  (the strength trio). Two optional blocks, so no migration:

  ```ts
  // LoRA types; its presence IS the turbo flag
  turbo?: {
    steps:    { min: number; max: number; default: number };
    cfgScale: { min: number; max: number; default: number };
  }
  // checkpoints
  generation?: { turboLora?: { id: number; strength?: number } }
  ```

  `min <= default <= max` is refined, and a cleared input ('') is refused rather than
  read as 0. The checkbox in the editor writes or removes `turbo`; the upsert
  service rejects `turbo` on a non-LoRA type, `generation` on a LoRA, and either
  outside an opted-in ecosystem. Settings already ride the resource data cache and
  the search index document, so nothing new is plumbed.

- **Ecosystem turbo defaults are the opt-in:** `ecosystemSettings[].defaults` in
  `packages/civitai-shared/src/basemodel.constants.ts` gains
  `turbo: { settings: { steps, cfgScale } }` beside `model`, each
  of `steps` and `cfgScale` a `{ min, max, default }`. An ecosystem without the
  entry has no turbo LoRAs: the editor shows neither the Turbo section nor the
  default turbo LoRA picker, and the server refuses both. With it, the editor
  prefills the turbo block from `settings` and the graph falls back to it for
  anything a turbo LoRA left unset. `settings` is one of the shared `TURBO_PRESETS`, since
  distillation recipes recur across ecosystems; a preset's numbers are what the
  LoRA pages on the site state for that ecosystem. Opted in today: MOSS Image
  and Anima. SDXL and its children, SD 1.5, Flux.1 D, Qwen and Wan all have
  turbo-style LoRAs and can opt in once their numbers are confirmed from the
  LoRA pages. A parent's entry reaches its children through the defaults
  merge. The generator's default turbo LoRA is not here; the family's graph file
  declares it (Graph; Briant, 2026-10-20). Z-Image, Flux Draft and Krea 2 Turbo are distilled checkpoints or
  ecosystems, not LoRAs, so they have no toggle.
- **Per-checkpoint override:** `settings.generation.turboLora` (`id`, optional
  `strength`), picked in the editor from the resource modal pinned to turbo
  variants, with a strength input beside it. It outranks the family default. MOSS
  Base's own LoRA is such a setting, not code. It rides the version's settings into
  the generator's resource data, so no extra subquery; and because the store holds
  a default checkpoint as a bare id, the form writes the hydrated checkpoint back
  into the store once its data arrives, so the graph sees it.
- **Finding turbo LoRAs:** the resource modal is backed by the models search
  index, and the loaded-only filter is the exact precedent. The index gets a
  per-version boolean `versions.turbo` derived from `settings.turbo` being present,
  listed in `modelsFilterableAttributes`; the resource-select service adds
  `eq('versions.turbo', true)` for the `filterTurbo` input, beside
  `versions.generatorLoaded`; `selectableVersions` narrows the card to a turbo
  version the same way it does for loaded-only. The modal's existing base-model
  clause scopes the list to the ecosystem. The chip also shows in the generator's
  own resources modal whenever LoRA types are offered, except where the Turbo
  toggle is mounted: there `excludeTurbo` hides the chip and filters turbo versions
  out of the cards client-side, since the toggle owns them. A pinned picker
  (`turboOnly`) hides the chip as well. Saving the version queues the model for
  reindex like any version edit.

## Version editor

- LoRA types in an opted-in ecosystem: a Turbo section with the checkbox; the turbo
  settings appear when it is on, steps on one line and CFG on the next, each min,
  max, default. The three inputs bound each other live; the schema refinement is
  the backstop.
- Checkpoints in an opted-in ecosystem: the Default turbo LoRA picker (the same
  modal with the turbo filter pinned) under Recommended Settings.
- The submit drops either block when the editor did not render it.

## Reaching the generator

A version's settings ride the resource data the generator already hydrates:
`settings` (the strength bounds and default, clip skip, and a checkpoint's
companion turbo LoRA), the `turbo` flag and `recommendedSettings` (steps and
CFG bands), per the shape below. All are client-supplied by the time the graph
sees them: they steer defaults and zones only, never a slider's range, and the
orchestrator handlers do not read them.

## Graph

`src/shared/form-graph/generation/turbo.ts` holds `comfyResourceBlock`, mounted with
one `.use()`: the resources field and the sampling sliders a comfy family declares.
Passing `turbo: { lora }` adds the toggle, so the option is the switch and the
family's default LoRA sits in its graph file (Briant, 2026-10-20). MOSS is the
first. The decisions the block encodes:

- Turbo on is a turbo LoRA in `resources`. A LoRA added by hand and one added by
  the toggle are the same state, nothing merges at submit, and off means no turbo
  LoRA at all. The pick (the form's `turboLora` field, per checkpoint; not the resource's `settings.turboLora`) is client memory and never rides the request.
- A resource counts as turbo when it carries the `turbo` flag, is the family default, or is the current pick. The default pick is the checkpoint's own `settings.turboLora` (with the strength the checkpoint set), else the family's.
- One turbo LoRA at most: two distillations fight over the sampling schedule
  and the row has one slot, so a later arrival replaces the earlier one (a
  `correct`, during the parse). The active LoRA, which the row and the sliders
  follow, is the last turbo LoRA in `resources`; the list shows the rest. The
  list's picker offers no turbo variants, so the toggle is the only way to one
  (Briant, 2026-10-20).
- Two graph rules, so they are part of the mount: a turbo LoRA arriving in
  `resources` by any route (a remix, stored state, the row's own Change) becomes the pick; a
  checkpoint switch swaps a default the toggle added for the new checkpoint's,
  never adding one already present, leaving a LoRA the user chose alone, and
  yielding to a patch that brings its own resources.
- The sliders follow the active turbo LoRA: its band (from its block, else the
  ecosystem presets for an unhydrated default) becomes the default and the painted
  zone, clamped to the graph's own range and never widening it, since the range
  is the server's bound and the block is client-supplied. Values are remembered
  per LoRA under the checkpoint, so turning Turbo off restores what the user had.
- The server re-checks a checkpoint's default turbo LoRA on save (a turbo LoRA of
  its ecosystem), since the id becomes every viewer's default.

## Generator UI

- Turbo row under the model, where the family mounted the toggle: the checkbox
  and, while Turbo is on, the LoRA card, whose Change opens the resource modal
  pinned to turbo variants. A swap or strength change on the card updates the pick
  and the LoRA in `resources`; Additional Resources hides it and offers none. A pick that
  cannot be generated with (unpublished, gone) falls back to the family default
  with a notice; while its data loads the checkbox waits; off never waits.
- A default checkpoint sits in the store as a bare id, so the form hydrates it
  into the store once its data arrives and the graph sees the checkpoint's own
  default.
- Sliders paint the band on the track (green inside, yellow outside) in place of
  the filled bar; a zero-width band paints a tick. A turbo LoRA's row shows a
  Turbo pill and keeps its strength slider.

## Rollout

Two PRs (Briant, 2026-10-19), so the first can deploy and make turbo versions
searchable before the generator changes land. A third PR, the resource data shape below, followed PR 2 (Briant, 2026-10-20).

1. **PR 1: editor and index.** Settings schema, the version editor (Turbo section,
   the default turbo LoRA picker), ecosystem turbo defaults as the opt-in,
   `versions.turbo` in the models index with the `filterTurbo` filter in the
   resource modal. No generator behaviour change. `versions.turbo` was made
   filterable on the live models index on 2026-10-19 through
   `/api/admin/temp/apply-models-index-filterable-attributes`, so no index step
   follows the deploy. The turbo blocks on the three MOSS turbo LoRAs and Base's
   `generation.turboLora` are on prod (verified 2026-10-20 against the replica);
   what remains is to confirm those models were reindexed, so `versions.turbo` is
   true for them in the models index.
2. **PR 2: generator.** Resource data forwarding, `turbo.ts` and
   `comfyResourceBlock`, the Turbo row, slider zone, the checkpoint strength input,
   the model write-back; MOSS declares `turbo: { lora }`. Also: the resource
   store's not-found set (a deleted pick no longer reads as loading), the create
   and remix converter carrying the turbo fields, and ACE's model rule ignoring a
   rewrite of the same checkpoint (the write-back would otherwise reset it).

Tests live beside the code; the MOSS turbo suite is the behaviour spec for the
block, and the paint itself has no browser test, by choice.

## The resource data shape

Decided with Briant on 2026-10-20 and built right after PR 2 (#6463), which had
shipped `turbo` and `turboLora` as two top-level fields on
`GenerationResourceBase`. This gives them, and the fields that were already
loose, a home.

The rule: **settings** are what a resource requires or fixes, **recommended
settings** are advisory bands inside the graph's own range that the user may
leave, and being a turbo variant is a fact about the resource, so it is its own
flag. Clip skip is a requirement, not advice; the default turbo LoRA is a
companion a checkpoint starts with.

```ts
// GenerationResourceBase: the server's resource data, for display and hydration
settings: {
  strength: Range; // was minStrength / maxStrength / strength
  clipSkip?: number; // was top level
  turboLora?: { id: number; strength?: number };
};
turbo?: boolean; // the variant flag the models index already carries
recommendedSettings?: { steps?: Range; cfgScale?: Range };
```

- The data type (`GenerationResource`) carries no weight; `GenerationResourceValue` adds the chosen one, and `asResourceValue` (`shared/utils/resource.utils`) is the one way data becomes a value, taking the chosen weight or the version's default. The server hands out values where a weight is already decided (generation data for the create button and remix, a version's recommended resources, the orchestrator's enriched step resources) and data everywhere else.
- The turbo flag replaces presence of the turbo block as the test for a turbo
  LoRA, in the graph, the row's badge and the picker's exclusion, so a
  checkpoint may later recommend steps and CFG without reading as turbo. The
  band stays the recommendation; the ecosystem presets stay the fallback.
- The MOSS graph's hard-coded defaults (25 steps, CFG 3) become a checkpoint's
  own recommendation once the editor can save one; that is the first use.
- `RecommendedRange` is now `Range` (`basemodel.constants.ts`), with one zod form in `src/shared/zod/range.schema.ts` that the graph and the server both use.
- Identity, access, pricing and trained words (content the generator inserts,
  not a setting) stay on the base type; the substitute inherits the shape.

Cost: the flattened strength fields were read across the picker, the form helpers, the controllers and the server mapping, almost all mechanically. Two need care: the public App Blocks resource projection keeps
emitting the flat fields, mapped from the new shape, so external readers do
not break; and form state saved before the shape still renders (a missing range falls back to the full bounds, an old turbo block still reads as the flag) but is not re-fetched: such a LoRA shows the full strength range and such a checkpoint starts Turbo on the family default until the user picks it again. Re-fetching was tried and dropped: it swapped a saved training epoch for the latest and left a deleted version as a skeleton with no remove control.

Done (on `feat/generation-resource-settings`): the shape is in the types, the graph and the server mapping, with the mapping pinned by a test of its own, and the weight is split off the data type (`GenerationResourceValue`, `asResourceValue`). The blocks resource endpoint keeps its flat output (its test and the projection test pin it). The version editor's recommended-resources read sets only the pairing's own strength on the resource (the version's default when the row has none), since that is the one value its row sets; the rest of a row's settings JSON is a historical shape and is not read.

Not done, by design: no editor saves a checkpoint's `recommendedSettings` yet, so the MOSS graph's hard-coded 25 steps and CFG 3 stay until one does. A `settings.vae` field was planned and dropped (Briant, 2026-10-21): nothing reads it, since a checkpoint's VAE is paired through linked components, and the idea of a checkpoint loading its VAE with it is not being built. Nothing here is a tracked item.

## Closing conditions

- On prod, the MOSS Turbo picker offers only flagged LoRAs, starts on the SFT
  8-step LoRA for SFT and community checkpoints and on Base's own for Base, and
  turning it on sets that LoRA's steps and CFG and paints the zone (clamped to
  the slider's range). An unusable pick falls back to the ecosystem default, and
  a hand-picked turbo LoRA survives a checkpoint switch. Additional Resources
  offers no turbo variants and shows no turbo chip, and the toggle's LoRA is not
  listed twice.
- Changing a family's default is a change to its graph file plus deploy; one
  checkpoint's default is a version edit. This amends the earlier "no deploy"
  closing condition, and whoever closes that task should say so.
