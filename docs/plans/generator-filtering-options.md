# Generator Filtering Options - Implementation Plan

## Overview

Add enhanced filtering capabilities to the Generator (Image/Video) to help users manage large volumes of generated content. This plan focuses on two tag-based filters:

1. **By Base Model** - Filter by the model used (Flux 2 Max, SDXL, SD1.5, etc.)
2. **By Process Type** - Filter by enhancement/generation type (Upscale, Background Removal, Video Interpolation, etc.)

## Current State Analysis

### Existing Tags Already Being Added

After code analysis, workflows **already include these tags** at submission time:

```typescript
// From textToImage.ts and comfy.ts (lines 127-136):
tags: [
  WORKFLOW_TAGS.GENERATION,  // 'gen'
  WORKFLOW_TAGS.IMAGE,       // 'img'
  params.workflow,           // e.g., 'txt2img', 'img2img-upscale', 'img2img-background-removal'
  baseModel,                 // e.g., 'Flux1', 'SDXL', 'SD1', 'Pony'
  process,                   // 'txt2img' or 'img2img'
  ...args.tags,
]
```

**Key Finding:** The `params.workflow` field already contains process type information:
- `'txt2img'` - Text to Image
- `'img2img'` - Image to Image
- `'img2img-upscale'` - Upscale
- `'img2img-upscale-enhancement-realism'` - Enhanced Upscale
- `'img2img-background-removal'` - Background Removal

### Existing Filters in UI
- **Generation Type**: `img` / `vid` tags
- **Reactions**: `favorite`, `feedback:liked`, `feedback:disliked` tags
- **Sort**: Newest / Oldest

### Current Architecture
```
MarkerFiltersDropdown.tsx → FiltersProvider.tsx → useGetTextToImageRequests.ts
                                                         ↓
                                              trpc.orchestrator.queryGeneratedImages
                                                         ↓
                                                  Orchestrator API (tags filter)
```

### Key Files
| File | Purpose |
|------|---------|
| `src/shared/constants/generation.constants.ts` | WORKFLOW_TAGS constants |
| `src/providers/FiltersProvider.tsx` | GenerationFilterSchema definition |
| `src/components/ImageGeneration/MarkerFiltersDropdown.tsx` | Filter UI |
| `src/components/ImageGeneration/utils/generationRequestHooks.ts` | Query hooks |
| `src/server/services/orchestrator/textToImage/textToImage.ts` | Image workflow submission |
| `src/server/services/orchestrator/comfy/comfy.ts` | ComfyUI workflow submission |

---

## Implementation Plan

### Phase 1: Add Process Type Tag Constants (Optional but Recommended)

While workflow IDs already exist as tags, adding explicit process type constants improves clarity and enables consistent filtering.

**File:** `src/shared/constants/generation.constants.ts`

```typescript
export const WORKFLOW_TAGS = {
  // Existing
  GENERATION: 'gen',
  IMAGE: 'img',
  VIDEO: 'vid',
  FAVORITE: 'favorite',
  FOLDER: 'folder',
  FEEDBACK: {
    LIKED: 'feedback:liked',
    DISLIKED: 'feedback:disliked',
  },

  // NEW: Explicit Process Types (for filtering)
  PROCESS: {
    // Image processes
    TXT2IMG: 'process:txt2img',
    IMG2IMG: 'process:img2img',
    UPSCALE: 'process:upscale',
    BACKGROUND_REMOVAL: 'process:bg-removal',

    // Video processes
    TXT2VID: 'process:txt2vid',
    IMG2VID: 'process:img2vid',
    VID_UPSCALE: 'process:vid-upscale',
    VID_INTERPOLATION: 'process:vid-interpolation',
    VID_ENHANCEMENT: 'process:vid-enhancement',
  },
};

// Helper to derive process tag from workflow ID
export function getProcessTagFromWorkflow(workflow: string, hasSourceImage: boolean): string | undefined {
  if (workflow.includes('background-removal')) return WORKFLOW_TAGS.PROCESS.BACKGROUND_REMOVAL;
  if (workflow.includes('upscale')) return WORKFLOW_TAGS.PROCESS.UPSCALE;
  if (workflow.includes('vid-upscale') || workflow === 'videoUpscaler') return WORKFLOW_TAGS.PROCESS.VID_UPSCALE;
  if (workflow.includes('interpolation')) return WORKFLOW_TAGS.PROCESS.VID_INTERPOLATION;
  if (workflow.includes('enhancement') && !workflow.includes('upscale')) return WORKFLOW_TAGS.PROCESS.VID_ENHANCEMENT;

  // Default based on media type and source image
  if (workflow.includes('vid') || workflow.includes('video')) {
    return hasSourceImage ? WORKFLOW_TAGS.PROCESS.IMG2VID : WORKFLOW_TAGS.PROCESS.TXT2VID;
  }
  return hasSourceImage ? WORKFLOW_TAGS.PROCESS.IMG2IMG : WORKFLOW_TAGS.PROCESS.TXT2IMG;
}
```

