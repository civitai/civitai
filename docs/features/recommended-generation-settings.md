# Recommended generation settings and the Turbo picker

> Status: **Plan** (2026-10-19). Agreed in the 2026-10-19 sync and refined with
> Briant the same day; nothing is built yet. Also covers where the MOSS Turbo
> toggle's default LoRA lives.

## What was decided

- A **checkpoint** version can carry recommended generation settings: min, max
  and default for steps and CFG, entered in that order. They apply on
  their own when the checkpoint is loaded. They sit in the version editor's
  existing Recommended Settings section, no toggle.
- A **LoRA** version can be a **Turbo variant**. The checkbox is its own section,
  shown for LORA, LoCon and DoRA only. On, it reveals the turbo settings, prefilled
  from the ecosystem's turbo defaults: min, max and default for steps and CFG, all
  **required**. A non-turbo LoRA has no steps or
  CFG fields at all, and nothing is applied from an ordinary LoRA in the generator.
- The generator gets a **Turbo picker** outside the resources list: a checkbox and
  the turbo LoRA it uses. Change opens the same resource modal the resources node
  uses, filtered to turbo LoRAs, since new turbo LoRAs appear often. A turbo LoRA
  has no strength slider and runs at strength 1.
- Ranges are **advisory**. Sliders keep their full range and paint the recommended
  range as a zone (green inside, yellow outside), with no fill bar.
- Precedence: turbo LoRA (when on) > checkpoint > ecosystem defaults.
- No resolution-dependent step counts. MOSS stays one ecosystem; turbo-as-ecosystem
  is revisited with the next ecosystem.

## Data

- **No new column.** Everything lives in `ModelVersion.settings`, the JSON column
  `recommendedSettingsSchema` already parses and that already holds LoRA-only data
  (the strength trio). Two optional blocks, so no migration:

  ```ts
  // checkpoints
  generation?: {
    steps?:    { min: number; max: number; default: number };
    cfgScale?: { min: number; max: number; default: number };
  }
  // LoRA types; its presence IS the turbo flag
  turbo?: {
    steps:    { min: number; max: number; default: number };
    cfgScale: { min: number; max: number; default: number };
  }
  ```

  `min <= default <= max` is refined on both. The checkbox in the editor writes or
  removes `turbo`; the upsert schema rejects `turbo` on a non-LoRA type and
  `generation` on a LoRA. Settings already ride the resource data cache and the
  search index document, so nothing new is plumbed. A Postgres partial index on
  `settings ? 'turbo'` is available if a query ever needs it; the picker goes
  through the search index.

- **Ecosystem turbo defaults:** `ecosystemSettings[].defaults` in
  `packages/civitai-shared/src/basemodel.constants.ts` gains
  `turbo: { lora?: { id }, settings: { steps, cfgScale } }` beside `model`, each
  of `steps` and `cfgScale` a `{ default, min, max }`. Every ecosystem resolves a
  `settings` set (its own, or a generic one): the editor prefills from it when the
  bit is turned on, and the graph falls back to it for anything a turbo LoRA left
  unset. Only ecosystems with a `lora` show the picker; today that is
  MOSS alone (Z-Image, Flux Draft and Krea 2 Turbo are distilled checkpoints or
  ecosystems, not LoRAs). Changing it is a constants change and a deploy.
- **Per-checkpoint override:** a checkpoint version may name its own default as
  `settings.generation.turboLora.id`, picked in the editor from the resource
  modal pinned to turbo variants. It outranks the code default; that is how MOSS
  Base names its own LoRA while SFT and community checkpoints inherit the
  ecosystem's. Nothing is required of creators. It rides the version's settings
  into the generator's resource data, so no extra subquery.
- **Finding turbo LoRAs:** the resource modal is backed by the models search
  index, and the loaded-only filter is the exact precedent. The index gets a
  per-version boolean `versions.turbo` derived from `settings.turbo` being present, listed in
  `modelsFilterableAttributes`; the resource-select service adds
  `eq('versions.turbo', true)` for a new `turboOnly` filter input, beside
  `versions.generatorLoaded`; `versionSatisfiesFilter` in
  `resource-select.types.ts` narrows the card to a turbo version the same way it
  does for loaded-only. The modal's existing base-model clause scopes the list to
  the ecosystem. Saving the version queues the model for reindex like any version
  edit; a one-off reindex of models with LoRA versions backfills the field. That
  extends an index the picker already reads; it is not a new search-index data
  source.

