import { generationPanel } from '~/store/generation.store';
import { StepWithData } from '~/types/tour';
import { waitForElement } from '~/utils/html-helpers';

export const postGenerationTour: StepWithData[] = [
  {
    target: '[data-tour="post:title"]',
    title: 'Add a Title',
    content:
      'Add a title to your post to give it some context. This step is optional but helps personalize your creation.',
    hideBackButton: true,
    disableBeacon: true,
    data: {
      onPrev: async () => {
        generationPanel.open();
        await waitForElement({ selector: '[data-tour="gen:select"]' }).catch(() => null);
      },
    },
  },
  {
    target: '[data-tour="post:tag"]',
    title: 'Add a Tag',
    disableBeacon: true,
    content:
      'Tags help other users easily find relevant content. For example, if these are cat images, adding a "cat" tag would help categorize your content.',
  },
  {
    target: '[data-tour="post:description"]',
    title: 'Add a Description',
    disableBeacon: true,
    content:
      'Descriptions provide additional details about your post, helping viewers understand your creation better.',
    data: {
      onNext: async () => {
        await waitForElement({
          selector: '[data-tour="post:rate-resource"]',
          timeout: 30000,
        }).catch(() => null);
      },
    },
  },
  {
    target: '[data-tour="post:rate-resource"]',
    title: 'Rate the Resource',
    disableBeacon: true,
    content:
      'Rate the resource you used to generate this content. This helps the creator improve the quality of their model.',
  },
  {
    target: '[data-tour="post:publish"]',
    title: 'Publish Your Post',
    disableBeacon: true,
    content:
      'Once you are ready, click this button to publish your post to the site and your creations with the community!',
  },
];