---

### Phase 2: Update Workflow Submissions to Include New Tags

#### 2.1 Text-to-Image Submission

**File:** `src/server/services/orchestrator/textToImage/textToImage.ts`

```typescript
// Around line 124-136, update the tags array:
const baseModel = 'baseModel' in params ? params.baseModel : undefined;
const process = !!params.sourceImage ? 'img2img' : 'txt2img';
const processTag = getProcessTagFromWorkflow(params.workflow, !!params.sourceImage);

const workflow = await submitWorkflow({
  token: args.token,
  body: {
    tags: [
      WORKFLOW_TAGS.GENERATION,
      WORKFLOW_TAGS.IMAGE,
      params.workflow,
      baseModel,
      process,
      processTag,  // NEW: Explicit process tag
      ...args.tags,
    ].filter(isDefined),
    // ... rest unchanged
  },
});
```

#### 2.2 ComfyUI Submission

**File:** `src/server/services/orchestrator/comfy/comfy.ts`

Same pattern as 2.1 - add `processTag` to the tags array.

#### 2.3 ImageGen Submissions (OpenAI, Google, Flux2, etc.)

**File:** `src/server/services/orchestrator/imageGen/imageGen.ts`

Update the tag generation to include process tags.

#### 2.4 Video Generation Submissions

**Files:**
- `src/server/orchestrator/video-upscaler/video-upscaler.ts`
- `src/server/orchestrator/video-interpolation/video-interpolation.ts`
- `src/server/orchestrator/video-enhancement/video-enhancement.ts`

Add appropriate `WORKFLOW_TAGS.PROCESS.*` tags to each video workflow submission

---

### Phase 3: Update Filter Schema

**File:** `src/providers/FiltersProvider.tsx`

```typescript
// Update the schema (around line 161)
export type GenerationFilterSchema = z.infer<typeof generationFilterSchema>;
const generationFilterSchema = z.object({
  sort: z.enum(GenerationSort).default(GenerationSort.Newest),
  marker: z.enum(GenerationReactType).optional(),
  tags: z.string().array().optional(),

  // NEW filters
  baseModel: z.string().optional(),      // Single base model filter
  processType: z.string().optional(),    // Single process type filter
});
```

---

### Phase 4: Update Filter UI Component

**File:** `src/components/ImageGeneration/MarkerFiltersDropdown.tsx`

Add new filter sections:

