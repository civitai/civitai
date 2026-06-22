---
name: add-training-support
description: Wire an existing ecosystem into the LoRA training system so it appears as a trainable base model in the training form. Adds the base-model entry, schema enums, orchestrator validation, feature flag, and per-ecosystem default params. Use when a model family (already in basemodel.constants.ts) needs training support — e.g. AI-Toolkit ecosystems like Anima, HiDream, Boogu. Always checks @civitai/client for the ecosystem's training input type first.
---

# Add Training Support

Wires an existing ecosystem into the **training** form (the "Train a LoRA" flow), distinct from the generation form. After this, the ecosystem shows up as a selectable base model in Training Step 1 and submits a valid `training` step to the orchestrator.

Training is a **separate subsystem from generation**. The generation handlers/graphs in `src/server/services/orchestrator/ecosystems/*` and `src/shared/data-graph/generation/*` are NOT part of this — do not touch them. The files below are the training path.

## When to use

- A new model family was just added via `add-ecosystem` and now needs to be trainable
- Re-enabling training for an ecosystem that was commented out
- The orchestrator/`@civitai/client` gained a new `*TrainingInput` type

## Prerequisites

The ecosystem, base model, family and license must already exist in
[basemodel.constants.ts](src/shared/constants/basemodel.constants.ts) (`ECO.<Name>`,
an `EcosystemRecord`, a `BaseModelRecord`). If any are missing, run **add-ecosystem** first.

Almost every ecosystem added recently is **AI-Toolkit-based** (engine `'ai-toolkit'`,
mandatory). The worked reference is **`anima`** — it is the simplest complete example
(image, AI-Toolkit-only, no `modelVariant`). The single highest-leverage move when adding
a new ecosystem: **grep every file below for `anima` and add a parallel entry.**

## Step 0 — Check `@civitai/client` for the training input type

**Always** confirm the SDK ships the ecosystem's training type before wiring. It tells you
the exact field shape, whether `modelVariant` is required, and any fixed fields.

```bash
grep -niE "<Name>AiToolkitTrainingInput|ecosystem: '<name>'" \
  node_modules/@civitai/client/dist/generated/types.gen.d.ts
```

Note from the type:
- **`ecosystem` literal** — the exact string the orchestrator expects (e.g. `'boogu'`).
- **`modelVariant`** — present (e.g. flux1 `'dev'|'schnell'`, wan `'2.1'|'2.2'`) or absent.
- **Fixed/constrained fields** — e.g. Boogu declares `batchSize?: null | number` "Fixed at 1
  for this ecosystem". Honor these in the UI param bounds.
- **`readonly` outputs** (`defaultSteps`, `storageBuzzPerEpoch`, `maxBatchSize`, …) — server-
  computed; never send them.

If the type is missing in the installed version, check the latest (`npm view @civitai/client
versions --json | tail`) and bump with `pnpm add @civitai/client@<v>`. If still absent, the
orchestrator dispatch (`training.orch.ts`) already casts `ecosystem as any`, so it works — but
prefer a typed SDK.

## Step 1 — Gather the ecosystem's training defaults

Get these from the user, the model card, or an orchestrator `whatif` sample request:

- **Default steps** (the AI-Toolkit primary length knob — drives pricing)
- **lr** (unet LR), whether the **text encoder** is trained (usually disabled)
- **networkDim / networkAlpha**, **lrScheduler**, **optimizerType**, **noiseOffset**
- **batch size** bounds (many AI-Toolkit image ecosystems are fixed at 1)
- **resolution** (image ecosystems are typically 1024)
- The **base-model AIR**. If the model isn't on civitai yet, use the HF repository URN from the
  sample as a placeholder and leave a comment to swap in
  `urn:air:<eco>:checkpoint:civitai:<modelId>@<versionId>` once uploaded. For AI-Toolkit-only
  ecosystems this AIR is NOT sent to the orchestrator (it resolves the base model from the
  ecosystem); it's used for UI display / `getTrainingFields.getModel`.

