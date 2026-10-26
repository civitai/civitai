# Preset generation: read sizes from the graph

> **Status: planned, not started.**
>
> **Closes when** `grep -rnE "pickAspectRatioSize|PRESET_MODEL_GRAPH_SIZES" src` matches only
> `src/shared/generation/preset-sizes.ts` and its test, `PresetModelConfig` in
> `src/server/services/orchestrator/preset-image-gen.service.ts` has no `sizes` field, and a unit
> test proves a comics panel's stored `width`/`height` equal the graph's resolved output for the
> same input. Checked by the CI of the PR that does it; until that merges, this file is the tracker.

## Problem

The preset layer (comics, iterate) composes a graph input server-side, but keeps its own copy of
what the graph will do with it:

- `PresetModelConfig.sizes` lists the dimensions each model produces for an aspect-ratio label.
  It is built from the graph files' exported lists (`src/shared/generation/preset-sizes.ts`), at
  the resolution the preset asks for.
- `pickAspectRatioSize` resolves a label to one of those sizes with the graph's own rule
  (`resolveAspectRatioLabel` in `src/shared/form-graph/generation/defs.ts`).
- `PresetModelConfig.resolution` tells the graph which resolution to use, so that `sizes` and the
  image agree.

Three things have to stay in step for a stored panel to describe its image: the registry's list,
the registry's resolution, and the graph's default for that version. Each has drifted once already
(Seedream listed 2K while its versions generated 4K; the label parser snapped differently in the
two places; the record was made against the picker's subset rather than the graph's list). Tests
pin each pair; this plan removes the pairs the server holds, not the picker's.

## What the registry actually needs to hold

Product choices only, the things no graph can know:

| Field | Why it stays |
| --- | --- |
| `versionId`, `img2imgVersionId` | Which version a comics option means, and its edit variant |
| `resolution` | The resolution comics generates at, where the graph's default is not it |
| `engine`, `baseModel`, `ecosystem` | Stored on panel metadata; `ecosystem` routes the graph input |
| `maxReferenceImages` | The graph's cap varies by version (Qwen, Grok), so deriving it needs the resolved `images` field; a later step |

Everything else is derivable from the graph for the input the preset sends.

## Plan

1. **Expose the resolved output.** `validateInput` in
   `src/server/services/orchestrator/orchestration-new.service.ts` is the one validation choke
   point (submit, what-if and `createWorkflowStepsFromGraphInput` for App Blocks all call it) and
   returns the graph's resolved data, which carries `aspectRatio: { value, width, height }`. Add a
   service function beside `submitPresetImageGen` that builds the preset input, runs the generation
   context and `validateInput`, and returns `{ input, width, height }` without submitting. Submit
   and what-if call it so the three never diverge. `createWorkflowStepsFromGraphInput` is not
   enough on its own: it returns steps, not the resolved aspect ratio.
2. **Record from it.** `getAspectRatioDimensions` in `src/server/routers/comics.router.ts` and the
   `pickAspectRatioSize` call in `src/server/routers/orchestrator.router.ts` read the width and
   height from that result. The comics default-size call sites (the ones that pass
   `DEFAULT_ASPECT_RATIO` for a placeholder panel) resolve the default label the same way.
3. **Delete the copies.** `PresetModelConfig.sizes`, `pickAspectRatioSize`, and in
   `preset-image-gen.surface.test.ts` the registry-parity, size-table and resolution-tie tests.
   The Seedream 2K pin in `preset-sizes.test.ts` stays: the picker list and `resolution` remain a
   pair.
4. **Keep the client offer list.** `PRESET_MODEL_SIZES` in `src/shared/generation/preset-sizes.ts`
   stays: the comics picker needs the options client-side, and a server round trip per model
   change is not worth it. `PRESET_MODEL_GRAPH_SIZES` stays as its private source, no longer
   exported, so the subset test has a graph list to check against. The subset rule (`offered`) and
   `defaultPresetRatio` are comics product choices and stay with it.
5. **Optionally** take `maxReferenceImages` from the resolved `images` field (its cap varies by
   version for Qwen and Grok, so read the resolved graph, not the field definition), which would
   drop the last derivable field.

## Risks

- `validateInput` needs a generation context, which is async and user-scoped. The comics router
  records dimensions before it fetches the orchestrator token; step 1 moves the context build
  ahead of the record, which is a reorder, not new work.
- A graph that refuses the input (a gated version, a blocked prompt) now refuses before the panel
  row exists rather than after. That is the better order, but the error path in the router changes.
- The placeholder-panel call sites resolve a label with no user prompt; the resolve step must
  accept an empty prompt, as `buildPresetGraphInput` already does for what-if.
