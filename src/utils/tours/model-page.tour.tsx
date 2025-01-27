import { StepWithData } from '~/types/tour';
import { waitForElement } from '~/utils/html-helpers';

export const modelPageTour: StepWithData[] = [
  {
    target: '[data-tour="model:create"]',
    spotlightClicks: false,
    title: 'Create with Resource',
    content: 'Click here to generate content using this resource, if available in the generator.',
  },
  {
    target: '[data-tour="model:type"]',
    spotlightClicks: false,
    title: 'Model Types Explained',
    content:
      'Understand the difference between LoRAs and Checkpoints: LoRAs are specialized resources trained on a limited set of images for a specific style or theme, and are used alongside checkpoints. Checkpoints can operate independently without LoRAs.',
  },
  {
    target: '[data-tour="model:like"]',
    spotlightClicks: false,
    title: 'Like this resource',
    content:
      'Click this button to review the resource positively and add it to your collection of liked models.',
  },
  {
    target: '[data-tour="model:download"]',
    spotlightClicks: false,
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
    spotlightClicks: false,
    placement: 'top',
    title: 'Join the Discussion',
    content: 'Engage in discussions related to this resource.',
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="model:gallery"]' });
      },
    },
  },
  {
    target: '[data-tour="model:gallery"]',
    spotlightClicks: false,
    placement: 'top',
    title: 'View Gallery',
    content: `View images created with this resource. You can add your review and post your own images that you've created using this resource.`,
  },
];
