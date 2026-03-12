# Plan: Iterative Panel Editor (Chat-Based Panel Refinement)

## Overview

A chat-bot-like experience for progressively refining comic panel images. Users start with a blank canvas or existing panel, describe changes via prompts and sketch annotations, and iteratively generate improved images until satisfied. Each "send" produces a new AI-generated image using the previous result as source. Users can revert to any earlier iteration and branch from there.

## Architecture

**New standalone component** — not an extension of PanelModal (already ~1000 lines with 4 tabs). The iterative editor is a fundamentally different UX paradigm: persistent chat-like session vs. one-shot modal.

No server changes needed — the existing `enhancePanel`, `createPanel`, and `replacePanelImage` mutations are sufficient.

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
5. Polls panel status until Ready (reuse existing polling pattern from workspace)
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
- Uses existing `DrawingEditorModal` component

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

### New Files

| File | Description | ~Lines |
|------|-------------|--------|
| `src/components/Comics/IterativePanelEditor.tsx` | Main modal: chat history, controls sidebar, generation orchestration | 400-500 |
| `src/components/Comics/IterationMessage.tsx` | Single chat entry: prompt, image thumbnail, "Use as source", cost badge | 80-100 |
| `src/components/Comics/IterativePanelEditor.module.scss` | Layout styles for chat, sidebar, messages | ~150 |

### Modified Files

| File | Changes |
|------|---------|
| `src/pages/comics/project/[id]/index.tsx` | Add state + handler for opening/closing editor, render `<IterativePanelEditor>`, pass through props (projectId, chapterPosition, references, cost estimates, model/aspect ratio, mutations) |
| `src/components/Comics/PanelCard.tsx` | Add "Iterative Edit" option to panel context menu |
| `src/components/Comics/PanelDetailDrawer.tsx` | Add `onIterativeEdit` prop and button (e.g., `IconMessages` icon) |

### Server — No Changes

Existing mutations are sufficient:
- `createPanel` — first txt2img generation
- `enhancePanel` — subsequent img2img iterations
- `replacePanelImage` — commit a reverted image
- `getCostEstimate` / `getPromptEnhanceCostEstimate` — cost display

## Implementation Phases

### Phase 1: Component Shell
- Create `IterativePanelEditor.tsx` with modal layout
- Empty chat area + controls sidebar (model, aspect ratio, enhance toggle, references)
- Wire open/close in workspace (`index.tsx`)
- Entry points from PanelCard menu and PanelDetailDrawer

### Phase 2: First Generation
- Implement "send" flow → `createPanelMutation` (when no source) or `enhancePanelMutation` (when source exists)
- Poll panel status until Ready
- Display first iteration result in chat

### Phase 3: Iteration History + Source Tracking
- Build iteration history display with `IterationMessage` components
- Each completed generation adds to history and updates `currentSource`
- Auto-scroll to latest message

### Phase 4: Revert
- "Use as source" button on each iteration message
- Updates `currentSource` to that entry's result image
- Visual indicator showing which image is the current source

### Phase 5: Annotations
- Integrate `DrawingEditorModal` for annotating current source
- Follow PanelModal's `handleAnnotateSource` pattern
- Reset annotations after each generation
- Show annotation indicator badge near the input area

### Phase 6: Commit and Close
- "Commit to Panel" button — `replacePanelImage` if reverted, else just close
- Handle edge cases: no generations yet, generation in progress, error state
- Confirmation dialog if uncommitted changes

### Phase 7: Polish
- Cost badge per iteration message
- Generating spinner / skeleton states
- Error handling and retry
- Mobile responsive layout (collapsed sidebar)
- Keyboard shortcuts (Enter to send, Ctrl+Z to revert?)

## Components to Reuse

These existing components can be imported directly:
- `MentionTextarea` — prompt input with @mention support
- `AspectRatioSelector` — aspect ratio picker
- `BuzzTransactionButton` — cost-aware submit button
- `DrawingEditorModal` — sketch annotation overlay
- `ImageSelectionSection` (from PanelModal) — reference image picker
- `EdgeImage` — optimized image display
