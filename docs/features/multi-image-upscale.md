# Multi-Image Batch Upscale

## Context

The upscale workflow (`img2img:upscale`) currently only accepts a single image. Users want to select multiple images from the queue/feed and upscale them in one batch. The user picks a single scale factor; each image uses that factor if possible, falls back to a lower multiplier if the selected one would exceed the 4096px max, or is excluded if no multiplier works.

## Key Behavior

- **Max 10 images** per batch
- **Single upscale selection** (multiplier or resolution preset) applies to all
- **Per-image adaptation** (multiplier mode):
  1. Try selected multiplier (e.g., 2x)
  2. If output > 4096px, try next lower from `[1.5, 2, 2.5, 3]`
  3. If none work, exclude the image with a warning
- **Resolution presets** (2K/4K): exclude if image already >= target
- **Append from queue/feed**: clicking "Upscale" on another image appends to the batch (when already in upscale mode) instead of replacing
- **Deduplication**: same image URL can't be added twice

## Files to Modify

| File | Change |
|------|--------|
| `src/shared/data-graph/generation/image-upscale-graph.ts` | max:10, new `imageUpscaleResults` computed node, update `upscaleSelection` for batch |
| `src/components/generation_v2/hooks/useGeneratedItemWorkflows.ts` | Append logic when already in upscale mode |
| `src/store/generation-graph.store.ts` | Add `'append'` to `RunType` |
| `src/components/generation_v2/GenerationFormProvider.tsx` | Handle `'append'` runType (merge images with dedup) |
| `src/server/services/orchestrator/orchestration-new.service.ts` | Fan out to N comfy steps, update `generateFromGraph` and `whatIfFromGraph` |
| `src/components/generation_v2/FormFooter.tsx` | Collect per-image sourceMetadata |
| `src/components/generation_v2/inputs/UpscaleDimensionsInput.tsx` | Batch results summary UI |
| `src/components/generation_v2/GenerationForm.tsx` | Render batch results controller |

## Implementation Steps

### 1. Graph: `image-upscale-graph.ts`

#### 1a. Change images node to max 10

```typescript
// Line 140: change from imagesNode() to:
.node('images', () => imagesNode({ min: 1, max: 10 }), [])
```

#### 1b. `imageUpscaleResults` computed node shape

@ai: Agreed — no separate type needed. The type is inferred from the computed node's return value in the graph. The shape returned per image will be:

```typescript
// Inferred from the computed node return — not a standalone type declaration
{
  imageIndex: number;
  url: string;
  sourceWidth: number;
  sourceHeight: number;
  effectiveMultiplier: number | null;
  targetDimensions: { width: number; height: number } | null;
  status: 'ok' | 'downgraded' | 'excluded';
  excludeReason?: string;
}
```

External consumers can extract the type from `ImageUpscaleGraphCtx['imageUpscaleResults'][number]`.

#### 1c. Update `upscaleSelection` node for batch

The multiplier/resolution options should be **enabled if any image can use them** (not just the first):

- Multiplier disabled when: `images.every(img => maxDim(img) * multiplier > MAX_OUTPUT_RESOLUTION)`
- Resolution disabled when: `images.every(img => maxDim(img) >= targetRes)`
- `canUpscale` = at least one image + one option is valid
- Keep `sourceWidth`/`sourceHeight` from first image for display
- Add `imageCount` to meta

#### 1d. Replace `targetDimensions` with `imageUpscaleResults` computed node

Per-image computed array. For each image + the current `upscaleSelection`:

**Multiplier mode:**
1. Sort `UPSCALE_MULTIPLIERS` descending, filter to `<= selection.multiplier`
2. Try each: compute dims, check if max dim <= 4096
3. First valid -> `status: 'ok'` (if same as selected) or `'downgraded'`
4. None valid -> `status: 'excluded'`

**Resolution mode:**
- If image max dim >= target resolution -> `excluded` ("Already at or above Xpx")
- Compute dims, check max dim <= 4096 -> `ok` or `excluded`

#### 1e. Remove `targetDimensions`, handle legacy on backend

@ai: Agreed — no backward-compat wrapper needed since upscale can't be remixed. We'll remove `targetDimensions` from the graph entirely and replace it with `imageUpscaleResults`. The backend (`createImageUpscaleSteps`) reads `imageUpscaleResults` directly. The output validation on `imageUpscaleResults` (e.g., `.min(1, 'At least one image must be upscalable')` filtering to non-excluded results) will handle disabling submit when no images are valid.

---

### 2. Append from Queue/Feed

#### 2a. `generation-graph.store.ts`: Add `'append'` to RunType

```typescript
export type RunType = 'run' | 'remix' | 'replay' | 'patch' | 'append';
```

#### 2b. `GenerationFormProvider.tsx`: Handle `'append'` runType

In the store data application logic, add a branch for `'append'`:

- Read current `images` from `graph.getSnapshot()`
- Merge incoming images with existing, dedup by URL
- Cap at 10
- Call `graph.set({ images: merged })`
- Don't touch workflow or other params (they're already set)

#### 2c. `useGeneratedItemWorkflows.ts`: Always append for upscale

@ai: Agreed — no need to check current workflow. Every "Upscale" click always uses `runType: 'append'`. The append handler in `GenerationFormProvider` will set the workflow to `img2img:upscale` if not already set, and append the image. If the form is on a different workflow, the append handler switches to upscale and starts the batch.

1. Store sourceMetadata for the new image URL
2. Call `generationGraphStore.setData()` with `runType: 'append'`, `workflow: 'img2img:upscale'`, and the new image in `params.images`

#### 2d. Clear all button

