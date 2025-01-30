import { data } from 'motion/dist/react-m';
import Router from 'next/router';
import { generationPanel } from '~/store/generation.store';
import { StepWithData } from '~/types/tour';
import { waitForElement } from '~/utils/html-helpers';

export const modelPageTour: StepWithData[] = [
  {
    target: '[data-tour="model:create"]',
    title: 'Create with Resource',
    content: 'Click here to generate content using this resource, if available in the generator.',
    disableBeacon: true,
  },
  {
    target: '[data-tour="model:type"]',
    disableBeacon: true,
    title: 'Model Types Explained',
    content:
      'Understand the difference between LoRAs and Checkpoints: LoRAs are specialized resources trained on a limited set of images for a specific style or theme, and are used alongside checkpoints. Checkpoints can operate independently without LoRAs.',
  },
  {
    target: '[data-tour="model:like"]',
    disableBeacon: true,
    title: 'Like this resource',
    content:
      'Click this button to review the resource positively and add it to your collection of liked models.',
  },
  {
    target: '[data-tour="model:download"]',
    disableBeacon: true,
    title: 'Download Resource',
    content: 'Download the resource here if you prefer to generate content locally.',
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="model:discussion"]' }).catch(() => null);
      },
    },
  },
  {
    target: '[data-tour="model:discussion"]',
    disableBeacon: true,
    title: 'Join the Discussion',
    placement: 'top',
    content: 'Engage in discussions related to this resource.',
  },
  {
    target: '[data-tour="model:gallery"]',
    disableBeacon: true,
    title: 'View Gallery',
    content: `View images created with this resource. You can add your review and post your own images that you've created using this resource.`,
  },
  {
    target: '[data-tour="gen:remix"]',
    title: 'Remix This Image',
    content: 'Click this button to remix an image and create something new',
    disableBeacon: true,
    spotlightClicks: true,
    spotlightPadding: 10,
    data: {
      onNext: async () => {
        const path = Router.asPath.split('?')[0];
        Router.replace(path, undefined, { shallow: true });
        generationPanel.open();
        await waitForElement({ selector: '[data-tour="gen:start"]' });
      },
    },
  },
];
