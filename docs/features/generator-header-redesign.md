# Generator header redesign — form-graph lane only

Implements the ["Above the Prompt"](https://claude.ai/code/artifact/01a73589-85d1-4e87-bdc2-b389579d1294)
proposal, scoped to the **form-graph** generation forms. `GenerationFormV2` (the data-graph lane) and
every other `ResourceSelectModal` consumer keep today's behaviour.

## Why this scope is safe

`GenerationTabs` mounts `FormGraphGenerator` when `formGraphGenerator` is on and `GenerationFormV2`
otherwise. That flag is `availability: ['mod']`, so the redesigned header ships to moderators only
until it is widened — the rollout gate already exists and needs nothing new.

## The seam

Three kinds of code are involved, and they get different treatment:

| Layer | Files | Treatment |
|---|---|---|
| Shell / header | `src/components/form-graph/generation/BaseGenerationForm.tsx` | Already form-graph-local. Edit freely. |
| Header inputs | `generation_v2/inputs/WorkflowInput`, `BaseModelInput` | **Fork** into `form-graph/generation/inputs/`. Shared with the v2 lane; the redesign changes their contract, not their styling. |
| Picker internals | `ImageGeneration/GenerationForm/ResourceSelect*` | **Extend additively.** Shared with App Blocks, Challenge, Apps settings, wildcards, `Resource/Files`. New props default to today's behaviour. |

The picker internals are the expensive half to rebuild and the ones the proposal explicitly wants to
keep (catalog query, cards, filters, infinite list). Forking them would double the surface that has to
stay correct; forking the two header inputs costs ~1.7k lines of divergence that dies when the v2 lane
does.

## Decisions taken (the artifact's three open questions)

1. **Version is a step after the pick.** Picking a model takes its latest version immediately; version
   becomes a field under the model row, rendered only when more than one exists. `VersionGroupSelector`
   in `form-graph/generation/form-helpers.tsx` is already form-graph-local and already renders under the
   model row — it stays, and the in-card segmented control stops being the mechanism. This absorbs the
   hierarchical case rather than leaving it parallel.
2. **The rail replaces the pill.** `BaseModelInput` comes out of the header entirely in the form-graph
   lane. Keeping both would put one axis in two places, which is the problem this started from.
3. **Input switching costs a click.** The mode strip folds into the workflow picker as a filter. No
   telemetry gate first — the lane is mod-only, so the click cost is observable directly by the people
   who can undo it.

## Phases

All four are implemented. Ordering below is the order they landed, not a remaining plan.

### 01 — Fold the mode strip into the workflow picker
- New `form-graph/generation/inputs/WorkflowPicker.tsx`: every workflow listed once, input type
  (`from text` / `from image` / `from video`) shown per row, with an All / From-text / From-image
  filter across the top.
- `BaseGenerationForm.tsx`: drop the `ButtonGroupInput` mode strip and its `getWorkflowModes()` call.
- `getWorkflowModes` stays exported (the v2 lane still uses it); only the form-graph call site goes.

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

### 04 — The rail and the consequence footer
- Ecosystem selection moves into the picker as a left rail with search, replacing `BaseModelInput` in
  the form-graph header. **No output-type scope control in the rail** — `BaseModelListContent` already
  carries its compatible/recent/all tabs, and two scope controls is the duplication being removed.
- The footer counts the resources a switch will actually drop, by real compatibility check, while the
  choice is still cancellable — `ResourceAlerts` information, moved before the commit.
- These two ship together: the point of moving the control is making the switching cost visible at the
  moment of switching.
- Mobile splits the panes into two screens and opens on the **catalog**, not the ecosystem list.
- Cards get no "picked" check overlay and no Early Access badge; the mode strip's `modeLabel` copy
  ("Text to Image") stops rendering in this lane — the picker shows the workflow `label` plus a
  per-row input line instead.

## How the rail reaches the catalog

The shared modal gained two slots — `rail` and `footer` — typed as components, not nodes, so they
render inside `ResourceSelectProvider` and can call `setOptionsOverride`. The modal itself contains
no ecosystem concept; `openCheckpointPicker` in the form-graph lane fills both slots.

Selecting in the rail is a **pending** choice: it re-aims the catalog at that family via
`getResourceSelectOptions(ecosystemKey, types)` (pure, keyed by ecosystem, so no store write is
needed to preview a family) and the footer counts what a commit would drop. It commits when you press
Use, or when you pick a checkpoint — the latter writes the ecosystem first so the model write is the
one that survives reconciliation.

Pending state lives in `checkpoint-picker.store.ts` because the rail and footer render into two
different slots and have no common ancestor to hold it.

## Not in scope

The v2 lane, App Blocks' checkpoint/resource pickers, the Challenge multi-select, wildcard sets, and
`Resource/Files`. Everything below the prompt (Compose, Output, Tuning) is untouched.