Pick a stable **base-model key** (the `trainingModelInfo` key, e.g. `boogu`) and a
**baseType** (the `TrainingBaseModelType`, e.g. `'boogu'`). They can differ (SD has
`sd_1_5`/`anime`/… keys all mapping to baseType `sd15`), but for a single-checkpoint
ecosystem keep them the same.

## Step 2 — Confirm the plan with the user

```
Adding training support for: <Name>  (baseType: <baseType>, key: <key>)
Engine: ai-toolkit (mandatory)   Variant: <none | enum>
Defaults: steps <n>, lr <n>, dim/alpha <n>/<n>, scheduler <x>, batch <n> (max <n>), res <n>
AIR: <placeholder|civitai urn>   Feature flag: <name>Training / <name>-training (Flipt)
```

Wait for confirmation, then make all edits in one pass.

## Step 3 — Edits

### 3a. `src/utils/training.ts` (the core — ~7 spots)

1. **`trainingBaseModelTypesImage`** (or `…Video` / `…Audio`) — add `'<baseType>'`.
2. **`aiToolkitStepDefault`** — add a branch returning the ecosystem's default steps if it
   differs from 2000.
3. **`aiToolkitBatchMax`** — add a branch only if max batch > 1 (default returns 1).
4. **`trainingModelInfo`** — add the `<key>: { label, pretty, type: '<baseType>', description,
   air, baseModel: '<BaseModelName>', isNew: true, aiToolkit: { ecosystem: '<eco>'
   [, modelVariant] } }` entry. `baseModel` MUST match the `BaseModelRecord.name` /
   ecosystem `key` in basemodel.constants.ts exactly (a mismatch produces a malformed AIR on
   training completion and fails the post-train scan with 400 — see the inline comment on the
   `hidream_o1` entry).
5. **`baseTypeToEcosystem`** — add `<baseType>: '<eco>'`.
6. **`isAiToolkitSupported`** `supportedTypes` — add `'<baseType>'`.
7. **`isAiToolkitMandatory`** `mandatoryTypes` — add `'<baseType>'` (for AI-Toolkit-only
   ecosystems). This auto-enables sample-prompt requirements and AI-Toolkit gating.
8. **`getDefaultEngine`** — add `if (baseType === '<baseType>') return 'ai-toolkit';`.

### 3b. `src/server/schema/model-version.schema.ts`

- Add `export const trainingDetailsBaseModels<Name> = ['<key>'] as const;` next to the others.
- Spread `...trainingDetailsBaseModels<Name>` into the matching aggregate
  (`trainingDetailsBaseModelsImage` / `…Video` / `…Audio`).
- The `trainingDetailsObj` zod enums (`baseModel`, `baseModelType`) derive from these +
  `trainingBaseModelType`, so they update automatically. No `baseModelToTraningDetailsBaseModelMap`
  entry unless mapping a `BaseModel` display name back to a key (Wan does this).

### 3c. `src/server/schema/orchestrator/training.schema.ts`

- Add a branch to the `aiToolkitTrainingParams` discriminated union:
  ```ts
  aiToolkitBaseParams.extend({ ecosystem: z.literal('<eco>'), modelVariant: z.undefined().optional() }),
  ```
  (or `modelVariant: z.enum([...])` if the SDK type requires one). Without this, submission
  validation rejects the new ecosystem.

### 3d. `src/server/services/feature-flags.service.ts`

- Add `<name>Training: { availability: ['mod'], fliptKey: '<name>-training' },`. Create the
  Flipt flag too (use the `flipt` skill). Mod-only is the norm for a new/experimental base model.

### 3e. `src/components/Training/Form/TrainingParams.tsx`

- The `trainingSettings` array drives the UI and per-base defaults. Each setting's `overrides`
  map is keyed by **base-model key** (`<key>`), not baseType. Grep the file for the reference
  ecosystem's key (`anima:`) and add a parallel `<key>: { all: { … } }` entry to **each** setting
  where the new ecosystem should differ from the base default. For an AI-Toolkit image ecosystem
  that's typically: `engine` (`'ai-toolkit'`), `maxTrainEpochs`, `trainBatchSize` (honor the
  fixed/max from the SDK type), `targetSteps`, `saveEvery`, `resolution`, `shuffleCaption`
  (disabled), `keepTokens` (disabled), `unetLR`, `textEncoderLR` (disabled), `lrScheduler`,
  `minSnrGamma` (disabled), `networkDim`, `networkAlpha`, `noiseOffset`, `optimizerArgs`.
  Skip a setting if the base default already matches (e.g. `optimizerType` AdamW8Bit,
  `flipAugmentation` false for image).

