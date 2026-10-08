import type { WorkflowStepEvent } from '@civitai/client';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { type InfiniteTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { extractTrpcErrorCode } from '~/components/AppBlocks/blockImageScanLogic';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { createDebouncer } from '~/utils/debouncer';
import { queryClient, trpc, trpcVanilla } from '~/utils/trpc';
import { normalizePreparation } from '~/shared/orchestrator/download-preparation';
import type {
  NormalizedStep,
  WorkflowStatusUpdate,
} from '~/server/services/orchestrator/orchestration-new.service';
import { COMPLETE_STATUSES, POLLABLE_STATUSES } from '~/shared/constants/orchestrator.constants';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';

type CustomWorkflowStepEvent = Omit<WorkflowStepEvent, '$type'> & { $type: 'step' };
const debouncer = createDebouncer(100);
let signalStepEventsDictionary: Record<string, CustomWorkflowStepEvent> = {};

/**
 * Writes a step event's download progress onto the cached step, and reports whether anything else
 * about the step changed. A preparing step reports progress every few seconds; refetching the
 * workflow for each of those would be one orchestrator read per waiting workflow per webhook.
 */
export function applyPreparationEvent(
  data: InfiniteTextToImageRequests | undefined,
  event: Pick<CustomWorkflowStepEvent, 'workflowId' | 'name' | 'status' | 'preparation'>
): 'applied' | 'needs-refetch' {
  let verdict: 'applied' | 'needs-refetch' = 'needs-refetch';
  for (const page of data?.pages ?? []) {
    const item = page.items.find((x) => x.id === event.workflowId);
    if (!item) continue;
    const step = item.steps.find((x) => x.name === event.name);
    if (!step) continue;
    // A status change still needs the full refetch — outputs and errors only arrive there.
    verdict = step.status === event.status ? 'applied' : 'needs-refetch';
    step.preparation = normalizePreparation(event.preparation);
    break;
  }
  return verdict;
}

export const usePollableWorkflowIdsStore = create<{ ids: string[] }>(() => ({ ids: [] }));
export function useTextToImageSignalUpdate() {
  usePollWorkflows();

  return useSignalConnection(SignalMessages.TextToImageUpdate, (data: CustomWorkflowStepEvent) => {
    if (data.$type !== 'step') return;
    if (normalizePreparation(data.preparation)) {
      const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
      // An object, not a `let`: the assignment happens inside a callback, which control-flow
      // analysis cannot see — it would narrow a plain variable to its initial value.
      const outcome = { verdict: 'needs-refetch' as ReturnType<typeof applyPreparationEvent> };
      queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
        produce(state, (old?: InfiniteTextToImageRequests) => {
          outcome.verdict = applyPreparationEvent(old, data);
        })
      );
      if (outcome.verdict === 'applied') return;
    }
    if (data.status !== 'unassigned') {
      signalStepEventsDictionary[data.workflowId] = { ...data };
    }
    debouncer(() =>
      updateSignaledWorkflows().catch((error) =>
        console.error('[generation] signaled workflow update failed', error)
      )
    );
  });
}

type SignaledStep = NonNullable<NonNullable<WorkflowStatusUpdate>['steps']>[number];

/** Applies one refetched step onto the cached step in place — `step` is an immer draft. */
export function mergeSignaledStep(
  step: Pick<
    NormalizedStep,
    'status' | 'completedAt' | 'errors' | 'queuePosition' | 'preparation' | 'output'
  >,
  stepMatch: SignaledStep
) {
  step.status = stepMatch.status;
  step.completedAt = stepMatch.completedAt;
  step.errors = stepMatch.errors;
  // Assigned even when undefined: a step that has left the queue reports no queuePosition, and
  // keeping the old one strands a stale position and ETA on the card for the rest of the session.
  step.queuePosition = stepMatch.queuePosition;
  step.preparation = stepMatch.preparation;
  // Merge updated images by id, then append ones the client has not seen. Multi-step workflows
  // (e.g. Wan 2.2 interpolation) start the later step with zero images and only materialize
  // outputs on completion, which a per-index loop drops until reload.
  for (const [index, item] of step.output.entries()) {
    const itemMatch = stepMatch.output.find((x) => x.id === item.id);
    if (itemMatch) step.output[index] = itemMatch;
  }
  const existingIds = new Set(step.output.map((x) => x.id));
  for (const item of stepMatch.output) {
    if (!existingIds.has(item.id)) step.output.push(item);
  }
}

