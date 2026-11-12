import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowsingLevelModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as HiddenPreferencesModule from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

// Crucible 1 has nothing left for this judge; crucible 2 has a pair.
const EMPTY_CRUCIBLE_ID = 1;
const crucibleFixture = (id: number) => ({
  id,
  name: `Crucible ${id}`,
  description: '',
  status: CrucibleStatus.Active,
  userId: 999,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  endAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  nsfwLevel: 1,
  _count: { entries: 5 },
  viewerEntries: [],
});
const entry = (id: number) => ({
  id,
  imageId: id,
  userId: id,
  image: { id, url: 'x', type: 'image', nsfwLevel: 1 },
  user: { id, username: `user${id}`, deletedAt: null, image: null },
});

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'crucible.getById': {
        useQuery: ({ id }: { id: number }) => ({ data: crucibleFixture(id), isLoading: false }),
      },
      'crucible.getJudgeEligibility': {
        useQuery: () => ({ data: { canJudge: true, score: 1000 }, isLoading: false }),
      },
      'crucible.getJudgingPair': {
        useQuery: ({ crucibleId }: { crucibleId: number }) => ({
          data:
            crucibleId === EMPTY_CRUCIBLE_ID
              ? null
              : { left: entry(10), right: entry(11), watchSeconds: 6 },
          isLoading: false,
          isFetching: false,
          isPlaceholderData: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
    }),
  };
});

// The page module's getServerSideProps pulls in server-only code that can't load in a browser.
vi.mock('~/server/utils/server-side-helpers', () => ({ createServerSideProps: () => vi.fn() }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({}),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, username: 'judge' }) }));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelModule>()),
  useBrowsingLevelDebounced: () => 1,
}));

vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenPreferencesModule>()),
  useApplyHiddenPreferences: () => ({ items: [] }),
}));

vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/components/Crucible/CrucibleJudgeNextButton', () => ({
  CrucibleJudgeNextButton: () => null,
}));

vi.mock('~/components/Crucible/CrucibleJudgingDoneState', () => ({
  CrucibleJudgingDoneState: ({ crucibleId }: { crucibleId: number }) => (
    <div data-testid="done-state">Nothing to judge right now (crucible {crucibleId})</div>
  ),
}));

vi.mock('~/components/Crucible/CrucibleJudgingUI', () => ({
  CrucibleJudgingUI: ({ pair }: { pair: { left: { id: number } } | null }) => (
    <div data-testid="arena">pair {pair?.left.id}</div>
  ),
}));

const { default: CrucibleJudgePage } = await import('~/pages/crucibles/[id]/judge');

describe('crucible judge page', () => {
  // "Next crucible" and the suggested crucibles navigate client-side to the same route, so
  // only the id prop changes. Without a remount, the caught-up state of the crucible just finished
  // carried into the next one.
  test('moving from a finished crucible to another shows the new pair, not the done state', async () => {
    const screen = await renderWithProviders(<CrucibleJudgePage id={EMPTY_CRUCIBLE_ID} />);
    await expect.element(page.getByTestId('done-state')).toBeVisible();

    await screen.rerender(<CrucibleJudgePage id={2} />);

    // Polled as text so a regression fails naming the stale screen, not on a locator timeout.
    await expect.poll(() => page.getByTestId('done-state').query()?.textContent ?? null).toBeNull();
    await expect.element(page.getByTestId('arena')).toHaveTextContent('pair 10');
  });
});
