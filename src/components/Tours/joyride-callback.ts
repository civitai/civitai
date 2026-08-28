import { ACTIONS, EVENTS, LIFECYCLE, STATUS } from 'react-joyride';
import type { Callback, Step } from 'react-joyride';
import type { TourKey } from '~/components/Tours/tours';
import type { StepData, StepWithData } from '~/types/tour';
import { emitTourEnd, emitTourStart, emitTourStep } from '~/utils/faro/tour';
import type { TourEndReason, TourTrigger } from '~/utils/faro/tour';

const completeStatus: string[] = [STATUS.SKIPPED, STATUS.FINISHED];

/**
 * TARGET_NOT_FOUND is deliberately absent: folded in here it was identical to a
 * click on Next, which is how a dead `data-tour` attribute stayed invisible for
 * over a year. It gets its own branch in the callback.
 */
export const nextEvents: string[] = [EVENTS.STEP_AFTER];

export function tourTargetKey(target: unknown): string {
  if (typeof target !== 'string') return 'unknown';
  return /^\[data-tour="([^"]+)"\]$/.exec(target)?.[1] ?? target;
}

export function endReasonFor(status: string, action: string): TourEndReason {
  if (action === ACTIONS.CLOSE) return 'closed';
  return status === STATUS.SKIPPED ? 'skipped' : 'finished';
}

export interface TourCallbackDeps {
  activeTour: TourKey | null | undefined;
  steps: StepWithData[] | undefined;
  trigger: TourTrigger;
  pauseTour: () => void;
  closeTour: (opts: { reason: TourEndReason }) => void;
  runTour: (opts: { step: number }) => void;
  scrollToTarget?: (step: Step) => void;
  emit?: {
    start: typeof emitTourStart;
    step: typeof emitTourStep;
    end: typeof emitTourEnd;
  };
}

export function createTourCallback(deps: TourCallbackDeps): Callback {
  const emit = deps.emit ?? { start: emitTourStart, step: emitTourStep, end: emitTourEnd };

  return async (data) => {
    const { status, type, action, index, step, lifecycle } = data;
    const key = deps.activeTour;

    if (action === ACTIONS.UPDATE && lifecycle === LIFECYCLE.TOOLTIP) {
      deps.scrollToTarget?.(step);
    }

    if ((type === EVENTS.TOUR_END && completeStatus.includes(status)) || action === ACTIONS.CLOSE) {
      const reason = endReasonFor(status, action);
      if (key) emit.end({ key, index, reason });
      deps.closeTour({ reason });
      return;
    }

    // Deliberately skip the step's own hook here: it's usually a waitForElement
    // with its own ~30s timeout, and this step's target is already known absent,
    // so attempting it would turn a fast degrade into a per-step stall — a run of
    // missing targets would then cost minutes, not milliseconds. Any side effect
    // the hook performed (e.g. closing the mobile generation panel) is lost.
    if (type === EVENTS.TARGET_NOT_FOUND) {
      if (key) emit.step({ key, index, target: tourTargetKey(step?.target), resolved: false });
      deps.runTour({ step: index + 1 });
      return;
    }

    if (nextEvents.includes(type)) {
      const isPrevAction = action === ACTIONS.PREV;
      const nextStepIndex = index + (isPrevAction ? -1 : 1);
      const stepData = step.data as StepData | undefined;
      const hook = isPrevAction ? stepData?.onPrev : stepData?.onNext;
      let resolved = true;
      const startedAt = Date.now();

      if (hook) {
        deps.pauseTour();
        try {
          await hook();
        } catch {
          // A hook that rejected used to END the tour and persist it as completed,
          // so a slow load cost the user the tour with no error and no second
          // chance. Advancing leaves the tour walkable on whatever did render.
          resolved = false;
        }
      }

      if (key)
        emit.step({
          key,
          index,
          target: tourTargetKey(step?.target),
          resolved,
          ...(hook ? { waitMs: Date.now() - startedAt } : {}),
        });

      deps.runTour({ step: nextStepIndex });
    } else if (type === EVENTS.STEP_BEFORE || type === EVENTS.TOUR_START) {
      // Emitted here rather than from `runTour` so `stepCount` is the count AFTER
      // `setSteps` filtering — a conditionally-cut tour is otherwise not comparable
      // with a full one.
      if (type === EVENTS.TOUR_START && key)
        emit.start({ key, trigger: deps.trigger, stepCount: deps.steps?.length ?? 0 });

      await step.data?.onBeforeStart?.();
    }
  };
}
