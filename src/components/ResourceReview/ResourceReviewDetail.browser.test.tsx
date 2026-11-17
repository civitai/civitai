import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

const state = vi.hoisted(() => ({
  review: {} as Record<string, unknown>,
  images: [] as unknown[],
  flatData: undefined as unknown[] | undefined,
  hasHidden: false,
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
      flatData: state.flatData ?? state.images,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
}));
const explained = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('~/components/Image/ExplainHiddenImages/ExplainHiddenImages', () => ({
  useExplainHiddenImages: (rows: unknown[]) => {
    explained.calls.push(rows);
    return { hasHidden: state.hasHidden };
  },
  ExplainHiddenImages: () => <div data-testid="explain-hidden" />,
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  BrowsingLevelProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', () => ({
  BrowsingSettingsAddonsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
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
    state.flatData = undefined;
    state.hasHidden = false;
    asked.calls = [];
    explained.calls = [];
  });

  test('a review with a post names it in a strip with a link, between the images and the text', async () => {
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    const gallery = document.querySelector('[data-testid="review-gallery"]')!;
    expect(viewPost()?.textContent).toMatch(/View post/);
    expect(document.body.textContent).toContain('From the post');
    expect(follows(gallery, viewPost()!)).toBe(true);
    expect(follows(viewPost()!, document.querySelector('[data-testid="review-text"]')!)).toBe(true);
  });

  test('shows at most eight images and a see-all link to the post when there are more', async () => {
    state.images = Array.from({ length: 9 }, (_, i) => makeImage(i + 1));
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    const gallery = document.querySelector('[data-testid="review-gallery"]')!;

    expect(asked.calls.at(-1)![0]).toEqual({ reviewId: 7, limit: 9 });
    expect(gallery.querySelectorAll('[data-testid="review-slide"]')).toHaveLength(8);
    const seeAll = [...gallery.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('See all their images')
    )!;
    expect(seeAll.getAttribute('href')).toBe('/posts/55');
    expect(seeAll.getAttribute('rel')).toBe('nofollow');
  });

  test('a post-less review sends see-all to the reviewer’s images of the version', async () => {
    state.review = makeReview();
    state.images = Array.from({ length: 9 }, (_, i) => makeImage(i + 1));
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    const seeAll = [...document.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('See all their images')
    )!;
    expect(seeAll.getAttribute('href')).toBe(
      '/images?view=feed&periodMode=stats&modelVersionId=2&userId=101'
    );
  });

  test('exactly eight images show no see-all slide', async () => {
    state.images = Array.from({ length: 8 }, (_, i) => makeImage(i + 1));
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    const gallery = document.querySelector('[data-testid="review-gallery"]')!;
    expect(gallery.querySelectorAll('[data-testid="review-slide"]')).toHaveLength(8);
    expect(document.body.textContent).not.toContain('See all their images');
  });

  test('images hidden by preferences add an explanation slide before the see-all slide', async () => {
    state.images = Array.from({ length: 9 }, (_, i) => makeImage(i + 1));
    state.flatData = [...state.images, makeImage(99)];
    state.hasHidden = true;
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    const gallery = document.querySelector('[data-testid="review-gallery"]')!;
    const explain = gallery.querySelector('[data-testid="explain-hidden"]')!;
    const seeAll = [...gallery.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('See all their images')
    )!;
    expect(explained.calls.at(-1)).toBe(state.flatData);
    expect(follows(gallery.querySelectorAll('[data-testid="review-slide"]')[7], explain)).toBe(
      true
    );
    expect(follows(explain, seeAll)).toBe(true);
  });

  test('no explanation slide when nothing is hidden', async () => {
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    expect(document.querySelector('[data-testid="explain-hidden"]')).toBeNull();
  });

  test('when every image is hidden the gallery shows the explanation, not the empty state', async () => {
    state.images = [];
    state.flatData = [makeImage(1), makeImage(2)];
    state.hasHidden = true;
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    expect(document.querySelector('[data-testid="explain-hidden"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="review-no-images"]')).toBeNull();
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
    expect(document.body.textContent).not.toContain('See all their images');
  });

  test('a review without a post links to the reviewer’s images of the version instead', async () => {
    state.review = makeReview();
    await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    expect(viewPost()).toBeNull();
    expect(document.body.textContent).toContain('Images made with this version');
    expect(document.querySelector('a[href^="/images?view=feed"]')).not.toBeNull();
  });

  test('a review whose author has no username still renders its images', async () => {
    state.review = makeReview({
      user: { id: 101, username: null, deletedAt: new Date(), cosmetics: [], profilePicture: null },
    });
    const screen = await renderWithProviders(<ResourceReviewDetail reviewId={7} />);
    await expect.element(screen.getByTestId('review-gallery')).toBeVisible();
    expect(document.querySelector('[data-testid="review-no-images"]')).toBeNull();
  });
});
