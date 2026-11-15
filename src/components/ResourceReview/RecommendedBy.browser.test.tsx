import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

const state = vi.hoisted(() => {
  const s = {
    pages: [] as { items: { user: { id: number; username: string } }[]; nextCursor?: number }[],
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    useInfiniteQuery: vi.fn((..._args: unknown[]) => ({
      data: { pages: s.pages },
      hasNextPage: s.hasNextPage,
      fetchNextPage: s.fetchNextPage,
      isFetchingNextPage: false,
    })),
  };
  return s;
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'resourceReview.getRecommendedBy': {
      useInfiniteQuery: (...args: unknown[]) => state.useInfiniteQuery(...args),
    },
  }),
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));

import { RecommendedBy } from './RecommendedBy';

const item = (id: number) => ({ user: { id, username: `fan${id}` } });
const render = () => renderWithProviders(<RecommendedBy modelId={1} modelVersionId={2} />);

beforeEach(() => {
  state.pages = [{ items: [item(1), item(2)], nextCursor: 2 }];
  state.hasNextPage = true;
  state.fetchNextPage.mockClear();
  state.useInfiniteQuery.mockClear();
});

describe('RecommendedBy', () => {
  test('lists the reviewers of the version and fetches the next page on Show more', async () => {
    const screen = await render();
    await expect.element(screen.getByRole('heading', { name: 'Recommended by' })).toBeVisible();
    await expect.element(screen.getByText('fan1')).toBeVisible();
    await expect.element(screen.getByText('fan2')).toBeVisible();
    const [input, options] = state.useInfiniteQuery.mock.calls[0] as [
      unknown,
      { getNextPageParam: (page: { nextCursor?: number }) => number | undefined }
    ];
    expect(input).toEqual({ modelId: 1, modelVersionId: 2 });
    expect(options.getNextPageParam({ nextCursor: 3 })).toBe(3);
    expect(options.getNextPageParam({})).toBeUndefined();

    await screen.getByRole('button', { name: 'Show more' }).click();
    expect(state.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  test('has no Show more on the last page', async () => {
    state.hasNextPage = false;
    const screen = await render();
    await expect.element(screen.getByText('fan1')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show more' }).elements()).toHaveLength(0);
  });

  test('renders nothing when nobody recommended without a review', async () => {
    state.pages = [{ items: [] }];
    state.hasNextPage = false;
    await render();
    expect(document.querySelector('section')).toBeNull();
    expect(document.body.textContent).not.toContain('Recommended by');
  });
});
