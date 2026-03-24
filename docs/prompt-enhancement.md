# Prompt Enhancement Feature

## Overview

A standalone feature that allows users to enhance their generation prompts via the orchestrator's `promptEnhancement` workflow step. Users can iteratively refine prompts before applying them to the generation form.

## Current Implementation (WIP — being refactored to drawer)

- Backend: tRPC mutation (`orchestrator.enhancePrompt`) submits a workflow with `$type: 'promptEnhancement'` and `wait: true`
- Frontend: Currently a modal, being replaced with a right-side drawer
- Inputs: prompt, negative prompt, instructions, temperature slider
- Result view shows: enhanced prompt, enhanced negative prompt, issues, recommendations
- Actions: Apply, Enhance Again, Cancel

---

## UI Design: Right-Side Drawer

### Layout

- **Drawer** opens from the **right** side of the screen
- **Overlay**, no backdrop — desktop users can still interact with the rest of the site
- **Two tabs** inside the drawer:
  1. **Enhance** — the active enhancement workspace
  2. **History** — past prompt enhancement results

### Enhance Tab

The current modal content moves here:

- Prompt textarea (pre-filled from generation form)
- Negative prompt textarea (if applicable)
- Instructions textarea
- Temperature / creativity slider
- Submit button (BuzzTransactionButton, 1 Buzz)
- Loading state
- Result view with Apply / Enhance Again actions
- State persists naturally since the drawer stays mounted (no data loss on close/reopen)

### History Tab

Compact log format with inline word-level diff view. History persists across sessions via orchestrator workflow queries.

**List view — each row shows:**

- Timestamp
- Ecosystem badge
- First ~50 chars of the original prompt (truncated)
- Status indicator (applied / not applied)

**Expanded view — clicking a row reveals:**

- Full original → enhanced prompt with **word-level inline diff** (green additions, red/strikethrough removals)
- Negative prompt diff (if applicable)
- Issues and recommendations from that enhancement
- "Apply" button to use this historical result in the current form

### Mobile Considerations

- On mobile, the drawer could become full-width or switch to a bottom sheet
- History tab is especially useful on mobile where re-typing is painful

---

## Reusing Existing Infrastructure

### What we can reuse from `generationRequestHooks.ts`

The existing hook infrastructure is built around `queryGeneratedImages` → `queryGeneratedImageWorkflows2`, which is tightly coupled to image/video workflows (it wraps results in `WorkflowData`/`BlobData`, handles image metadata, marker tags like favorite/liked, etc.). The prompt enhancement data shape is fundamentally different — text in/out rather than image blobs.

However, several lower-level patterns are reusable:

| Pattern | Source | How to reuse |
| --- | --- | --- |
| Tag-based workflow querying | `useGetTextToImageRequests` filters by `WORKFLOW_TAGS.GENERATION` | Create `useGetPromptEnhancementHistory` that filters by `'prompt-enhancement'` tag using the same `queryWorkflows` endpoint |
| Infinite scroll pagination | `useInfiniteQuery` + `getNextPageParam: lastPage.nextCursor` | Same cursor-based pagination pattern for history list |
| Optimistic cache updates | `updateTextToImageRequests` pattern with `produce` | Same pattern for inserting newly completed enhancements into the history cache |
| Signal-based live updates | `useTextToImageSignalUpdate` debounce pattern | Could subscribe to same signal channel if prompt enhancement emits step events (with `wait: true` this is less critical since we already wait for completion) |
| Delete workflow | `useDeleteTextToImageRequest` wraps `deleteWorkflow` mutation | Reuse directly — `deleteWorkflow` is workflow-type-agnostic |

### What needs to be new

- **Query endpoint**: We can use the existing `queryWorkflows` (raw workflow query) instead of `queryGeneratedImages` (image-specific wrapper). This avoids the `WorkflowData`/`BlobData` layer entirely.
- **Data mapping**: Extract `input.prompt`, `input.ecosystem`, `output.enhancedPrompt`, etc. from the raw `PromptEnhancementStep` on each workflow. This is a simple mapping function, not a new API.
- **History hook**: `useGetPromptEnhancementHistory` — thin wrapper around `trpc.orchestrator.queryWorkflows` with `tags: ['prompt-enhancement']`, returns mapped enhancement records.

### Recommendation

@ai: Don't force prompt enhancement into the `queryGeneratedImages` pipeline. Instead, build a parallel but structurally similar hook (`useGetPromptEnhancementHistory`) that:

1. Uses the existing `queryWorkflows` tRPC endpoint (already in the router) with `tags: ['prompt-enhancement']`
2. Follows the same infinite query + cursor pagination pattern
3. Maps raw workflow data to a `PromptEnhancementRecord` type (timestamp, ecosystem, input prompt, output prompt, issues, recommendations)
4. Uses the same `produce`-based cache update pattern to insert new enhancements after mutation success

