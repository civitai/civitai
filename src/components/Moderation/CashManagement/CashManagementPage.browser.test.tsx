import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as CreatorCardModule from '~/components/CreatorCard/CreatorCard';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const TARGET_ID = 1234;

type CreatorState = 'loaded' | 'loading' | 'other-id' | 'not-found' | 'error';

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  ledgerQuery: vi.fn(),
  creator: 'loaded' as CreatorState,
  cashLoaded: true,
  cashOtherId: false,
  ledgerRows: [] as unknown[],
}));

function creatorResult(id: number) {
  switch (h.creator) {
    case 'loaded':
      return { data: { id, username: 'RightUser' }, isFetched: true, error: null };
    // A response still on screen for the id typed before this one.
    case 'other-id':
      return { data: { id: id + 1, username: 'OtherUser' }, isFetched: true, error: null };
    case 'not-found':
      return {
        data: undefined,
        isFetched: true,
        error: { message: 'Could not find user', data: { code: 'NOT_FOUND' } },
      };
    case 'error':
      return {
        data: undefined,
        isFetched: true,
        error: { message: 'Upstream timed out', data: { code: 'INTERNAL_SERVER_ERROR' } },
      };
    default:
      return { data: undefined, isFetched: false, error: null };
  }
}

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
    'user.getCreator': { useQuery: ({ id }: { id: number }) => creatorResult(id) },
    'moderator.cash': {
      getCashForUser: {
        useQuery: ({ userId }: { userId: number }) => ({
          data: h.cashLoaded
            ? {
                // A balance still on screen for the id typed before this one.
                id: h.cashOtherId ? userId + 1 : userId,
                pending: 2000,
                ready: 5000,
                withdrawn: 0,
                status: 'ready',
              }
            : undefined,
          isLoading: !h.cashLoaded,
          error: null,
        }),
      },
      getWithdrawalHistory: { useQuery: () => ({ data: [], isLoading: false }) },
      adjustBalance: { useMutation: () => ({ mutate: h.mutate, isPending: false }) },
      updateWithdrawal: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      getCashTransactions: {
        useInfiniteQuery: (input: unknown) => {
          h.ledgerQuery(input);
          return {
            data: { pages: [{ cursor: null, transactions: h.ledgerRows }] },
            isLoading: false,
            error: null,
            hasNextPage: false,
            isFetchingNextPage: false,
            fetchNextPage: vi.fn(),
          };
        },
      },
    },
  }),
}));

import { CashManagementPage } from '~/components/Moderation/CashManagement/CashManagementPage';
import { TransactionType } from '~/shared/constants/buzz.constants';

beforeEach(() => {
  vi.clearAllMocks();
  h.creator = 'loaded';
  h.cashLoaded = true;
  h.cashOtherId = false;
  h.ledgerRows = [];
});

async function fillForm(amount: string) {
  await userEvent.fill(page.getByLabelText('User ID'), String(TARGET_ID));
  await userEvent.fill(page.getByLabelText('Amount (in cents)'), amount);
  await userEvent.fill(page.getByLabelText('Reason / Note'), 'payout correction');
}

async function choose(label: string, option: string) {
  await userEvent.click(page.getByRole('textbox', { name: label }));
  await userEvent.click(page.getByRole('option', { name: option }));
}

const grantButton = () => page.getByRole('button', { name: /^Grant \$10\.00 to Settled/ });

describe('CashManagementPage adjustment', () => {
  // Opening the confirm before the target's name and balance are on screen is how a mistyped id
  // reaches the wrong account unseen.
  test.each([
    ['nothing has loaded', { creator: 'loading', cashLoaded: false, cashOtherId: false }],
    ['the balance has not loaded', { creator: 'loaded', cashLoaded: false, cashOtherId: false }],
    ['the user has not loaded', { creator: 'loading', cashLoaded: true, cashOtherId: false }],
    [
      'the user on screen belongs to another id',
      { creator: 'other-id', cashLoaded: true, cashOtherId: false },
    ],
    [
      'the balance on screen belongs to another id',
      { creator: 'loaded', cashLoaded: true, cashOtherId: true },
    ],
  ] as const)('cannot open the confirm while %s', async (_, state) => {
    h.creator = state.creator;
    h.cashLoaded = state.cashLoaded;
    h.cashOtherId = state.cashOtherId;
    renderWithProviders(<CashManagementPage />);
    await fillForm('1000');

    await expect.element(grantButton()).toBeDisabled();
  });

  test('confirm names the target, shows the balance before and after, and needs the username typed', async () => {
    renderWithProviders(<CashManagementPage />);
    await fillForm('1000');
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

  test('a deduct from Pending is confirmed against the Pending balance and warns when it overdraws', async () => {
    renderWithProviders(<CashManagementPage />);
    await fillForm('2500');
    await choose('Account Type', 'Cash Pending');
    await choose('Direction', 'Deduct (remove funds)');
    await userEvent.click(page.getByRole('button', { name: /^Deduct \$25\.00 from Pending/ }));

    await expect.element(page.getByTestId('balance-now')).toHaveTextContent('$20.00');
    await expect.element(page.getByTestId('balance-after')).toHaveTextContent('−$5.00');
    await expect
      .element(page.getByText(/larger than the current Cash Pending balance/))
      .toBeVisible();

    await userEvent.fill(page.getByLabelText(/Type the username/), 'RightUser');
    await userEvent.click(page.getByRole('button', { name: 'Confirm Deduction' }));

    expect(h.mutate).toHaveBeenCalledWith({
      userId: TARGET_ID,
      amount: 2500,
      accountType: 'cashPending',
      direction: 'deduct',
      note: 'payout correction',
    });
  });

  // A timeout read as "no such user" sends the moderator hunting for a different id.
  test('a failed user lookup is not reported as an unknown user', async () => {
    h.creator = 'error';
    renderWithProviders(<CashManagementPage />);
    await userEvent.fill(page.getByLabelText('User ID'), String(TARGET_ID));

    await expect.element(page.getByText('Could not load this user')).toBeVisible();
    expect(page.getByText('User not found').query()).toBeNull();
  });

  test('an unknown id says so', async () => {
    h.creator = 'not-found';
    renderWithProviders(<CashManagementPage />);
    await userEvent.fill(page.getByLabelText('User ID'), String(TARGET_ID));

    await expect.element(page.getByText('User not found')).toBeVisible();
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
  });

  test("reads the typed user's Settled account, and Pending when switched", async () => {
    renderWithProviders(<CashManagementPage />);
    await userEvent.fill(page.getByLabelText('User ID'), String(TARGET_ID));
    await expect.element(page.getByText('No transactions in this account.')).toBeVisible();
    expect(h.ledgerQuery).toHaveBeenLastCalledWith({
      userId: TARGET_ID,
      accountType: 'cashSettled',
    });

    await userEvent.click(page.getByText('Pending', { exact: true }).last());
    await vi.waitFor(() =>
      expect(h.ledgerQuery).toHaveBeenLastCalledWith({
        userId: TARGET_ID,
        accountType: 'cashPending',
      })
    );
  });
});