```tsx
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import {
  getGenerationBaseModelConfigs,
  baseModelGroupConfig,
} from '~/shared/constants/base-model.constants';

// Get all base models dynamically from config (show all, not just popular)
const baseModelGroups = getGenerationBaseModelConfigs(); // Returns all groups with generation support

// Define ALL process types (not contextual - show all regardless of img/vid selection)
const PROCESS_TYPES = [
  // Image processes
  { value: WORKFLOW_TAGS.PROCESS.TXT2IMG, label: 'Text to Image' },
  { value: WORKFLOW_TAGS.PROCESS.IMG2IMG, label: 'Image to Image' },
  { value: WORKFLOW_TAGS.PROCESS.UPSCALE, label: 'Upscale' },
  { value: WORKFLOW_TAGS.PROCESS.BACKGROUND_REMOVAL, label: 'Background Removal' },
  // Video processes
  { value: WORKFLOW_TAGS.PROCESS.TXT2VID, label: 'Text to Video' },
  { value: WORKFLOW_TAGS.PROCESS.IMG2VID, label: 'Image to Video' },
  { value: WORKFLOW_TAGS.PROCESS.VID_UPSCALE, label: 'Video Upscale' },
  { value: WORKFLOW_TAGS.PROCESS.VID_INTERPOLATION, label: 'Interpolation' },
  { value: WORKFLOW_TAGS.PROCESS.VID_ENHANCEMENT, label: 'Enhancement' },
] as const;

// Inside DumbMarkerFiltersDropdown component:

// Calculate filter count for badge
let filterLength = 0;
if (filters.marker) filterLength += 1;
if (filters.tags?.length) filterLength += filters.tags.length;
if (filters.baseModel) filterLength += 1;
if (filters.processType) filterLength += 1;

// Clear all filters function
const clearAllFilters = () => {
  setFilters({
    marker: undefined,
    tags: [],
    baseModel: undefined,
    processType: undefined,
  });
};

// Add Clear All button at top of dropdown when filters are active
{filterLength > 0 && (
  <Button variant="subtle" size="xs" onClick={clearAllFilters}>
    Clear all filters
  </Button>
)}

{/* Base Model Filter - Show ALL models from config */}
<Divider label="Base Model" className="text-sm font-bold" />
<div className="flex flex-wrap gap-2">
  <FilterChip
    checked={!filters.baseModel}
    onChange={() => setFilters({ baseModel: undefined })}
  >
    All Models
  </FilterChip>
  {baseModelGroups.map((group) => (
    <FilterChip
      key={group}
      checked={filters.baseModel === group}
      onChange={(checked) => setFilters({ baseModel: checked ? group : undefined })}
    >
      {baseModelGroupConfig[group]?.name ?? group}
    </FilterChip>
  ))}
</div>

{/* Process Type Filter - Show ALL process types (not contextual) */}
<Divider label="Process Type" className="text-sm font-bold" />
<div className="flex flex-wrap gap-2">
  <FilterChip
    checked={!filters.processType}
    onChange={() => setFilters({ processType: undefined })}
  >
    All
  </FilterChip>
  {PROCESS_TYPES.map(({ value, label }) => (
    <FilterChip
      key={value}
      checked={filters.processType === value}
      onChange={(checked) => setFilters({ processType: checked ? value : undefined })}
    >
      {label}
    </FilterChip>
  ))}
</div>
```

---

### Phase 5: Update Query Hook

**File:** `src/components/ImageGeneration/utils/generationRequestHooks.ts`

Update `useGetTextToImageRequests` to include new filters:

```typescript
export function useGetTextToImageRequests(/* ... */) {
  const { filters } = useFiltersContext((state) => ({
    filters: state.generation,
    setFilters: state.setGenerationFilters,
  }));

  // Existing marker → tags conversion
  const reactionTags = useMemo(() => {
    switch (filters.marker) {
      case GenerationReactType.Favorited:
        return [WORKFLOW_TAGS.FAVORITE];
      case GenerationReactType.Liked:
        return [WORKFLOW_TAGS.FEEDBACK.LIKED];
      case GenerationReactType.Disliked:
        return [WORKFLOW_TAGS.FEEDBACK.DISLIKED];
      default:
        return [];
    }
  }, [filters.marker]);

  // Build complete tags array including new filters
  const queryTags = useMemo(() => {
    const tags = [
      WORKFLOW_TAGS.GENERATION,
      ...reactionTags,
      ...(filters.tags ?? []),
    ];

    // Add base model filter if set
    if (filters.baseModel) {
      tags.push(filters.baseModel);
    }

    // Add process type filter if set
    if (filters.processType) {
      tags.push(filters.processType);
    }

    return tags;
  }, [reactionTags, filters.tags, filters.baseModel, filters.processType]);

  const { data, ...rest } = trpc.orchestrator.queryGeneratedImages.useInfiniteQuery({
    ...input,
    ascending: filters.sort === GenerationSort.Oldest,
    tags: queryTags,
  }, /* ... */);

  // ... rest of hook
}
```

