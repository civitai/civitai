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
src/components/Generation/Form/
└── GenForm.tsx                     # Form wrapper with queue validation

src/components/Generation/Alerts/
└── WhatIfAlert.tsx                 # Error display for whatIf queries

src/components/ImageGeneration/GenerationForm/
├── InputQuantity.tsx               # Quantity input component
└── BaseModelSelect.tsx             # Base model selector modal
```

### Stores

```
src/store/
└── generation-form.store.ts        # UI preferences (media type, engine selection)
```

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

These are temporary hooks in shared code that should be removed with the legacy generator:

```
src/store/generation-graph.store.ts
```
- `syncLegacyFormStore()` — called from `setData` to sync the legacy form store (type, engine) whenever graph data changes. Remove this function and its call when the legacy generator is removed.

---

## Files That Should NOT Be Removed

These are shared infrastructure used by both old and new generators:

```
src/store/generation-graph.store.ts          # Shared data store
src/store/remix.store.ts                     # Remix tracking
src/server/services/orchestrator/legacy-metadata-mapper.ts  # Data conversion utils
```

---

## Removal Checklist

When removing legacy generator support:

1. [ ] Remove legacy form files from `src/components/ImageGeneration/GenerationForm/`:
   - `GenerationFormLegacy.tsx`
   - `GenerationForm.tsx`
   - `GenerationFormProvider.tsx`
   - `GenerationForm2.tsx`
   - `GenerationForm2.module.scss`
   - `GenerationForm2.module.scss.d.ts`
   - `TextToImageWhatIfProvider.tsx`
2. [ ] Remove `src/components/Generation/Video/` directory
3. [ ] Remove `src/components/Generation/Form/GenForm.tsx`
4. [ ] Remove `src/components/Generation/Alerts/WhatIfAlert.tsx`
5. [ ] Remove `src/components/ImageGeneration/GenerationForm/InputQuantity.tsx`
6. [ ] Remove `src/components/ImageGeneration/GenerationForm/BaseModelSelect.tsx`
7. [ ] Remove `src/store/generation-form.store.ts`
8. [ ] Revert `steps` addition in `generation.schema.ts` (if not needed)
9. [ ] Remove `imageUpload` route from `orchestrator.router.ts` (if not needed elsewhere)
10. [ ] Remove `syncLegacyFormStore` and its call from `generation-graph.store.ts`
11. [ ] Update any imports/references to removed components

---

## Date Added

Files added: 2026-02-05
