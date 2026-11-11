import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

const state = vi.hoisted(() => ({
  review: {} as Record<string, unknown>,
  images: [] as unknown[],
}));

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
vi.mock('~/components/ResourceReview/ResourceReviewComments', () => ({
  ResourceReviewComments: () => <div data-testid="comments" />,
}));

const asked = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('~/components/ResourceReview/useReviewImages', () => ({
  useReviewImages: (...args: unknown[]) => {
    asked.calls.push(args);
    return {
      images: state.images,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
}));
// Their own behaviour is not under test; they read sessions, flags and image metrics.
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Image/Meta/ImageMetaPopover', () => ({ ImageMetaPopover2: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({}) }));
vi.mock('~/components/Reaction/Reactions', () => ({ Reactions: () => null }));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({ EdgeMedia: () => <span /> }));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  function ImageGuard2({ children }: { children: (safe: boolean) => React.ReactNode }) {
    return <>{children(true)}</>;
  }

  ImageGuard2.BlurToggle = function BlurToggle() {
    return null;
  };
  return { ImageGuard2 };
});

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

const makeImage = (id: number) => ({
  id,
  url: `img-${id}`,
  name: `img${id}`,
  type: 'image',
  nsfwLevel: 1,
  postTitle: 'Night market set',
  user: { id: 101 },
  stats: {},
});

const viewPost = () => document.querySelector<HTMLAnchorElement>('a[href="/posts/55"]');
const follows = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('ResourceReviewDetail', () => {
  beforeEach(() => {
    state.review = makeReview({ postId: 55 });
    state.images = [1, 2, 3, 4].map(makeImage);
    asked.calls = [];
  });

  test('a review with a post names it in a strip with a link, between the images and the text', async () => {
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    const gallery = document.querySelector('[data-testid="review-gallery"]')!;
    expect(viewPost()?.textContent).toMatch(/View post/);
    expect(document.body.textContent).toContain(
      'From the post “Night market set” · 4 images made with this version'
    );
    expect(follows(gallery, viewPost()!)).toBe(true);
    expect(follows(viewPost()!, document.querySelector('[data-testid="review-text"]')!)).toBe(true);
  });

  test('clicking a thumbnail swaps it into the large slot', async () => {
    const screen = await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    const gallery = document.querySelector('[data-testid="review-gallery"]')!;
    const large = () => gallery.querySelector('a[href^="/images/"]')!.getAttribute('href');
    expect(large()).toBe('/images/1');
    expect(gallery.querySelectorAll('button[aria-label="Show this image"]')).toHaveLength(3);
    await screen.getByRole('button', { name: 'Show this image' }).first().click();
    expect(large()).toBe('/images/2');
  });

  test('asks for the review’s images by id, one over what it shows, and says when there are more', async () => {
    state.review = makeReview({ postId: 55 });
    state.images = Array.from({ length: 11 }, (_, i) => makeImage(i + 1));
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);

    expect(asked.calls.at(-1)![0]).toEqual({ reviewId: 7, limit: 11 });
    expect(document.body.textContent).toContain('10+ images made with this version');
  });

  test('the text comes before the comments', async () => {
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    const text = document.querySelector('[data-testid="review-text"]')!;
    expect(follows(text, document.querySelector('[data-testid="comments"]')!)).toBe(true);
  });

  test('a review without images shows a compact empty state and no strip or link', async () => {
    state.images = [];
    const screen = await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    await expect.element(screen.getByText('No images in this review')).toBeVisible();
    expect(document.querySelector('[data-testid="review-gallery"]')).toBeNull();
    expect(viewPost()).toBeNull();
    expect(document.body.textContent).not.toMatch(/made with this version/);
  });

  test('a review without a post links to the reviewer’s images of the version instead', async () => {
    state.review = makeReview();
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    expect(viewPost()).toBeNull();
    expect(document.body.textContent).toContain('Images made with this version');
    expect(document.querySelector('a[href^="/images?view=feed"]')).not.toBeNull();
  });

  test('a post-backed review shows its images even when the reviewer has no username', async () => {
    state.review = makeReview({
      postId: 55,
      user: { id: 101, username: null, deletedAt: new Date(), cosmetics: [], profilePicture: null },
    });
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    expect(document.querySelector('[data-testid="review-gallery"]')).not.toBeNull();
  });

  test('a post-less review from a user with no username has nothing to look up', async () => {
    state.review = makeReview({
      user: { id: 101, username: null, deletedAt: new Date(), cosmetics: [], profilePicture: null },
    });
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    expect(document.querySelector('[data-testid="review-no-images"]')).not.toBeNull();
  });
});
