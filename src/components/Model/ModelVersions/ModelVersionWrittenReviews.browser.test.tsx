import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const state = vi.hoisted(() => {
  const s = {
    flags: {} as Record<string, boolean>,
    items: [] as unknown[],
    useQuery: vi.fn((..._args: unknown[]) => ({ data: { items: s.items }, isLoading: false })),
  };
  return s;
});

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => state.flags,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'resourceReview.getPaged': { useQuery: (...args: unknown[]) => state.useQuery(...args) },
  }),
}));

vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));
vi.mock('~/components/RenderHtml/RenderHtml', () => ({
  RenderHtml: ({ html }: { html: string }) => <span>{html.replace(/<[^>]+>/g, '')}</span>,
}));

import { ModelVersionWrittenReviews } from './ModelVersionWrittenReviews';

const review = (id: number, details: string) => ({
  id,
  modelId: 1,
  modelVersionId: 2,
  rating: 5,
  recommended: true,
  details,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  user: { id: 100 + id, username: `reviewer${id}`, cosmetics: [], profilePicture: null },
});

const renderSection = (counts: { thumbsUpCount?: number; thumbsDownCount?: number } = {}) =>
  renderWithProviders(<ModelVersionWrittenReviews modelId={1} modelVersionId={2} {...counts} />);
const section = () => document.querySelector('[data-testid="model-written-reviews"]');

beforeEach(() => {
  state.flags = { modelPageReviews: true };
  state.items = [review(1, '<p>Works with the turbo base only.</p>'), review(2, '<p>Solid.</p>')];
  state.useQuery.mockClear();
});

describe('ModelVersionWrittenReviews', () => {
  test('with the flag on, shows the written reviews and links to the version’s reviews page', async () => {
    const screen = await renderSection();
    await expect.element(screen.getByText('Works with the turbo base only.')).toBeVisible();
    expect(document.querySelectorAll('[data-testid="model-written-review"]')).toHaveLength(2);
    expect(
      screen
        .getByRole('link', { name: /See all reviews/ })
        .element()
        .getAttribute('href')
    ).toBe('/models/1/reviews?modelVersionId=2');
    expect(state.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({ modelVersionId: 2, writtenOnly: true, limit: 4 }),
      expect.objectContaining({ enabled: true })
    );
  });

  test('with the flag off, renders nothing and does not fetch, even when reviews exist', async () => {
    state.flags = {};
    await renderSection();
    expect(section()).toBeNull();
    expect(state.useQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false })
    );
  });

  test('with no written reviews, renders nothing', async () => {
    state.items = [];
    await renderSection();
    expect(section()).toBeNull();
  });

  test('each card is one link that opens that review’s dialog; there is no Read review footer', async () => {
    const screen = await renderSection();
    await expect.element(screen.getByText('Solid.')).toBeVisible();
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        '[data-testid="model-written-review"] a[rel="nofollow"]'
      )
    );
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toContain('dialog=resourceReview');
    expect(links[0].getAttribute('href')).toContain('reviewId=1');
    expect(links[1].getAttribute('href')).toContain('reviewId=2');
    expect(links[0].textContent).toBe('Read review by reviewer1');
    expect(document.body.textContent).not.toMatch(/Read review(?! by)/);
  });

  test('the line under the title leads with the rating label, then the share rounded down and the count', async () => {
    const screen = await renderSection({ thumbsUpCount: 996, thumbsDownCount: 4 });
    await expect
      .element(screen.getByTestId('model-written-reviews-summary'))
      .toHaveTextContent('Overwhelmingly Positive · 99% of 1,000 reviews');
  });

  test('a single review reads "1 review", not "1 reviews"', async () => {
    const screen = await renderSection({ thumbsUpCount: 1, thumbsDownCount: 0 });
    await expect
      .element(screen.getByTestId('model-written-reviews-summary'))
      .toHaveTextContent(/100% of 1 review$/);
  });

  test('with no thumbs on the model, shows no summary line', async () => {
    await renderSection();
    expect(document.querySelector('[data-testid="model-written-reviews-summary"]')).toBeNull();
  });
});
