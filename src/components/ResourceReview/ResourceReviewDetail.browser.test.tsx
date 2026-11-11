import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

const state = vi.hoisted(() => ({ review: {} as Record<string, unknown> }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'resourceReview.get': { useQuery: () => ({ data: state.review, isLoading: false }) },
  }),
}));

vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));
vi.mock('~/components/RenderHtml/RenderHtml', () => ({
  RenderHtml: ({ html }: { html: string }) => (
    <div data-testid="review-text">{html.replace(/<[^>]+>/g, '')}</div>
  ),
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/components/ResourceReview/ResourceReviewMenu', () => ({
  ResourceReviewMenu: () => null,
}));
vi.mock('~/components/ResourceReview/ResourceReviewCarousel', () => ({
  ResourceReviewCarousel: ({ postId }: { postId: number | null }) => (
    <div data-testid="carousel" data-post-id={postId ?? ''} />
  ),
}));
vi.mock('~/components/ResourceReview/ResourceReviewComments', () => ({
  ResourceReviewComments: () => <div data-testid="comments" />,
}));

import { ResourceReviewDetail } from './ResourceReviewDetail';

const makeReview = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  rating: 5,
  recommended: true,
  details: '<p>Great model.</p>',
  postId: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  user: { id: 101, username: 'reviewer', deletedAt: null, cosmetics: [], profilePicture: null },
  model: { id: 1, name: 'Model', userId: 5, status: 'Published' },
  modelVersion: { id: 2, name: 'v1', baseModel: 'SDXL 1.0' },
  thread: { commentCount: 0 },
  ...overrides,
});

const viewPost = () => document.querySelector<HTMLAnchorElement>('a[href="/posts/55"]');
const follows = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('ResourceReviewDetail', () => {
  beforeEach(() => {
    state.review = makeReview({ postId: 55 });
  });

  test('a review with a post links to it, between the images and the text', async () => {
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    const carousel = document.querySelector('[data-testid="carousel"]')!;
    expect(carousel.getAttribute('data-post-id')).toBe('55');
    expect(viewPost()?.textContent).toMatch(/View post/);
    expect(follows(carousel, viewPost()!)).toBe(true);
    expect(follows(viewPost()!, document.querySelector('[data-testid="review-text"]')!)).toBe(true);
  });

  test('the text comes before the comments', async () => {
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    const text = document.querySelector('[data-testid="review-text"]')!;
    expect(follows(text, document.querySelector('[data-testid="comments"]')!)).toBe(true);
  });

  test('a review without a post has no View post link', async () => {
    state.review = makeReview();
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    expect(viewPost()).toBeNull();
    expect(document.querySelector('a[href^="/posts/"]')).toBeNull();
  });

  test('a post-backed review shows its images even when the reviewer has no username', async () => {
    state.review = makeReview({
      postId: 55,
      user: { id: 101, username: null, deletedAt: new Date(), cosmetics: [], profilePicture: null },
    });
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    expect(document.querySelector('[data-testid="carousel"]')).not.toBeNull();
  });
});
