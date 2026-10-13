# form-graph lane parity sweep — 2026-09-23

> **Decided and executed (`feat/remove-data-graph`).** `GenerationFormV2` and the whole data-graph
> lane are deleted. Everything below is the record of the read-across that supported that decision —
> the lane comparison, the shadow-parse divergence analysis and the Phase 6 sizing are history and
> are not re-checkable. Two findings outlived the sweep and are still open; they are restated at the
> top of "What is left".

A read-across of the two generation form lanes, to decide whether `GenerationFormV2` (the data-graph
lane) can be retired. Run after the header revert of the same date (see
[`features/generator-header-redesign.md`](features/generator-header-redesign.md)), which put the
form-graph header back on `WorkflowInput` + `SelectedWorkflowDisplay` + the `getWorkflowModes` strip.

**Scope:** UI and behaviour only. Graph/parse parity is pinned by the differential suites in
`src/shared/form-graph/generation/__tests__/` and is not re-checked here — see
[`form-graph-port-plan.md`](form-graph-port-plan.md) §7.

**Lanes compared**

| | data-graph | form-graph |
|---|---|---|
| Entry | `generation_v2/GenerationForm.tsx` (2,951 lines, one body) | `form-graph/generation/BaseGenerationForm.tsx` + four per-output bodies |
| Footer | `generation_v2/FormFooter.tsx` | `form-graph/generation/FormFooter.tsx` (shares the v2 buzz selector and metadata footer) |
| Provider | `GenerationFormProvider.tsx` | `BaseGenerationForm` owns the store |

**Method.** Three passes: the set of `<Controller name=…>` keys in each lane (104 vs 98); the set of
imported modules by basename, footers and providers included; then each difference chased to whether
it is a missing feature, a different implementation of the same feature, or dead code on the v2 side.

---

## Gaps — the form-graph lane does not do this

Ordered by user impact. Each closes when the named check passes on the form-graph lane with
`formGraphGenerator` on.

**1, 2 and 4 were fixed on 2026-09-23, in the commit that carries this sweep.** They are kept below
with what was done, because the fixes are what the next sweep checks against.

### 1. The content-generation tour never runs — FIXED

`GenerationForm.tsx:267-320` owns both tour effects — `runTour({ key: remixOfId ?
'remix-content-generation' : 'content-generation' })` and the step-filtering effect that cuts the
step list on `hasGeneratedImages`, sign-in state and `review-generation-terms`. Neither exists
anywhere in `src/components/form-graph/`, and `FormGraphGenerator.tsx` is 37 lines of mount.

Every step target the tour names already resolves on this lane — `gen:submit` and `gen:buzz` from
its own footer, `gen:terms` from the shared `GenerationLayout`, `gen:prompt` from
`PromptEditorShell` (which carries the attribute itself), and `gen:start`/`gen:queue`/`gen:feed`/
`gen:select`/`gen:post`/`gen:remix` from the shared `GenerationTabs` chrome. Only the start was
missing.

**Fix:** the two effects moved verbatim into `generation_v2/hooks/useGenerationTour.ts` and both
lanes call it. They read only generator readiness — no form state — so nothing had to be
reimplemented per lane. `tour-steps.test.ts`'s source guard follows the code to the hook.

### 2. Neither header control shows compatibility — FIXED

`WorkflowInput`'s `isCompatible` and `BaseModelInput`'s `isCompatible`/`getTargetWorkflow` are
optional and both default to "everything is compatible" (`isCompatible?.(id) ?? true`). The
form-graph lane passes none of them, so the incompatible-option styling and the
`Will switch to <workflow>` badge (`BaseModelInput.tsx:386-390`) never render, and
`BaseModelInput`'s last-used/default ecosystem resolution (`:759-776`) picks without the
compatibility filter.

