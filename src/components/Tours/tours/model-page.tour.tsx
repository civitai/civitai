import { StepWithData } from '~/types/tour';
import { waitForElement } from '~/utils/html-helpers';

export const modelPageTour: StepWithData[] = [
  {
    target: '[data-tour="model:start"]',
    title: 'Welcome to the Model Page',
    content:
      'A model is a resource that can be used to generate content. This tour will guide you through the features of this page.',
    placement: 'center',
    disableBeacon: true,
    floaterProps: {
      styles: { floater: { width: '100%' } },
    },
  },
  {
    target: '[data-tour="model:create"]',
    title: 'Create with this Resource',
    content: 'Click here to generate content using this resource!',
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
    content: 'Engage in discussions related to this resource.',
  },
  {
    target: '[data-tour="model:gallery"]',
    disableBeacon: true,
    title: 'View Gallery',
    content: `View images created with this resource. You can add your review and post your own images that you've created using this resource.`,
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="model:remix"]' }).catch(() => null);
      },
    },
  },
  {
    target: '[data-tour="model:remix"]',
    title: 'Remix This Image',
    content: 'Click this button to remix an image and create something new',
    disableBeacon: true,
    spotlightClicks: true,
    disableOverlayClose: true,
    spotlightPadding: 16,
    styles: {
      spotlight: {
        animation: 'shadowGlow 2s infinite',
      },
    },
  },
];

export const welcomeTour: StepWithData[] = [
  {
    target: '[data-tour="model:start"]',
    title: 'Welcome to Civitai!',
    content: `Civitai is the leading hub for AI-generated content, connecting creators to share, discover, and collaborate. Let's walk you through the tools we provide to start engaging in the community.`,
    placement: 'center',
    showProgress: false,
    disableBeacon: true,
    locale: {
      next: `Let's go!`,
      skip: 'No thanks',
    },
    floaterProps: {
      styles: { floater: { width: '100%' } },
    },
  },
  {
    target: '[data-tour="model:remix"]',
    title: 'Create with this Resource',
    content: 'Click here to generate content using this resource!',
    disableBeacon: true,
    showProgress: false,
    hideFooter: true,
    spotlightPadding: 16,
    spotlightClicks: true,
    disableOverlayClose: true,
    styles: {
      spotlight: {
        animation: 'shadowGlow 2s infinite',
      },
    },
  },
];
