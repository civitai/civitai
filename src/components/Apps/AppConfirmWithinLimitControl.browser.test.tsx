import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';

/**
 * The /apps/activity line for an app the viewer lets run jobs without asking: today's spend
 * against the limit, and the switch that turns it off.
 */

type MutationOpts = { onSuccess: () => Promise<void> };

const mocks = vi.hoisted(() => ({
  data: null as null | { maxJob: number; limit: number; spentToday: number },
  mutate: vi.fn(),
  invalidate: vi.fn(async () => undefined),
  mutationOpts: null as unknown as MutationOpts,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'blocks.getMyConfirmWithinLimit': { useQuery: () => ({ data: mocks.data }) },
        'blocks.optOutConfirmWithinLimit': {
          useMutation: (opts: MutationOpts) => {
            mocks.mutationOpts = opts;
            return { mutate: mocks.mutate, isPending: false };
          },
        },
      },
      {
        useUtils: () => ({
          blocks: {
            getMyConfirmWithinLimit: { invalidate: mocks.invalidate },
            getMyAppDailyLimit: { invalidate: mocks.invalidate },
          },
        }),
      }
    ),
  };
});

// eslint-disable-next-line import/first
import { AppConfirmWithinLimitControl } from '~/components/Apps/AppConfirmWithinLimitControl';

describe('AppConfirmWithinLimitControl', () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.invalidate.mockClear();
  });

  test('opted in: shows the job ceiling and today’s spend against the limit', async () => {
    mocks.data = { maxJob: 1040, limit: 10_000, spentToday: 2080 };
    renderWithProviders(<AppConfirmWithinLimitControl appBlockId="apb_test" />);
    await expect
      .element(page.getByTestId('app-confirm-within-limit'))
      .toHaveTextContent('Runs jobs up to 1,040 Buzz without asking');
    await expect
      .element(page.getByTestId('app-confirm-within-limit-spend'))
      .toHaveTextContent('2,080 of 10,000 Buzz spent today');
  });

  test('"Ask me each job" turns it off for this app and refreshes what the host reads', async () => {
    mocks.data = { maxJob: 1040, limit: 10_000, spentToday: 0 };
    renderWithProviders(<AppConfirmWithinLimitControl appBlockId="apb_test" />);
    await userEvent.click(page.getByTestId('app-confirm-within-limit-off'));
    expect(mocks.mutate).toHaveBeenCalledWith({ appBlockId: 'apb_test' });
    await mocks.mutationOpts.onSuccess();
    expect(mocks.invalidate).toHaveBeenCalledTimes(2);
  });

  test('not opted in: renders nothing', async () => {
    mocks.data = null;
    renderWithProviders(
      <>
        <span data-testid="anchor">mounted</span>
        <AppConfirmWithinLimitControl appBlockId="apb_test" />
      </>
    );
    await expect.element(page.getByTestId('anchor')).toBeInTheDocument();
    expect(page.getByTestId('app-confirm-within-limit').query()).toBeNull();
  });
});
