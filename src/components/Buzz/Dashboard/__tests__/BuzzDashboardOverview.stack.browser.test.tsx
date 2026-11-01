import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../../test/component-setup';

const mocks = vi.hoisted(() => ({
  balances: { yellow: 1200, green: 345 } as Record<string, number>,
}));

vi.mock('~/components/Buzz/useBuzz', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryBuzz: (types: string[] = []) => {
    const accounts = types.map((type) => ({ type, balance: mocks.balances[type] ?? 0 }));
    return {
      data: { accounts, total: accounts.reduce((n, a) => n + a.balance, 0), nsfwTotal: 0 },
      isLoading: false,
    };
  },
  useBuzzTransactions: () => ({ transactions: [], isLoading: false }),
  useTransactionsReport: () => ({ report: [], isLoading: false }),
}));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({
  useAvailableBuzz: (types: string[] = []) => types,
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({}) }));
vi.mock('~/components/Buzz/BuzzTopUpCard', () => ({ BuzzTopUpCard: () => null }));
vi.mock('react-chartjs-2', () => ({ Bar: () => null }));

import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { BuzzDashboardOverview } from '~/components/Buzz/Dashboard/BuzzDashboardOverview';

const render = (type: 'yellow' | 'green' | 'blue') =>
  renderWithProviders(
    <ContainerProvider containerName="main">
      <BuzzDashboardOverview accountId={1} selectedAccountType={type} />
    </ContainerProvider>
  );

describe('BuzzDashboardOverview stacking', () => {
  beforeEach(() => localStorage.clear());

  test('off by default: header shows the single balance', async () => {
    await render('yellow');
    await expect.element(page.getByText('Current Yellow Buzz')).toBeInTheDocument();
    await expect.element(page.getByText('1,200')).toBeInTheDocument();
  });

  test('turning it on sums both balances and names both', async () => {
    await render('yellow');
    await page.getByRole('switch').click();
    await expect.element(page.getByText('Current Yellow + Green Buzz')).toBeInTheDocument();
    await expect.element(page.getByText('1,545')).toBeInTheDocument();
  });

  test('remembers the choice after a remount', async () => {
    const first = await render('yellow');
    await page.getByRole('switch').click();
    await first.unmount();

    await render('yellow');
    await expect.element(page.getByText('Current Yellow + Green Buzz')).toBeInTheDocument();
  });

  test('turning it back off restores the single header', async () => {
    await render('yellow');
    await page.getByRole('switch').click();
    await page.getByRole('switch').click();
    await expect.element(page.getByText('Current Yellow Buzz')).toBeInTheDocument();
    expect(localStorage.getItem('buzz-dashboard-stack-yellow')).toBe('false');
  });

  test('each tab keeps its own choice', async () => {
    // Yellow stacked, Green not: Green must show its own single header after the storage read.
    localStorage.setItem('buzz-dashboard-stack-yellow', 'true');
    const yellow = await render('yellow');
    await expect.element(page.getByText('Current Yellow + Green Buzz')).toBeInTheDocument();
    await yellow.unmount();

    const green = await render('green');
    await expect.element(page.getByText('Current Green Buzz')).toBeInTheDocument();
    await page.getByRole('switch').click();
    await expect.element(page.getByText('Current Green + Yellow Buzz')).toBeInTheDocument();
    await green.unmount();

    // Turning Green on left Yellow's remembered choice alone.
    expect(localStorage.getItem('buzz-dashboard-stack-yellow')).toBe('true');
    expect(localStorage.getItem('buzz-dashboard-stack-green')).toBe('true');
  });

  test('the info popover lists each balance while stacking', async () => {
    await render('yellow');
    await page.getByRole('switch').click();
    await page.getByLabelText('Buzz info').click();
    await expect.element(page.getByText('Yellow Buzz: 1,200')).toBeInTheDocument();
    await expect.element(page.getByText('Green Buzz: 345')).toBeInTheDocument();
  });
});