This gives us the same UX patterns (infinite scroll, live updates, delete) without fighting the image-specific abstractions.

---

## Technical Notes

### Files

| Layer | File |
| --- | --- |
| Schema | `src/server/schema/orchestrator/promptEnhancement.schema.ts` |
| Service | `src/server/services/orchestrator/promptEnhancement.ts` |
| Router | `src/server/routers/orchestrator.router.ts` (enhancePrompt endpoint) |
| Modal (current) | `src/components/Generation/PromptEnhance/PromptEnhanceModal.tsx` |
| Trigger (current) | `src/components/Generation/PromptEnhance/triggerPromptEnhance.ts` |
| V2 Form | `src/components/generation_v2/GenerationForm.tsx` |
| Legacy Form | `src/components/ImageGeneration/GenerationForm/GenerationForm2.tsx` |

### Planned New Files

| File | Purpose |
| --- | --- |
| `src/components/Generation/PromptEnhance/PromptEnhanceDrawer.tsx` | Main drawer with tab layout |
| `src/components/Generation/PromptEnhance/EnhanceTab.tsx` | Active enhancement workspace (extracted from modal) |
| `src/components/Generation/PromptEnhance/HistoryTab.tsx` | History list with expand/diff |
| `src/components/Generation/PromptEnhance/PromptDiff.tsx` | Word-level diff rendering component |
| `src/components/Generation/PromptEnhance/promptEnhanceHooks.ts` | `useGetPromptEnhancementHistory` + cache update helpers |
| `src/store/prompt-enhance.store.ts` | Zustand store for drawer open state + current enhancement state |

### API Shape

- Input: `{ ecosystem, prompt, negativePrompt?, temperature?, instruction? }`
- Output: `{ workflowId, output: { enhancedPrompt, enhancedNegativePrompt?, issues[], recommendations[] } }`
- Cost: 1 Buzz per request (placeholder, TBD)
- Tags: `['civitai', 'prompt-enhancement']`

### History Data

- Query existing workflows filtered by `prompt-enhancement` tag via `queryWorkflows` (already exists in router)
- Each workflow step contains `input` (original prompt) and `output` (enhanced prompt)
- Word-level diff computed client-side (e.g., `diff` npm package or lightweight custom implementation)
- Infinite scroll pagination using same cursor pattern as image generation history

---

## Trigger Word Preservation

### Problem

Users often include LoRA trigger words in their prompts (e.g., `ohwx`, `sks`, `style_xyz`). These look like gibberish to the LLM performing enhancement, so it will strip or rephrase them. Additionally, word order in prompts can affect generation output, so trigger word placement matters.

### Approach: Instruction-based preservation (Option A)

When the user has active resources with trigger words, we auto-populate the `instruction` field with a directive like:

```
Preserve these exact trigger words in the prompt: ohwx, sks, style_xyz
```

This instruction is **visible and editable** in the Enhance tab — the user can see what we're doing and remove or modify it if they want. The LLM can make intelligent decisions about where to place the triggers relative to the restructured prompt.

After the result comes back, we verify trigger words are still present. If any are missing, we surface a warning to the user.

### Resource metadata in workflow

We store the active resource data (IDs, trigger words) in the workflow metadata when submitting the enhancement. This serves two purposes:

1. **History tab**: When viewing past enhancements, we can hydrate the resources and know which trigger words were relevant at that time
2. **Trigger word highlighting**: In both the Enhance result view and History tab, we can highlight trigger words in the enhanced prompt output (e.g., with a distinct background color or badge), making it easy to verify they were preserved and see where they ended up

### Data flow

1. **Trigger** — When opening the drawer, pass the current resources (IDs + trigger words) alongside prompt/ecosystem
2. **Store** — Zustand store holds `resources: { id: number, trainedWords: string[] }[]`
3. **Instruction** — Auto-generate a trigger word preservation instruction, pre-fill the instruction textarea. User can edit/remove
4. **Submit** — Include resources in workflow `metadata` (same pattern as generation form)
5. **Result** — Highlight any trigger words found in the enhanced prompt output
6. **History** — Hydrate resources from workflow metadata, highlight trigger words in diff view

### Implementation changes needed

- **Store**: Add `resources` field with resource IDs and trigger words
- **Trigger**: Pass resources from both generation forms (v2 uses `triggerWords` from graph, legacy uses `resources[].trainedWords`)
- **EnhanceTab**: Auto-populate instruction with trigger word directive when resources have trained words
- **Service**: Include resources in workflow `metadata` when submitting
- **Schema**: Add optional `resources` to the input schema (for metadata storage, not sent to the LLM)
- **PromptDiff / result views**: Highlight trigger words with a distinct style (e.g., underline or colored background)