Half of this pre-dates today: `BaseModelInput` has been wired without those props since the
2026-09-16 restore. The other half is new — `WorkflowPicker` had its own "Switches model" badge, and
removing it left the lane with no compatibility affordance on either control.

**Fix:** `GenerationFormBody` calls `useCompatibilityInfo({ workflow, ecosystem })` — a pure
`useMemo` over values it already reads — and passes `isCompatible` to `WorkflowInput` and
`isCompatible`/`getTargetWorkflow` to `BaseModelInput`, as v2 does. Display and selection only;
the modal decision in finding 3 is untouched.

### 3. `openCompatibilityConfirmModal` is not on the direct-selection path

Known and recorded in the port plan; restated here because it is the behavioural half of finding 2.
The form-graph lane opens the modal only from `ingestion.ts:242,374` (remix / preset apply). A
direct workflow or ecosystem pick sets the value and lets `reconcile.ts` redirect silently, where v2
asks first (`GenerationForm.tsx:366-420`).

This is a **decision, not a defect**: silent redirect may be the better behaviour now that coherence
is redirect-only. It needs to be made rather than inherited.

*Closes when:* Briant states which behaviour ships, and the lane matches that statement.

### 4. Three ecosystem alerts are not rendered — FIXED

All three are exported components the form-graph lane simply never mounts; none is in the shared
`GenerationLayout`.

| Alert | v2 site | What it says |
|---|---|---|
| `GrokEcosystemAlert` | `GenerationForm.tsx:716-721` | Grok terms notice, keyed on ecosystem |
| `SeedanceImg2VidAlert` | `:723-730` | Seedance img2vid copyright-filter warning |
| `ReadyAlert` | `:783` | "Potentially slow generation" — resources still downloading (reads `whatIf.ready === false`) |

`ReadyAlert` is a separate export from `ResourceAlerts.tsx`; mounting `ResourceAlerts` does not
bring it.

**Fix:** all three mount in `BaseGenerationForm`'s standard-workflow branch — one site, ahead of the
per-output body, so audio and 3D are covered too. Grok and Seedance self-gate on ecosystem/workflow,
so a single mount is correct for every output type.

`ReadyAlert` needed a change to be mountable at all: it read `useWhatIfContext`, and the two lanes
have **separate** WhatIf contexts, so the v2 component would have thrown inside the form-graph tree.
It now takes `ready`/`isLoading` as props, and each lane wraps it in a two-line `ConnectedReadyAlert`
reading its own context. (`ResourceAlerts` itself never touched the context, which is why it already
worked on both lanes.)

### 5. `ResourceAlerts` is missing from the audio body — FIXED (3D was not a gap)

v2 renders it once for every output type, because it has one body. The form-graph lane mounted it in
`ImageGenerationForm.tsx` and `VideoGenerationForm.tsx` only, so unstable and content-restricted
resource warnings did not appear on audio. `GateRuleWarnings` *is* on all four.

**Only three of the four bodies can report anything, so "all four" was the wrong target.** Counting
`.field(...)` declarations per hub: image has `model`/`resources`/`vae`, video has
`model`/`resources`, audio has `model` alone, and **model3d declares none of the three**. So audio
now mounts it on the checkpoint alone (`ResourceAlerts` tolerates `resources`/`vae` undefined —
`getSelectedResources` takes all three optionally), and 3D deliberately does not: there is no resource
field for the alert to read, so a mount there is dead UI. That also rules out moving it up into
`BaseGenerationForm`, which cannot name fields the 3D hub does not declare.

### 6. `MissingPreprocessorExamplesAlert` is not rendered — FIXED

Moderator-only alert flagging preprocessors with no example output — i.e. ones likely failing on the
orchestrator. v2 mounts it inside the `preprocessKind` controller; the form-graph lane rendered
`PreprocessorExamples` and `PreprocessKindParamsInput` but not this.

**Fix:** it takes no props and self-gates on `isModerator` plus a non-empty
`getPreprocessKindsMissingExamples()`, so it mounts beside `PreprocessorExamples` in
`ImageGenerationForm`, matching the v2 site.

