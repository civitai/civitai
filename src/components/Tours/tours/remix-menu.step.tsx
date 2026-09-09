import { Text } from '@mantine/core';
import type { StepData, StepWithData } from '~/types/tour';

/**
 * The step describing the menu a remix button opens.
 *
 * Shared by the three tours that spotlight such a button, so they describe the
 * same options the same way rather than drifting apart.
 */
export function remixMenuStep(target: string, data?: StepData): StepWithData {
  return {
    target: `[data-tour="${target}"]`,
    title: 'Pick How to Remix',
    content: (
      <Text>
        <Text fw={600} span>
          Edit image
        </Text>{' '}
        changes it with a prompt,{' '}
        <Text fw={600} span>
          Animate
        </Text>{' '}
        turns it into a video, and{' '}
        <Text fw={600} span>
          Reuse prompt &amp; resources
        </Text>{' '}
        starts from its settings. Any one of them opens the generator.
      </Text>
    ),
    // The menu hangs below the button, so keep the tooltip off to the side.
    placement: 'right',
    disableBeacon: true,
    spotlightClicks: true,
    disableOverlayClose: true,
    spotlightPadding: 6,
    // The only way on is picking an option, so that a `Next` cannot walk the tour
    // onto the generator before one has opened it. `RemixMenu` reports the menu as
    // a blocked target when an engine refusal leaves nothing clickable, which is
    // what restores the footer for that case.
    hideFooter: true,
    ...(data ? { data } : {}),
    styles: {
      spotlight: {
        animation: 'shadowGlow 2s infinite',
        willChange: 'box-shadow',
      },
    },
  };
}
