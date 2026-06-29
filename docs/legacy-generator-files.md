# Legacy Generator Files

This document tracks all files added to support the legacy generator forms. These files can be removed once the transition to the new data-graph based generator is complete.

## Overview

The legacy generator uses:
- `generation-graph.store.ts` for incoming data (shared with new generator)
- `legacy-metadata-mapper.ts` to convert between formats
- `generateFromGraph` / `whatIfFromGraph` routes for submission

---

## Files to Remove

### Image Generation - Legacy Form

```
src/components/ImageGeneration/GenerationForm/
├── GenerationFormLegacy.tsx       # Re-export wrapper (entry point)
├── GenerationForm.tsx             # Combined image/video form with toggle
├── GenerationFormProvider.tsx     # Form context with legacy data mapping
├── GenerationForm2.tsx            # Full image form UI (~2700 lines from civitai)
├── GenerationForm2.module.scss    # Styles for GenerationForm2
├── GenerationForm2.module.scss.d.ts  # TypeScript declarations for styles
└── TextToImageWhatIfProvider.tsx  # Cost estimation provider
```

### Video Generation

```
src/components/Generation/Video/
├── VideoGenerationProvider.tsx     # Video engine state management
├── VideoGenerationFormWrapper.tsx  # Engine selection UI
├── VideoGenerationForm.tsx         # Main form with graph routes
├── ViduFormInput.tsx
├── HunyuanFormInput.tsx
├── KlingFormInput.tsx
├── MinimaxFormInput.tsx
├── HaiperFormInput.tsx
├── MochiFormInput.tsx
├── LightricksFormInput.tsx
├── Ltx2FormInput.tsx
├── Veo3FormInput.tsx
├── SoraFormInput.tsx
└── WanFormInput/
    ├── WanFormInput.tsx
    ├── Wan21FormInput.tsx
    ├── Wan22FormInput.tsx
    ├── Wan25FormInput.tsx
    └── Wan225bFormInput.tsx
```

### Supporting Components

```
src/components/ImageGeneration/GenerationForm/
├── InputQuantity.tsx               # Quantity input component
└── BaseModelSelect.tsx             # Base model selector modal
```

> `GenForm.tsx` and `WhatIfAlert.tsx` were removed along with the legacy enhancement
> modals (see "Legacy enhancement modals" below). `generation-form.store.ts` is **kept** —
> it's now shared infra (the v2 `FormFooter` reads `buzzType` from it).

### Legacy enhancement modals

Removed once the legacy form was gone — they were only reachable when
`useLegacyGeneratorStore.useLegacy` was true, and now everyone routes through the
in-form enhancement flow (`applyWorkflowWithCheck` in `useGeneratedItemWorkflows.ts`):

```
src/components/Orchestrator/components/UpscaleImageModal.tsx
src/components/Orchestrator/components/UpscaleVideoModal.tsx
src/components/Orchestrator/components/BackgroundRemovalModal.tsx
src/components/Orchestrator/components/VideoInterpolationModal.tsx
src/components/Generation/Form/GenForm.tsx          # only used by those modals
src/components/Generation/Alerts/WhatIfAlert.tsx    # only used by those modals
src/components/Generation/Input/SourceImageUpscale.tsx  # only used by UpscaleImageModal
src/store/legacy-generator.store.ts                 # only consumer was the modal branch
```

Also dropped: the `ModalSubmitButton` export in `Orchestrator/components/GenerateButton.tsx`
and the modal-handler block (`MODAL_WORKFLOWS` / `shouldOpenModal` / `openEnhancementModal`)
in `useGeneratedItemWorkflows.ts`.

---

## Modified Files

These files were modified and may need changes reverted:

### Schema Changes

```
src/server/schema/generation.schema.ts
```
- Added `steps` to `generationLimitsSchema`
- Added `steps` to `defaultsByTier` for all tiers

### Router Changes

```
src/server/routers/orchestrator.router.ts
```
- Added `imageUpload` route import
- Added `imageUpload` mutation endpoint

---

## Temporary Legacy Sync in Shared Files

~~`syncLegacyFormStore()` in `src/store/generation-graph.store.ts`~~ — **removed.** Along
with it: `isNewFormOnly` / `NEW_FORM_ONLY` in
`src/shared/data-graph/generation/config/workflows.ts` (its only consumer) and the
legacy-sync mocks in `generation-graph.store.test.ts`.

---

## Files That Should NOT Be Removed

These are shared infrastructure used by both old and new generators:

```
src/store/generation-graph.store.ts          # Shared data store
src/store/generation-form.store.ts           # UI prefs (buzzType) — read by v2 FormFooter
src/store/remix.store.ts                     # Remix tracking
src/server/services/orchestrator/legacy-metadata-mapper.ts  # Data conversion utils
```

---

## Removal Checklist

Most of this was completed by commit `cd6e16196` (legacy form + orphaned code) and a
follow-up that removed `syncLegacyFormStore`. Remaining state:

1. [x] Remove legacy form files from `src/components/ImageGeneration/GenerationForm/`:
   `GenerationFormLegacy.tsx`, `GenerationForm.tsx`, `GenerationFormProvider.tsx`,
   `GenerationForm2.tsx`, `GenerationForm2.module.scss(.d.ts)`, `TextToImageWhatIfProvider.tsx`
2. [x] Remove `src/components/Generation/Video/` directory
3. [x] Remove `InputQuantity.tsx` and `BaseModelSelect.tsx`
4. [x] Remove `syncLegacyFormStore` + `isNewFormOnly`/`NEW_FORM_ONLY` and update references
5. [x] Remove the legacy enhancement modals + `GenForm.tsx` / `WhatIfAlert.tsx` /
   `SourceImageUpscale.tsx` / `legacy-generator.store.ts` and the modal branch in
   `useGeneratedItemWorkflows.ts` (see "Legacy enhancement modals" above)
6. [~] `generation-form.store.ts` — **kept**, now shared infra (v2 `FormFooter` reads `buzzType`)
7. [ ] Revert `steps` addition in `generation.schema.ts` (if not needed)
8. [ ] Remove `imageUpload` route from `orchestrator.router.ts` (if not needed elsewhere)

---

## Date Added

Files added: 2026-02-05
