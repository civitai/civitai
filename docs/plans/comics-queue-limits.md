# Comics Generation Queue Limits

## Implementation Status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Server-Side Queue Checking | ✅ Complete | `queue-limits.ts` created |
| Phase 2: Multi-Panel Fail-Fast Checks | ✅ Complete | `assertCanGenerate(panelCount)` at start |
| Phase 3: Single-Panel Endpoints | ✅ Complete | `assertCanGenerate` added |
| Phase 4: Queue Status Endpoint | ✅ Complete | `getQueueStatus` added |
| Phase 5: Frontend Updates | ✅ Complete | Queue warnings in SmartCreateModal & PanelModal |

## Summary

Comics generation must respect the same queue limits as the main image generator. This plan covers:
1. Server-side enforcement before submitting workflows
2. Smart Create handling (**fail-fast** - check all slots upfront)
3. Frontend queue status display and validation
4. Affected endpoints: `createPanel`, `smartCreateChapter`, `enhancePanel`, `iterateGenerate`, `bulkCreatePanels`

> **Note**: Initially planned wait-and-retry approach (Option B) was rejected due to server load concerns.
> The current implementation uses **fail-fast** - check all required slots before starting any generation.

## Problem Statement

Users have generation queue limits based on their membership tier:
- **Free**: 4 concurrent jobs
- **Founder/Bronze**: 8 concurrent jobs
- **Silver/Gold**: 10 concurrent jobs

Currently, comics generation does NOT respect these limits:
1. Users can create panels even when their queue is full
2. **Smart Create** can request multiple panels (up to 20) regardless of available slots
3. There's no server-side enforcement - the orchestrator may reject or the user exceeds their limit

## Current Architecture

### Client-Side (Main Generator)
- `GenerationProvider.tsx` tracks queued workflows via `useGetTextToImageRequests`
- Calculates `requestsRemaining = limits.queue - queuedRequests.length`
- Uses `POLLABLE_STATUSES` to identify in-progress jobs: `[UNASSIGNED, PREPARING, SCHEDULED, PROCESSING]`
- `canGenerate` flag prevents UI from allowing generation when queue is full

### Server-Side (Comics)
- `comics.router.ts` calls `submitWorkflow` directly
- No pre-flight queue limit checking
- `smartCreateChapter` loops through panels sequentially but doesn't check limits

### Queue Limit Source
- Defined in `src/server/schema/generation.schema.ts`: `defaultsByTier`
- Accessed via `getGenerationStatus()` which reads from Redis

## Proposed Solution

### Phase 1: Server-Side Queue Checking

#### 1.1 Create Queue Helper Function

Location: `src/server/services/orchestrator/queue-limits.ts`

```typescript
import { WorkflowStatus } from '@civitai/client';
import type { GenerationLimits } from '~/server/schema/generation.schema';
import { defaultsByTier, getGenerationStatus } from '~/server/services/generation/generation.service';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { POLLABLE_STATUSES } from '~/shared/constants/orchestrator.constants';

export interface QueueStatus {
  used: number;
  limit: number;
  available: number;
  canGenerate: boolean;
}

export async function getUserQueueStatus(
  token: string,
  userTier: UserTier = 'free'
): Promise<QueueStatus> {
  // Get tier-based limits
  const status = await getGenerationStatus();
  const limits = status.limits[userTier] ?? defaultsByTier[userTier];
  const queueLimit = limits.queue;

  // Query active workflows for this user
  const { items: workflows } = await queryWorkflows({
    token,
    tags: ['gen'], // WORKFLOW_TAGS.GENERATION
    statuses: POLLABLE_STATUSES,
    take: queueLimit + 1, // Just need to know if at/over limit
    hideMatureContent: false,
  });

  const used = workflows?.length ?? 0;
  const available = Math.max(0, queueLimit - used);

  return {
    used,
    limit: queueLimit,
    available,
    canGenerate: available > 0 && status.available,
  };
}

export async function assertCanGenerate(
  token: string,
  userTier: UserTier,
  requestedSlots: number = 1
): Promise<void> {
  const status = await getUserQueueStatus(token, userTier);

  if (status.available < requestedSlots) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Queue limit reached. You have ${status.used}/${status.limit} jobs running. Available slots: ${status.available}`,
    });
  }
}
```

#### 1.2 Add Queue Check to Comics Endpoints

Update `comics.router.ts` to check queue before generation:

```typescript
// In createPanel mutation
createPanel: comicProtectedProcedure
  .input(createPanelSchema)
  .use(isChapterOwner)
  .mutation(async ({ ctx, input }) => {
    const token = await getOrchestratorToken(ctx.user!.id, ctx);
    const userTier = ctx.user?.tier ?? 'free';

    // Check queue limit before proceeding
    await assertCanGenerate(token, userTier, 1);

    // ... existing logic
  }),