### 7. The Veo 3 `version` radio has no control — latent

`veo3.graph.ts:93` declares `version` with `meta.options`, and nothing in the form-graph lane renders
it. Invisible today: `veo3ApiVersions` is `['3.1']`, one option, and v2's control hides itself below
two (`GenerationForm.tsx:645`). It becomes a real gap the day a second Veo API version lands.

*Closes when:* a second entry in `veo3ApiVersions` produces a radio group in both lanes — or the
field is removed.

---

## Not gaps

Chased and cleared, recorded so the next sweep does not re-chase them.

- **`key`, `language`, `timeSignature`** — v2 renders three `TextInput` Controllers for these
  (`GenerationForm.tsx:2515-2557`) and **no graph in `src/shared/data-graph/generation/` declares
  any of them**. Dead controls that render nothing; they die with v2. Nothing to port.
- **`PromptInput`** — imported at `GenerationForm.tsx:90`, zero usages in the file. Dead import.
- **`klingElements`, `multiShot`** — dead in v1 and deliberately not ported; see the kling row of
  the port plan's family checklist.
- **`triggerWords`** — v2 renders `TriggerWordsStrip` from a dedicated Controller; the form-graph
  lane gets the same strip through `PromptEditorShell`, which renders it internally. Same output,
  less plumbing.
- **`output`** — a wrapper Controller in v2 gating the Output Settings group. The form-graph lane
  uses the `useOutputType(store)` computed and renders `outputFormat` + `priority` in
  `ImageGenerationForm`. Equivalent.
- **`quantity`** — rendered in v2's footer, in the form-graph body. Present in both.
- **`useGeneratedItemWorkflows`, `useGenerationFormValue`, `BuzzTypeSelector`,
  `MetadataExtractionFooter`, `useSelfHostedBlock`** — all in shared or bridge-based code the
  form-graph lane imports from `generation_v2`. `useSelfHostedBlock` says so in its own comment.
- **`useSourceImageAnnotations` + the `ImageMetadataModal` apply flow** — fully ported into
  `form-graph/generation/inputs/SourceImagesInput.tsx`, including `canApply`, `onAddResource` and
  the resource limit check.

## The other direction

`audioSetting` (HappyHorse `vid2vid:edit`) is declared in `happy-horse-graph.ts:175` and has **no
control in v2** — the form-graph lane renders it. The lane is not a strict subset.

---

## Scope beyond the form: what retiring the lane actually touches

**(Historical — this is the sizing that `feat/remove-data-graph` executed against.)**

`grep -rln "libs/data-graph\|shared/data-graph/generation" src` outside the graph directories
themselves: **175 files**.

- **88** bind the engine or a `*-graph` module. Most are the v1 handler lane
  (`server/services/orchestrator/ecosystems/*.handler.ts`), which already has a ported twin under
  `orchestrator/form-graph/`.
- **58** import only `config/`, `gates.ts` or `context.ts` — the modules the port plan says survive.
  They need a path move, not a rewrite.
- Four client files outside both lanes still reach into the engine, three of them dual-lane shims
  built to collapse: `useSnippetsGraph.ts`, `useGenerationFormBridge.ts`,
  `GenerationTextEditor.tsx` (type-only) and `triggerPromptEnhance.ts` (type-only).
- Three server-side helper modules live under `shared/data-graph/generation/` but are not graphs and
  are imported by App Blocks: `workflow-capability.ts`, `model-substitution.ts`, `images-limit.ts`
  (`server/services/blocks/workflow.service.ts:15-21`). They move with `config/`.

## What is left

Still open, and now the only live items in this file:

- **Finding 3** — needs a decision on silent redirect vs confirm modal.
- **Finding 7** — the Veo 3 `version` field has no control; latent until `veo3ApiVersions` has a
  second entry. *Closes when:* a second entry produces a radio group, or the field is removed.

