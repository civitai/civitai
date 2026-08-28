import { useComputedColorScheme } from '@mantine/core';
import { useCallback } from 'react';
import type { Callback } from 'react-joyride';
import Joyride, {
  ACTIONS,
  EVENTS,
  LIFECYCLE,
  type Props as JoyrideProps,
  STATUS,
} from 'react-joyride';
import { IsClient } from '~/components/IsClient/IsClient';
import { TourPopover } from '~/components/Tour/TourPopover';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { endReasonFor, nextEvents, tourTargetKey } from '~/components/Tours/joyride-callback';
import type { StepData } from '~/types/tour';
import { tourScrollBlock } from '~/components/Tours/tour-scroll';
import { tourOverlayZIndex } from '~/shared/constants/app-layout.constants';
import { emitTourEnd, emitTourStart, emitTourStep } from '~/utils/faro/tour';

const completeStatus: string[] = [STATUS.SKIPPED, STATUS.FINISHED];

export default function LazyTours({ getHelpers }: Pick<JoyrideProps, 'getHelpers'>) {
  const colorScheme = useComputedColorScheme('dark');
  const { closeTour, pauseTour, runTour, activeTour, steps, currentStep, run, trigger } =
    useTourContext();

  const handleJoyrideCallback = useCallback<Callback>(
    async (data) => {
      const { status, type, action, index, step, lifecycle } = data;
      const key = activeTour;

      if (action === ACTIONS.UPDATE && lifecycle === LIFECYCLE.TOOLTIP) {
        const target = document.querySelector(step?.target as string);
        if (target && step.placement !== 'center')
          target.scrollIntoView({
            behavior: 'smooth',
            block: tourScrollBlock(target.getBoundingClientRect().height, window.innerHeight),
          });
        window.dispatchEvent(new Event('resize'));
      }

      if ((type === EVENTS.TOUR_END && completeStatus.includes(status)) || action === ACTIONS.CLOSE) {
        const reason = endReasonFor(status, action);
        if (key) emitTourEnd({ key, index, reason });
        closeTour({ reason });
        return;
      }

      // A target Joyride could not find. Advance past it as before, but record it —
      // the run of `resolved: false` events is the only way a step that renders for
      // nobody becomes visible.
      if (type === EVENTS.TARGET_NOT_FOUND) {
        if (key) emitTourStep({ key, index, target: tourTargetKey(step?.target), resolved: false });
        runTour({ step: index + 1 });
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
          pauseTour();
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
          emitTourStep({
            key,
            index,
            target: tourTargetKey(step?.target),
            resolved,
            ...(hook ? { waitMs: Date.now() - startedAt } : {}),
          });

        runTour({ step: nextStepIndex });
      } else if (type === EVENTS.STEP_BEFORE || type === EVENTS.TOUR_START) {
        // Emitted here rather than from `runTour` so `stepCount` is the count AFTER
        // `setSteps` filtering — a conditionally-cut tour is otherwise not comparable
        // with a full one.
        if (type === EVENTS.TOUR_START && key)
          emitTourStart({ key, trigger, stepCount: steps?.length ?? 0 });

        await step.data?.onBeforeStart?.();
      }
    },
    [closeTour, pauseTour, runTour, activeTour, steps, trigger]
  );

  return (
    <IsClient>
      <Joyride
        key={activeTour}
        steps={steps}
        stepIndex={currentStep}
        getHelpers={getHelpers}
        callback={handleJoyrideCallback}
        styles={{
          options: {
            zIndex: tourOverlayZIndex,
            arrowColor:
              colorScheme === 'dark' ? 'var(--mantine-color-dark-6)' : 'var(--mantine-color-white)',
          },
          spotlight: {
            border: '2px solid var(--mantine-color-cyan-4)',
            backgroundColor: 'rgba(255, 255, 255, 0.3)',
          },
        }}
        floaterProps={{
          styles: {
            floater: { position: 'absolute', top: 0 },
          },
        }}
        locale={{
          nextLabelWithProgress: 'Next',
        }}
        run={run}
        tooltipComponent={TourPopover}
        disableScrollParentFix
        scrollToFirstStep
        disableScrolling
        showSkipButton
        showProgress
        continuous
      />
    </IsClient>
  );
}
