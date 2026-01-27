# Legacy Metadata Mapping

Maps historic orchestration step metadata (`step.metadata.resources` + `step.metadata.params`) to the new generation-graph input format (`step.metadata.input`).

**Source file:** `src/server/services/orchestrator/legacy-metadata-mapper.ts`

## Format Comparison

### Historic Format
```
step.metadata = {
  resources: [{ id, strength, epochNumber?, air? }],  // flat array of all resources
  params: TextToImageParams,                           // generation parameters
  remixOfId?: number,
  transformations?: Transformation[],
  images?: Record<string, ImageMetadata>,              // per-image feedback/hidden state
}
```

### New Format
```
step.metadata = {
  input: {                      // full generation-graph output
    workflow: string,           // e.g. 'txt2img', 'img2img:face-fix'
    output: 'image' | 'video',
    input: 'text' | 'image' | 'video',
    baseModel: string,
    model: ResourceData,        // checkpoint (split from resources)
    resources: ResourceData[],  // LoRAs, etc. (split from resources)
    vae?: ResourceData,         // VAE (split from resources)
    prompt, seed, steps, cfgScale, sampler, clipSkip, quantity, ...
    aspectRatio: { value, width, height },
    images?: [{ url, width, height }],
    ...
  },
  isPrivateGeneration?: boolean,
}

// ResourceData includes epochDetails for epoch resources:
ResourceData = {
  id: number,
  strength?: number,
  baseModel: string,
  model: { id: number, type: string },
  epochDetails?: { epochNumber?: number },
}
```

## Mapping Details

### Resource Splitting
The historic format stores all resources in a single flat array. The mapper splits them by `model.type`:

| Model Type | New Property | Notes |
|---|---|---|
| `Checkpoint` / `Upscaler` | `model` | First match becomes the checkpoint |
| `VAE` | `vae` | First match becomes the VAE |
| `LORA`, `LoCon`, `DoRA`, `TextualInversion`, etc. | `resources[]` | All others become additional resources |

**Requires enriched resource data** from `getResourceData()` since the historic `resources` array only stores `{ id, strength }` without model type information.

### Workflow Resolution
The historic format uses `params.process` and `params.workflow` instead of a single `workflow` key. The mapper infers `baseModel` **before** resolving the workflow, since the correct workflow variant depends on the ecosystem.

#### Resolution Priority

1. **Comfy steps** (`$type === 'comfy'`): `params.workflow` mapped through `COMFY_KEY_TO_WORKFLOW`
2. **Draft detection**: `params.draft === true` on txt2img → `txt2img:draft`
3. **Already new format**: `params.workflow` contains `:` → used directly
4. **Process-based** (`params.process` or `params.workflow`): refined by ecosystem context (see below)
5. **Source image detection**: presence of `params.sourceImage` or `params.images` → `img2img` refined by ecosystem
6. **Fallback**: `txt2img`

#### Ecosystem-Aware Refinement

When the base process is determined (step 4/5), it is refined based on the inferred `baseModel`. The mapper derives which ecosystems support which workflow variants from `workflowConfigs` (in `config/workflows.ts`) rather than maintaining hardcoded sets. This means adding a new ecosystem to a workflow config automatically updates the legacy mapping.

The helper `ecosystemSupportsWorkflow(baseModel, workflowKey)` converts a baseModel key to its ecosystem ID via `ecosystemByKey`, then checks if that ID appears in the workflow config's `ecosystemIds`.

**`img2img` refinement** (`resolveImg2ImgWorkflow`):

| Condition | Resolved Workflow | Source |
| --- | --- | --- |
| Ecosystem in `img2img:edit` config | `img2img:edit` | `workflowConfigs['img2img:edit'].ecosystemIds` |
| No inferable `baseModel` | `img2img:upscale` | Likely a standalone upscale operation |
| Other | `img2img` | Default (SD family and anything else) |

**`img2vid` refinement** (`resolveImg2VidWorkflow`):

| Condition | Resolved Workflow | Source |
| --- | --- | --- |
| Ecosystem in `img2vid:ref2vid` config + 3+ images | `img2vid:ref2vid` | `workflowConfigs['img2vid:ref2vid'].ecosystemIds` |
| Ecosystem in `img2vid:first-last-frame` config + 2 images | `img2vid:first-last-frame` | `workflowConfigs['img2vid:first-last-frame'].ecosystemIds` |
| Other | `img2vid` | Standard image-to-video |

**`txt2img` and `txt2vid`** pass through without refinement.

#### Comfy Workflow Key Mapping

| Old Key (hyphenated) | New Key (colon-separated) |
|---|---|
| `txt2img` | `txt2img` |
| `img2img` | `img2img` |
| `txt2img-facefix` | `txt2img:face-fix` |
| `txt2img-hires` | `txt2img:hires-fix` |
| `img2img-facefix` | `img2img:face-fix` |
| `img2img-hires` | `img2img:hires-fix` |
| `img2img-upscale` | `img2img:upscale` |
| `img2img-background-removal` | `img2img:remove-background` |

### Aspect Ratio
The historic format stores `width` and `height` as separate numbers with an optional `aspectRatio` string (e.g. `"1:1"`). The mapper combines them into the new structured format:
```
{ value: params.aspectRatio ?? `${width}:${height}`, width, height }
```

