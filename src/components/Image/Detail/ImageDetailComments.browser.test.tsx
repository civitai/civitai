import Router from 'next/router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import {
  BrowserRouterProvider,
  getBrowserRouter,
} from '~/components/BrowserRouter/BrowserRouterProvider';
import type * as CommentSectionModule from '~/components/CommentsV3/CommentSection';
import { renderWithProviders } from '../../../../test/component-setup';

vi.mock('~/components/CommentsV3/CommentSection', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentSectionModule>()),
  CommentSection: ({ highlight }: { highlight?: number }) => (
    <output data-testid="section-highlight">{String(highlight)}</output>
  ),
}));

import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';

const IMAGE = 3;

afterEach(() => {
  getBrowserRouter().replace({ query: {} }, '/');
});

describe('the detail view’s comments, opened as a routed dialog', () => {
  // A routed dialog moves the browser router only; Next's router keeps the page underneath's query,
  // so the comment a link names (the global player's timed comments) has to come from the dialog's.
  test('highlight the comment the dialog’s link names', async () => {
    Object.assign(Router, { query: {}, asPath: '/', pathname: '/' });
    renderWithProviders(
      <BrowserRouterProvider>
        <ImageDetailComments imageId={IMAGE} userId={9} />
      </BrowserRouterProvider>
    );
    // the provider listens for route changes from an effect
    await new Promise((resolve) => setTimeout(resolve, 50));
    getBrowserRouter().push(
      { query: { dialog: 'imageDetail', imageId: IMAGE, highlight: 777 } },
      `/images/${IMAGE}?highlight=777`
    );
    await expect.element(page.getByTestId('section-highlight')).toHaveTextContent('777');
  });
});
