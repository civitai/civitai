import { Text } from '@mantine/core';
import Router from 'next/router';
import { GEN_SUBMIT_TARGET } from '~/components/Tours/tour-targets';
import { remixMenuStep } from '~/components/Tours/tours/remix-menu.step';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import type { StepWithData } from '~/types/tour';
import { waitForElement } from '~/utils/html-helpers';

const glowingSpotlight = {
  spotlight: { animation: 'shadowGlow 2s infinite', willChange: 'box-shadow' },
};

const termsStep: StepWithData = {
  target: '[data-tour="gen:terms"]',
  title: 'Accept the Terms',
  content: 'Before generating content, you must accept the terms of service.',
  spotlightClicks: true,
  disableBeacon: true,
  disableOverlayClose: true,
  disableCloseOnEsc: true,
  hideCloseButton: true,
  hideFooter: true,
  styles: glowingSpotlight,
};

const buzzStep: StepWithData = {
  target: '[data-tour="gen:buzz"]',
  title: 'Cost of Generation',
  content:
    'All AI tools on Civitai run on Buzz. Depending on the complexity of your request, the amount of Buzz may vary.',
  placement: 'top',
  disableBeacon: true,
};

const queueStep: StepWithData = {
  target: '[data-tour="gen:queue"]',
  title: 'Your Generation Queue',
  content: 'This is where your generated media is stored, along with all the generation details.',
  data: {
    onPrev: async () => useGenerationPanelStore.setState({ view: 'generate' }),
  },
  disableBeacon: true,
};

const feedStep: StepWithData = {
  target: '[data-tour="gen:feed"]',
  title: 'Your Generation Feed',
  disableBeacon: true,
  content: 'View all your generated media here in a single scrollable view.',
  data: {
    onNext: async () => {
      useGenerationPanelStore.setState({ view: 'feed' });
      await waitForElement({ selector: '[data-tour="gen:select"]' });
    },
  },
};

// The closing sentence is the only thing the two tours say differently here.
const selectStep = (closing: string): StepWithData => ({
  target: '[data-tour="gen:select"]',
  title: 'Selecting Content',
  content: (
    <Text>
      You can select images from both the{' '}
      <Text fw={600} span>
        Queue
      </Text>{' '}
      and the{' '}
      <Text fw={600} span>
        Feed
      </Text>{' '}
      to post them on the site. {closing}
    </Text>
  ),
  hideFooter: true,
  disableBeacon: true,
  disableCloseOnEsc: true,
  disableOverlayClose: true,
  spotlightClicks: true,
  spotlightPadding: 10,
  data: {
    onBeforeStart: async () => {
      useGenerationPanelStore.setState({ opened: true, view: 'feed' });
    },
  },
  styles: glowingSpotlight,
});

const postStep: StepWithData = {
  target: '[data-tour="gen:post"]',
  title: 'Posting Content',
  content: 'Click this button to post your selected content to the site.',
  hideFooter: true,
  disableOverlayClose: true,
  disableBeacon: true,
  spotlightClicks: true,
  data: {
    onBeforeStart: async () => {
      useGenerationPanelStore.setState({ opened: true, view: 'feed' });
    },
  },
  styles: glowingSpotlight,
};

export const contentGenerationTour: StepWithData[] = [
  {
    target: '[data-tour="gen:start"]',
    placement: 'center',
    title: 'Getting Started with Content Generation',
    content:
      'Welcome to the content generation tool! This tour will guide you through the process.',
    locale: { next: "Let's go" },
    floaterProps: {
      styles: { floater: { width: '100%' } },
    },
    disableBeacon: true,
  },
  termsStep,
  {
    target: '[data-tour="gen:prompt"]',
    title: 'Start Here',
    spotlightClicks: true,
    disableBeacon: true,
    disableScrolling: true,
    content:
      'You can type a prompt here to generate an image. Try something simple, like "a blue robot", to get started.',
  },
  {
    target: '[data-tour="gen:prompt"]',
    title: 'Remix Content',
    content: (
      <div className="flex flex-col gap-2">
        <Text>
          Alternatively, you can remix existing images on the site. Click{' '}
          <Text fw={600} span>
            Next
          </Text>{' '}
          to learn more.
        </Text>
      </div>
    ),
    disableBeacon: true,
    disableScrolling: true,
    data: {
      onNext: async () => {
        Router.push({
          pathname: '/collections/[collectionId]',
          query: { collectionId: 107 },
        });
        // if window width is mobile size, the sidebar will be hidden
        if (window.innerWidth < 768) useGenerationPanelStore.setState({ opened: false });
        await waitForElement({ selector: '[data-tour="gen:remix"]', timeout: 30000 });
      },
    },
  },
  {
    target: '[data-tour="gen:remix"]',
    title: 'Remix This Image',
    content: 'Click this button to see what you can make from this image.',
    // Below the button is where the remix menu opens; a tooltip there covers it.
    placement: 'top',
    hideFooter: true,
    disableBeacon: true,
    spotlightClicks: true,
    disableCloseOnEsc: true,
    disableOverlayClose: true,
    spotlightPadding: 10,
    styles: glowingSpotlight,
  },
  remixMenuStep('gen:remix-menu', {
    onNext: async () => {
      await waitForElement({ selector: GEN_SUBMIT_TARGET, interval: 1000 }).catch(() => null);
    },
  }),
  {
    target: GEN_SUBMIT_TARGET,
    title: 'Create Your Image',
    content: `Once your prompt is ready to go, hit the generate button and AI will start doing it's magic!`,
    placement: 'top',
    hideFooter: true,
    disableOverlayClose: true,
    disableBeacon: true,
    spotlightClicks: true,
    data: {
      onPrev: async () => {
        if (window.innerWidth < 768) useGenerationPanelStore.setState({ opened: false });
        await waitForElement({ selector: '[data-tour="gen:remix"]' }).catch(() => null);
      },
    },
    styles: glowingSpotlight,
  },
  buzzStep,
  queueStep,
  feedStep,
  selectStep(
    'Posting lets you share your creations with the community and earn Buzz allowing you to create more!'
  ),
  postStep,
];

export const remixContentGenerationTour: StepWithData[] = [
  {
    target: '[data-tour="gen:start"]',
    placement: 'center',
    title: 'Getting Started with Content Generation',
    content:
      'Welcome to the content generation tool! This tour will guide you through the process.',
    locale: { next: "Let's go" },
    disableBeacon: true,
    disableOverlayClose: true,
    floaterProps: {
      styles: { floater: { width: '100%' } },
    },
  },
  termsStep,
  {
    target: '[data-tour="gen:prompt"]',
    title: 'Start Here',
    spotlightClicks: true,
    disableScrolling: true,
    disableBeacon: true,
    content:
      'Looks like you are remixing an image. You can modify the prompt here to generate an image based on the remix.',
  },
  {
    target: GEN_SUBMIT_TARGET,
    title: 'Submit Your Prompt',
    content: 'You can submit your prompt by clicking this button and see the magic happen!',
    placement: 'top',
    disableOverlayClose: true,
    hideFooter: true,
    disableBeacon: true,
    spotlightClicks: true,
    styles: glowingSpotlight,
  },
  buzzStep,
  queueStep,
  feedStep,
  selectStep(
    'Posting lets you share your creations with the community and earn rewards like Buzz!'
  ),
  postStep,
];
