// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as TrpcModule from '~/utils/trpc';

// React 18.3 has `act` at runtime; the installed @types/react predates it.
const act = (React as unknown as { act: (callback: () => Promise<void>) => Promise<void> }).act;

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
  /** Whether the next re-mint fails (the API saturated in an outage) instead of returning `nextToken`. */
  nextFails: false,
  /** Bumped on every change to `token`, so `advance` knows to re-render. */
  version: 0,
};

function setToken(patch: Partial<TokenState>) {
  state.token = { ...state.token, ...patch };
  state.version += 1;
}

function settleFetch() {
  if (state.nextFails) setToken({ isFetching: false, errorUpdatedAt: Date.now() });
  else setToken({ isFetching: false, data: state.nextToken, dataUpdatedAt: Date.now() });
}

// Behaves like React Query's invalidate of an active query, with an instant fetch: it settles at
// once, bumping `dataUpdatedAt` on success or only `errorUpdatedAt` on failure. A fetch still in
// flight (`isFetching`) is modelled explicitly by the test that needs one.
const invalidate = vi.fn(async () => {
  state.invalidations.push(Date.now());
  settleFetch();
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

const currentUser = { id: 1 };
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: currentUser.id }) }));

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

/** Advance in steps, re-rendering whenever the query changed so the hook sees its new state. */
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
    const before = state.version;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });
    if (state.version !== before) await render();
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
  state.version += 1;
  await render();
  await fromWorker({ type: 'worker:ready', version: '2.3' });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ now: 1_000_000 });
  vi.spyOn(Math, 'random').mockReturnValue(1);
  state.invalidations = [];
  state.nextFails = false;
  currentUser.id = 1;
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

    // A held token never expires, so it is re-minted only as a slow safety net: after 10 min closed,
    // then 20 min (random() = 1) — not every few seconds from every tab.
    await advance(40 * 60_000);
    expect(state.invalidations.map((t) => t - t0)).toEqual([600_000, 1_800_000]);
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

  it('debug forceReconnect restarts the re-mint backoff from its first step', async () => {
    await mount({});
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(100_000); // re-mints at 30s and 90s; the next step would be 120s out
    expect(state.invalidations).toHaveLength(2);

    const t1 = Date.now();
    await act(async () => api.debug.forceReconnect());
    await render(); // the settled re-mint, as React Query would re-render it
    await advance(40_000);
    expect(state.invalidations.slice(2).map((t) => t - t1)).toEqual([0, 30_000]);
  });

  it('keeps re-minting on schedule when the re-mint itself fails', async () => {
    await mount({});
    state.nextFails = true;
    const t0 = Date.now();
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(5 * 60_000);
    expect([state.invalidations[0] - t0, ...gaps(state.invalidations)]).toEqual([
      30_000, 60_000, 120_000,
    ]);
  });

  it('does not stack a re-mint on a fetch that is still in flight', async () => {
    // The page-load fetch is still running (slow API) when the worker reports 'closed'.
    await mount({});
    setToken({ data: undefined, isFetching: true, dataUpdatedAt: 0 });
    await render();
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(60_000);
    expect(state.invalidations).toEqual([]);

    // It settles; the first re-mint follows the schedule from there.
    const t1 = Date.now();
    settleFetch();
    await render();
    await advance(40_000);
    expect(state.invalidations.map((t) => t - t1)).toEqual([30_000]);
  });

  it("does not re-mint while SignalR is still reconnecting, or before the worker's first state", async () => {
    await mount({});
    await advance(10 * 60_000); // no state from the worker yet
    await fromWorker({ type: 'connection:state', state: 'reconnecting' });
    await advance(10 * 60_000);
    expect(state.invalidations).toEqual([]);

    const t1 = Date.now();
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(40_000);
    expect(state.invalidations.map((t) => t - t1)).toEqual([30_000]);
  });

  it('a connection that drops within a minute does not restart the re-mint backoff', async () => {
    await mount({});
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(100_000); // re-mints at 30s and 90s; the next step is 120s
    expect(state.invalidations).toHaveLength(2);

    // A hub that accepts the connection and drops it 10s later.
    await fromWorker({ type: 'connection:state', state: 'connected' });
    await advance(10_000);
    const t1 = Date.now();
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(130_000);
    expect(state.invalidations.slice(2).map((t) => t - t1)).toEqual([120_000]);
  });

  it('a tab that held a token stays on the slow schedule when a re-mint comes back degraded', async () => {
    await mount({ accessToken: 't1' });
    await fromWorker({ type: 'connection:state', state: 'connected' });
    state.nextToken = {}; // the signals service is the thing that is down
    const t0 = Date.now();
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(35 * 60_000);
    // The worker still holds t1, so a `{}` answer is no reason to re-mint every few minutes.
    expect(state.invalidations.map((t) => t - t0)).toEqual([600_000, 1_800_000]);
  });

  /** The token of the last connection:init the given worker received, if any. */
  function lastInitToken(worker: { port: FakePort }) {
    const inits = worker.port.postMessage.mock.calls
      .map(([m]) => m)
      .filter((m) => m.type === 'connection:init');
    return inits.at(-1)?.token;
  }

  it("after a re-mint came back degraded, 'closed' still hands the worker the last real token", async () => {
    await mount({ accessToken: 't1' });
    await fromWorker({ type: 'connection:state', state: 'connected' });
    state.nextToken = {};
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(11 * 60_000); // the revalidate at 10 min returned `{}`
    expect(state.invalidations).toHaveLength(1);
    workers[0].port.postMessage.mockClear();

    // The worker dropped its connection object on this close; only an init rebuilds it.
    await fromWorker({ type: 'connection:state', state: 'closed' });
    expect(lastInitToken(workers[0])).toBe('t1');
  });

  it('a replacement worker is handed the last real token even after a degraded re-mint', async () => {
    await mount({ accessToken: 't1' });
    state.nextToken = {};
    await fromWorker({ type: 'connection:state', state: 'closed' });
    await advance(11 * 60_000);
    expect(state.invalidations).toHaveLength(1);

    // The tab gets a stale script back and retries with a fresh worker a minute later.
    await fromWorker({ type: 'worker:ready', version: 'stale' });
    await advance(61_000);
    expect(workers).toHaveLength(2);
    await fromWorker({ type: 'worker:ready', version: '2.3' });
    expect(lastInitToken(workers[1])).toBe('t1');
  });

  it("never hands the worker another user's last token", async () => {
    await mount({ accessToken: 't1' });
    expect(lastInitToken(workers[0])).toBe('t1');
    workers[0].port.postMessage.mockClear();

    // A different user in the same mounted tab, whose first token came back degraded.
    currentUser.id = 2;
    setToken({ data: {}, dataUpdatedAt: Date.now() });
    await render();
    await fromWorker({ type: 'connection:state', state: 'closed' });
    expect(lastInitToken(workers[0])).toBeUndefined();
  });
});