### 3f. `src/components/Training/Form/TrainingSubmitModelSelect.tsx`

- Import `trainingDetailsBaseModels<Name>`.
- Add `const baseModel<Name> = !!formBaseModel && (trainingDetailsBaseModels<Name> as
  ReadonlyArray<string>).includes(formBaseModel) ? formBaseModel : null;`.
- Add a `{features.<name>Training && (<ModelSelector … name="<Name>" value={baseModel<Name>}
  baseType="<baseType>" makeDefaultParams={makeDefaultParams} isNew={…} />)}` block under the
  right `mediaType` group (image/video/audio). Pick an unused `color`.
- Add `selectedRun.baseType === '<baseType>' ||` to the "experimental build" alert condition
  (for new/experimental base models).

### 3g. `src/shared/constants/basemodel.constants.ts`

- Add the training support entry to `ecosystemSupport`:
  ```ts
  { ecosystemId: ECO.<Name>, supportType: 'training', modelTypes: loraOnly },
  ```
  (`loraOnly` is the standard for trained outputs — they're LoRAs.) Generation support is
  independent; don't add it unless the ecosystem is also generatable.

### Files that need NO change (generic / arbitrary-ecosystem aware)

- `src/server/services/orchestrator/training/training.orch.ts` — `createTrainingStep_AiToolkit`
  builds the input generically and casts `ecosystem as any`. Only add a branch if the ecosystem
  needs special fields (sd1/sdxl send `model` + `minSnrGamma`; ACE-Step sends `samplesOverrides`).
- `src/store/training.store.ts` — `getDefaultTrainingParams` reads `trainingSettings` overrides
  by key. Only touch if the new ecosystem should become a form default.
- `src/components/Training/Form/TrainingSubmit.tsx` / `TrainingSubmitAdvancedSettings.tsx` —
  generic; resolve the ecosystem via `getAiToolkitEcosystem` once 3a is done.
- `src/server/common/enums.ts` `OrchEngineTypes` — `ai-toolkit` already present.

## Step 4 — Typecheck

```bash
pnpm run typecheck
```

Common failures: a `baseType`/key typo (the literal won't match the `TrainingBaseModelType`
union), a missing spread in the aggregate array, or a `baseModel` string that isn't a valid
`BaseModel`. Iterate until clean.

## Step 5 — Verify (optional)

With a dev server running (see `dev-server` skill) and the Flipt flag on for your user:
- Open the training form → Step 1 shows the new base model under its media type.
- Selecting it loads the expected default params in Step 3.
- The `whatif` submit returns a price without a validation error.

## Notes

- **Mandatory vs optional AI-Toolkit**: mandatory ecosystems (the common case) are gated solely
  by their own `<name>Training` flag. Optional ones (sd15/sdxl/flux/…) additionally check a
  per-model `aiToolkit<X>` flag via `aiToolkitFlagByBaseType` — only relevant if you're adding an
  ecosystem that also supports Kohya.
- **Audio ecosystems** additionally gate on `audioTraining` and may send `samplesOverrides`
  (see ACE-Step). **Video ecosystems** go in `trainingBaseModelTypesVideo` and usually disable
  spatial params (resolution/clipSkip/noiseOffset).
- **Batch size**: if the SDK type fixes it (e.g. Boogu = 1), set the `trainBatchSize` override to
  `{ all: { default: 1, min: 1, max: 1 } }` and leave `aiToolkitBatchMax` at its default.
- **Placeholder AIR**: fine to ship before the base model is on civitai — it's not sent for
  AI-Toolkit-only ecosystems. Leave a comment so it gets swapped to the civitai URN later.
