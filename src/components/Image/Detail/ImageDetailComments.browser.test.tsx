import Router from 'next/router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  BrowserRouterProvider,
  getBrowserRouter,
} from '~/components/BrowserRouter/BrowserRouterProvider';
import type * as CommentSectionContextModule from '~/components/CommentsV3/CommentSectionContext';
import { renderWithProviders } from '../../../../test/component-setup';

// The real CommentSection; its provider, which marks the comment, reports what it was handed.
vi.mock('~/components/CommentsV3/CommentSectionContext', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentSectionContextModule>()),
  CommentSectionProvider: ({ highlight }: { highlight?: number }) => (
    <output data-testid="section-highlight">{String(highlight)}</output>
  ),
}));

import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';

const IMAGE = 3;

const marked = () => document.querySelector('[data-testid="section-highlight"]')?.textContent;
const push = (query: Record<string, unknown>) =>
  getBrowserRouter().push(
    { query: { dialog: 'imageDetail', imageId: IMAGE, ...query } },
    `/images/${IMAGE}`
  );

function renderComments() {
  Object.assign(Router, { query: {}, asPath: '/', pathname: '/' });
  renderWithProviders(
    <BrowserRouterProvider>
      <ImageDetailComments imageId={IMAGE} userId={9} />
    </BrowserRouterProvider>
  );
}

afterEach(() => {
  getBrowserRouter().replace({ query: {} }, '/');
});

describe('the detail view’s comments, opened as a routed dialog', () => {
  // A routed dialog moves the browser router only; Next's router keeps the page underneath's query,
  // so the comment a link names (the global player's timed comments) has to come from the dialog's.
  test('mark the comment the dialog’s link names', async () => {
    renderComments();
    // The provider takes route changes from an effect: push until it has taken one. As the URL
    // carries it, the highlight is a string.
    await vi.waitFor(() => {
      push({ highlight: '777' });
      expect(marked()).toBe('777');
    });
  });

  test('mark none once the dialog moves to a link that names none', async () => {
    renderComments();
    await vi.waitFor(() => {
      push({ highlight: '777' });
      expect(marked()).toBe('777');
    });
    push({});
    await expect.poll(marked).toBe('undefined');
  });
});
