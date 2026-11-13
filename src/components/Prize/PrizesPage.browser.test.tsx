import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as TrpcModule from '~/utils/trpc';

/**
 * A failed `prize.getMine` used to fall through to "You have no prizes yet", which hid a
 * schema rejection from every user for weeks. A failure must read as a failure.
 */

const mocks = vi.hoisted(() => ({
  query: {} as { data?: unknown[]; isLoading: boolean; isError: boolean },
  refetch: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'prize.getMine': { useQuery: () => ({ ...mocks.query, refetch: mocks.refetch }) },
  }),
}));
vi.mock('~/server/utils/server-side-helpers', () => ({ createServerSideProps: () => undefined }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/components/Prize/PrizeClaimCard', () => ({
  PrizeClaimCard: ({ prize }: { prize: { id: number } }) => <div>prize {prize.id}</div>,
}));

const { default: PrizesPage } = await import('~/pages/prizes/index');

beforeEach(() => {
  mocks.refetch.mockReset();
});

describe('/prizes', () => {
  test('a failed query shows an error with Retry, not the empty state', async () => {
    mocks.query = { data: undefined, isLoading: false, isError: true };
    renderWithProviders(<PrizesPage />);

    await expect.element(page.getByText('Could not load your prizes.')).toBeInTheDocument();
    expect(page.getByText('You have no prizes yet.').elements()).toHaveLength(0);
    await page.getByRole('button', { name: 'Retry' }).click();
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  test('an empty successful query still shows the empty state', async () => {
    mocks.query = { data: [], isLoading: false, isError: false };
    renderWithProviders(<PrizesPage />);

    await expect.element(page.getByText('You have no prizes yet.')).toBeInTheDocument();
  });
});