```

### Phase 2: Smart Create Queue Management

Smart Create has special considerations because it generates multiple panels.

#### ~~Option A: Fail-Fast Approach~~ ✅ **SELECTED**
- Check if user has enough slots for ALL panels before starting
- Fail immediately if not enough slots available
- Pros: Simple, predictable, no server load from polling
- Cons: User must wait for entire queue to clear

#### ~~Option B: Wait-and-Retry Approach~~ ❌ **REJECTED**
- Initially considered polling approach where server waits for slots
- Rejected due to **server load concerns** - keeping connections open for polling adds load
- Future consideration: Use job system to create panels in "enqueued" status and process them via background workers

**Implementation: Fail-Fast with `assertCanGenerate(panelCount)`**

```typescript
// In smartCreateChapter mutation - check ALL slots upfront
smartCreateChapter: comicProtectedProcedure
  .input(smartCreateChapterSchema)
  .use(isProjectOwner)
  .mutation(async ({ ctx, input }) => {
    const panelCount = input.panels.length;
    const token = await getOrchestratorToken(ctx.user!.id, ctx);

    // Fail-fast: check all required slots before creating any panels
    await assertCanGenerate(token, ctx.user?.tier ?? 'free', panelCount);

    // ... proceed with panel creation
  })

// In bulkCreatePanels mutation - count panels needing generation
bulkCreatePanels: comicProtectedProcedure
  .mutation(async ({ ctx, input }) => {
    const batchToken = await getOrchestratorToken(ctx.user!.id, ctx);

    // Count panels that need generation (Mode 3 and Mode 4 only)
    const panelsNeedingGeneration = input.panels.filter((p) => {
      const hasPrompt = !!p.prompt?.trim();
      const hasExistingImage = p.imageId != null;
      return !hasExistingImage && hasPrompt;
    }).length;

    // Fail-fast: check all required slots before creating any panels
    if (panelsNeedingGeneration > 0) {
      await assertCanGenerate(batchToken, ctx.user?.tier ?? 'free', panelsNeedingGeneration);
    }

    // ... proceed with panel creation
  })
```

#### Benefits of Fail-Fast Approach

1. **No server load** - No long-running connections or polling
2. **Predictable behavior** - Clear error message if not enough slots
3. **Simple implementation** - Just a pre-check before starting
4. **Clean failure** - No partial state if queue is full

#### Future Enhancement: Job-Based Enqueued Panels

For a more user-friendly experience, consider:
1. Create panels in "enqueued" status immediately
2. Use existing job system (`src/server/jobs/`) to process enqueued panels
3. Background workers check queue status and submit when slots available
4. This avoids server load from polling while allowing partial progress

### Phase 3: Client-Side UI Updates ✅ Complete

#### 3.1 Add Queue Status to Comics UI

Created hook at `src/components/Comics/hooks/useComicsQueueStatus.ts`:

```typescript
export function useComicsQueueStatus() {
  const { data, isLoading, error, refetch } = trpc.comics.getQueueStatus.useQuery(undefined, {
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 3000,
  });

  return {
    used: data?.used ?? 0,
    limit: data?.limit ?? 4,
    available: data?.available ?? 0,
    canGenerate: data?.canGenerate ?? false,
    isLoading,
    error,
    refetch,
  };
}
```

#### 3.2 Updated Panel Generation UIs

**SmartCreateModal** (`src/components/Comics/SmartCreateModal.tsx`):
- Shows queue status warnings in review step
- Alert when queue is full (red): "Your generation queue is full"
- Alert when queue partially full (yellow): "You have X of Y queue slots available"

**PanelModal** (`src/components/Comics/PanelModal.tsx`):
- Disables Generate/Enhance buttons when queue is full
- Shows Alert warning when queue is full

```tsx
// Example usage in PanelModal
const { available, limit, used, isLoading: queueLoading } = useComicsQueueStatus();
const queueFull = available === 0;

