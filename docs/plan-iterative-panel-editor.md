# Plan: Iterative Panel Editor (Chat-Based Panel Refinement)

## Overview

A chat-bot-like experience for progressively refining comic panel images. Users start with a blank canvas or existing panel, describe changes via prompts and sketch annotations, and iteratively generate improved images until satisfied. Each "send" produces a new AI-generated image using the previous result as source. Users can revert to any earlier iteration and branch from there.

## Architecture

**New standalone component** — not an extension of PanelModal (already ~1000 lines with 4 tabs). The iterative editor is a fundamentally different UX paradigm: persistent chat-like session vs. one-shot modal.

No server changes needed — the existing `enhancePanel`, `createPanel`, and `replacePanelImage` mutations are sufficient.

## Implementation Status

### Completed (Phases 1-6)

- **Component shell** — `IterativePanelEditor.tsx` (~650 lines): fullscreen modal with chat history + controls sidebar
- **IterationMessage** — `IterationMessage.tsx` (~99 lines): chat entry with image thumbnail, source selection, cost/annotation badges
- **Styles** — `IterativePanelEditor.module.scss` (~270 lines): split layout, mobile responsive at 768px
- **Entry points wired** — "Iterative Edit" in PanelCard context menu + PanelDetailDrawer actions
- **Workspace integration** — `iterativeEditorState` in `index.tsx` with `handleOpenIterativeEditor` / `handleOpenIterativeEditorNew`
- **Generation flow** — First send → `createPanelMutation` (txt2img), subsequent → `enhancePanelMutation` (img2img with `forceGenerate: true`)
- **Polling** — 1.5s interval via `utils.comics.pollPanelStatus.fetch`, updates iteration entry on Ready/Failed
- **Iteration history** — Chat display with auto-scroll, source tracking
- **Revert** — "Use as source" on any past iteration, purely client-side
- **Annotations** — `DrawingEditorModal` integration via `dialogStore.trigger`, uploads annotated blob to CF, resets after each generation
- **Commit** — "Commit to Panel" calls `replacePanelImage` if reverted, else just closes
- **Controls sidebar** — Model selector (`COMIC_MODEL_OPTIONS`), `AspectRatioSelector`, enhance prompt toggle, referenced characters display, `ImageSelectionSection` for over-budget references

### Completed (Phase 7: Polish)

- [x] **Confirmation dialog on close** — `openConfirmModal` warns when iterations exist and user tries to close
- [x] **Keyboard shortcuts** — Ctrl/Cmd+Enter to send via `sendButtonRef` wrapper
- [x] **Error retry** — "Retry" button on failed iterations restores prompt/source and removes failed entry
- [x] **Cost running total** — Session total buzz bar at top of chat area
- [x] **Empty source placeholder** — Improved visual with `IconPhotoPlus` and clearer copy
- [x] **Generation progress indicator** — Mantine `Loader` with pulsing "Generating..." text and skeleton pulse animation

### Remaining (Phase 7: Polish — Deferred)

- [ ] **Mobile testing** — Verify the collapsed single-column layout works well in practice
- [ ] **Discard/cancel generation** — Allow canceling a pending generation mid-flight
- [ ] **Accessibility** — Focus management when modal opens, screen reader labels on iterative messages

### Future Enhancements (Not in scope)

- [ ] **Branching tree view** — When reverting and generating from an earlier iteration, show a tree instead of linear history
- [ ] **Persist iteration history** — Save history server-side so users can resume sessions across page loads
- [ ] **Side-by-side compare** — Compare two iterations visually before choosing one
- [ ] **Prompt templates** — Quick-action buttons like "Add more detail", "Change lighting", "Remove background"

---

## UI Layout

```
┌─────────────────────────────────────────────────────┐
│ Iterative Panel Editor                          [X] │
├──────────────────────────┬──────────────────────────┤
│  Chat / History (60%)    │  Controls Sidebar (40%)  │
│                          │                          │
│  ┌─ Iteration 1 ──────┐ │  [Current source image]  │
│  │ "A beach scene"     │ │                          │
│  │ [result image]      │ │  Model: [Nano Banana ▼]  │
│  │ ○ Use as source     │ │  Aspect: [4:3] [16:9]...│
│  └─────────────────────┘ │  Enhance prompt: [✓]     │
│                          │                          │
│  ┌─ Iteration 2 ──────┐ │  References:             │
│  │ "Add @Hero here"    │ │  [@Hero] [2/5 images]    │
│  │ [result image] ★    │ │  [@Villain] [all]        │
│  │ ● Current source    │ │                          │
│  └─────────────────────┘ │                          │
│                          │                          │
│  ┌─ Input area ────────┐ │                          │
│  │ @mention prompt...  │ │                          │
│  │ [✏ Annotate] [💎42] │ │  [Commit to Panel]      │
│  └─────────────────────┘ │                          │
└──────────────────────────┴──────────────────────────┘
```

On mobile: single column with controls in a collapsible section at the top.

## State Management

All state is **client-only during the session**. The server already stores panels/workflows — iteration history is ephemeral UI state for the editing session.