Add a "Clear all" action to the `ImageUploadMultipleInput` when in upscale mode (max > 1 and images present). This calls `graph.set({ images: [] })` to reset the batch.

---

### 3. Backend: Multi-Step Fan-Out in `orchestration-new.service.ts`

#### 3a. New `createImageUpscaleSteps()` function

Returns `StepInput[]` (one per non-excluded image):

```typescript
async function createImageUpscaleSteps(
  data: Extract<GenerationGraphOutput, { workflow: 'img2img:upscale' }>
): Promise<StepInput[]> {
  const results: ImageUpscaleResult[] = data.imageUpscaleResults ?? [];
  const images = data.images ?? [];
  const validResults = results.filter(r => r.status !== 'excluded');
  // throw if no valid results
  return Promise.all(validResults.map(result =>
    createComfyInput({
      key: 'img2img-upscale',
      params: {
        image: images[result.imageIndex].url,
        upscaleWidth: result.targetDimensions!.width,
        upscaleHeight: result.targetDimensions!.height,
      },
    })
  ));
}
```

#### 3b. Refactor step creation to always return `WorkflowStepTemplate[]`

@ai: Agreed — all workflows are multi-step conceptually, single-step is just the common case. Rename `createWorkflowStepFromGraph` -> `createWorkflowStepsFromGraph`, always returning `WorkflowStepTemplate[]`:

- For `img2img:upscale`: call `createImageUpscaleSteps()` -> N step inputs -> N wrapped steps
- For everything else: `createStepInput()` returns single `StepInput`, wrap in `[step]`
- Per-step sourceMetadata: look up from `sourceMetadataMap` by image URL (falls back to single `sourceMetadata`)

#### 3c. Update `generateFromGraph`

```typescript
// Change from:
const step = await createWorkflowStepFromGraph({ ... });
steps: [step],

// To:
const steps = await createWorkflowStepsFromGraph({ ... });
steps: steps,
```

#### 3d. Update `whatIfFromGraph` the same way

Multi-step cost estimation uses the same `steps` array pattern.

---

### 4. Per-Image sourceMetadata: `FormFooter.tsx`

#### 4a. Collect metadata for all images on submit

Currently reads `sourceMetadataStore.getMetadata(images[0].url)`. Change to:

- If multi-image enhancement: build `sourceMetadataMap: Record<string, SourceMetadata>` from all image URLs
- Pass both `sourceMetadata` (first image, backward compat) and `sourceMetadataMap` to the mutation

#### 4b. Thread `sourceMetadataMap` through router -> service

- `orchestrator.router.ts` line 193: destructure `sourceMetadataMap` from input (schema is `z.any()` so no schema change needed)
- Pass to `generateFromGraph` -> `createWorkflowStepsFromGraph`
- In step creation: use `sourceMetadataMap[imageUrl]` for each step's metadata

---

### 5. UI: Batch Results Display

#### 5a. `UpscaleDimensionsInput.tsx`: Add batch summary

When `imageUpscaleResults` has more than one entry, show a compact summary below the multiplier/resolution buttons:

- Green: "X images ready" (ok count)
- Yellow: "X images at reduced multiplier" with per-image detail (e.g., "512x512 -> x1.5 (768x768)")
- Red: "X images will be skipped" with per-image reason

#### 5b. Image annotations via `annotations` node

Instead of the current `UpscaleAwareImageInput` wrapper, use an `annotations` node + `multiController`:

- The `annotations` node depends on `images` + `upscaleSelection` and returns per-image annotation data (label, color, tooltip)
- Graphs that don't need annotations simply omit the node
- The images `multiController` checks if an `annotations` node exists and passes its value to `ImageUploadMultipleInput`
- This eliminates the special-case `UpscaleAwareImageInput` component from `GenerationForm.tsx`
- Other future workflows can define their own `annotations` node from any source without plumbing changes

#### 5c. `GenerationForm.tsx`: Add `imageUpscaleResults` controller

```tsx
<Controller graph={graph} name="imageUpscaleResults" render={({ value }) => {
  if (!value || value.length <= 1) return null;
  return <BatchResultsSummary results={value} />;
}} />
```

#### 5d. Submit validation

@ai: Agreed — no extra computed node. The `imageUpscaleResults` output validation (requiring at least one non-excluded result) handles this naturally. When all images are excluded, the validation error message disables the submit button and communicates the issue.

---

## Implementation Order

1. **Step 1** -- Graph changes (foundation)
2. **Step 2** -- Append mechanism (enables adding multiple images)
3. **Step 5** -- UI display (see results as images are added)
4. **Step 3** -- Backend fan-out (makes submit work)
5. **Step 4** -- Per-image sourceMetadata (correctness for enhancement tracking)

## Verification

1. **Unit test the graph**: Init `imageUpscaleGraph` with multiple images of varying sizes, verify `imageUpscaleResults` shows correct effective multipliers and statuses
2. **Manual flow**: From the queue, click "Upscale" on image A -> form shows 1 image. Click "Upscale" on image B -> form shows 2 images. Verify dedup (click A again -> still 2).
3. **Fallback**: Add a large image (e.g., 3000x3000), select 2x -> verify it falls back to 1.5x or is excluded. Check the batch summary shows the status.
4. **Cost estimation**: With multiple images, verify the what-if cost scales correctly (N times single upscale cost approximately)
5. **Submit**: Generate a batch of 3 upscales, verify 3 separate output images appear in the queue
6. **Edge cases**: All images excluded -> submit disabled. Single image -> no batch summary shown. Max 10 -> 11th image not added.
7. **Typecheck**: `pnpm run typecheck` passes
