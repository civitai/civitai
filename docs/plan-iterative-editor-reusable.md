# Plan: Extract Iterative Editor into Reusable Page + Component

## Context

The iterative image editor (chat-based image refinement) is currently a modal embedded in the comics workspace (`IterativePanelEditor.tsx`). It's tightly coupled to comic concepts (panels, chapters, references). The user wants it to be:
1. **Its own standalone page** — accessible at `/images/iterate`
2. **A reusable component** — works with any image, not just comic panels

The core experience (chat history, iterate, revert, annotate, poll, signals) is inherently generic. The comic-specific parts (reference resolution, panel CRUD, project/chapter context) should be isolated into a thin wrapper.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Generic Core: IterativeImageEditor                  │
│  (src/components/IterativeEditor/)                   │
│                                                      │
│  - Chat history + iteration messages                 │
│  - Prompt input (optional @mentions)                 │
│  - Annotations via DrawingEditorModal                │
│  - Model/aspect ratio/enhance controls               │
│  - Polling + signal-based fast updates               │
│  - Keyboard shortcuts, confirmation dialog           │
│  - Configurable via callbacks + config object        │
├──────────────────┬──────────────────────────────────┤
│  Standalone Page  │  Comic Wrapper (modal)           │
│  /images/iterate  │  IterativePanelEditor.tsx        │
│                   │                                  │
│  Uses orchestrator│  Uses comics.iterateGenerate     │
│  endpoints        │  Passes comic references         │
│  Generic commit   │  Commits to panel on close       │
└──────────────────┴──────────────────────────────────┘
```

---

## File Changes

### New Files

| File | Description |
|------|-------------|
| `src/components/IterativeEditor/IterativeImageEditor.tsx` | Generic core component (~600 lines, extracted from current IterativePanelEditor) |
| `src/components/IterativeEditor/IterativeImageEditor.module.scss` | Styles (copy of current SCSS, with `mode` variants for page vs modal) |
| `src/components/IterativeEditor/IterationMessage.tsx` | Move from Comics/ |
| `src/components/IterativeEditor/AspectRatioSelector.tsx` | Move from Comics/ (already fully generic) |
| `src/components/IterativeEditor/MentionTextarea.tsx` | Move from Comics/ (already generic — accepts `references` prop) |
| `src/components/IterativeEditor/iterative-editor.types.ts` | Shared types: `SourceImage`, `IterationEntry`, `IterativeEditorConfig` |
| `src/pages/images/iterate.tsx` | Standalone page |
| `src/server/services/orchestrator/poll-iteration.ts` | Shared poll logic (extracted from comics router) |

### Modified Files

| File | Changes |
|------|---------|
| `src/server/routers/orchestrator.router.ts` | Add `iterateGenerate` mutation + `pollIterationStatus` query (generic, no comic flag) |
| `src/server/routers/comics.router.ts` | Refactor `pollIterationStatus` to use shared util |
| `src/components/Comics/IterativePanelEditor.tsx` | Rewrite as thin wrapper around `IterativeImageEditor` |
| `src/components/Comics/comic-project-constants.ts` | No change (comic wrapper imports these directly) |
| `src/components/Comics/AspectRatioSelector.tsx` | Re-export from new location |
| `src/components/Comics/MentionTextarea.tsx` | Re-export from new location |
| `src/components/Comics/IterationMessage.tsx` | Re-export from new location |

---

## Component Interface

```typescript
// iterative-editor.types.ts
interface IterativeEditorConfig {
  modelOptions: { value: string; label: string }[];
  modelSizes: Record<string, { label: string; width: number; height: number }[]>;
  defaultModel: string;
  defaultAspectRatio: string;
  generationCost: number;
  enhanceCost: number;
  commitLabel?: string;  // Default: "Save Image"
}

// IterativeImageEditor.tsx
interface IterativeImageEditorProps {
  initialSource?: SourceImage | null;
  config: IterativeEditorConfig;

  // Generation callbacks (abstracts tRPC)
  onGenerate: (params: GenerateParams) => Promise<{ workflowId: string; width: number; height: number }>;
  onPollStatus: (params: PollParams) => Promise<{ status: string; imageUrl: string | null }>;
  onCommit?: (source: SourceImage) => Promise<void> | void;
  onClose?: () => void;

  // Optional features
  mentions?: { id: number; name: string }[];
  referenceImages?: { id: number; name: string; images?: any[] }[];

  // Layout
  mode?: 'page' | 'modal';  // 'page' = full viewport, 'modal' = fills parent
}
```

---

## Server Endpoints

### `orchestrator.iterateGenerate` (new, generic)

Takes pre-resolved inputs — no comic DB lookups:
- `prompt`, `enhance`, `aspectRatio`, `baseModel`
- Optional: `sourceImageUrl`, `sourceImageWidth`, `sourceImageHeight`
- Optional: `referenceImages: { url, width, height }[]`

Calls `createImageGen` directly. Returns `{ workflowId, width, height }`.

### `orchestrator.pollIterationStatus` (new, generic)

Takes `{ workflowId, width?, height?, prompt? }`.
Polls orchestrator → on success downloads to S3 → creates Image record.
Returns `{ status, imageUrl, imageId }`.

Both use `protectedProcedure` (auth only, no feature flag).

### Shared utility: `pollIterationWorkflow()`

`src/server/services/orchestrator/poll-iteration.ts` — extracted from comics router.
Both `orchestrator.pollIterationStatus` and `comics.pollIterationStatus` call this.

---

## Standalone Page (`/images/iterate`)

```
src/pages/images/iterate.tsx
```

- Auth-gated via `createServerSideProps`
- Accepts optional query params: `?imageUrl=...&width=...&height=...`
- Uses `orchestrator.iterateGenerate` + `orchestrator.pollIterationStatus`
- On commit: shows success notification (image already saved as Image record during poll)
- Full-viewport layout (no sidebar chrome)

---

## Comic Wrapper (thin)

`src/components/Comics/IterativePanelEditor.tsx` becomes ~80 lines:

1. Wraps `IterativeImageEditor` in a `<Modal>`
2. Provides `onGenerate` → calls `comics.iterateGenerate` (with projectId, chapterPosition)
3. Provides `onPollStatus` → calls `comics.pollIterationStatus`
4. Provides `onCommit` → calls `replacePanelImage` (existing panel) or `enhancePanel` (new panel)
5. Passes comic references as `mentions` + `referenceImages`
6. Passes comic model config as `config`

---

## Implementation Order

1. **Types + constants** — `iterative-editor.types.ts`
2. **Move sub-components** — `IterationMessage`, `AspectRatioSelector`, `MentionTextarea` to `IterativeEditor/`, add re-exports
3. **Extract shared poll utility** — `poll-iteration.ts`
4. **Add orchestrator endpoints** — `iterateGenerate` + `pollIterationStatus`
5. **Create generic component** — `IterativeImageEditor.tsx` + SCSS
6. **Rewrite comic wrapper** — thin `IterativePanelEditor.tsx`
7. **Create standalone page** — `src/pages/images/iterate.tsx`
8. **Refactor comics router** — `pollIterationStatus` uses shared util

## Verification

1. `pnpm run typecheck` — zero new errors
2. Comics: Open iterative editor from panel card → generate → commit → panel updated
3. Standalone: Navigate to `/images/iterate` → generate from scratch → commit → image saved
4. Standalone with initial image: `/images/iterate?imageUrl=...` → shows source → iterate → commit
5. Signal fast-polling works in both contexts