---

## File Changes Summary

| File | Changes |
|------|---------|
| `src/shared/constants/generation.constants.ts` | Add `WORKFLOW_TAGS.PROCESS.*` constants + helper function |
| `src/providers/FiltersProvider.tsx` | Add `baseModel` and `processType` to schema |
| `src/components/ImageGeneration/MarkerFiltersDropdown.tsx` | Add Base Model and Process Type filter UI sections |
| `src/components/ImageGeneration/utils/generationRequestHooks.ts` | Include new filters in query tags |
| `src/server/services/orchestrator/textToImage/textToImage.ts` | Add process tags to workflow submission |
| `src/server/services/orchestrator/comfy/comfy.ts` | Add process tags to workflow submission |
| `src/server/services/orchestrator/imageGen/imageGen.ts` | Add process tags to workflow submission |
| `src/server/orchestrator/video-*/` files | Add process tags to video workflow submissions |

---

## Migration Considerations

### Existing Workflows

Existing workflows won't have the new `process:*` tags. However, they DO have:
- **Base model tags** (already present)
- **Workflow ID tags** (e.g., `'img2img-upscale'`)

**Options:**

1. **Forward-only (Recommended for Phase 1)**
   - New `process:*` tags only apply to new generations
   - Base model filtering works immediately (tags already exist)
   - Process type filtering works for new generations only

2. **Use existing workflow ID tags for filtering**
   - Filter by `'img2img-upscale'` instead of `'process:upscale'`
   - Works for existing data but less clean/maintainable

3. **Backfill script (Optional future enhancement)**
   - Add `process:*` tags to existing workflows based on their workflow ID
   - Requires orchestrator API batch tag update support

**Recommendation:** Start with option 1 (forward-only). Base model filtering will work immediately. Process type filtering will gradually become more useful as users create new generations.

---

## Testing Plan

### Manual Testing Checklist
- [ ] Generate images with different base models (Flux, SDXL, SD1.5)
- [ ] Perform upscale operation
- [ ] Perform background removal operation
- [ ] Create video with txt2vid
- [ ] Create video with img2vid
- [ ] Perform video upscale
- [ ] Perform video interpolation
- [ ] Verify tags appear in workflow data
- [ ] Test base model filter (all combinations)
- [ ] Test process type filter (all combinations)
- [ ] Test filter combinations (e.g., Flux + Upscale)
- [ ] Test clearing filters
- [ ] Test filter persistence across page refreshes

### Edge Cases
- [ ] Filter with no matching results shows empty state
- [ ] Switching between img/vid tabs resets process type filter appropriately
- [ ] Filter indicator badge shows correct count

---

## Future Enhancements

Once these filters are implemented, future additions could include:

1. **Date Range Filter** - Requires orchestrator API changes or client-side filtering
2. **Status Filter** (Failed/Succeeded) - Requires orchestrator API changes or client-side filtering
3. **Multi-select for Base Models** - Allow selecting multiple models at once
4. **Saved Filter Presets** - Let users save common filter combinations
5. **Search by prompt** - Text search within generation prompts

---

## Design Decisions (Resolved)

1. **Base model filter**: Show ALL models from `getGenerationBaseModelConfigs()` ✅
2. **More models option**: Not needed - show all models directly ✅
3. **Process type filters**: NOT contextual - show all process types regardless of img/vid selection ✅
4. **Filter count badge**: Yes, show count in dropdown button ✅
5. **Clear all filters**: Yes, add button when filters are active ✅

---

## Implementation Order

1. **Phase 1 & 2** - Add constants and update submissions (backend)
2. **Phase 3** - Update filter schema
3. **Phase 4** - Add UI components
4. **Phase 5** - Wire up query hook
5. **Testing** - Manual verification
6. **Deploy** - Monitor for issues

Each phase can be deployed independently, with full functionality available after Phase 5.