/**
 * Which updates to apply from one settled poll batch, and which ids to stop polling.
 *
 * Pure and exported because this decision is what regressed, and the caller it lives in writes to
 * the query cache and a zustand store. A card's queue slot is released only once its status is
 * written back, so an id that silently stays in the batch pins the slot counter.
 */
export function resolvePollOutcomes(
  workflowIds: string[],
  outcomes: PromiseSettledResult<WorkflowStatusUpdate>[]
) {
  const updates: NonNullable<WorkflowStatusUpdate>[] = [];
  const drop = new Set<string>();

  for (const [index, outcome] of outcomes.entries()) {
    const id = workflowIds[index];
    if (outcome.status === 'rejected') {
      // A transient failure keeps its id, so a blip does not abandon a running job. NOT_FOUND
      // never recovers, and an id left in the set is re-requested every minute all session.
      if (extractTrpcErrorCode(outcome.reason) === 'NOT_FOUND') drop.add(id);
      continue;
    }
    // The orchestrator answers for a workflow it no longer has by resolving undefined rather
    // than throwing, which is the same dead end as NOT_FOUND.
    if (!outcome.value) {
      drop.add(id);
      continue;
    }
    updates.push(outcome.value);
    if (!POLLABLE_STATUSES.includes(outcome.value.status)) drop.add(id);
  }

  return { updates, drop };
}

export async function updateWorkflowsStatus(workflowIds: string[]) {
  if (!workflowIds.length) return;
  const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);

  // allSettled, never all: one rejected id used to throw past the prune and the cache write
  // below, so NO id was pruned and NO status was applied — the failing id stayed in the batch and
  // froze the slot counter for every other job until the page was reloaded.
  const outcomes = await Promise.allSettled(workflowIds.map(fetchSignaledWorkflow));
  const { updates, drop } = resolvePollOutcomes(workflowIds, outcomes);

  if (drop.size)
    usePollableWorkflowIdsStore.setState(({ ids }) => ({
      ids: ids.filter((id) => !drop.has(id)),
    }));

  if (!updates.length) return;

  queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: InfiniteTextToImageRequests) => {
      if (!old) return;
      outerLoop: for (const page of old.pages) {
        for (const item of page.items) {
          if (!updates.length) break outerLoop;
          const index = updates.findIndex((x) => x.id === item.id);
          if (index > -1) {
            const update = updates.splice(index, 1)[0];
            if (update && !COMPLETE_STATUSES.includes(item.status)) {
              item.status = update.status;
              item.downloadPriority = update.downloadPriority;

              for (const step of item.steps) {
                const stepMatch = update.steps?.find((x) => x.name === step.name);
                if (stepMatch) mergeSignaledStep(step, stepMatch);
              }
            }
          }
        }
      }
    })
  );
}

async function updateSignaledWorkflows() {
  const signalData = { ...signalStepEventsDictionary };
  signalStepEventsDictionary = {};

  const workflowIds = Object.keys(signalData);
  if (!workflowIds.length) return;

  await updateWorkflowsStatus(workflowIds);
}

function usePollWorkflows() {
  const hasIds = usePollableWorkflowIdsStore(({ ids }) => ids.length > 0);

  const intervalRef = useRef<number | null>(null);
  function handleClearInterval() {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }
  useEffect(() => {
    if (!hasIds) {
      handleClearInterval();
      return;
    }

    if (!intervalRef.current) {
      intervalRef.current = window.setInterval(() => {
        const ids = usePollableWorkflowIdsStore.getState().ids;
        // Nothing awaits this timer, so an escaping rejection is an unhandled one with no stack
        // worth reading. Report it instead; the next tick retries.
        updateWorkflowsStatus(ids).catch((error) =>
          console.error('[generation] workflow status poll failed', error)
        );
      }, 60000);
    }

    return handleClearInterval;
  }, [hasIds]);
}

export async function fetchSignaledWorkflow(
  workflowId: string
): Promise<WorkflowStatusUpdate | undefined> {
  return await trpcVanilla.orchestrator.statusUpdate.query({ workflowId });
}
