# Workflow Metadata Refactor

## Goal

Establish clean, scalable metadata architecture for generation workflows that handles:
- Single-step workflows (standard generation)
- Multi-step workflows (batch upscale: one form → multiple steps)
- Chained workflows (txt2img → face-fix: multiple form inputs → one workflow)

## Architecture

### Two-Layer Model

**`workflow.metadata`** = the generation form input snapshot (workflow-level replay)
- What the user submitted: params + resources + flags
- Used for workflow-level replay ("redo this entire generation")
- Shared across all steps — same regardless of how many steps the workflow has

**`step.metadata.params/resources`** = the original generation (step-level remix)
- Always resolved: for enhancements, this is the source generation (what you'd remix to); for standard generations, this is the step's own params
- `step.metadata.workflow` = what action this step performed (e.g., `img2img:upscale`). Undefined for standard generations.
- Clients never need to branch or check for source — `metadata.params` is always the answer

### Data model (what the orchestrator API stores)

**Standard generation (new writes):**
```
workflow.metadata = {
  params: { prompt: "a cat", steps: 30, workflow: "image:create", ... },
  resources: [{ id: 123, strength: 1 }],
  remixOfId?: 42,
  isPrivateGeneration?: true,
}
workflow.steps[0].metadata = {}
// Step metadata is empty — params/resources live only on workflow.metadata.
// Per-image feedback goes here: { images: { "img-id": { feedback: "liked" } } }
```

**Standard generation (legacy — step has params):**
```
workflow.metadata = undefined | { params, resources }  // may or may not exist
workflow.steps[0].metadata = {
  params: { prompt: "a cat", steps: 30, ... },
  resources: [{ id: 123, strength: 1 }],
  remixOfId?: 42,
  isPrivateGeneration?: true,
  images?: { "img-id": { feedback: "liked" } }
}
```

**Single-image upscale:**
```
workflow.metadata = {
  params: { upscaler: "4x-ultrasharp", creativity: 0.5, workflow: "img2img:upscale", ... },
  resources: [],
}
workflow.steps[0].metadata = {
  params: { upscaler: "4x-ultrasharp", ... },   // step's own action
  resources: [],
  source: {                                       // original generation (raw, stored)
    params: { prompt: "a cat", steps: 30, ... },
    resources: [{ id: 123, strength: 1 }],
    remixOfId?: 42,
  }
}
```

**Batch upscale (4 images):**
```
workflow.metadata = {
  params: { upscaler: "4x-ultrasharp", creativity: 0.5, workflow: "img2img:upscale", ... },
  resources: [],
}
workflow.steps[0].metadata = {
  ...stepOwnParams,
  source: { params: { prompt: "a cat" }, resources: [{ id: 1 }] }
}
workflow.steps[1].metadata = {
  ...stepOwnParams,
  source: { params: { prompt: "a dog" }, resources: [{ id: 2 }] }
}
// ...etc for each image
```

**Chained workflow (txt2img → face-fix):**
```
workflow.metadata = {
  params: { prompt: "a portrait", steps: 30, workflow: "image:create", ... },
  resources: [{ id: 123, strength: 1 }],
}
workflow.steps[0] = {
  $type: "textToImage",
  name: "$0",
  metadata: { params: {...}, resources: [...] }
}
workflow.steps[1] = {
  $type: "comfy",
  name: "$1",
  input: { image: { $ref: "$0", path: "output.images[0].url" } },
  metadata: {
    params: { faceFixStrength: 0.8, workflow: "img2img:face-fix", ... },
    resources: [],
    source: {
      params: { prompt: "a portrait", steps: 30, ... },
      resources: [{ id: 123, strength: 1 }],
    }
  }
}
```

### Key principles

1. **`workflow.metadata`** = what the user submitted to the form. Single source of truth for standard generations. Used for workflow-level replay.
2. **`step.metadata`** = step-specific data only. Empty for new standard generation writes. Enhancement steps have their own params/resources + `source`.
3. **`step.metadata.source`** = the original generation this enhancement acts upon (raw stored format). Only present on enhancement steps.
4. **`step.metadata.params/resources`** = optional. Present on enhancement steps and legacy data. Absent on new standard gen writes.
5. **`metadata.workflow`** = what action this step performed (badge display). Undefined for standard generations.
6. **Source always points to the original generation**, not intermediate enhancements.
7. **`isPrivateGeneration`** and **`remixOfId`** live on `workflow.metadata`, not per-step.

### Read path normalization

`formatStep` resolves stored metadata into a consistent normalized shape. It accepts `workflowMetadata` from the parent workflow for dimension/seed resolution when steps have no params.

**New format — enhancement (source field on step):**
```ts
// step.metadata.source has original, step.metadata root has step's own action
normalized.metadata.params     = resolve(source.params)       // original generation
normalized.metadata.resources  = enrich(source.resources)
normalized.metadata.workflow   = step.metadata.params.workflow // what this step did
```

**Legacy (transformations[]):**
```ts
// Root params/resources are the original generation. Last transformation = step's action.
normalized.metadata.params     = resolve(step.metadata.params)    // original generation
normalized.metadata.resources  = enrich(step.metadata.resources)
normalized.metadata.workflow   = lastTransformation.workflow       // what this step did
```

**Legacy standard (step has params, no source/transformations):**
```ts
normalized.metadata.params     = resolve(step.metadata.params)    // the generation itself
normalized.metadata.resources  = enrich(step.metadata.resources)
normalized.metadata.workflow   = undefined                         // standard generation
```

**New standard (step has no params — data on workflow.metadata):**
```ts
// Step metadata stays empty (no params/resources fabricated)
// Dimension/seed resolution uses workflow.metadata.params as fallback
normalized.metadata             = {}   // or just { images: { ... } }
normalized.metadata.workflow    = undefined
```

`formatGenerationResponse2` also enriches `workflow.metadata.resources` alongside step resources, building a typed `NormalizedWorkflowMetadata` on the response.

### Client consumption — data class model

Data flows through a parent chain: `WorkflowData` → `StepData` → `BlobData`. Each class resolves metadata with automatic fallback (step → workflow). Components receive `BlobData` and access everything via getters:

```ts
image.step.params       // step.metadata.params ?? workflow.metadata.params
image.step.resources    // step.metadata.resources ?? workflow.metadata.resources
image.workflow          // parent WorkflowData
image.step              // parent StepData
```

**Key getters on StepData:**

- `succeededImages` — images with `status === 'succeeded' && !blockedReason && !hidden`
- `displayImages` — images suitable for display (not hidden, not hard-blocked, upgradeable included)
- `completedCount` / `processingCount` / `blockedCount` / `blockedReasons`

**Key getters on WorkflowData:**

- Same aggregate getters across all steps (`completedCount`, `succeededImages`, etc.)
- `params` / `resources` / `remixOfId` — resolved from `workflow.metadata`

**Usage patterns:**

- **Workflow replay** (QueueItem "redo"): reads `request.params` (workflow-level)
- **Per-image remix**: reads `image.step.params` / `image.step.resources` (automatic fallback)
- **Badge display**: `step.metadata.workflow` (e.g., "img2img:upscale")
- **EXIF/Posting**: `getStepMeta(image.step)` — reads resolved params/resources directly
- **Prompt display**: `image.step.params.prompt` or `request.params.prompt`
- **Image filtering**: `step.succeededImages`, `request.displayImages`, `matchesMarkerTags(image, markerTags)`

## Current Implementation Status

### What's been built

**Helper modules (tested, 73 tests passing):**

- `workflow-metadata.ts` — `buildStepSource()` / `resolveStepSource()` for writing and reading `source` on step metadata
- `step-ref.ts` — `$ref` helpers: `isStepRef`, `buildStepRef`, `assignStepNames`
- `multi-graph.ts` — `processMultiGraphInputs()` for chained workflows
- `index.ts` — `getStepParams()` / `getStepResources()` client helpers with fallback logic

**Write path (production):**

- `buildResolvedSource()` puts step's own params at root, original generation in `source`. Looks up per-image metadata from `sourceMetadataMap` (or falls back to single `sourceMetadata`).
- `SourceCtx` carries `sourceMetadata`, `sourceMetadataMap`, and `workflow` key for source resolution
- `StepInput.resolvedSource` — pre-computed field that step creators set when they've already computed their source metadata
- `createWorkflowStepsFromGraph()` returns `{ steps, workflowMetadata }` — workflow metadata is the form input snapshot
- Standard gen steps write empty metadata (`additionalMetadata ?? {}`), not full params/resources
- `isPrivateGeneration` and `remixOfId` live on `workflowMetadata`, not per-step
- `generateFromGraph()` reads `isPrivateGeneration` from `workflowMetadata`
- `sourceMetadataMap` supports per-image source for batch upscale
- `needsSourceMetadata` flag (on workflow config) determines whether to build source context

**Read path (production — `formatStep`):**

- Handles 4 formats: transformations[], source field, step-has-params (legacy), no-step-params (new)
- Enhancement steps: resolves source server-side, `metadata.params` = original generation
- New standard gen: step metadata stays empty, dimension/seed resolution uses workflow params as fallback
- `formatGenerationResponse2()` enriches `workflow.metadata.resources` and builds typed `NormalizedWorkflowMetadata`
- `metadata.workflow` = what this step did (badge display)
- `getResourceRefsFromStep()` collects IDs from both step resources AND source resources for enrichment

**Client-side (data class model):**

- `WorkflowData` → `StepData` → `BlobData` parent chain in `src/shared/orchestrator/workflow-data.ts`
- `WorkflowData` constructor handles the full chain: wraps steps in `StepData`, wraps images in `BlobData`, wires parent refs
- `StepData` has image getters: `succeededImages`, `displayImages`, `completedCount`, `processingCount`, `blockedCount`, `blockedReasons`
- `WorkflowData` has aggregate getters across all steps
- `BlobData` has `step`, `workflow`, `params`, `resources` getters via parent chain
- `BlobData` handles NSFW blocking logic (private gen, site restricted, enable nsfw, can upgrade)
- Components receive `image: BlobData` as single prop — no separate `step`/`request`/`workflowMetadata` props
- `matchesMarkerTags(image, markerTags)` used in Feed, Lightbox, and Queue/QueueItem for marker filtering
- `transformations` and `source` references removed from all client code
- No standalone `new StepData()` construction in any component — all instances created by WorkflowData

## Backward Compatibility

Historic workflows have everything on `step.metadata`. The read path handles all four formats:

| Format | `workflow.metadata` | `step.metadata` | Era |
| ------ | ------------------- | --------------- | --- |
| New standard gen | Has params/resources/flags | Empty (or images feedback only) | New writes |
| New enhancement | Has form input snapshot | Has own params + `source` with original gen | New writes |
| Legacy + transformations | Empty | Root = original gen, transformations = enhancements | Existing enhancements |
| Legacy (no transformations) | Empty | Root = generation params/resources | Existing standard |

## Multi-Step Workflows

The current branch (`feature/multi-step-workflows`) supports multi-step workflows for batch upscale:

- `createWorkflowStepsFromGraph()` returns `WorkflowStepTemplate[]` (one step per image for batch upscale)
- `sourceMetadataMap` maps image URLs → source metadata for per-step source tracking
- `buildResolvedSource()` looks up per-image source from `sourceMetadataMap` (or falls back to single `sourceMetadata`)
- The form's `appendUpscaleImage()` accumulates images, `FormFooter` collects `sourceMetadataMap` for multi-image enhancements
- QueueItem supports `stepDisplay: 'separate'` for multi-step workflows — renders each step with its own label and image grid
- Queue/QueueItem filter displayed images via `matchesMarkerTags` when marker filters are active

## Multi-Graph Submission (Future)

### Concept

Submit multiple generation-graphs in a single workflow request. Each graph = one orchestrator step. Steps can reference earlier step outputs via `$ref`.

### Orchestrator `$ref` support (already exists)

```ts
// Step 1: named step
{ $type: 'wdTagging', name: 'tags', input: { mediaUrl: { $ref: '$arguments', path: 'mediaUrl' } } }

// Step 2: references step 1's output
{ $type: 'repeat', input: { for: { $ref: 'videoFrames', path: 'output.frames', as: 'frame' } } }
```

### Helpers (built in `step-ref.ts`)

```ts
type StepRef = { $ref: string; path: string };
function isStepRef(value: unknown): value is StepRef;
function buildStepRef(stepIndex: number, outputPath: string): StepRef;
function assignStepNames(steps: WorkflowStepTemplate[]): WorkflowStepTemplate[];
```

## Key Files

| File | Role |
| ---- | ---- |
| `src/server/services/orchestrator/orchestration-new.service.ts` | Main service — write + read paths |
| `src/server/services/orchestrator/index.ts` | Barrel exports, `getStepParams` / `getStepResources` helpers |
| `src/server/services/orchestrator/workflow-metadata.ts` | `buildStepSource` / `resolveStepSource` helpers (tested) |
| `src/server/services/orchestrator/step-ref.ts` | `$ref` helpers (tested) |
| `src/server/services/orchestrator/legacy-metadata-mapper.ts` | `mapDataToGraphInput()` — maps raw metadata to graph format |
| `src/shared/utils/resource.utils.ts` | `toStepMetadata()` — converts graph output to params/resources |
| `src/store/source-metadata.store.ts` | Client `SourceMetadata` type |
| `src/utils/metadata/extract-source-metadata.ts` | EXIF extraction for re-uploaded images |
| `src/components/generation_v2/hooks/useGeneratedItemWorkflows.ts` | Client source metadata + workflow application |
| `src/components/ImageGeneration/GenerationForm/generation.utils.ts` | `getStepMeta()` — builds EXIF data |
| `src/shared/orchestrator/workflow-data.ts` | `WorkflowData`, `StepData`, `BlobData` data classes |

## Completed: Standalone StepData Construction Eliminated

All components now use the `WorkflowData` → `StepData` → `BlobData` parent chain. No standalone `new StepData()` construction exists in any component code.

| File | Old pattern | New pattern |
| ---- | ----------- | ----------- |
| `GeneratedImage.tsx` | Separate `step` + `request` + `image` props | Single `image: BlobData` prop — accesses `image.step`, `image.workflow` |
| `GeneratedItemWorkflowMenu.tsx` | `step` + `workflowMetadata` → `new StepData()` | `image: BlobData` — accesses `image.workflow.id`, `image.ecosystemKey` |
| `useGeneratedItemWorkflows.ts` | `ApplyWorkflowOptions` with `step` + `workflowMetadata`, 4× `new StepData()` | `ApplyWorkflowOptions` with `image: BlobData` — `image.params`, `image.resources` |
| `generation.utils.ts` | `getStepMeta(step?, wfMeta?)` → `new StepData()` internally | `getStepMeta(step?)` — accepts step-like object with resolved params/resources |
| `ChallengeSubmitModal.tsx` | Fabricated `{ params, resources, metadata: {} } as any` | `image: BlobData` — `getStepMeta(image.step)` |
| `ImageSelectModal.tsx` | Same as Challenge | Same |
| `QueueItem.tsx` | Cast `(step as StepData)` | `step: StepData` typed directly (from `WorkflowData.steps`) |
| `Feed.tsx` / `Lightbox.tsx` | `{ ...image, step, request }` spread | `image: BlobData` — no spread needed |