```typescript
interface IterationEntry {
  id: string;                         // client-generated unique ID
  prompt: string;                     // prompt used for this iteration
  annotated: boolean;                 // whether sketch annotations were applied
  sourceImage: SourceImage | null;    // the source image fed INTO this generation
  resultImage: SourceImage | null;    // the image produced (null while generating)
  cost: number;                       // buzz spent
  timestamp: Date;
  status: 'generating' | 'ready' | 'error';
  errorMessage?: string;
}

interface SourceImage {
  url: string;          // CF image ID or URL
  previewUrl: string;   // thumbnail URL
  width: number;
  height: number;
}

// Core component state
const [iterations, setIterations] = useState<IterationEntry[]>([]);
const [currentSource, setCurrentSource] = useState<SourceImage | null>(initialSource);
const [annotationElements, setAnnotationElements] = useState<DrawingElement[]>([]);
const [originalSourceUrl, setOriginalSourceUrl] = useState<string | null>(null);
const [stagingPanelId, setStagingPanelId] = useState<number | null>(existingPanelId);
const [isGenerating, setIsGenerating] = useState(false);
```

`currentSource` starts as:
- The existing panel image (if editing an existing panel)
- `null` (if starting fresh — first generation uses txt2img)

## Generation Flow

1. User types prompt, optionally annotates current source image
2. Clicks BuzzTransactionButton (shows cost per generation)
3. **If first generation (no source):** calls `createPanelMutation` → creates panel at target position
4. **If subsequent:** calls `enhancePanelMutation` with current source as `sourceImageUrl`, `forceGenerate: true`
5. Polls panel status until Ready (1.5s interval via `pollPanelStatus`)
6. Result image added to iteration history, becomes new `currentSource`
7. Annotations and `originalSourceUrl` reset to `[]` / `null`

The staging panel approach: first "send" creates the panel normally (it appears in the chapter at the target position). Subsequent sends use `enhancePanelMutation` which deletes the old panel and creates a new one at the same position. Only one panel exists in the chapter at any time.

## Revert Mechanism

When the user clicks a previous iteration's "Use as source" button:

1. Set `currentSource` to that iteration's `resultImage`
2. Clear `annotationElements` (annotations are baked into each generated image)
3. Clear `originalSourceUrl`
4. The next "send" uses this reverted image as source

This is purely a client-side state change. No server calls. The iteration history remains intact — users can see the full history even after reverting.

## Annotations

- Annotations **reset after each generation** — they're composited into the source image when generating, producing a new image with annotations "baked in"
- After generation completes: `annotationElements → []`, `originalSourceUrl → null`
- User can annotate the NEW result image for the next iteration
- Uses existing `DrawingEditorModal` component, opened via `dialogStore.trigger` with `confirmLabel: 'Apply Annotations'`

## Commit to Panel

When user clicks "Commit to Panel":

```typescript
if (currentSource.url !== latestPanelImageUrl) {
  // User reverted to a non-latest image — replace the panel image
  await replacePanelImageMutation.mutateAsync({
    panelId: stagingPanelId,
    imageUrl: currentSource.url,
  });
}
onClose();
refetch(); // refresh project data
```

If the latest generation is already the current source, the staging panel already has the right image — just close.

## Cost Display

- BuzzTransactionButton shows `panelCost + (enhancePrompt ? enhanceCost : 0)` per send
- Each `IterationMessage` shows a small badge with the cost paid
- Persistent info text: "Each generation costs ~{cost} Buzz"

## Key Design Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| New component vs extend PanelModal? | New component | Different UX paradigm; avoids prop explosion in already-complex modal |
| History persistence? | Client-only during session | Server stores panels/workflows; no separate history table needed |
| Staging approach? | First send creates panel, subsequent sends replace it | One panel exists in chapter at all times; no cleanup needed |
| Revert mechanism? | Change `currentSource` state | Pure client-side; click any past image to use as next source |
| Annotations across iterations? | Reset after each generation | Annotations are baked into the generated image |
| First gen (no source image)? | `createPanelMutation` (txt2img), then `enhancePanelMutation` (img2img) | Matches existing pipeline |
| Commit flow? | Close editor; `replacePanelImage` if reverted | Staging panel already exists; minimal server work |

## File Changes

### New Files (Created)

| File | Description | Lines |
|------|-------------|-------|
| `src/components/Comics/IterativePanelEditor.tsx` | Main modal: chat history, controls sidebar, generation orchestration | ~650 |
| `src/components/Comics/IterationMessage.tsx` | Single chat entry: prompt, image thumbnail, "Use as source", cost badge | ~99 |
| `src/components/Comics/IterativePanelEditor.module.scss` | Layout styles for chat, sidebar, messages, mobile responsive | ~270 |

### Modified Files (Done)

| File | Changes |
|------|---------|
| `src/pages/comics/project/[id]/index.tsx` | Added `iterativeEditorState` state, `handleOpenIterativeEditor`/`handleOpenIterativeEditorNew` handlers, renders `<IterativePanelEditor>` with all props |
| `src/components/Comics/PanelCard.tsx` | Added `onIterativeEdit` prop, "Iterative Edit" menu item (IconMessages, only on Ready panels with images) |
| `src/components/Comics/PanelDetailDrawer.tsx` | Added `onIterativeEdit` prop, "Iterative Edit" button in drawer actions |

### Server — No Changes

Existing mutations are sufficient:
- `createPanel` — first txt2img generation
- `enhancePanel` — subsequent img2img iterations
- `replacePanelImage` — commit a reverted image
- `getCostEstimate` / `getPromptEnhanceCostEstimate` — cost display

## Components Reused

These existing components are imported directly:
- `MentionTextarea` — prompt input with @mention support
- `AspectRatioSelector` — aspect ratio picker
- `BuzzTransactionButton` — cost-aware submit button
- `DrawingEditorModal` — sketch annotation overlay (via `dialogStore.trigger`)
- `ImageSelectionSection` (from PanelModal) — reference image picker when over budget
- `useCFImageUpload` — upload annotated images to CloudFlare
