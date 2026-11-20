import { describe, it, expect, vi } from 'vitest';
import { attachSysSentinelListeners } from '../client';

// A fake sentinel client that records listeners so the test can fire events.
function fakeClient() {
  const listeners: Record<string, (e: any) => void> = {};
  return {
    on(event: string, listener: (e: any) => void) {
      listeners[event] = listener;
      return this;
    },
    fire(event: string, payload: any) {
      listeners[event]?.(payload);
    },
  };
}

function fakeCounter() {
  const inc = vi.fn();
  const labels = vi.fn(() => ({ inc }));
  return { labels, inc };
}

describe('attachSysSentinelListeners', () => {
  it('logs + counts topology-change events with {type, host, deployment} labels', () => {
    const client = fakeClient();
    const log = vi.fn();
    const topologyCounter = fakeCounter();
    const errorCounter = fakeCounter();

    attachSysSentinelListeners(client, {
      deployment: 'pod-123',
      log,
      topologyCounter,
      errorCounter,
    });

    client.fire('topology-change', {
      type: 'MASTER_CHANGE',
      node: { host: '10.0.0.5', port: 6379 },
    });

    expect(log).toHaveBeenCalledOnce();
    expect(topologyCounter.labels).toHaveBeenCalledWith({
      type: 'MASTER_CHANGE',
      host: '10.0.0.5',
      deployment: 'pod-123',
    });
    expect(topologyCounter.inc).toHaveBeenCalledOnce();
    expect(errorCounter.inc).not.toHaveBeenCalled();
  });

  it('logs a sentinel-list event only when the list size changes, and counts every one', () => {
    const client = fakeClient();
    const log = vi.fn();
    const topologyCounter = fakeCounter();
    const errorCounter = fakeCounter();

    attachSysSentinelListeners(client, { deployment: 'd', log, topologyCounter, errorCounter });

    const scan = (size: number) =>
      client.fire('topology-change', { type: 'SENTINE_LIST_CHANGE', size });
    scan(3);
    scan(3);
    scan(3);
    expect(log).toHaveBeenCalledOnce();

    scan(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(
      'Redis sentinel topology change [type=SENTINE_LIST_CHANGE, host=?, port=?]',
      { type: 'SENTINE_LIST_CHANGE', size: 2 }
    );

    scan(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(topologyCounter.inc).toHaveBeenCalledTimes(5);
  });

  it('logs every repeated node event; only the sentinel-list event is deduplicated', () => {
    const client = fakeClient();
    const log = vi.fn();
    attachSysSentinelListeners(client, {
      deployment: 'd',
      log,
      topologyCounter: fakeCounter(),
      errorCounter: fakeCounter(),
    });

    const master = { type: 'MASTER_CHANGE', node: { host: 'h1', port: 6379 } };
    client.fire('topology-change', master);
    client.fire('topology-change', master);
    client.fire('topology-change', { type: 'SENTINE_LIST_CHANGE', size: 3 });
    client.fire('topology-change', { type: 'SENTINE_LIST_CHANGE', size: 3 });

    expect(log).toHaveBeenCalledTimes(3);
  });

  // RedisSentinel forwards its connections' errors as `error` (passthroughClientErrorEvents), in
  // the shape @redis/client 6.3.0 builds; sentinel-master-loss.integration.test.ts checks that
  // shape against a real master loss.
  it('logs + counts a forwarded master/replica/Sentinel connection error', () => {
    const client = fakeClient();
    const log = vi.fn();
    const topologyCounter = fakeCounter();
    const errorCounter = fakeCounter();

    attachSysSentinelListeners(client, { deployment: 'pod-9', log, topologyCounter, errorCounter });

    const cause = new Error('connect ECONNREFUSED');
    client.fire('error', new Error('Replica Client (h1:6380): connect ECONNREFUSED', { cause }));

    expect(errorCounter.labels).toHaveBeenCalledWith({
      type: 'REPLICA',
      host: 'h1',
      deployment: 'pod-9',
    });
    expect(errorCounter.inc).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      'Redis sentinel sub-client error [type=REPLICA, host=h1, port=6380]',
      cause
    );
    expect(topologyCounter.inc).not.toHaveBeenCalled();
  });

  it('ignores an error that is not a forwarded connection error', () => {
    const client = fakeClient();
    const log = vi.fn();
    const topologyCounter = fakeCounter();
    const errorCounter = fakeCounter();

    attachSysSentinelListeners(client, { deployment: 'd', log, topologyCounter, errorCounter });

    client.fire('error', new Error('None of the sentinels are available'));
    client.fire('error', 'obseve client error: Error: connect ECONNREFUSED');

    expect(errorCounter.inc).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('falls back to "unknown"/"?" when event fields are missing', () => {
    const client = fakeClient();
    const log = vi.fn();
    const topologyCounter = fakeCounter();
    const errorCounter = fakeCounter();

    attachSysSentinelListeners(client, { deployment: 'd', log, topologyCounter, errorCounter });

    client.fire('topology-change', undefined);

    expect(topologyCounter.labels).toHaveBeenCalledWith({
      type: 'unknown',
      host: '?',
      deployment: 'd',
    });
    expect(topologyCounter.inc).toHaveBeenCalledOnce();
  });
});
