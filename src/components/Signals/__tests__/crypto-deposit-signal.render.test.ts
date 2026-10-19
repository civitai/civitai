// @vitest-environment happy-dom
/**
 * `useCryptoDepositSignal` is mounted for the whole session by `SignalsRegistrar`, on every
 * page. Requests are counted at a fake transport behind a REAL React Query client using the
 * app's own default options, so "no request" below means React Query decided not to fetch —
 * not that a mocked hook was never asked.
 */
import { QueryClient, useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

const act = (React as unknown as { act: typeof actType }).act;

const CURRENCIES = 'nowPayments.getSupportedCurrencies';
const BUZZ_ACCOUNT = 'buzz.getBuzzAccount';

const h = vi.hoisted(() => ({
  user: { id: 1 } as { id: number } | null,
  handler: undefined as undefined | ((data: unknown) => unknown),
  showNotification: vi.fn(),
  calls: [] as string[],
  responses: {} as Record<string, () => unknown>,
  client: undefined as unknown,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => h.user }));
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalConnection: (_message: string, cb: (data: unknown) => unknown) => {
    h.handler = cb;
  },
}));
vi.mock('@mantine/notifications', () => ({ showNotification: h.showNotification }));

/**
 * The subset of the tRPC React surface these hooks use, routed to real React Query calls with
 * tRPC's key shape (`[path, input]`), so seeding, staleness and invalidation behave as they do
 * in the app.
 */
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const client = new QueryClient({ defaultOptions: actual.queryClient.getDefaultOptions() });
  h.client = client;
  const key = (path: string, input: unknown) => [path, input ?? null];
  const queryFn = (path: string) => async () => {
    h.calls.push(path);
    const respond = h.responses[path];
    if (!respond) throw new Error(`no response scripted for ${path}`);
    return respond();
  };
  const proc = (path: string) => ({
    useQuery: (input: unknown, opts: Record<string, unknown> = {}) => {
      const { trpc: _trpc, ...rest } = opts;
      return useQuery({ queryKey: key(path, input), queryFn: queryFn(path), ...rest }, client);
    },
  });
  const utilsProc = (path: string) => ({
    fetch: (input: unknown, opts: Record<string, unknown> = {}) =>
      client.fetchQuery({ queryKey: key(path, input), queryFn: queryFn(path), ...opts }),
    invalidate: () => client.invalidateQueries({ queryKey: [path] }),
  });
  const routers = (make: (path: string) => unknown) =>
    new Proxy(
      {},
      {
        get: (_r, router) =>
          new Proxy({}, { get: (_p, name) => make(`${String(router)}.${String(name)}`) }),
      }
    );
  const utils = routers(utilsProc);
  const hooks = routers(proc) as Record<string, unknown>;
  return {
    ...actual,
    trpc: new Proxy(hooks, {
      get: (target, prop) => (prop === 'useUtils' ? () => utils : Reflect.get(target, prop)),
    }),
  };
});

import { useCryptoDepositSignal } from '~/components/Signals/CryptoDepositSignal';
import { trpc } from '~/utils/trpc';

const queryClient = () => h.client as QueryClient;
const callsTo = (path: string) => h.calls.filter((p) => p === path).length;

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
    await Promise.resolve(h.handler!({ paymentId: 'p1', amount: 10, ...data })).catch(() => undefined);
  });
}

const lastMessage = () =>
  h.showNotification.mock.calls.at(-1)?.[0] as
    | { title: string; message: string; color: string }
    | undefined;

beforeEach(() => {
  h.user = { id: 1 };
  h.handler = undefined;
  h.calls = [];
  h.showNotification.mockReset();
  h.responses = {
    [CURRENCIES]: () => currencies,
    [BUZZ_ACCOUNT]: () => ({ yellow: 100 }),
    'nowPayments.getDepositHistory': () => [],
  };
  queryClient().clear();
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

  it('an anonymous page load requests nothing', async () => {
    h.user = null;
    mount(Registrar, BuzzBalance);
    await flush();

    expect(h.calls).toEqual([]);
  });
});

describe('useCryptoDepositSignal — on a deposit signal', () => {
  it('names the currency in the completion toast and refreshes the balance', async () => {
    mount(Registrar, BuzzBalance);
    await flush();
    expect(callsTo(BUZZ_ACCOUNT)).toBe(1);

    await signal({ status: 'finished', currency: 'USDTTRC20', outcomeAmount: 1.5 });
    await flush();

    expect(lastMessage()).toEqual({
      title: 'Crypto Deposit Complete',
      message: 'You received 1,500 Buzz from your USDT on Tron deposit.',
      color: 'green',
    });
    expect(callsTo(CURRENCIES)).toBe(1);
    // The balance shown in the header is refetched, as before.
    expect(callsTo(BUZZ_ACCOUNT)).toBe(2);
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
      await queryClient().fetchQuery({
        queryKey: [CURRENCIES, null],
        queryFn: async () => currencies,
      });
    });

    await signal({ status: 'confirming', currency: 'usdttrc20' });
    await signal({ status: 'finished', currency: 'usdttrc20', outcomeAmount: 2 });

    expect(callsTo(CURRENCIES)).toBe(0);
    expect(lastMessage()?.message).toBe('You received 2,000 Buzz from your USDT on Tron deposit.');
  });

  it('still shows the toast, with the raw code, when the currency lookup fails', async () => {
    h.responses[CURRENCIES] = () => {
      throw new Error('currency lookup down');
    };
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
