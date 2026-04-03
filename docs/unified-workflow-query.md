# Unified Workflow Query Endpoint

## Goal

Consolidate `queryGeneratedImages` and `queryPromptEnhancements` (and future workflow types) into a single tRPC endpoint that can return all orchestrator workflow types.

## Current State

Two separate query paths exist:

| Endpoint | Tag Filter | Server Processing | Client Consumer |
| --- | --- | --- | --- |
| `queryGeneratedImages` | `generation` | `formatGenerationResponse2` (~200 lines: resource enrichment, legacy metadata normalization, image blob formatting) | Queue.tsx, Feed.tsx via `useGetTextToImageRequests` |
| `queryPromptEnhancements` | `prompt-enhancement` | None (raw `queryWorkflows` passthrough) | HistoryTab.tsx via `useGetPromptEnhancementHistory` |

Both call the same underlying orchestrator API (`queryWorkflows`), which is already type-agnostic. The divergence is entirely in our server-side formatting layer.

## Proposed Approach

### 1. Single tRPC endpoint

Rename/replace `queryGeneratedImages` with a unified `queryWorkflows` endpoint. Remove the hardcoded `generation` tag filter — let clients pass whatever tags they need.

### 2. Type-aware server formatter

`formatGenerationResponse2` currently assumes every workflow contains image/video steps. Make it type-aware:

```
switch (step.$type) {
  case 'textToImage':
  case 'videoGen':
    // existing image/video formatting (resource enrichment, blob processing, legacy compat)
    break;
  case 'promptEnhancement':
    // passthrough or light normalization (input/output are self-contained)
    break;
  default:
    // generic passthrough for unknown types
    break;
}
```

### 3. Discriminated union response

Return a response where each workflow item carries a `type` discriminator:

```typescript
type NormalizedWorkflow =
  | { type: 'generation'; /* existing image/video fields */ }
  | { type: 'promptEnhancement'; /* input/output/issues/recommendations */ }
  | { type: 'unknown'; /* raw step data */ };
```

### 4. Client-side filtering

- Queue/Feed: filter to `type === 'generation'`
- History tab: filter to `type === 'promptEnhancement'`
- Or render mixed content in a unified feed with type-specific card components

## Key Challenges

### Legacy format handling

`formatGenerationResponse2` handles multiple metadata formats:

- New format: `workflow.metadata.params` + `workflow.metadata.resources`
- Legacy format: `step.metadata.params` + `step.metadata.resources`
- Legacy enhancement format: `step.metadata.transformations[last]`

This logic must remain for image workflows but must not run for prompt enhancement workflows (it would fail or produce garbage).

### Resource enrichment

Image workflows enrich resource IDs with model names, versions, epoch numbers. This hits the database. Prompt enhancement workflows have no resources. The enrichment step needs to be conditional.

### Signal updates

`useTextToImageSignalUpdate` subscribes to `SignalMessages.TextToImageUpdate` and updates the React Query cache. A unified query would need either:

- A unified signal channel, or
- Multiple signal subscriptions that update the same cache

### `WorkflowData` / `BlobData` wrappers

The client wraps image workflows in `WorkflowData` and extracts `BlobData` for images. These are tightly coupled to image output. A unified query would need polymorphic wrappers or skip wrapping for non-image types.

## Estimated Effort

2-3 days. The main work is:

1. Making `formatGenerationResponse2` type-aware without breaking existing image workflows (~1 day)
2. Updating client-side hooks and components to handle the discriminated union (~1 day)
3. Testing legacy workflow formats still render correctly (~0.5 day)

## Recommendation

Do this as a follow-up, not as part of the prompt enhancement feature. The current two-endpoint approach works and is clean enough. Unification becomes worthwhile when adding a third orchestrator workflow type, at which point the pattern of "new endpoint per type" starts to feel redundant.
