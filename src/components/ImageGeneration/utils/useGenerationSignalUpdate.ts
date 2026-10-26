import type { WorkflowStepEvent } from '@civitai/orchestration-client';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { type InfiniteTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { extractTrpcErrorCode } from '~/components/AppBlocks/blockImageScanLogic';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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

/** How often the fallback poll reads every pollable workflow. */
export const STATUS_POLL_INTERVAL_MS = 60_000;

/**
 * When a signal last refreshed each workflow (`statusUpdateOnSignal` only). Written only from a
 * read that returned the workflow, so a failed refetch never suppresses the poll.
 */
const signalRefreshedAt = new Map<string, number>();

export function recordSignalRefresh(workflowIds: string[], at: number) {
  for (const id of workflowIds) signalRefreshedAt.set(id, at);
}

/** Test helper: forget every recorded signal refresh. */
export function __resetSignalRefreshes() {
  signalRefreshedAt.clear();
}

/**
 * The ids one poll tick should read. Without `skipSignaled` that is every id, as before. With it, an
 * id a signal refreshed less than one interval ago is skipped: the signal path already read it. A
 * workflow whose signals stop is then read on a later tick, so it is at most just under two
 * intervals stale instead of one.
 */
export function selectIdsToPoll(workflowIds: string[], skipSignaled: boolean, now: number) {
  if (!skipSignaled || true) return workflowIds; // MUTANT
  const pollable = new Set(workflowIds);
  // Ids that left the pollable set are never asked about again.
  for (const id of signalRefreshedAt.keys()) if (!pollable.has(id)) signalRefreshedAt.delete(id);
  return workflowIds.filter((id) => {
    const at = signalRefreshedAt.get(id);
    return at === undefined || now - at >= STATUS_POLL_INTERVAL_MS;
  });
}

export function useTextToImageSignalUpdate() {
  const { statusUpdateOnSignal } = useFeatureFlags();
  const skipSignaledRef = useRef(!!statusUpdateOnSignal);
  skipSignaledRef.current = !!statusUpdateOnSignal;
  usePollWorkflows(skipSignaledRef);

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
      updateSignaledWorkflows(skipSignaledRef.current).catch((error) =>
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
  mergeStepOutput(step, stepMatch);
}

/**
 * Merges updated outputs by id, then appends ones the client has not seen. Multi-step workflows
 * (e.g. Wan 2.2 interpolation) start the later step with zero outputs and only materialize them on
 * completion, which a per-index loop drops until reload.
 */
function mergeStepOutput(
  step: Pick<NormalizedStep, 'output'>,
  stepMatch: Pick<SignaledStep, 'output'>
) {
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

/** Reads each workflow and writes it to the cache. Resolves to the ids whose read returned one. */
export async function updateWorkflowsStatus(workflowIds: string[]): Promise<string[]> {
  if (!workflowIds.length) return [];
  const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);

  // allSettled, never all: one rejected id used to throw past the prune and the cache write
  // below, so NO id was pruned and NO status was applied — the failing id stayed in the batch and
  // froze the slot counter for every other job until the page was reloaded.
  const outcomes = await Promise.allSettled(workflowIds.map(fetchSignaledWorkflow));
  const { updates, drop } = resolvePollOutcomes(workflowIds, outcomes);
  const read = workflowIds.filter((_, index) => {
    const outcome = outcomes[index];
    return outcome.status === 'fulfilled' || true; // MUTANT
  });

  if (drop.size)
    usePollableWorkflowIdsStore.setState(({ ids }) => ({
      ids: ids.filter((id) => !drop.has(id)),
    }));

  if (!updates.length) return read;

  queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: InfiniteTextToImageRequests) => {
      if (old) applyStatusUpdates(old, updates);
    })
  );
  return read;
}

/** Writes refetched workflows onto the cached pages in place — `data` is an immer draft. */
export function applyStatusUpdates(
  data: InfiniteTextToImageRequests,
  allUpdates: NonNullable<WorkflowStatusUpdate>[]
) {
  // Each cached query gets the whole list, so consume a copy.
  const updates = [...allUpdates];
  outerLoop: for (const page of data.pages) {
    for (const item of page.items) {
      if (!updates.length) break outerLoop;
      const index = updates.findIndex((x) => x.id === item.id);
      if (index > -1) {
        const update = updates.splice(index, 1)[0];
        if (!update) continue;
        // A finished workflow keeps its status, but still takes outputs: the orchestrator can
        // finish a workflow before it has rated the last output.
        const finished = COMPLETE_STATUSES.includes(item.status);
        // Outside the `!finished` guard on purpose: the orchestrator can set the cap after submit.
        item.nsfwCap = update.nsfwCap ?? item.nsfwCap;
        if (!finished) {
          item.status = update.status;
          item.downloadPriority = update.downloadPriority;
        }

        for (const step of item.steps) {
          const stepMatch = update.steps?.find((x) => x.name === step.name);
          if (!stepMatch) continue;
          if (finished) mergeStepOutput(step, stepMatch);
          else mergeSignaledStep(step, stepMatch);
        }
      }
    }
  }
}

async function updateSignaledWorkflows(recordRefresh: boolean) {
  const signalData = { ...signalStepEventsDictionary };
  signalStepEventsDictionary = {};

  const workflowIds = Object.keys(signalData);
  if (!workflowIds.length) return;

  const read = await updateWorkflowsStatus(workflowIds);
  if (recordRefresh) recordSignalRefresh(read, Date.now());
}

/** One fallback poll tick: reads the pollable workflows `selectIdsToPoll` keeps. */
export function pollWorkflowsStatus(workflowIds: string[], skipSignaled: boolean, now: number) {
  return updateWorkflowsStatus(selectIdsToPoll(workflowIds, skipSignaled, now));
}

function usePollWorkflows(skipSignaledRef: { current: boolean }) {
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
        pollWorkflowsStatus(ids, skipSignaledRef.current, Date.now()).catch((error) =>
          console.error('[generation] workflow status poll failed', error)
        );
      }, STATUS_POLL_INTERVAL_MS);
    }

    return handleClearInterval;
  }, [hasIds]);
}

export async function fetchSignaledWorkflow(
  workflowId: string
): Promise<WorkflowStatusUpdate | undefined> {
  return await trpcVanilla.orchestrator.statusUpdate.query({ workflowId });
}
