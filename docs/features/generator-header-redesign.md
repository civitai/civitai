# Generator header redesign — form-graph lane only

Implements the ["Above the Prompt"](https://claude.ai/code/artifact/01a73589-85d1-4e87-bdc2-b389579d1294)
proposal, scoped to the **form-graph** generation forms. `GenerationFormV2` (the data-graph lane) and
every other `ResourceSelectModal` consumer keep today's behaviour.

> **Header fully reverted (2026-09-23).** Decisions 2 and 3 and phases 01 and 04 are undone — the
> form-graph header is now `generation_v2`'s `WorkflowInput` beside `BaseModelInput`, with
> `SelectedWorkflowDisplay` and the `getWorkflowModes` mode strip beneath, the same as the data-graph
> lane. `WorkflowPicker` and its browser test are deleted; `workflow-visibility.ts` stays, since
> `WorkflowInput` was moved onto it.
>
> The flat list was the reason: it showed every workflow regardless of ecosystem, so `img2img`
> ("Image Variations", SD-family only) appeared while Qwen 2.1 was selected, badged "Switches model".
> The mode strip is ecosystem-filtered, so it offers only the keys the current ecosystem supports.
>
> Decision 2 and phase 04 were undone earlier (2026-09-16): testers found family switching took extra
> steps. The model field is `ResourceSelectInput` with no `role` — so its cards show the in-card
> version dropdown again, alongside `VersionGroupSelector` (decision 1 now only half holds).
> `role: 'checkpoint'`, the modal's `rail`/`footer` slots, `PickerRail` and `setOptionsOverride` were
> removed with it. Phases 02–03 stand.

## Why this scope is safe

`GenerationTabs` mounts `FormGraphGenerator` when `formGraphGenerator` is on and `GenerationFormV2`
otherwise. That flag is `availability: ['mod']`, so the redesigned header ships to moderators only
until it is widened — the rollout gate already exists and needs nothing new.

## The seam

Three kinds of code are involved, and they get different treatment:

| Layer | Files | Treatment |
|---|---|---|
| Shell / header | `src/components/form-graph/generation/BaseGenerationForm.tsx` | Already form-graph-local. Edit freely. |
| Header inputs | `generation_v2/inputs/WorkflowInput`, `BaseModelInput` | Both used as-is from `generation_v2` — the `WorkflowPicker` fork is gone. |
| Picker internals | `ImageGeneration/GenerationForm/ResourceSelect*` | **Extend additively.** Shared with App Blocks, Challenge, Apps settings, wildcards, `Resource/Files`. New props default to today's behaviour. |

The picker internals are the expensive half to rebuild and the ones the proposal explicitly wants to
keep (catalog query, cards, filters, infinite list). Forking them would double the surface that has to
stay correct.

## Decisions taken (the artifact's three open questions)

1. **Version is a step after the pick.** Picking a model takes its latest version immediately; version
   becomes a field under the model row, rendered only when more than one exists. `VersionGroupSelector`
   in `form-graph/generation/form-helpers.tsx` is already form-graph-local and already renders under the
   model row — it stays, and the in-card segmented control stops being the mechanism. This absorbs the
   hierarchical case rather than leaving it parallel.
2. **~~The rail replaces the pill.~~** Reverted — see the note at the top.
3. **~~Input switching costs a click.~~** Reverted — see the note at the top.

## Phases

Phases 02–03 are implemented. 01 and 04 were implemented and then removed.

### 01 — Fold the mode strip into the workflow picker (removed)
One flat workflow list with an input-type filter, in place of the four-segment picker and the mode
strip. Shipped and removed 2026-09-23; see git history before that date.

### 02 — Teach the picker its role
- `ResourceSelectProvider` gains `role?: 'checkpoint' | 'resource'` (default `undefined` = today).
- In `resource` mode: per-card compatibility badging against the current checkpoint's ecosystem,
  multi-select, and a footer tray that stages a batch. **Per-item strength is NOT edited in the tray**
  — the form's own resource list already owns strength, and a second control for one value is the
  duplication this redesign removes.
- The `resource` role has **no rail**. One was built — the picker's resource types, promoted out of
  the filters dropdown — and removed again: it was a second control writing the same `filters.types`
  the dropdown owns, with different semantics (rail single-select, dropdown multi-select), so the two
  could disagree about what was selected. A rail now means the catalog's SCOPE is selectable, and its
  absence means the catalog is already scoped and the toolbar narrows it.
- The modal's LAYOUT changed for **every** consumer, not only the roled ones: the header band spans
  the full width, rail beside catalog, footer spans, width 1200 → 1500, and the grid fills its pane
  instead of centring fixed-width columns. Behaviour without a `role` is unchanged; the shared chrome
  is not.

### 03 — Catalog or roster
- `ResourceHitList` branches on catalog size. Hosted providers (Kling, Veo, Sora, ACE, Hunyuan3D)
  render a version roster instead of a search grid; search, sort and filters hide rather than sitting
  dead. **No price column** — `TransformedModel` carries no cost data, so "N per second" is deferred
  rather than faked.

### 04 — The rail and the consequence footer (removed)
Ecosystem rail and consequence footer in the checkpoint picker. Shipped and removed 2026-09-16; see git
history before that date.

## What is left

Phases 02 and 03 — the picker's `resource` role (compatibility badging, multi-select, the staging
tray) and the catalog-or-roster branch — plus the shared modal chrome those landed with. The header
itself is back to the data-graph lane's.

## Not in scope

The v2 lane, App Blocks' checkpoint/resource pickers, the Challenge multi-select, wildcard sets, and
`Resource/Files`. Everything below the prompt (Compose, Output, Tuning) is untouched.
