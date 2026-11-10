import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as CreatorCardModule from '~/components/CreatorCard/CreatorCard';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const TARGET_ID = 1234;

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  fetchNextPage: vi.fn(),
  targetLoaded: true,
  ledgerRows: [] as unknown[],
}));

vi.mock('~/components/CreatorCard/CreatorCard', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorCardModule>()),
  CreatorCardV2: () => null,
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'user.getCreator': {
      useQuery: ({ id }: { id: number }) => ({
        data: h.targetLoaded ? { id, username: 'RightUser' } : undefined,
        isFetched: h.targetLoaded,
        error: null,
      }),
    },
    'moderator.cash': {
      getCashForUser: {
        useQuery: ({ userId }: { userId: number }) => ({
          data: h.targetLoaded
            ? { id: userId, pending: 0, ready: 5000, withdrawn: 0, status: 'ready' }
            : undefined,
          isLoading: !h.targetLoaded,
          error: null,
        }),
      },
      getWithdrawalHistory: { useQuery: () => ({ data: [], isLoading: false }) },
      adjustBalance: { useMutation: () => ({ mutate: h.mutate, isPending: false }) },
      updateWithdrawal: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      getCashTransactions: {
        useInfiniteQuery: () => ({
          data: { pages: [{ cursor: new Date(), transactions: h.ledgerRows }] },
          isLoading: false,
          error: null,
          hasNextPage: true,
          isFetchingNextPage: false,
          fetchNextPage: h.fetchNextPage,
        }),
      },
    },
  }),
}));

import { CashManagementPage } from '~/components/Moderation/CashManagement/CashManagementPage';
import { TransactionType } from '~/shared/constants/buzz.constants';

beforeEach(() => {
  vi.clearAllMocks();
  h.targetLoaded = true;
  h.ledgerRows = [];
});

async function fillGrant() {
  await userEvent.fill(page.getByLabelText('User ID'), String(TARGET_ID));
  await userEvent.fill(page.getByLabelText('Amount (in cents)'), '1000');
  await userEvent.fill(page.getByLabelText('Reason / Note'), 'payout correction');
}

const grantButton = () => page.getByRole('button', { name: /^Grant \$10\.00 to Settled/ });

describe('CashManagementPage adjustment', () => {
  // Opening the confirm before the target's name and balance are on screen is how a mistyped id
  // reaches the wrong account unseen.
  test('cannot open the confirm while the target user is still loading', async () => {
    h.targetLoaded = false;
    renderWithProviders(<CashManagementPage />);
    await fillGrant();

    await expect.element(grantButton()).toBeDisabled();
  });

  test('confirm names the target, shows the balance before and after, and needs the username typed', async () => {
    renderWithProviders(<CashManagementPage />);
    await fillGrant();
    await userEvent.click(grantButton());

    await expect.element(page.getByText('@RightUser')).toBeVisible();
    await expect.element(page.getByTestId('balance-now')).toHaveTextContent('$50.00');
    await expect.element(page.getByTestId('balance-after')).toHaveTextContent('$60.00');

    const confirm = page.getByRole('button', { name: 'Confirm Grant' });
    const typeName = page.getByLabelText(/Type the username/);
    await expect.element(confirm).toBeDisabled();

    await userEvent.fill(typeName, 'WrongUser');
    await expect.element(confirm).toBeDisabled();

    await userEvent.fill(typeName, 'rightuser');
    await expect.element(confirm).toBeEnabled();
    await userEvent.click(confirm);

    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate).toHaveBeenCalledWith({
      userId: TARGET_ID,
      amount: 1000,
      accountType: 'cashSettled',
      direction: 'grant',
      note: 'payout correction',
    });
  });
});

describe('CashManagementPage cash ledger', () => {
  test('signs rows by amount, so a mod deduct recorded as a Withdrawal reads as a debit', async () => {
    h.ledgerRows = [
      {
        date: new Date('2026-11-01T12:00:00Z'),
        type: TransactionType.Incentive,
        amount: 1000,
        description: 'Mod cash adjustment (grant): first',
      },
      {
        date: new Date('2026-11-02T12:00:00Z'),
        type: TransactionType.Withdrawal,
        amount: -2500,
        description: 'Mod cash adjustment (deduct): error',
      },
      {
        date: new Date('2026-11-03T12:00:00Z'),
        type: TransactionType.Refund,
        amount: 700,
        description: 'Refund for failed withdrawal. Fees: 0',
      },
    ];
    renderWithProviders(<CashManagementPage />);
    await userEvent.fill(page.getByLabelText('User ID'), String(TARGET_ID));

    const deductRow = page.getByRole('row').filter({ hasText: 'Mod cash adjustment (deduct)' });
    await expect.element(deductRow).toHaveTextContent('Debit');
    await expect.element(deductRow).toHaveTextContent('−$25.00');

    const grantRow = page.getByRole('row').filter({ hasText: 'Mod cash adjustment (grant)' });
    await expect.element(grantRow).toHaveTextContent('Credit');
    await expect.element(grantRow).toHaveTextContent('+$10.00');

    const refundRow = page.getByRole('row').filter({ hasText: 'Refund for failed withdrawal' });
    await expect.element(refundRow).toHaveTextContent('Return');
    await expect.element(refundRow).toHaveTextContent('+$7.00');

    await userEvent.click(page.getByRole('button', { name: 'Load more' }));
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
