import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowsingLevelModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as HiddenPreferencesModule from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

const mocks = vi.hoisted(() => ({
  dismiss: vi.fn<(input: unknown) => Promise<{ dismissed: boolean }>>(async () => ({
    dismissed: true,
  })),
  refetchPair: vi.fn(async () => ({ data: undefined as unknown })),
}));

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
          refetch: mocks.refetchPair,
        }),
      },
      'crucible.dismissJudgingPair': {
        useMutation: () => ({ mutateAsync: mocks.dismiss, isPending: false }),
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
  CrucibleJudgingUI: ({
    pair,
    onDismiss,
  }: {
    pair: { left: { id: number } } | null;
    onDismiss?: () => void;
  }) => (
    <div data-testid="arena">
      pair {pair?.left.id}
      <button type="button" data-testid="stub-dismiss" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  ),
}));

const { default: CrucibleJudgePage } = await import('~/pages/crucibles/[id]/judge');

describe('crucible judge page', () => {
  // "Next crucible" and the suggested crucibles navigate client-side to the same route, so
  // only the id prop changes. Without a remount, the caught-up state of the crucible just finished
  // carried into the next one.
  test('moving from a finished crucible to another shows the new pair, not the done state', async () => {
    const screen = await renderWithProviders(<CrucibleJudgePage id={EMPTY_CRUCIBLE_ID} />, {
      user: { id: 1, username: 'judge' },
    });
    await expect.element(page.getByTestId('done-state')).toBeVisible();

    await screen.rerender(<CrucibleJudgePage id={2} />);

    // Polled as text so a regression fails naming the stale screen, not on a locator timeout.
    await expect.poll(() => page.getByTestId('done-state').query()?.textContent ?? null).toBeNull();
    await expect.element(page.getByTestId('arena')).toHaveTextContent('pair 10');
  });

  test("Don't show again dismisses the pair on screen, then loads the next one", async () => {
    mocks.dismiss.mockClear();
    mocks.refetchPair.mockClear();
    await renderWithProviders(<CrucibleJudgePage id={2} />, { user: { id: 1, username: 'judge' } });
    await expect.element(page.getByTestId('arena')).toHaveTextContent('pair 10');

    // A DOM click: the first-visit briefing covers the arena, and this pins the page's handler.
    document.querySelector<HTMLButtonElement>('[data-testid="stub-dismiss"]')?.click();

    await expect
      .poll(() => mocks.dismiss.mock.calls)
      .toEqual([[{ crucibleId: 2, entryIds: [10, 11] }]]);
    await expect.poll(() => mocks.refetchPair.mock.calls.length).toBe(1);
    // Let the refetch settle and React commit before asserting what did not render.
    await mocks.refetchPair.mock.results[0]?.value;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      page.getByTestId('done-state').query(),
      'done state with a next pair to load'
    ).toBeNull();
  });

  test("Don't show again on the last pair shows the done state", async () => {
    mocks.refetchPair.mockClear();
    mocks.refetchPair.mockResolvedValueOnce({ data: null });
    await renderWithProviders(<CrucibleJudgePage id={2} />, { user: { id: 1, username: 'judge' } });
    await expect.element(page.getByTestId('arena')).toHaveTextContent('pair 10');

    document.querySelector<HTMLButtonElement>('[data-testid="stub-dismiss"]')?.click();

    await expect.poll(() => page.getByTestId('done-state').query() !== null).toBe(true);
  });

  test("a double click on Don't show again dismisses once", async () => {
    mocks.dismiss.mockClear();
    await renderWithProviders(<CrucibleJudgePage id={2} />, { user: { id: 1, username: 'judge' } });
    await expect.element(page.getByTestId('arena')).toHaveTextContent('pair 10');

    const button = document.querySelector<HTMLButtonElement>('[data-testid="stub-dismiss"]')!;
    button.click();
    button.click();

    await expect.poll(() => mocks.refetchPair.mock.calls.length).toBeGreaterThan(0);
    expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  });
});
