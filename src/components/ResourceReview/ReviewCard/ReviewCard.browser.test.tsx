import { describe, expect, test, vi } from 'vitest';
import type { ResourceReviewPagedModel } from '~/types/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));
vi.mock('~/components/RenderHtml/RenderHtml', () => ({
  RenderHtml: ({ html }: { html: string }) => <span>{html.replace(/<[^>]+>/g, '')}</span>,
}));

// The menu reads the session; its own behaviour is not under test here.
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

const card = () => document.querySelector('[data-testid="model-written-review"]') as HTMLElement;

describe('ReviewCard, full variant', () => {
  test('a review with no text, images or post is one short row with no footer', async () => {
    await renderWithProviders(<ReviewCard review={makeReview()} variant="full" />);
    expect(card().className).toContain('flex-row');
    expect(card().textContent).not.toMatch(/From the post/);
    expect(card().querySelector('[aria-label="Comments"]')).toBeNull();
  });

  test('a review with text is the tall card, with a comments badge', async () => {
    await renderWithProviders(
      <ReviewCard
        review={makeReview({ details: '<p>Great.</p>', commentCount: 3 })}
        variant="full"
      />
    );
    expect(card().className).not.toContain('flex-row');
    expect(card().querySelector('[aria-label="Comments"]')?.textContent).toBe('3');
  });

  test('an image count over the cap reads 100+', async () => {
    await renderWithProviders(
      <ReviewCard review={makeReview({ imageCount: 101 })} variant="full" />
    );
    expect(card().querySelector('[aria-label="100+ images"]')?.textContent).toBe('100+');
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

  test('the whole card is wrapped by the link that opens the review dialog', async () => {
    await renderWithProviders(<ReviewCard review={makeReview({ id: 42 })} variant="full" />);
    const link = card().querySelector<HTMLAnchorElement>('a[rel="nofollow"]');
    expect(link?.getAttribute('href')).toContain('dialog=resourceReview');
    expect(link?.getAttribute('href')).toContain('reviewId=42');
    expect(link?.className).toContain('absolute');
    expect(link?.className).toContain('inset-0');
  });
});
