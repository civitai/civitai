import { describe, expect, test, vi } from 'vitest';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import type { ResourceReviewPagedModel } from '~/types/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));
vi.mock('~/components/RenderHtml/RenderHtml', () => ({
  RenderHtml: ({ html }: { html: string }) => <span>{html.replace(/<[^>]+>/g, '')}</span>,
}));

vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  function ImageGuard2({ children }: { children: (safe: boolean) => React.ReactNode }) {
    return <>{children(true)}</>;
  }

  ImageGuard2.BlurToggle = function BlurToggle() {
    return null;
  };
  return { ImageGuard2 };
});
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({ EdgeMedia: () => <span /> }));
vi.mock('~/components/ResourceReview/ResourceReviewMenu', () => ({
  ResourceReviewMenu: () => null,
}));

import { ReviewCard } from './ReviewCard';

const makeReview = (overrides: Partial<ResourceReviewPagedModel> = {}) =>
  ({
    id: 7,
    modelId: 1,
    modelVersionId: 2,
    rating: 5,
    recommended: true,
    details: null,
    postId: null,
    imageCount: 0,
    commentCount: 0,
    exclude: false,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    user: { id: 101, username: 'reviewer', cosmetics: [], profilePicture: null },
    ...overrides,
  } as ResourceReviewPagedModel);

const makeImage = (id: number) =>
  ({ id, url: `img-${id}`, name: `img${id}`, type: 'image', nsfwLevel: 1 } as ImagesInfiniteModel);

const card = () => document.querySelector('[data-testid="model-written-review"]') as HTMLElement;

const link = () => card().querySelector<HTMLAnchorElement>('a[rel="nofollow"]')!;

describe('ReviewCard, full variant', () => {
  test('a text-less review with images stays a card with its comments count', async () => {
    await renderWithProviders(
      <ReviewCard review={makeReview({ imageCount: 2, commentCount: 1 })} variant="full" />
    );
    expect(card().querySelector('[aria-label="Comments"]')?.textContent).toBe('1 comment');
  });

  test('a review with text is the tall card, with a comments badge', async () => {
    await renderWithProviders(
      <ReviewCard
        review={makeReview({ details: '<p>Great.</p>', commentCount: 3 })}
        variant="full"
      />
    );
    expect(card().textContent).toContain('Great.');
    expect(card().querySelector('[aria-label="Comments"]')?.textContent).toBe('3 comments');
  });

  test('an image count over the cap reads 100+ in the "more" tile', async () => {
    await renderWithProviders(
      <ReviewCard review={makeReview({ imageCount: 101 })} variant="full" images={[makeImage(1)]} />
    );
    const tiles = Array.from(document.querySelectorAll('[data-testid="review-more-images"]'));
    expect(tiles.map((tile) => tile.textContent)).toEqual(['100+images', '100+images']);
  });

  test('images past the shown ones are counted in a "+N images" tile', async () => {
    await renderWithProviders(
      <ReviewCard
        review={makeReview({ imageCount: 12 })}
        variant="full"
        images={[1, 2, 3, 4].map(makeImage)}
      />
    );
    const tiles = Array.from(document.querySelectorAll('[data-testid="review-more-images"]'));
    expect(tiles.map((tile) => tile.textContent)).toEqual(['+10images', '+8images']);
  });

  test('hidden images turn the "+N" tile caption into "some hidden"', async () => {
    await renderWithProviders(
      <ReviewCard
        review={makeReview({ imageCount: 12 })}
        variant="full"
        images={[1, 2, 3].map(makeImage)}
        hiddenImageCount={1}
      />
    );
    const tiles = Array.from(document.querySelectorAll('[data-testid="review-more-images"]'));
    expect(tiles.map((tile) => tile.textContent)).toEqual(['+10some hidden', '+9some hidden']);
  });

  test('when every fetched image is hidden, one tile says so instead of an empty strip', async () => {
    await renderWithProviders(
      <ReviewCard
        review={makeReview({ imageCount: 3 })}
        variant="full"
        images={[]}
        hiddenImageCount={3}
      />
    );
    expect(document.querySelector('[data-testid="review-images-hidden"]')?.textContent).toBe(
      'Hidden by your preferences'
    );
    expect(document.querySelector('[data-testid="review-images"]')).toBeNull();
  });

  test('no hidden images means no hidden tile', async () => {
    await renderWithProviders(
      <ReviewCard review={makeReview({ imageCount: 3 })} variant="full" images={[makeImage(1)]} />
    );
    expect(document.querySelector('[data-testid="review-images-hidden"]')).toBeNull();
  });

  test('a verdict badge names the recommendation', async () => {
    const screen = await renderWithProviders(
      <ReviewCard review={makeReview({ recommended: false })} variant="full" />
    );
    await expect.element(screen.getByText('Doesn’t recommend')).toBeInTheDocument();
  });

  test('a review with a post links to it, named by the post title when given', async () => {
    const screen = await renderWithProviders(
      <ReviewCard
        review={makeReview({ postId: 55, imageCount: 2 })}
        postTitle="Turbo tests"
        variant="full"
      />
    );
    expect(
      screen
        .getByRole('link', { name: 'From the post “Turbo tests”' })
        .element()
        .getAttribute('href')
    ).toBe('/posts/55');
  });

  test('a review without a post has no post link', async () => {
    await renderWithProviders(<ReviewCard review={makeReview({ imageCount: 2 })} variant="full" />);
    expect(card().textContent).not.toMatch(/From the post/);
  });

  test('the card carries the link to the review dialog', async () => {
    await renderWithProviders(<ReviewCard review={makeReview({ id: 42 })} variant="full" />);
    expect(link().getAttribute('href')).toContain('dialog=resourceReview');
    expect(link().getAttribute('href')).toContain('reviewId=42');
  });
});

describe('ReviewCard, compact variant', () => {
  test('shows the image count but no images', async () => {
    await renderWithProviders(
      <ReviewCard
        review={makeReview({ details: '<p>Great.</p>', imageCount: 9 })}
        variant="compact"
        images={[makeImage(1)]}
      />
    );
    expect(document.querySelector('[data-testid="review-images"]')).toBeNull();
    expect(card().querySelector('[aria-label="Images"]')?.textContent).toBe('9');
  });

  test('caps the image count label at 100+', async () => {
    await renderWithProviders(
      <ReviewCard review={makeReview({ details: '<p>a</p>', imageCount: 101 })} variant="compact" />
    );
    expect(card().querySelector('[aria-label="Images"]')?.textContent).toBe('100+');
  });

  test('has no image count when the review has no images', async () => {
    await renderWithProviders(
      <ReviewCard review={makeReview({ details: '<p>a</p>', imageCount: 0 })} variant="compact" />
    );
    expect(card().querySelector('[aria-label="Images"]')).toBeNull();
  });
});

describe('ReviewCard, excluded-from-count badge', () => {
  const badge = /Excluded from count/;

  test('an excluded review shows it', async () => {
    await renderWithProviders(
      <ReviewCard review={makeReview({ exclude: true, imageCount: 2 })} variant="full" />
    );
    expect(card().textContent).toMatch(badge);
  });

  test('the model owner’s own review shows it', async () => {
    await renderWithProviders(
      <ReviewCard review={makeReview({ imageCount: 2 })} creatorId={101} variant="full" />
    );
    expect(card().textContent).toMatch(badge);
  });

  test('another reviewer’s counted review does not', async () => {
    await renderWithProviders(
      <ReviewCard review={makeReview({ imageCount: 2 })} creatorId={999} variant="full" />
    );
    expect(card().textContent).not.toMatch(badge);
  });
});
