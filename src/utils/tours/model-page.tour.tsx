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
  },
];
