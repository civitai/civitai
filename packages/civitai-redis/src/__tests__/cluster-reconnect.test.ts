import { ConnectionTimeoutError, SocketClosedUnexpectedlyError, SocketTimeoutError } from 'redis';
import { describe, expect, it, vi } from 'vitest';
import {
  createClusterReconnectStrategy,
  createThrottle,
  dropClosedNodeClients,
  installLazyNodeClientReopen,
  isNodeConnectError,
  isTopologyChangeSignal,
  pickRediscoverStartNode,
} from '../cluster-reconnect';
import { triggerTopologyRediscovery } from '../client';

const sysErr = (code: string) => Object.assign(new Error(`connect ${code}`), { code });

describe('isNodeConnectError / isTopologyChangeSignal', () => {
  it.each(['EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTDOWN'])(
    '%s is a connect error and a topology signal',
    (code) => {
      expect(isNodeConnectError(sysErr(code))).toBe(true);
      expect(isTopologyChangeSignal(sysErr(code))).toBe(true);
    }
  );

  it('ConnectionTimeoutError is a connect error', () => {
    expect(isNodeConnectError(new ConnectionTimeoutError())).toBe(true);
  });

  it('a dropped connection is a topology signal but NOT a connect failure', () => {
    for (const err of [new SocketClosedUnexpectedlyError(), sysErr('ECONNRESET')]) {
      expect(isTopologyChangeSignal(err)).toBe(true);
      expect(isNodeConnectError(err)).toBe(false);
    }
  });

  it('anything else is neither', () => {
    for (const err of [
      new SocketTimeoutError(10_000),
      new Error('WRONGPASS'),
      sysErr('EPIPE'),
      undefined,
      null,
    ]) {
      expect(isTopologyChangeSignal(err)).toBe(false);
      expect(isNodeConnectError(err)).toBe(false);
    }
  });
});

describe('createClusterReconnectStrategy — give-up counter', () => {
  const make = (maxConnectFailures = 5) => {
    const onTopologyChangeSignal = vi.fn();
    const strategy = createClusterReconnectStrategy({
      maxConnectFailures,
      onTopologyChangeSignal,
      log: () => undefined,
    });
    return { strategy, onTopologyChangeSignal };
  };

  it('retries the first 4 consecutive connect failures, gives up on the 5th', () => {
    const { strategy } = make(5);
    const cause = sysErr('EHOSTUNREACH');
    // node-redis passes a 0-based retry count per connect loop. Literal backoff values.
    expect([0, 1, 2, 3].map((r) => strategy(r, cause))).toEqual([0, 100, 200, 300]);
    const fifth = strategy(4, cause);
    expect(fifth).toBeInstanceOf(Error);
    expect((fifth as Error).message).toContain('unreachable after 5 attempts');
    expect((fifth as Error).message).toContain('EHOSTUNREACH');
  });

  it('honours a different limit (not a hard-coded 5)', () => {
    const { strategy } = make(3);
    const cause = new ConnectionTimeoutError();
    expect(strategy(1, cause)).toBe(100);
    expect(strategy(2, cause)).toBeInstanceOf(Error);
  });

  it('never gives up on a non-connect failure, and keeps the 3s backoff cap', () => {
    const { strategy } = make(5);
    expect(strategy(40, new SocketTimeoutError(10_000))).toBe(3000);
    expect(strategy(40, new SocketClosedUnexpectedlyError())).toBe(3000);
  });

  it('maxConnectFailures <= 0 disables giving up', () => {
    const { strategy } = make(0);
    expect(strategy(99, sysErr('ECONNREFUSED'))).toBe(3000);
  });

  it('asks for a rediscovery on topology signals only', () => {
    const { strategy, onTopologyChangeSignal } = make(5);
    strategy(0, new SocketClosedUnexpectedlyError());
    strategy(1, sysErr('ECONNREFUSED'));
    strategy(2, new Error('WRONGPASS'));
    expect(onTopologyChangeSignal).toHaveBeenCalledTimes(2);
  });

  it('a throwing rediscovery request does not break the strategy', () => {
    const strategy = createClusterReconnectStrategy({
      maxConnectFailures: 5,
      onTopologyChangeSignal: () => {
        throw new Error('boom');
      },
      log: () => undefined,
    });
    expect(strategy(2, sysErr('ECONNREFUSED'))).toBe(200);
  });
});

