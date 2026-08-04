import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The panel must never present buckets that were never measured as earnings.
 * `getMyRevenue` returns all-zero buckets both for a publisher who has genuinely
 * earned nothing yet and for a caller the dark `appBlocks` flag never let it
 * query — only `unavailable` separates them, so rendering the former shape for
 * the latter fabricates a clean $0.00 revenue report.
 *
 * Both /apps/revenue and /apps/[appBlockId]/revenue render this component, so
 * these cases cover the guard for both pages.
 */

const mocks = vi.hoisted(() => ({ revenue: { current: undefined as unknown } }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    blocks: {
      getMyRevenue: {
        useQuery: () => ({ data: mocks.revenue.current, isLoading: false, error: null }),
      },
    },
  },
}));

const { RevenuePanel } = await import('./RevenuePanel');

const ZERO_BUCKET = { count: 0, grossCents: 0, shareCents: 0 };
const ZEROED = {
  summary: {
    pending: { ...ZERO_BUCKET },
    confirmed: { ...ZERO_BUCKET },
    paidOut: { ...ZERO_BUCKET },
    voided: { count: 0, grossCents: 0 },
  },
  topApps: [],
  recentAttributions: [],
};

describe('RevenuePanel — unavailable vs genuine zero', () => {
  test('dark flag (notEntitled): shows an honest unavailable state, NOT a $0.00 dashboard', async () => {
    mocks.revenue.current = { ...ZEROED, unavailable: 'notEntitled' };
    renderWithProviders(<RevenuePanel />);

    await expect.element(page.getByText('Revenue unavailable')).toBeInTheDocument();
    await expect.element(page.getByText(/not a report of zero earnings/i)).toBeInTheDocument();
    // The fabricated dashboard must be gone entirely.
    expect(page.getByText('Pending').elements()).toHaveLength(0);
    expect(page.getByText('Confirmed (unpaid)').elements()).toHaveLength(0);
    expect(page.getByText('Recent attributions').elements()).toHaveLength(0);
  });

  test('dark flag, scoped to one app: same guard on the per-app revenue page', async () => {
    mocks.revenue.current = { ...ZEROED, unavailable: 'notEntitled' };
    renderWithProviders(<RevenuePanel appBlockId="apb_1" />);

    await expect.element(page.getByText('Revenue unavailable')).toBeInTheDocument();
    expect(page.getByText('Pending').elements()).toHaveLength(0);
    expect(page.getByText('Recent attributions').elements()).toHaveLength(0);
  });

  test('DISCRIMINATOR: a genuine earned-nothing result still renders the real dashboard', async () => {
    // Byte-identical buckets to the two cases above — only `unavailable` is
    // absent. If a later change flags this path too, a publisher loses a report
    // they are entitled to; if it stops flagging the others, the fabricated zero
    // comes back.
    mocks.revenue.current = { ...ZEROED };
    renderWithProviders(<RevenuePanel />);

    await expect.element(page.getByText('Pending')).toBeInTheDocument();
    await expect.element(page.getByText('Confirmed (unpaid)')).toBeInTheDocument();
    await expect.element(page.getByText('Recent attributions')).toBeInTheDocument();
    expect(page.getByText('Revenue unavailable').elements()).toHaveLength(0);
  });
});
