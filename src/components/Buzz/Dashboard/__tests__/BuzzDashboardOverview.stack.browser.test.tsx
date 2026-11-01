import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../../test/component-setup';

const mocks = vi.hoisted(() => ({
  balances: { yellow: 1200, green: 345 } as Record<string, number>,
}));

vi.mock('~/components/Buzz/useBuzz', () => ({
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

  test('remembers the choice after a remount, per tab', async () => {
    const first = await render('yellow');
    await page.getByRole('switch').click();
    await first.unmount();

    await render('yellow');
    await expect.element(page.getByText('Current Yellow + Green Buzz')).toBeInTheDocument();
  });

  test('the Green tab keeps its own choice', async () => {
    const first = await render('yellow');
    await page.getByRole('switch').click();
    await first.unmount();

    await render('green');
    await expect.element(page.getByText('Current Green Buzz')).toBeInTheDocument();
    await expect.element(page.getByText('345', { exact: true })).toBeInTheDocument();
  });

  test('a stored choice is ignored on a type with no partner', async () => {
    localStorage.setItem('buzz-dashboard-stack-blue', 'true');
    await render('blue');
    await expect.element(page.getByText('Current Blue Buzz')).toBeInTheDocument();
    expect(page.getByRole('switch').query()).toBeNull();
  });
});
