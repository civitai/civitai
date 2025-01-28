import { Text } from '@mantine/core';
import { generationPanel } from '~/store/generation.store';
import { StepWithData } from '~/types/tour';
import { waitForElement } from '~/utils/html-helpers';

export const postGenerationTour: StepWithData[] = [
  {
    target: '[data-tour="gen:queue"]',
    title: 'Your Generation Queue',
    content: 'This is where your generated media is stored, along with all the generation details.',
    data: {
      onNext: async () => generationPanel.setView('queue'),
    },
    disableBeacon: true,
    placement: 'bottom',
  },
  {
    target: '[data-tour="gen:feed"]',
    title: 'Your Generation Feed',
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
    disableOverlayClose: true,
    data: {
      onNext: async () => {
        await waitForElement({ selector: '[data-tour="post:title"]', timeout: 30000 });
      },
    },
  },
  {
    target: '[data-tour="post:title"]',
    title: 'Add a Title',
    content:
      'Add a title to your post to give it some context. This step is optional but helps personalize your creation.',
    hideBackButton: true,
    data: {
      onPrev: async () => {
        generationPanel.open();
        await waitForElement({ selector: '[data-tour="gen:select"]' });
      },
    },
  },
  {
    target: '[data-tour="post:tag"]',
    title: 'Add a Tag',
    content:
      'Tags help other users easily find relevant content. For example, if these are cat images, adding a "cat" tag would help categorize your content.',
  },
  {
    target: '[data-tour="post:description"]',
    title: 'Add a Description',
    content:
      'Descriptions provide additional details about your post, helping viewers understand your creation better.',
    data: {
      onNext: async () => {
        await waitForElement({
          selector: '[data-tour="post:rate-resource"]',
          timeout: 30000,
        });
      },
    },
  },
  {
    target: '[data-tour="post:rate-resource"]',
    title: 'Rate the Resource',
    content:
      'Rate the resource you used to generate this content. This helps the creator improve the quality of their model.',
  },
  {
    target: '[data-tour="post:publish"]',
    title: 'Publish Your Post',
    content:
      'Once you are ready, click this button to publish your post to the site and your creations with the community!',
  },
];
