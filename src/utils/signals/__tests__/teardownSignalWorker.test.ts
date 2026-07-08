import { describe, it, expect, vi } from 'vitest';
import { teardownSignalWorker } from '~/utils/signals/utils';

// Regression coverage for the chronic Android-cohort crash:
//   `TypeError: port.close is not a function` at useSignalsWorker cleanup.
//
// The `@okikio/sharedworker` wrapper backs onto a real SharedWorker when the
// browser supports it, and falls back to a dedicated Worker when it does NOT
// (Android Chrome / Samsung Internet). On the fallback path `worker.port` is the
// dedicated Worker (which has `terminate()`, NOT `close()`), so the old
// `worker.port.close()` teardown threw on every unmount for that cohort.
//
// These tests exercise BOTH runtime shapes the wrapper presents.

describe('teardownSignalWorker', () => {
  it('SharedWorker path: closes the MessagePort via the wrapper close() and sends beforeunload', () => {
    // Shape a: SharedWorker-capable. wrapper.close() closes this tab's MessagePort.
    const portClose = vi.fn();
    const portPostMessage = vi.fn();
    const wrapperClose = vi.fn();
    const worker = {
      port: { postMessage: portPostMessage, close: portClose },
      close: wrapperClose,
    };

    expect(() => teardownSignalWorker(worker)).not.toThrow();

    // best-effort unload notification is sent
    expect(portPostMessage).toHaveBeenCalledWith({ type: 'beforeunload' });
    // teardown goes through the wrapper's polymorphic close(), not the raw port
    expect(wrapperClose).toHaveBeenCalledTimes(1);
  });

  it('dedicated-Worker fallback: terminates the worker and NEVER throws (no port.close())', () => {
    // Shape b: no SharedWorker. The wrapper's port getter returns the dedicated
    // Worker, which has `postMessage`/`terminate` but NO `close`. Calling
    // `port.close()` here is exactly the original TypeError. The wrapper's
    // close() delegates to terminate() on this path.
    const workerTerminate = vi.fn();
    const portPostMessage = vi.fn();
    // wrapper.close() delegates to the underlying Worker.terminate()
    const wrapperClose = vi.fn(() => workerTerminate());
    const worker = {
      // port is the dedicated Worker: has postMessage + terminate, NO close
      port: { postMessage: portPostMessage, terminate: workerTerminate },
      close: wrapperClose,
    };

    expect(() => teardownSignalWorker(worker)).not.toThrow();

    expect(portPostMessage).toHaveBeenCalledWith({ type: 'beforeunload' });
    expect(wrapperClose).toHaveBeenCalledTimes(1);
    // the underlying dedicated worker is actually terminated → no leak
    expect(workerTerminate).toHaveBeenCalledTimes(1);
  });

  it('defensive belt: no wrapper close() → falls back to raw MessagePort.close()', () => {
    // If the wrapper contract ever changes and only exposes a raw port, teardown
    // must still close a MessagePort-shaped port.
    const portClose = vi.fn();
    const portPostMessage = vi.fn();
    const worker = {
      port: { postMessage: portPostMessage, close: portClose },
      // no wrapper-level close/terminate
    };

    expect(() => teardownSignalWorker(worker)).not.toThrow();
    expect(portClose).toHaveBeenCalledTimes(1);
  });

  it('defensive belt: no wrapper close() and a Worker-shaped port → terminate(), no throw', () => {
    // The exact original crash shape with the defensive belt engaged: a raw
    // Worker-shaped port (terminate, no close) and no wrapper close(). Must
    // terminate the worker and NOT throw.
    const portTerminate = vi.fn();
    const portPostMessage = vi.fn();
    const worker = {
      port: { postMessage: portPostMessage, terminate: portTerminate },
    };

    expect(() => teardownSignalWorker(worker)).not.toThrow();
    expect(portTerminate).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the worker or port is missing', () => {
    expect(() => teardownSignalWorker(null)).not.toThrow();
    expect(() => teardownSignalWorker(undefined)).not.toThrow();
    expect(() => teardownSignalWorker({})).not.toThrow();
    expect(() => teardownSignalWorker({ port: null, close: vi.fn() })).not.toThrow();
  });

  it('teardown never throws even if beforeunload postMessage throws', () => {
    // A dying port can throw on postMessage; teardown must still complete close().
    const wrapperClose = vi.fn();
    const worker = {
      port: {
        postMessage: vi.fn(() => {
          throw new Error('port is closing');
        }),
        close: vi.fn(),
      },
      close: wrapperClose,
    };

    expect(() => teardownSignalWorker(worker)).not.toThrow();
    expect(wrapperClose).toHaveBeenCalledTimes(1);
  });
});
