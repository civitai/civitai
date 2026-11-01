import { ConnectionTimeoutError, SocketClosedUnexpectedlyError, SocketTimeoutError } from 'redis';
import { describe, expect, it, vi } from 'vitest';
import {
  createClusterReconnectStrategy,
  createThrottle,
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

  it('a socket that went silent until socketTimeout destroyed it is a topology signal', () => {
    // A peer that vanished without a FIN/RST: node-redis destroys the idle socket with
    // SocketTimeoutError, and that is the first strategy call a client gets for it.
    const err = new SocketTimeoutError(10_000);
    expect(isTopologyChangeSignal(err)).toBe(true);
    expect(isNodeConnectError(err)).toBe(false);
  });

  it('anything else is neither', () => {
    for (const err of [new Error('WRONGPASS'), sysErr('EPIPE'), undefined, null]) {
      expect(isTopologyChangeSignal(err)).toBe(false);
      expect(isNodeConnectError(err)).toBe(false);
    }
  });
});

describe('createClusterReconnectStrategy', () => {
  const make = () => {
    const onTopologyChangeSignal = vi.fn();
    const strategy = createClusterReconnectStrategy({
      onTopologyChangeSignal,
      log: () => undefined,
    });
    return { strategy, onTopologyChangeSignal };
  };

  it('keeps the existing backoff and never gives up (literal values, 3s cap)', () => {
    const { strategy } = make();
    const cause = sysErr('EHOSTUNREACH');
    expect([0, 1, 2, 7, 40, 99].map((r) => strategy(r, cause))).toEqual([
      0, 100, 200, 700, 3000, 3000,
    ]);
  });

  it('asks for a rediscovery on topology signals only', () => {
    const { strategy, onTopologyChangeSignal } = make();
    strategy(0, new SocketClosedUnexpectedlyError());
    strategy(1, sysErr('ECONNREFUSED'));
    strategy(2, new ConnectionTimeoutError());
    strategy(3, new Error('WRONGPASS'));
    strategy(4, sysErr('EPIPE'));
    expect(onTopologyChangeSignal).toHaveBeenCalledTimes(3);
  });

  it('with no onTopologyChangeSignal (the off switch) it is the plain backoff', () => {
    const strategy = createClusterReconnectStrategy({ log: () => undefined });
    expect(strategy(2, sysErr('ECONNREFUSED'))).toBe(200);
  });

  it('a throwing rediscovery request does not break the strategy', () => {
    const strategy = createClusterReconnectStrategy({
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

  it('masters whose clients are gone: rotates through the seeds call by call', () => {
    const seeds = [{ url: 'redis://seed-a:6379' }, { url: 'redis://seed-b:6379' }];
    const { client, rediscover } = fakeCluster(
      [{ client: undefined }, { client: undefined }],
      seeds
    );
    triggerTopologyRediscovery(client, 'test');
    triggerTopologyRediscovery(client, 'test');
    triggerTopologyRediscovery(client, 'test');
    const used = rediscover.mock.calls.map(([arg]) => seeds.indexOf((arg as any).options));
    // The cursor is process-wide, so the first index depends on earlier calls; consecutive calls
    // must alternate between the two seeds, never repeat one.
    expect(used).toHaveLength(3);
    expect(used.every((i) => i >= 0)).toBe(true);
    expect(used[1]).toBe((used[0] + 1) % 2);
    expect(used[2]).toBe(used[0]);
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