## Version editor

- Checkpoints: min, max and default for steps and CFG join Clip Skip under
  Recommended Settings; plus the optional Default turbo LoRA picker (Change / Clear),
  the same modal with the turbo filter.
- LoRA types: a Turbo section with the checkbox; the turbo defaults appear when it
  is on. `model-version-submit.ts` sends the flag and the block.

## Reaching the generator

- `resourceDataCache` already selects `settings` and `flags`.
  `transformGenerationData` forwards `settings.generation` as `recommended` and
  derives `isTurbo` from `settings.turbo`, on `GenerationResourceBase`.
- The graph's `resourceSchema` gains `recommended?` and `isTurbo?`. The output
  schema strips unknown keys, so without this a hydrated value would lose them
  between parses. They are client-supplied and only steer defaults and zones; the
  server never trusts them for anything else and the orchestrator handlers do not
  read them.

## Graph

- A `turbo` field beside `vae`: one flagged LoRA or nothing. Its default resolves
  user pick (persisted per checkpoint version) > checkpoint override > ecosystem
  code default. A `correct` drops a value that is not a flagged LoRA. At submit the
  value merges into resources the way the VAE does, strength 1. A flagged LoRA
  present in `resources` counts as on, as today.
- A shared `recommendedSlider(opts)` in `shared.ts` replaces `perModelSlider` and
  MOSS's `turboAwareSlider`. Source: the turbo LoRA when on, else the checkpoint,
  else `opts`. It returns `sliderDef` with that default and `meta.recommended =
{ min, max }` when the source has a range. Scope segments are `[modelId]` plus
  `['turbo', loraId]` when on, so values are remembered per source as MOSS does
  today.
- Every image and video graph that has `steps` / `cfgScale` adopts the helper
  (24 graphs; SD's draft-mode branch keeps its own definitions).
- `mossImageTurboLoraVersions` and `mossImageTurboToggleVersionIds` go away.

## Generator UI

- Turbo row under the model (only when the ecosystem has a turbo default): checkbox,
  the LoRA in use with its steps and CFG, Change opens the resource modal filtered
  to turbo LoRAs on the ecosystem.
- `SliderInput` gains `recommended?: { min; max }` and paints the zone on the
  track; the filled bar is dropped when a zone is present.
- `ResourceItemContent`: a flagged LoRA shows a Turbo pill and no strength slider.
  No link or alert on any row.

## Rollout

Two PRs (Briant, 2026-10-19), so the first can deploy and make turbo versions
searchable before the generator changes land.

1. **PR 1: editor and index.** Settings schema, the version editor (Turbo section,
   checkpoint recommendations, the override picker), ecosystem turbo defaults for
   prefill, `versions.turbo` in the models index with the `turboOnly` filter in
   the resource modal. No generator behaviour change. `versions.turbo` was made filterable on the live
   models index on 2026-10-19 through
   `/api/admin/temp/apply-models-index-filterable-attributes`, so no index step
   follows the deploy. After deploy: set the turbo block on the three MOSS turbo LoRAs and Base's `turboLora` by
   SQL, reindex those models.
2. **PR 2: generator.** Resource data forwarding, graph helper, `turbo` field, the
   Turbo row, slider zone, the MOSS code default; remove the hard-coded map.

Tests: schema refinement (required steps and CFG under the bit; block stripped
otherwise); `transformGenerationData` forwards `recommended` and `isTurbo`; the
helper's precedence and scope segments; `turbo` default resolution and the
`correct` that rejects an unflagged LoRA; the MOSS turbo suite rewritten against
the `turbo` field.

## Closing conditions

- On prod, loading a checkpoint with recommended settings sets them and paints the
  zone; the MOSS Turbo picker offers only flagged LoRAs, starts on the SFT 8-step
  LoRA for SFT and community checkpoints and on Base's own for Base, and turning
  it on sets that LoRA's steps and CFG and moves the zone.
- Changing the ecosystem default is a constants change plus deploy; one
  checkpoint's default is a version edit. This amends the earlier "no deploy"
  closing condition, and whoever closes that task should say so.
