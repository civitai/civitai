// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import type * as TrpcModule from '~/utils/trpc';

const act = (React as unknown as { act: typeof actType }).act;

// How often a tab re-mints its signals token (`signals.getToken`) while the hub is unreachable.
// Re-minting on every 'closed', in every tab at once, multiplied `signals.getToken` ~50x during one
// outage; and a degraded `{}` token was never re-fetched at all.

type TokenState = {
  data: { accessToken?: string } | undefined;
  status: 'pending' | 'error' | 'success';
  error: null;
  isFetching: boolean;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
};

type QueryOptions = {
  enabled: boolean;
  retry: unknown;
  retryDelay?: (failureCount: number, error: unknown) => number;
};

const state = {
  token: undefined as unknown as TokenState,
  options: undefined as unknown as QueryOptions,
  invalidations: [] as number[],
  /** What the next re-mint returns. */
  nextToken: undefined as { accessToken?: string } | undefined,
};

const invalidate = vi.fn(async () => {
  state.invalidations.push(Date.now());
  // Settles like a refetch would: new data, new `dataUpdatedAt`.
  state.token = { ...state.token, data: state.nextToken, dataUpdatedAt: Date.now() };
});
const utils = { signals: { getToken: { invalidate } } };

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      {
        'signals.getToken': {
          useQuery: (_input: unknown, options: QueryOptions) => {
            state.options = options;
            return state.token;
          },
        },
      },
      { useUtils: () => utils }
    ),
  };
});

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));

type FakePort = {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((event: { data: unknown }) => void) | null;
};
const workers: { port: FakePort }[] = [];
vi.mock('@okikio/sharedworker', () => ({
  default: class FakeSharedWorker {
    port: FakePort = { postMessage: vi.fn(), onmessage: null };
    close = vi.fn();
    constructor() {
      workers.push(this);
    }
  },
}));

import { useSignalsWorker } from '~/utils/signals/useSignalsWorker';

let root: Root;
let api: ReturnType<typeof useSignalsWorker>;

function Harness() {
  api = useSignalsWorker();
  return null;
}

async function render() {
  await act(async () => {
    root.render(React.createElement(Harness));
  });
}

async function fromWorker(data: unknown) {
  await act(async () => {
    workers.at(-1)!.port.onmessage!({ data });
  });
  await render();
}

// Every delay these tests produce is a multiple of this, so a re-mint always lands on a step boundary
// and the re-render that re-arms the timer happens at the same instant — no rounding in the gaps.
const STEP_MS = 500;

/** Advance in steps, re-rendering after each re-mint so the hook sees the settled query. */
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
    const before = state.invalidations.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });
    if (state.invalidations.length !== before) await render();
  }
}

function gaps(times: number[]) {
  return times.slice(1).map((t, i) => t - times[i]);
}

async function mount(token: { accessToken?: string }) {
  state.token = {
    data: token,
    status: 'success',
    error: null,
    isFetching: false,
    dataUpdatedAt: Date.now(),
    errorUpdatedAt: 0,
  };
  state.nextToken = token;
  await render();
  await fromWorker({ type: 'worker:ready', version: '2.3' });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ now: 1_000_000 });
  vi.spyOn(Math, 'random').mockReturnValue(1);
  state.invalidations = [];
  workers.length = 0;
  invalidate.mockClear();
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useSignalsWorker: signals token re-mint', () => {
  it("reuses the token on 'closed' instead of re-minting it straight away", async () => {
    await mount({ accessToken: 't1' });
    await fromWorker({ type: 'connection:state', state: 'connected' });
    const t0 = Date.now();
    await fromWorker({ type: 'connection:state', state: 'closed' });

    // The worker is handed the token it already had, to retry with.
    const inits = workers[0].port.postMessage.mock.calls
      .map(([m]) => m)
      .filter((m) => m.type === 'connection:init');
    expect(inits.at(-1)).toMatchObject({ token: 't1' });
    expect(invalidate).not.toHaveBeenCalled();

    // Only once the hub has kept refusing for a while: 30s at random() = 1.
    await advance(60_000);
    expect(state.invalidations[0] - t0).toBe(30_000);
  });

  it('re-fetches a degraded `{}` token on a backoff capped at 10 minutes, rather than never', async () => {
    await mount({});
    const t0 = Date.now();
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(45 * 60_000);
    expect(state.invalidations[0] - t0).toBe(30_000);
    expect(gaps(state.invalidations).slice(0, 6)).toEqual([
      60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
    ]);
  });

  it('jitters the re-mint, so tabs that lost the hub together do not re-mint together', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    await mount({});
    const t0 = Date.now();
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(5 * 60_000);
    // Midpoint of [5s, ceiling] — next to the 30s/60s/120s a random() of 1 gives above.
    expect([state.invalidations[0] - t0, ...gaps(state.invalidations).slice(0, 2)]).toEqual([
      17_500, 32_500, 62_500,
    ]);
  });

  it('never re-mints while connected, and connecting resets the backoff', async () => {
    await mount({});
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(100_000); // re-mints at 30s and 90s, so the next step would be 120s
    expect(state.invalidations).toHaveLength(2);

    state.nextToken = { accessToken: 't2' };
    await fromWorker({ type: 'connection:state', state: 'connected' });
    await advance(60 * 60_000);
    expect(state.invalidations).toHaveLength(2);

    const t1 = Date.now();
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(60_000);
    expect(state.invalidations[2] - t1).toBe(30_000);
  });

  it('retries a failed fetch at most twice, on a jittered exponential delay capped at 60s', async () => {
    await mount({ accessToken: 't1' });
    expect(state.options.retry).toBe(2);
    const delays = (n: number) =>
      Array.from({ length: n }, (_, i) => state.options.retryDelay!(i, new Error('x')));
    expect(delays(6)).toEqual([4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(delays(2)).toEqual([1_000, 1_000]);
  });

  it('debug forceReconnect re-mints immediately, skipping the backoff', async () => {
    await mount({ accessToken: 't1' });
    await fromWorker({ type: 'connection:state', state: 'connected' });
    api.debug.forceReconnect();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(workers[0].port.postMessage).toHaveBeenCalledWith({ type: 'debug:reconnect' });
  });
});
