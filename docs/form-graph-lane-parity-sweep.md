# form-graph lane parity sweep — 2026-09-23

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

### 5. `ResourceAlerts` is missing from the audio and 3D bodies

v2 renders it once for every output type, because it has one body. The form-graph lane mounts it in
`ImageGenerationForm.tsx:116` and `VideoGenerationForm.tsx:135` only, so unstable and
content-restricted resource warnings do not appear on audio or 3D. `GateRuleWarnings` *is* on all
four.

*Closes when:* all four bodies mount `ResourceAlerts`, or it moves up into `BaseGenerationForm`.

### 6. `MissingPreprocessorExamplesAlert` is not rendered

Moderator-only alert flagging preprocessors with no example output — i.e. ones likely failing on the
orchestrator. v2: `GenerationForm.tsx:776`. The form-graph lane renders `PreprocessorExamples` and
`PreprocessKindParamsInput` but not this.

*Closes when:* the alert appears on `img2img:preprocess` for a moderator in both lanes.

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

Findings **3** (needs a decision on silent redirect vs confirm modal), **5**, **6** and **7**. None
blocks widening the flag; 5 and 6 can ride any later commit and 7 is latent until Veo ships a second
API version.

`src/components/form-graph/generation/__tests__/lane-parity.test.ts` guards the three fixed findings
by reading both lane entry files — the defect class is "the call site is absent in one lane", which
source can answer, and rendering either lane needs its whole provider stack. Mutation-checked:
deleting `useGenerationTour()` from `BaseGenerationForm` fails it by name.