Everything after this paragraph concerns the shadow comparison, which was deleted with the lane.

Bigger than either, and not a form gap — though the largest class of it is now addressed: the shadow comparison
(`orchestrator/form-graph/shadow-parse.ts`) is not at zero, which is the counter's own stated
criterion for widening. Over the 7 days to 2026-09-29, `civitai-prod` logged 1,451 divergences —
1,010 `success-disagreement` and 441 `data-keys` — all one-directional, the hub accepting what v1
rejects and never the reverse. 984 of the disagreements are `errorKeys: ["ecosystem"]` on
`txt2img`; the largest field class is a single field, `snippets` (265). Axiom only receives
non-matches, so there is no denominator here — the match count is in Prometheus.

**The `ecosystem` class was a correction-placement difference, not a lost gate.** Both engines carry
the identical output refusal for a hidden/disabled ecosystem. What differed is where the
workflow-incompatible REDIRECT happens: v1 used an effect keyed on `workflow`, and
`data-graph.ts` skips an entry unless one of its deps is in the changed set — so a one-shot parse
supplying `ecosystem` without `workflow` skipped the redirect (and, at `:1963`, the input
transform) and failed validation. The hub attached it to the field, so it runs on whatever the caller
sent. That placement is the better one and it stays; it now uses the lib's `correct` hook instead of
an `input` transform, which yields a `ResolutionNote` with a reason, and its fallback is
gate-aware (v1 chose from the usable set; `getDefaultEcosystemForWorkflow` is `ecosystemIds[0]`
and cannot see the gate). `shadow-parse` now carries those notes as `key:kind` labels — never
`detail`, which holds the values — so a divergence the hub EXPLAINS is separable from one it cannot.

Nothing here needed a change in the form-graph library: `correct` and `ValidationResult.notes`
already existed, and the app was using an `input` transform and discarding `result.notes`.

**The `data-keys` classes, worked through.** Of 441/week:

- **`snippets` (265) — a real hub bug, fixed.** v1 registers each text editor as a
  `snippets.targets` slice through an effect; the port bakes the set into the value instead, which
  is the better shape — but it did it in `coerce`, which the library runs for trusted `set()`
  writes only. So a parse that SUPPLIED a snippets value kept the caller's targets and registered
  no editors. A bare parse uses `default`, which already baked them, which is why it survived
  review. Now done on the `input` path as well.
- **Z-Image (28) and MageFlow (28) — closed by the ecosystem correction** moving onto the field.
  Both now match.
- **MiniMax (102) — the hub is right and v1 is wrong.** `ecosystemByKey.get('MiniMax')` is
  `undefined`: it is a legacy key predating the H3 rename, still arriving from stored client
  state. The hub drops an unknown key at the boundary so the default applies and the payload comes
  out complete; v1 keeps it and returns `aspectRatio`/`duration` undefined on a txt2vid submit.
  No hub change — but it means the CURRENT lane emits an incomplete payload for those users.
- ~32 remain across small per-workflow tails (img2img 10, img2vid:ref2vid 6, img2img:face-fix 5,
  img2vid 3, img2img:edit 2, a `duration`-only class 6). Not examined.

So the counter should not be read as "441 bugs": one class was a hub defect, two were fixed
upstream of it, and the largest remaining class is v1's. That is what the `corrections` labels in
`shadow-parse` exist to make legible without this kind of manual pass.

`src/components/form-graph/generation/__tests__/generation-form-mounts.test.ts` (renamed from
`lane-parity.test.ts` when the second lane was deleted) guards the five fixed findings by reading the
entry file plus the image and audio bodies for the two per-body mounts — the defect class is "the call
site is absent", which source can answer, and rendering the form needs its whole provider stack.
Mutation-checked: deleting `useGenerationTour()` from `BaseGenerationForm` fails it by name.
