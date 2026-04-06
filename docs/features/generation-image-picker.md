# Generated Image Picker

## Context

Users need a way to select generated images from their queue/feed for various purposes: uploading to img2img/upscale form inputs, selecting for challenges, training, etc. Currently they must manually drag images. We want a generic picker system that any feature can activate, with the first consumer being the `ImageUploadMultipleInput` in the v2 generation form.

As part of this, we're refactoring `orchestratorImageSelect` to store `BlobData` instead of string IDs, which eliminates the second-pass lookup in `GeneratedImageActions` and gives us the foundation for the picker — same store, extended with picker state.

## Store refactor: `orchestratorImageSelect` → BlobData + picker

**File:** `src/components/ImageGeneration/utils/generationImage.select.ts`

### Current (string IDs + `createSelectStore` + immer)

```ts
// Stores: { "wfId:stepName:imgId": true }
const selectStore = createSelectStore<string>('generated-image-select');
```

- `useSelection()` returns `{ workflowId, stepName, imageId }[]`
- `GeneratedImageActions.getSelectedImages()` does a second lookup to find the actual BlobData from query data

### New (plain zustand, BlobData values + picker state)

```ts
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { BlobData } from '~/shared/orchestrator/workflow-data';

const makeKey = (image: BlobData) => `${image.workflowId}:${image.stepName}:${image.id}`;

interface OrchestratorImageSelectState {
  selected: Record<string, BlobData>;

  // Picker-specific state
  picker: {
    active: boolean;
    maxSelectable: number;
    onConfirm: ((images: BlobData[]) => void) | null;
  };
}

const useStore = create<OrchestratorImageSelectState>()(
  devtools(() => ({
    selected: {},
    picker: { active: false, maxSelectable: 0, onConfirm: null },
  }), { name: 'generated-image-select' })
);
```

**No immer** — BlobData uses private fields (`#step`, `#index`) which break immer's Proxy. Plain zustand with shallow copies works fine since the store shape is simple.

### Exported API (same consumer signatures, richer data)

```ts
export const orchestratorImageSelect = {
  // === Existing API (unchanged call sites) ===
  useSelection: () => BlobData[],              // was { workflowId, stepName, imageId }[]
  useIsSelected: (image: BlobData) => boolean, // was (args: { workflowId, stepName, imageId })
  useIsSelecting: () => boolean,
  toggle: (image: BlobData, value?: boolean) => void,
  setSelected: (images: BlobData[]) => void,
  getSelected: () => BlobData[],

  // === Picker extensions ===
  usePickerActive: () => boolean,
  usePickerMaxReached: () => boolean,
  startPicker: (opts: { maxSelectable: number; onConfirm: (images: BlobData[]) => void }) => void,
  confirmPicker: () => void,
  cancelPicker: () => void,
};
```

### Consumer migration

**`GeneratedImage.tsx`** — call sites change from `{ workflowId, stepName, imageId }` to passing `image` (BlobData) directly:
```ts
// Before:
orchestratorImageSelect.useIsSelected({ workflowId: request.id, stepName: step.name, imageId: image.id })
orchestratorImageSelect.toggle({ workflowId: request.id, stepName: step.name, imageId: image.id })

// After:
orchestratorImageSelect.useIsSelected(image)
orchestratorImageSelect.toggle(image)
```

When picker is active:
- Checkbox reflects selection state as usual (same store)
- Click toggles selection (same `toggle()` call)
- `toggle` respects `picker.maxSelectable` — no-op if at limit and not already selected
- Always shows checkbox (not gated on `isSelecting`)
- Disabled appearance when at max and not selected

**`GeneratedImageActions.tsx`** — `getSelectedImages()` second-pass lookup eliminated:
```ts
// Before:
const selected = orchestratorImageSelect.useSelection(); // { workflowId, stepName, imageId }[]
function getSelectedImages() {
  const selectedIds = selected.map(x => x.imageId);
  return data.flatMap(wf => wf.succeededImages.filter(x => selectedIds.includes(x.id)));
}

// After:
const selected = orchestratorImageSelect.useSelection(); // BlobData[] directly
// getSelectedImages() is gone — `selected` is already what we need
```

When picker is active, hides bulk actions and shows "Selecting images..." context label.

## Image picker flow

### Activation (from ImageUploadMultipleInput)

```ts
orchestratorImageSelect.startPicker({
  maxSelectable: max - currentCount,
  onConfirm: (images) => {
    const newValues = images.map(img => ({ url: img.url, width: img.width, height: img.height }));
    onChange?.([...(value ?? []), ...newValues]);
  },
});
// startPicker also calls generationGraphPanel.setView('queue')
```

### Button on dropzone

Inside `ImageUploadMultipleInput` default layout, wrap the `Dropzone` in a `relative` div with the button as a sibling (not child of Dropzone) to avoid triggering file selection. `e.stopPropagation()` on click.

### Sticky footer

`ImagePickerFooter` renders inside `ScrollableQueue` / `ScrollableFeed` (after Queue/Feed, inside ScrollArea). Uses `shadow-topper sticky bottom-0 z-10` pattern from FormFooter. Shows "{n} of {max} selected" + Cancel + Confirm.

### Tab switching guard

During picker mode, switching to 'generate' tab is blocked (must use Cancel/Confirm). Switching between queue/feed allowed.

### Confirm / Cancel

- `confirmPicker()`: calls `onConfirm(Object.values(selected))`, resets state, `setView('generate')`
- `cancelPicker()`: resets state (clears selection + picker), `setView('generate')`

## Files to modify

| # | File | Change |
|---|------|--------|
| 1 | `src/components/ImageGeneration/utils/generationImage.select.ts` | Rewrite: plain zustand, BlobData storage, picker state |
| 2 | `src/components/ImageGeneration/GeneratedImage.tsx` | Simplify toggle/isSelected calls (pass BlobData), add picker-aware checkbox/click |
| 3 | `src/components/ImageGeneration/GeneratedImageActions.tsx` | Remove `getSelectedImages()` lookup, use BlobData directly. Hide during picker. |
| 4 | **NEW** `src/components/ImageGeneration/ImagePickerFooter.tsx` | Sticky footer: count + Cancel + Confirm |
| 5 | `src/components/ImageGeneration/GenerationTabs.tsx` | Add `ImagePickerFooter` to ScrollableQueue/ScrollableFeed, tab guard |
| 6 | `src/components/generation_v2/inputs/ImageUploadMultipleInput.tsx` | Add `enableGeneratedImagePicker` prop + button |
| 7 | `src/components/generation_v2/GenerationForm.tsx` | Wire `enableGeneratedImagePicker` through `ImagesInput` |

## Implementation order

1. Rewrite `generationImage.select.ts` — BlobData store + picker state
2. Update `GeneratedImage.tsx` — pass BlobData to toggle/isSelected, add picker UI
3. Update `GeneratedImageActions.tsx` — use BlobData directly, remove lookup, hide during picker
4. Create `ImagePickerFooter.tsx`
5. Update `GenerationTabs.tsx` — add footer + tab guard
6. Update `ImageUploadMultipleInput.tsx` — add prop + button
7. Update `GenerationForm.tsx` — wire prop

## Verification

1. `pnpm run typecheck` — no errors
2. Existing bulk select → download/delete/post still works (regression test)
3. Picker: click button on dropzone → select images in queue → confirm → images in form
4. Max enforcement: 3/7 uploaded → picker allows max 4
5. Cancel returns to generate view, no form changes