For **Flux Ultra**, `params.fluxUltraAspectRatio` (e.g. `"16:9"`) is resolved to the correct Ultra dimensions via `FLUX_ULTRA_ASPECT_RATIOS`, since Ultra uses higher-resolution output sizes (2048px+ base) that differ from standard Flux aspect ratios.

### Source Images
The historic format uses `params.sourceImage` (single object) or `params.images` (array). The mapper normalizes both to the new `images[]` array format.

### Flux Model Inference
The legacy `params.fluxMode` is an AIR string (e.g. `urn:air:flux1:checkpoint:civitai:618692@1088507`) that encodes the Flux model version. In the new format, `fluxMode` is a computed value derived from `model.id`, so it is not stored directly.

When no checkpoint is found in the enriched resources, the mapper parses the `fluxMode` AIR to construct a `model` ResourceData with the correct version ID. Neither `fluxMode` nor `fluxUltraAspectRatio` appear in the mapped output.

### BaseModel Inference
When `params.baseModel` is missing, the mapper infers it using:

1. **`params.engine`** → `ENGINE_TO_BASE_MODEL` lookup (video workflows)
2. **Enriched resources** → `getBaseModelFromResources()` (checkpoint baseModel → ecosystem group)

#### Engine-to-BaseModel Mapping

| Engine | BaseModel |
|---|---|
| `wan` | `WanVideo` |
| `vidu` | `Vidu` |
| `kling` | `Kling` |
| `hunyuan` | `HyV1` |
| `minimax` | `MiniMax` |
| `mochi` | `Mochi` |
| `sora` | `Sora2` |
| `veo3` | `Veo3` |
| `haiper` | `Haiper` |
| `lightricks` | `Lightricks` |

### Epoch Details
The `epochDetails.epochNumber` field is now preserved in `ResourceData`. The mapper pulls epoch info from the enriched `GenerationResource` (via `epochDetails.epochNumber` or `epochNumber`) and includes it in the mapped resource data.

## Known Gaps & Lossy Mappings

### 1. Injectable/Draft Resources Not Filtered with Full Accuracy
**Impact: Low**

The mapper filters out known injectable resource IDs (draft LoRAs: `391999`, `424706`). However, if the injectable resource list changes over time, historic data with different injectable IDs may not be filtered correctly. Those would appear as extra entries in `resources[]`.

### 2. `remixOfId` Not Mapped
**Impact: Low**

The historic `metadata.remixOfId` is not included in the mapped input. The new format does not store remix tracking in `metadata.input`. This field is still accessible from `metadata.remixOfId` directly.

### 3. `transformations` Not Mapped
**Impact: Low**

The historic `metadata.transformations` array is not included in the mapped input. The new generation-graph does not have a transformations concept at the input level.

### 4. Per-Image Metadata (`metadata.images`) Not Mapped
**Impact: None (different concern)**

The historic `metadata.images` record (hidden, feedback, comments, postId, favorite) tracks UI state per generated image. This is orthogonal to generation input and does not need mapping. It remains accessible at `metadata.images`.

### 5. Video Workflow Parameters May Be Incomplete
**Impact: Medium**

Video workflows (`txt2vid`, `img2vid`, `vid2vid:*`) in the historic format have ecosystem-specific parameters stored in `params`. The mapper uses `engine` to infer baseModel (see Engine-to-BaseModel Mapping above), but may miss ecosystem-specific fields like:
- Video-specific aspect ratios
- Duration/frame settings
- Model-specific parameters (Wan version/resolution, Vidu ref2vid, Kling mode, etc.)

These would need to be accessed from the raw `metadata.params` as a fallback.

### 6. `params.draft` Boolean vs `txt2img:draft` Workflow
**Impact: Low**

The historic format uses `params.draft: true` to indicate draft mode. The new format uses `workflow: 'txt2img:draft'`. The mapper detects `draft: true` + txt2img workflow and maps to `txt2img:draft`, but this only applies when `params.workflow` starts with `txt2img`. Draft with other base workflows (if any existed) would not be detected.

### 7. Aspect Ratio Precision
**Impact: Low**

The historic format may store exact pixel dimensions (e.g., `512x768`) but the aspect ratio `value` string may not match the new format's predefined aspect ratio options (e.g., `"2:3"`). The mapper stores the raw dimensions, and downstream code should use `width`/`height` rather than parsing the `value` string.

### 8. `isPrivateGeneration` Lives Outside `input`
**Impact: None**

In the new format, `isPrivateGeneration` is stored at `metadata.isPrivateGeneration`, not inside `metadata.input`. The mapper only produces the `input` portion. This field is already handled separately.

### 9. Missing `output` and `input` Type for Some Legacy Entries
**Impact: Low**

Older step entries that predate the `process` field may not have enough information to determine `output`/`input` types. The mapper defaults to `{ output: 'image', input: 'text' }` in these cases.

## Usage

```typescript
import { getGenerationInput, mapLegacyMetadata } from './legacy-metadata-mapper';

// Option 1: Get input from any step (handles both formats)
const input = getGenerationInput(step, enrichedResources);

// Option 2: Explicitly map legacy metadata (returns undefined if already new format)
const mapped = mapLegacyMetadata(step, enrichedResources);
```

The `getGenerationInput` function is the primary entry point. It checks whether `metadata.input` exists (new format) and returns it directly, or falls back to `mapLegacyMetadata` for historic data.