<BuzzTransactionButton
  disabled={!genInputsValid || queueFull}
  // ...
/>
</Button>
```

#### 3.3 Smart Create Panel Count Validation

- Limit panel count selector to available slots
- Or show warning: "You have X slots available but requested Y panels"

### Phase 4: Expose Queue Status Endpoint

Add a tRPC endpoint for comics to query queue status:

```typescript
// In comics.router.ts
getQueueStatus: comicProtectedProcedure
  .query(async ({ ctx }) => {
    const token = await getOrchestratorToken(ctx.user!.id, ctx);
    const userTier = ctx.user?.tier ?? 'free';
    return getUserQueueStatus(token, userTier);
  }),
```

## Implementation Order

1. **Create queue helper functions** (`queue-limits.ts`)
   - `getUserQueueStatus()` - query active workflow count
   - `assertCanGenerate()` - throw if no slots (for single-panel endpoints)
   - `waitForQueueSlot()` - poll until slot available (for multi-panel endpoints)

2. **Add server-side checks to single-panel endpoints**
   - `createPanel` - fail immediately if no slots
   - `enhancePanel` - fail immediately if no slots
   - `iterateGenerate` - fail immediately if no slots

3. **Update multi-panel endpoints with fail-fast checks**
   - `smartCreateChapter` - check all required slots upfront via `assertCanGenerate(panelCount)`
   - `bulkCreatePanels` - check all required slots upfront for panels needing generation

4. **Add `getQueueStatus` endpoint** - expose status to frontend

5. **Update frontend**
   - Show queue status in project view
   - Disable single-panel buttons when queue full
   - Show "may take longer" warning on Smart Create when queue is partially full
   - Add progress indicator for waiting panels

## Affected Endpoints

### Generation Endpoints (Need Queue Checks)
| Endpoint | Slots Needed | Notes |
|----------|--------------|-------|
| `createPanel` | 1 | Single panel generation |
| `enhancePanel` | 1 | Re-generate existing panel |
| `iterateGenerate` | 1 | Iterative panel editing |
| `smartCreateChapter` | N (panel count) | Creates multiple panels - **fail-fast check upfront** |
| `bulkCreatePanels` | N (panel count) | Creates multiple panels - **fail-fast check upfront** |

### Non-Generation Endpoints (No Queue Check)
- `createPanelFromImage` - Uses existing image, no generation
- `replacePanelImage` - Just updates DB, no generation
- `deletePanel`, `reorderPanels`, etc. - No generation involved

## Files to Modify

### Server
- `src/server/services/orchestrator/queue-limits.ts` (NEW)
- `src/server/routers/comics.router.ts` - add queue checks to generation endpoints
- `src/server/schema/generation.schema.ts` - may need to export tier utilities

### Client
- `src/components/Comics/hooks/useComicsQueueStatus.ts` (NEW)
- `src/components/Comics/PanelModal.tsx` - queue status display
- `src/components/Comics/SmartCreateModal.tsx` - panel count validation
- `src/components/IterativeEditor/IterativeImageEditor.tsx` - queue status in iterate view
- Project page components as needed

## Edge Cases

1. **Race conditions**: User submits panel, another job finishes, slot opens - should we retry?
2. **Partial Smart Create**: If we go with Option B, what happens if some panels succeed and others fail?
3. **UI sync**: How quickly does the UI reflect queue changes after a job completes?
4. **Shared queue**: Comics and main generator share the same queue - UI needs to reflect total usage

## Testing Plan

1. Unit tests for `getUserQueueStatus` and `assertCanGenerate`
2. Integration tests for queue limit enforcement
3. E2E tests for UI disable states
4. Load testing for race conditions

## Questions for Review

1. ~~Which Smart Create approach (A or B)?~~ **→ Option A (Fail-Fast) selected** — check all slots upfront before starting any generation
2. Should comics have its own queue or share with main generator?
3. Do we need real-time queue status updates (WebSocket)?
4. Should we add queue status to the comics project header/sidebar?
