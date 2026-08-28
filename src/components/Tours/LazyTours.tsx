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
import type { StepData } from '~/types/tour';
import { tourScrollBlock } from '~/components/Tours/tour-scroll';
import { tourOverlayZIndex } from '~/shared/constants/app-layout.constants';

const completeStatus: string[] = [STATUS.SKIPPED, STATUS.FINISHED];
const nextEvents: string[] = [EVENTS.STEP_AFTER, EVENTS.TARGET_NOT_FOUND];

export default function LazyTours({ getHelpers }: Pick<JoyrideProps, 'getHelpers'>) {
  const colorScheme = useComputedColorScheme('dark');
  const { closeTour, pauseTour, runTour, activeTour, steps, currentStep, run } = useTourContext();

  const handleJoyrideCallback = useCallback<Callback>(
    async (data) => {
      const { status, type, action, index, step, lifecycle } = data;

      if (action === ACTIONS.UPDATE && lifecycle === LIFECYCLE.TOOLTIP) {
        const target = document.querySelector(step?.target as string);
        if (target && step.placement !== 'center')
          target.scrollIntoView({
            behavior: 'smooth',
            block: tourScrollBlock(target.getBoundingClientRect().height, window.innerHeight),
          });
        window.dispatchEvent(new Event('resize'));
      }

      if (type === EVENTS.TOUR_END && completeStatus.includes(status)) {
        closeTour({ reason: status === STATUS.SKIPPED ? 'skipped' : 'finished' });
        return;
      }

      if (action === ACTIONS.CLOSE) {
        closeTour({ reason: 'closed' });
        return;
      }

      if (nextEvents.includes(type)) {
        const isPrevAction = action === ACTIONS.PREV;
        const nextStepIndex = index + (isPrevAction ? -1 : 1);

        try {
          if (isPrevAction && step.data?.onPrev) {
            pauseTour();
            await (step.data as StepData)?.onPrev?.();
          } else if (!isPrevAction && step.data?.onNext) {
            pauseTour();
            await (step.data as StepData)?.onNext?.();
          }
        } catch {
          closeTour({ reason: 'failed' });
          return;
        }

        runTour({ step: nextStepIndex });
      } else if (type === EVENTS.STEP_BEFORE || type === EVENTS.TOUR_START) {
        await step.data?.onBeforeStart?.();
      }
    },
    [closeTour, pauseTour, runTour]
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
