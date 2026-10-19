# Turbo LoRAs and the Turbo picker

> Status: **PR 1 in review, PR 2 planned** (2026-10-19). Agreed in the 2026-10-19 sync
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
  Turbo picker, over the ecosystem default. Recommended steps and CFG on checkpoints
  are deferred (Briant, 2026-10-19): with Turbo off the ecosystem defaults apply.
- The generator gets a **Turbo picker** outside the resources list: a checkbox and
  the turbo LoRA it uses. Change opens the same resource modal the resources node
  uses, filtered to turbo LoRAs, since new turbo LoRAs appear often. A turbo LoRA
  has no strength slider and runs at strength 1.
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
  generation?: { turboLora?: { id: number } }
  ```

  `min <= default <= max` is refined, and a cleared input ('') is refused rather than
  read as 0. The checkbox in the editor writes or removes `turbo`; the upsert
  service rejects `turbo` on a non-LoRA type, `generation` on a LoRA, and either
  outside an opted-in ecosystem. Settings already ride the resource data cache and
  the search index document, so nothing new is plumbed.

- **Ecosystem turbo defaults are the opt-in:** `ecosystemSettings[].defaults` in
  `packages/civitai-shared/src/basemodel.constants.ts` gains
  `turbo: { lora?: { id }, settings: { steps, cfgScale } }` beside `model`, each
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
  merge. Only ecosystems with a
  `lora` show the generator picker; today that is MOSS alone (Z-Image, Flux Draft and Krea 2 Turbo
  are distilled checkpoints or ecosystems, not LoRAs). Changing the default is a
  constants change and a deploy.
- **Per-checkpoint override:** `settings.generation.turboLora.id`, picked in the
  editor from the resource modal pinned to turbo variants. It outranks the code
  default; that is how MOSS Base names its own LoRA while SFT and community
  checkpoints inherit the ecosystem's. Nothing is required of creators. It rides the
  version's settings into the generator's resource data, so no extra subquery.
- **Finding turbo LoRAs:** the resource modal is backed by the models search
  index, and the loaded-only filter is the exact precedent. The index gets a
  per-version boolean `versions.turbo` derived from `settings.turbo` being present,
  listed in `modelsFilterableAttributes`; the resource-select service adds
  `eq('versions.turbo', true)` for the `filterTurbo` input, beside
  `versions.generatorLoaded`; `selectableVersions` narrows the card to a turbo
  version the same way it does for loaded-only. The modal's existing base-model
  clause scopes the list to the ecosystem. Saving the version queues the model for
  reindex like any version edit.

## Version editor

- LoRA types in an opted-in ecosystem: a Turbo section with the checkbox; the turbo
  settings appear when it is on, steps on one line and CFG on the next, each min,
  max, default. The three inputs bound each other live; the schema refinement is
  the backstop.
- Checkpoints in an opted-in ecosystem: the Default turbo LoRA picker (the same
  modal with the turbo filter pinned) under Recommended Settings.
- The submit drops either block when the editor did not render it.

## Reaching the generator (PR 2)

- `resourceDataCache` already selects `settings`. `transformGenerationData` forwards
  `settings.turbo` and `settings.generation.turboLora` on `GenerationResourceBase`.
- The graph's `resourceSchema` keeps them. The output schema strips unknown keys,
  so without this a hydrated value would lose them between parses. They are
  client-supplied and only steer defaults and zones; the server never trusts them
  for anything else and the orchestrator handlers do not read them.

## Graph (PR 2)

- A `turbo` field beside `vae`: one flagged LoRA or nothing. Its default resolves
  user pick (persisted per checkpoint version) > checkpoint override > ecosystem
  code default. A `correct` drops a value that is not a flagged LoRA. At submit the
  value merges into resources the way the VAE does, strength 1. A flagged LoRA
  present in `resources` counts as on, as today.
- A shared `turboAwareSlider(opts)` in `shared.ts` replaces `perModelSlider` and
  MOSS's own. Source: the turbo LoRA when on, else `opts`. It returns `sliderDef`
  with that default and `meta.recommended = { min, max }` when the LoRA has a
  range. Scope segments are `[modelId]` plus `['turbo', loraId]` when on, so values
  are remembered per source as MOSS does today.
- Every image and video graph that has `steps` / `cfgScale` adopts the helper
  (24 graphs; SD's draft-mode branch keeps its own definitions).
- `mossImageTurboLoraVersions` and `mossImageTurboToggleVersionIds` go away.

## Generator UI (PR 2)

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
   the default turbo LoRA picker), ecosystem turbo defaults as the opt-in,
   `versions.turbo` in the models index with the `filterTurbo` filter in the
   resource modal. No generator behaviour change. `versions.turbo` was made
   filterable on the live models index on 2026-10-19 through
   `/api/admin/temp/apply-models-index-filterable-attributes`, so no index step
   follows the deploy. After deploy: set the turbo block on the three MOSS turbo
   LoRAs and Base's `turboLora` by SQL, reindex those models.
2. **PR 2: generator.** Resource data forwarding, graph helper, `turbo` field, the
   Turbo row, slider zone, the MOSS code default; remove the hard-coded map.

Tests: schema refinement (required bands under `turbo`, cleared input refused);
the service's type and ecosystem assertions; the picker's filter wire and version
narrowing; `transformGenerationData` forwards the blocks; the helper's precedence
and scope segments; `turbo` default resolution and the `correct` that rejects an
unflagged LoRA; the MOSS turbo suite rewritten against the `turbo` field.

## Closing conditions

- On prod, the MOSS Turbo picker offers only flagged LoRAs, starts on the SFT
  8-step LoRA for SFT and community checkpoints and on Base's own for Base, and
  turning it on sets that LoRA's steps and CFG and paints the zone.
- Changing the ecosystem default is a constants change plus deploy; one
  checkpoint's default is a version edit. This amends the earlier "no deploy"
  closing condition, and whoever closes that task should say so.
