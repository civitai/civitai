import { StepWithData } from '~/types/tour';
import { waitForElement } from '~/utils/html-helpers';

export const postGenerationTour: StepWithData[] = [
  {
    target: '[data-tour="post:title"]',
    title: 'Add a Title',
    content:
      'Add a title to your post to give it some context. This step is optional but helps personalize your creation.',
    disableBeacon: true,
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
          timeout: 10000,
          interval: 1000,
        });
      },
    },
  },
  {
    target: '[data-tour="post:rate-resource"]',
    title: 'Rate the Resource',
    disableBeacon: true,
    content:
      'Rate the resource you used to generate this content. This helps the creator improve the quality of their model.',
    // Hack to prevent solid gray box from appearing
    styles: {
      overlay: { backgroundColor: 'rgba(0, 0, 0, 0.4)' },
      spotlight: { backgroundColor: 'rgba(255, 255, 255, 0.2)' },
    },
  },
  {
    target: '[data-tour="post:publish"]',
    title: 'Publish Your Post',
    disableBeacon: true,
    content:
      'Once you are ready, click this button to publish your post to the site and your creations with the community!',
  },
];
