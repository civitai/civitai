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
    floaterProps: {
      styles: { floater: { width: '100%' } },
    },
    disableBeacon: true,
  },
  {
    target: '[data-tour="gen:terms"]',
    title: 'Accept the Terms',
    content: 'Before generating content, you must accept the terms of service.',
    spotlightClicks: true,
    disableBeacon: true,
    disableOverlayClose: true,
    disableCloseOnEsc: true,
    hideCloseButton: true,
    hideFooter: true,
  },
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
          <Text weight={600} span>
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
    disableCloseOnEsc: true,
    disableOverlayClose: true,
    spotlightPadding: 16,
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="gen:submit"]' }).catch(() => null);
      },
    },
  },
  {
    target: '[data-tour="gen:submit"]',
    title: 'Create Your Image',
    content: `Once your prompt is ready to go, hit the generate button and AI will start doing it's magic!`,
    placement: 'top',
    disableOverlayClose: true,
    disableBeacon: true,
    spotlightClicks: true,
    data: {
      onPrev: async () => {
        if (window.innerWidth < 768) generationPanel.close();
        await waitForElement({ selector: '[data-tour="gen:remix"]' }).catch(() => null);
      },
    },
  },
  {
    target: '[data-tour="gen:buzz"]',
    title: 'Cost of Generation',
    content:
      'All AI tools on Civitai run on Buzz. Depending on the complexity of your request, the amount of Buzz may vary.',
    placement: 'top',
    disableBeacon: true,
  },
  {
    target: '[data-tour="gen:queue"]',
    title: 'Your Generation Queue',
    content: 'This is where your generated media is stored, along with all the generation details.',
    data: {
      onPrev: async () => generationPanel.setView('generate'),
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
        await waitForElement({ selector: '[data-tour="gen:select"]' }).catch(() => null);
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
        Buzz allowing you to create more!
      </Text>
    ),
    hideFooter: true,
    disableBeacon: true,
    disableCloseOnEsc: true,
    disableOverlayClose: true,
    spotlightClicks: true,
    spotlightPadding: 16,
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="gen:post"]' }).catch(() => null);
      },
      onBeforeStart: async () => {
        generationPanel.setView('feed');
        generationPanel.open();
      },
    },
  },
  {
    target: '[data-tour="gen:post"]',
    title: 'Posting Content',
    content: 'Click this button to post your selected content to the site.',
    disableCloseOnEsc: true,
    disableOverlayClose: true,
    disableBeacon: true,
    spotlightClicks: true,
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="post:title"]', timeout: 30000 }).catch(
          () => null
        );
      },
      onBeforeStart: async () => {
        generationPanel.setView('feed');
        generationPanel.open();
      },
    },
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
    floaterProps: {
      styles: { floater: { width: '100%' } },
    },
  },
  {
    target: '[data-tour="gen:terms"]',
    title: 'Accept the Terms',
    content: 'Before generating content, you must accept the terms of service.',
    spotlightClicks: true,
    disableBeacon: true,
    disableOverlayClose: true,
    disableCloseOnEsc: true,
    hideCloseButton: true,
    hideFooter: true,
  },
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
    target: '[data-tour="gen:submit"]',
    title: 'Submit Your Prompt',
    content: 'You can submit your prompt by clicking this button and see the magic happen!',
    placement: 'top',
    disableOverlayClose: true,
    disableBeacon: true,
    spotlightClicks: true,
  },
  {
    target: '[data-tour="gen:buzz"]',
    title: 'Cost of Generation',
    content:
      'All AI tools on Civitai run on Buzz. Depending on the complexity of your request, the amount of Buzz may vary.',
    placement: 'top',
    disableBeacon: true,
  },
  {
    target: '[data-tour="gen:queue"]',
    title: 'Your Generation Queue',
    content: 'This is where your generated media is stored, along with all the generation details.',
    data: {
      onPrev: async () => generationPanel.setView('generate'),
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
        await waitForElement({ selector: '[data-tour="gen:select"]' }).catch(() => null);
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
    disableBeacon: true,
    disableCloseOnEsc: true,
    disableOverlayClose: true,
    spotlightClicks: true,
    spotlightPadding: 16,
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="gen:post"]' }).catch(() => null);
      },
      onBeforeStart: async () => {
        generationPanel.setView('feed');
        generationPanel.open();
      },
    },
  },
  {
    target: '[data-tour="gen:post"]',
    title: 'Posting Content',
    content: 'Click this button to post your selected content to the site.',
    disableCloseOnEsc: true,
    disableOverlayClose: true,
    disableBeacon: true,
    spotlightClicks: true,
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="post:title"]', timeout: 30000 }).catch(
          () => null
        );
      },
      onBeforeStart: async () => {
        generationPanel.setView('feed');
        generationPanel.open();
      },
    },
  },
];
