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

    client.fire('topology-change', { type: 'MASTER_CHANGE', node: { host: '10.0.0.5', port: 6379 } });

    expect(log).toHaveBeenCalledOnce();
    expect(topologyCounter.labels).toHaveBeenCalledWith({
      type: 'MASTER_CHANGE',
      host: '10.0.0.5',
      deployment: 'pod-123',
    });
    expect(topologyCounter.inc).toHaveBeenCalledOnce();
    expect(errorCounter.inc).not.toHaveBeenCalled();
  });

  it('logs + counts client-error events', () => {
    const client = fakeClient();
    const log = vi.fn();
    const topologyCounter = fakeCounter();
    const errorCounter = fakeCounter();

    attachSysSentinelListeners(client, { deployment: 'pod-9', log, topologyCounter, errorCounter });

    client.fire('client-error', { type: 'REPLICA', node: { host: 'h1', port: 6380 }, error: new Error('x') });

    expect(errorCounter.labels).toHaveBeenCalledWith({ type: 'REPLICA', host: 'h1', deployment: 'pod-9' });
    expect(errorCounter.inc).toHaveBeenCalledOnce();
    expect(topologyCounter.inc).not.toHaveBeenCalled();
  });

  it('falls back to "unknown"/"?" when event fields are missing', () => {
    const client = fakeClient();
    const log = vi.fn();
    const topologyCounter = fakeCounter();
    const errorCounter = fakeCounter();

    attachSysSentinelListeners(client, { deployment: 'd', log, topologyCounter, errorCounter });

    client.fire('topology-change', undefined);

    expect(topologyCounter.labels).toHaveBeenCalledWith({ type: 'unknown', host: '?', deployment: 'd' });
    expect(topologyCounter.inc).toHaveBeenCalledOnce();
  });
});
