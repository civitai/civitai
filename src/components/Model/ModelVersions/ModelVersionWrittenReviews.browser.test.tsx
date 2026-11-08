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

const renderSection = () =>
  renderWithProviders(<ModelVersionWrittenReviews modelId={1} modelVersionId={2} />);
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
});