describe('createThrottle — rediscover debounce', () => {
  it('runs at once, drops calls inside the interval, runs again once it has passed', () => {
    let now = 50_000;
    const fn = vi.fn();
    const throttled = createThrottle(1000, fn, () => now);
    expect(throttled('a')).toBe(true);
    now += 999;
    expect(throttled('b')).toBe(false);
    now += 1;
    expect(throttled('c')).toBe(true);
    expect(fn.mock.calls).toEqual([['a'], ['c']]);
  });

  it('a throwing fn is swallowed and still counts as a run', () => {
    let now = 0;
    const fn = vi.fn(() => {
      throw new Error('boom');
    });
    const throttled = createThrottle(1000, fn, () => now);
    expect(throttled('a')).toBe(true);
    now = 500;
    expect(throttled('b')).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('pickRediscoverStartNode', () => {
  const seeds = [
    { url: 'redis://seed-a:6379' },
    { url: 'redis://seed-b:6379' },
    { url: 'redis://seed-c:6379' },
  ];

  it('prefers the first READY master client', () => {
    const ready = { isReady: true, options: { socket: { host: 'm2' } } };
    const picked = pickRediscoverStartNode(
      [{ client: { isReady: false, options: { socket: { host: 'm1' } } } }, { client: ready }],
      seeds,
      0
    );
    expect(picked).toBe(ready);
  });

  it('with no ready master, rotates through the seeds by cursor', () => {
    const masters = [{ client: { isReady: false, options: {} } }, { client: undefined }];
    expect([0, 1, 2, 3, 4].map((c) => pickRediscoverStartNode(masters, seeds, c))).toEqual([
      { options: seeds[0] },
      { options: seeds[1] },
      { options: seeds[2] },
      { options: seeds[0] },
      { options: seeds[1] },
    ]);
  });

  it('works with no masters at all (the case that used to throw)', () => {
    expect(pickRediscoverStartNode([], seeds, 1)).toEqual({ options: seeds[1] });
    expect(pickRediscoverStartNode(undefined, seeds, 2)).toEqual({ options: seeds[2] });
  });

  it('returns undefined when there is nothing to ask', () => {
    expect(pickRediscoverStartNode([], [], 0)).toBeUndefined();
    expect(pickRediscoverStartNode(undefined, undefined, 0)).toBeUndefined();
  });
});

describe('triggerTopologyRediscovery — always passes a start node with options', () => {
  const fakeCluster = (masters: unknown[], rootNodes: unknown[]) => {
    const rediscover = vi.fn((_startWith: unknown) => Promise.resolve());
    return {
      rediscover,
      client: {
        _options: { rootNodes },
        _slots: { masters, rediscover, nodeByAddress: new Map() },
      },
    };
  };

  it('no masters: rediscovers from a seed node instead of calling rediscover() bare', () => {
    // Before the fix this called `_slots.rediscover()` with NO argument, which node-redis then
    // dereferenced (`startWith.options`) and threw.
    const seeds = [{ url: 'redis://seed-a:6379' }];
    const { client, rediscover } = fakeCluster([], seeds);
    triggerTopologyRediscovery(client, 'test');
    expect(rediscover).toHaveBeenCalledTimes(1);
    expect(rediscover.mock.calls[0][0]).toEqual({ options: seeds[0] });
  });

  it('no masters and no seeds: does not call rediscover at all', () => {
    const { client, rediscover } = fakeCluster([], []);
    triggerTopologyRediscovery(client, 'test');
    expect(rediscover).not.toHaveBeenCalled();
  });

  it('masters whose clients are gone (node-redis dropped them): seed node, not a bare call', () => {
    const seeds = [{ url: 'redis://seed-a:6379' }, { url: 'redis://seed-b:6379' }];
    const { client, rediscover } = fakeCluster(
      [{ client: undefined }, { client: undefined }],
      seeds
    );
    triggerTopologyRediscovery(client, 'test');
    expect(rediscover).toHaveBeenCalledTimes(1);
    expect((rediscover.mock.calls[0][0] as { options?: unknown })?.options).toBeDefined();
  });

  it('uses a READY master when there is one', () => {
    const ready = { isReady: true, options: { socket: { host: 'm2' } } };
    const { client, rediscover } = fakeCluster(
      [{ client: { isReady: false, options: { socket: { host: 'm1' } } } }, { client: ready }],
      [{ url: 'redis://s:6379' }]
    );
    triggerTopologyRediscovery(client, 'test');
    expect(rediscover.mock.calls).toEqual([[ready]]);
  });
});

describe('closed node clients', () => {
  const node = (client: unknown, connectPromise?: unknown) => ({ client, connectPromise } as any);

  it('dropClosedNodeClients clears only closed, idle clients', () => {
    const closed = node({ isOpen: false });
    const open = node({ isOpen: true });
    const closedButConnecting = node({ isOpen: false }, Promise.resolve());
    const empty = node(undefined);
    const slots = {
      nodeByAddress: new Map([
        ['a', closed],
        ['b', open],
        ['c', closedButConnecting],
        ['d', empty],
      ]),
    };
    expect(dropClosedNodeClients(slots)).toBe(1);
    expect(closed.client).toBeUndefined();
    expect(open.client).toEqual({ isOpen: true });
    expect(closedButConnecting.client).toEqual({ isOpen: false });
  });

  it('installLazyNodeClientReopen drops a closed client before node-redis routes to it', () => {
    const seen: unknown[] = [];
    const slots: any = {
      nodeClient(n: any) {
        seen.push(n.client);
        return n.client ?? 'fresh-client';
      },
    };
    installLazyNodeClientReopen(slots);
    installLazyNodeClientReopen(slots); // idempotent: not wrapped twice
    const closed = node({ isOpen: false });
    const open = node({ isOpen: true });
    expect(slots.nodeClient(closed)).toBe('fresh-client');
    expect(slots.nodeClient(open)).toEqual({ isOpen: true });
    expect(seen).toEqual([undefined, { isOpen: true }]);
  });
});
