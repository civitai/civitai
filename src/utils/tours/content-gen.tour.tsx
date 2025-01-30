import { Text } from '@mantine/core';
import Router from 'next/router';
import { generationPanel } from '~/store/generation.store';
import { StepWithData } from '~/types/tour';
import { waitForElement } from '~/utils/html-helpers';

export const contentGenerationTour: StepWithData[] = [
  {
    target: '[data-tour="gen:start"]',
    placement: 'center',
    title: 'Getting Started with Content Generation',
    content:
      'Welcome to the content generation tool! This tour will guide you through the process.',
    locale: { next: "Let's go" },
    disableBeacon: true,
    disableOverlayClose: true,
  },
  {
    target: '[data-tour="gen:prompt"]',
    title: 'Start Here',
    spotlightClicks: true,
    disableBeacon: true,
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
          <Text weight={600} span>
            Next
          </Text>{' '}
          to learn more.
        </Text>
      </div>
    ),
    disableBeacon: true,
    data: {
      onNext: async () => {
        Router.push({
          pathname: '/collections/[collectionId]',
          query: { collectionId: 107, tour: 'content-generation' },
        });
        // if window width is mobile size, the sidebar will be hidden
        if (window.innerWidth < 768) generationPanel.close();

        await waitForElement({ selector: '[data-tour="gen:remix"]', timeout: 30000 });
      },
    },
  },
  {
    target: '[data-tour="gen:remix"]',
    title: 'Remix This Image',
    content: 'Click this button to remix an image and create something new',
    hideFooter: true,
    disableBeacon: true,
    spotlightClicks: true,
    spotlightPadding: 10,
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="gen:submit"]' });
      },
    },
  },
  {
    target: '[data-tour="gen:submit"]',
    title: 'Submit Your Prompt',
    content: 'You can submit your prompt by clicking this button and see the magic happen!',
    placement: 'top',
    disableBeacon: true,
  },
  {
    target: '[data-tour="gen:queue"]',
    title: 'Your Generation Queue',
    content: 'This is where your generated media is stored, along with all the generation details.',
    data: {
      onNext: async () => generationPanel.setView('queue'),
    },
    disableBeacon: true,
  },
  {
    target: '[data-tour="gen:feed"]',
    title: 'Your Generation Feed',
    disableBeacon: true,
    content: 'View all your generated media here in a single scrollable view.',
    data: {
      onNext: async () => {
        generationPanel.setView('feed');
        await waitForElement({ selector: '[data-tour="gen:select"]' });
      },
    },
  },
  {
    target: '[data-tour="gen:select"]',
    title: 'Selecting Content',
    content: (
      <Text>
        You can select images from both the{' '}
        <Text weight={600} span>
          Queue
        </Text>{' '}
        and the{' '}
        <Text weight={600} span>
          Feed
        </Text>{' '}
        to post them on the site. Posting lets you share your creations with the community and earn
        rewards like Buzz!
      </Text>
    ),
    hideFooter: true,
    hideCloseButton: true,
    disableBeacon: true,
    disableCloseOnEsc: true,
    disableOverlayClose: true,
    spotlightClicks: true,
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="gen:post"]' });
      },
    },
  },
  {
    target: '[data-tour="gen:post"]',
    title: 'Posting Content',
    content: 'Click this button to post your selected content to the site.',
    hideFooter: true,
    hideCloseButton: true,
    disableCloseOnEsc: true,
    disableOverlayClose: true,
    disableBeacon: true,
    spotlightClicks: true,
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="post:title"]', timeout: 30000 });
      },
    },
  },
  {
    target: '[data-tour="gen:reset"]',
    title: 'All Set!',
    content: 'You can view this tour at anytime by clicking this icon.',
    locale: { last: 'Done' },
  },
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
  },
  {
    target: '[data-tour="gen:prompt"]',
    title: 'Start Here',
    spotlightClicks: true,
    disableBeacon: true,
    content:
      'You can type a prompt here to generate an image. Try something simple, like "a blue robot", to get started.',
  },
  {
    target: '[data-tour="gen:submit"]',
    title: 'Submit Your Prompt',
    content: 'You can submit your prompt by clicking this button and see the magic happen!',
    placement: 'top',
    disableBeacon: true,
  },
  {
    target: '[data-tour="gen:queue"]',
    title: 'Your Generation Queue',
    content: 'This is where your generated media is stored, along with all the generation details.',
    data: {
      onNext: async () => generationPanel.setView('queue'),
    },
    disableBeacon: true,
  },
  {
    target: '[data-tour="gen:feed"]',
    title: 'Your Generation Feed',
    disableBeacon: true,
    content: 'View all your generated media here in a single scrollable view.',
    data: {
      onNext: async () => {
        generationPanel.setView('feed');
        await waitForElement({ selector: '[data-tour="gen:select"]' });
      },
    },
  },
  {
    target: '[data-tour="gen:select"]',
    title: 'Selecting Content',
    content: (
      <Text>
        You can select images from both the{' '}
        <Text weight={600} span>
          Queue
        </Text>{' '}
        and the{' '}
        <Text weight={600} span>
          Feed
        </Text>{' '}
        to post them on the site. Posting lets you share your creations with the community and earn
        rewards like Buzz!
      </Text>
    ),
    hideFooter: true,
    hideCloseButton: true,
    disableBeacon: true,
    disableCloseOnEsc: true,
    disableOverlayClose: true,
    spotlightClicks: true,
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="gen:post"]' });
      },
    },
  },
  {
    target: '[data-tour="gen:post"]',
    title: 'Posting Content',
    content: 'Click this button to post your selected content to the site.',
    hideFooter: true,
    hideCloseButton: true,
    disableCloseOnEsc: true,
    disableOverlayClose: true,
    disableBeacon: true,
    spotlightClicks: true,
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="post:title"]', timeout: 30000 });
      },
    },
  },
  {
    target: '[data-tour="gen:reset"]',
    title: 'All Set!',
    content: 'You can view this tour at anytime by clicking this icon.',
    disableBeacon: true,
  },
];
