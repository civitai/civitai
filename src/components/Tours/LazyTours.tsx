import { useComputedColorScheme } from '@mantine/core';
import { useCallback } from 'react';
import type { Callback, Step } from 'react-joyride';
import Joyride, { type Props as JoyrideProps } from 'react-joyride';
import { IsClient } from '~/components/IsClient/IsClient';
import { TourPopover } from '~/components/Tour/TourPopover';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { createTourCallback } from '~/components/Tours/joyride-callback';
import { tourScrollBlock } from '~/components/Tours/tour-scroll';
import { tourOverlayZIndex } from '~/shared/constants/app-layout.constants';

export default function LazyTours({ getHelpers }: Pick<JoyrideProps, 'getHelpers'>) {
  const colorScheme = useComputedColorScheme('dark');
  const { closeTour, pauseTour, runTour, activeTour, steps, currentStep, run, trigger } =
    useTourContext();

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps list the factory's inputs, not a literal
  const handleJoyrideCallback = useCallback<Callback>(
    createTourCallback({
      activeTour,
      steps,
      trigger,
      pauseTour,
      closeTour,
      runTour,
      scrollToTarget: (step: Step) => {
        const target = document.querySelector(step?.target as string);
        if (target && step.placement !== 'center')
          target.scrollIntoView({
            behavior: 'smooth',
            block: tourScrollBlock(target.getBoundingClientRect().height, window.innerHeight),
          });
        window.dispatchEvent(new Event('resize'));
      },
    }),
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
