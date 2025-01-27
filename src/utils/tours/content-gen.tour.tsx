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
  },
  {
    target: '[data-tour="gen:reset"]',
    title: 'All Set!',
    content: 'You can view this tour at anytime by clicking this icon.',
    locale: { last: 'Done' },
  },
];
