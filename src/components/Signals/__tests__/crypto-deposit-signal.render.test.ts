// @vitest-environment happy-dom
/**
 * `useCryptoDepositSignal` is mounted for the whole session by `SignalsRegistrar`, on every
 * page. Requests are counted at a fake transport behind a REAL React Query client using the
 * app's own default options, so "no request" below means React Query decided not to fetch —
 * not that a mocked hook was never asked.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import type { QueryClientTrpcFake } from '../../../../test/queryClientTrpcFake';

const act = (React as unknown as { act: typeof actType }).act;

const CURRENCIES = 'nowPayments.getSupportedCurrencies';
const BUZZ_ACCOUNT = 'buzz.getBuzzAccount';

const h = vi.hoisted(() => ({
  user: { id: 1 } as { id: number } | null,
  handler: undefined as undefined | ((data: unknown) => unknown),
  showNotification: vi.fn(),
  fake: undefined as unknown as QueryClientTrpcFake,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => h.user }));
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalConnection: (_message: string, cb: (data: unknown) => unknown) => {
    h.handler = cb;
  },
}));
vi.mock('@mantine/notifications', () => ({ showNotification: h.showNotification }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const { makeQueryClientTrpcFake } = await import('../../../../test/queryClientTrpcFake');
  h.fake = makeQueryClientTrpcFake(actual.queryClient.getDefaultOptions());
  return { ...actual, trpc: h.fake.trpc };
});

import { SUPPORTED_CURRENCIES_STALE_TIME } from '~/components/Buzz/CryptoDeposit/crypto-deposit.hooks';
import { useCryptoDepositSignal } from '~/components/Signals/CryptoDepositSignal';
import { trpc } from '~/utils/trpc';

const callsTo = (path: string) => h.fake.callsTo(path);

const currencies = [
  {
    ticker: 'usdt',
    name: 'Tether',
    networks: [
      { code: 'usdttrc20', name: 'Tether (TRC20)', network: 'tron', ticker: null },
      { code: 'usdterc20', name: 'Tether (ERC20)', network: 'eth', ticker: null },
    ],
  },
];

function Registrar() {
  useCryptoDepositSignal();
  return null;
}

/** The header balance — an active observer, as on every signed-in page. */
function BuzzBalance() {
  trpc.buzz.getBuzzAccount.useQuery(undefined, { enabled: !!h.user });
  return null;
}

const DEPOSIT_HISTORY = 'nowPayments.getDepositHistory';

/** The deposit history list, as the buzz dashboard mounts it. */
function DepositHistory() {
  trpc.nowPayments.getDepositHistory.useQuery(undefined);
  return null;
}

let container: HTMLDivElement;
let root: Root;

function mount(...components: React.FC[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        React.Fragment,
        null,
        ...components.map((c, i) => React.createElement(c, { key: i }))
      )
    );
  });
}

function unmount() {
  act(() => root.unmount());
  container.remove();
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** Delivers a signal. A rejection is swallowed as the signal worker swallows it: what counts is the toast. */
async function signal(data: Record<string, unknown>) {
  await act(async () => {
    await Promise.resolve(h.handler!({ paymentId: 'p1', amount: 10, ...data })).catch(
      () => undefined
    );
  });
}

const lastMessage = () =>
  h.showNotification.mock.calls.at(-1)?.[0] as
    | { title: string; message: string; color: string }
    | undefined;

beforeEach(() => {
  h.user = { id: 1 };
  h.handler = undefined;
  h.showNotification.mockReset();
  h.fake.reset({
    [CURRENCIES]: () => currencies,
    [BUZZ_ACCOUNT]: () => ({ yellow: 100 }),
    [DEPOSIT_HISTORY]: () => [],
  });
});

afterEach(() => {
  if (container?.isConnected) unmount();
});

describe('useCryptoDepositSignal — page load', () => {
  it('a signed-in page load does not request the supported currencies', async () => {
    mount(Registrar, BuzzBalance);
    await flush();

    // Positive control: the transport sees the shell's other request, so the zero below is not
    // a probe wired to nothing.
    expect(callsTo(BUZZ_ACCOUNT)).toBe(1);
    expect(callsTo(CURRENCIES)).toBe(0);
  });

  it('a client navigation (remount) does not request them either', async () => {
    mount(Registrar);
    await flush();
    unmount();
    mount(Registrar);
    await flush();

    expect(callsTo(CURRENCIES)).toBe(0);
  });
});

describe('useCryptoDepositSignal — on a deposit signal', () => {
  it('names the currency in the completion toast and refreshes the balance and history', async () => {
    mount(Registrar, BuzzBalance, DepositHistory);
    await flush();
    expect(callsTo(BUZZ_ACCOUNT)).toBe(1);
    expect(callsTo(DEPOSIT_HISTORY)).toBe(1);

    await signal({ status: 'finished', currency: 'USDTTRC20', outcomeAmount: 1.5 });
    await flush();

    expect(lastMessage()).toEqual({
      title: 'Crypto Deposit Complete',
      message: 'You received 1,500 Buzz from your USDT on Tron deposit.',
      color: 'green',
    });
    expect(callsTo(CURRENCIES)).toBe(1);
    // The balance shown in the header and the open history list are refetched, as before.
    expect(callsTo(BUZZ_ACCOUNT)).toBe(2);
    expect(callsTo(DEPOSIT_HISTORY)).toBe(2);
  });

  it('names the currency in the confirming toast', async () => {
    mount(Registrar);
    await flush();

    await signal({ status: 'confirming', currency: 'usdterc20' });

    expect(lastMessage()).toEqual({
      title: 'Crypto Deposit Detected',
      message: 'Your USDT on Ethereum deposit is being confirmed on-chain.',
      color: 'blue',
    });
  });

  it('reuses a currency list the deposit UI already loaded', async () => {
    mount(Registrar);
    await flush();
    await act(async () => {
      await h.fake.client.fetchQuery({
        queryKey: h.fake.queryKey(CURRENCIES),
        queryFn: async () => currencies,
      });
    });

    await signal({ status: 'confirming', currency: 'usdttrc20' });
    await signal({ status: 'finished', currency: 'usdttrc20', outcomeAmount: 2 });

    expect(callsTo(CURRENCIES)).toBe(0);
    expect(lastMessage()?.message).toBe('You received 2,000 Buzz from your USDT on Tron deposit.');
  });

  it('refetches a currency list older than its stale time', async () => {
    mount(Registrar);
    await flush();
    act(() => {
      h.fake.client.setQueryData(h.fake.queryKey(CURRENCIES), currencies, {
        updatedAt: Date.now() - SUPPORTED_CURRENCIES_STALE_TIME - 1000,
      });
    });

    await signal({ status: 'confirming', currency: 'usdttrc20' });

    expect(callsTo(CURRENCIES)).toBe(1);
  });

  it('still shows the toast, with the raw code, when the currency lookup fails', async () => {
    h.fake.respond(CURRENCIES, () => {
      throw new Error('currency lookup down');
    });
    mount(Registrar);
    await flush();

    await signal({ status: 'finished', currency: 'usdttrc20' });

    expect(lastMessage()).toEqual({
      title: 'Crypto Deposit Complete',
      message: 'Your USDTTRC20 deposit has been processed.',
      color: 'green',
    });
  });
});
