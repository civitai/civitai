import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAxiomLogger } from '../client';

// `logToAxiom` is awaited on request paths (the tRPC error handler, uploads, webhooks). The Axiom
// dual-write is a second copy of a line already written to stderr, so it must add no latency to
// those requests: the caller returns once the stderr line is written, the ingest runs in the
// background, and the number of ingests in flight is capped so a stalled ingest endpoint cannot
// pile up sockets and memory. Over the cap, the Axiom copy is dropped (the stderr line remains).

const h = vi.hoisted(() => ({ ingestEvents: vi.fn() }));
vi.mock('@axiomhq/axiom-node', () => ({
  Client: class {
    ingestEvents = h.ingestEvents;
  },
}));

const PROD_CONFIGURED = {
  isProd: true,
  token: 'token',
  orgId: 'org',
  datastream: 'civitai-errors',
  podName: 'pod-test',
  provisionedDatastreams: new Set(['civitai-errors']) as ReadonlySet<string>,
} as const;

// Shared process-wide state, pinned on globalThis by the client; reset so each case starts clean.
const INGEST_FAILURES_KEY = Symbol.for('@civitai/axiom.ingestFailuresByDatastream');
const IN_FLIGHT_KEY = Symbol.for('@civitai/axiom.ingestsInFlight');
beforeEach(() => {
  const g = globalThis as Record<symbol, unknown>;
  g[INGEST_FAILURES_KEY] = new Map<string, number>();
  delete g[IN_FLIGHT_KEY];
  h.ingestEvents.mockReset();
});

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  vi.useRealTimers();
});

const reports = () =>
  (errorSpy.mock.calls as unknown[][])
    .map((c) => {
      try {
        return JSON.parse(c[0] as string) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((l): l is Record<string, unknown> => !!l && l.name === 'axiom-ingest-failed');

describe('logToAxiom does not hold the caller on the Axiom dual-write', () => {
  it('an ingest that never settles: the caller resolves in under 50 ms, and the write was attempted', async () => {
    h.ingestEvents.mockReturnValue(new Promise(() => {}));
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);

    const started = performance.now();
    await logToAxiom({ name: 'x', message: 'y' });
    expect(performance.now() - started).toBeLessThan(50);
    expect(h.ingestEvents).toHaveBeenCalledTimes(1);
  });

  it('caps ingests in flight at 256 and drops the Axiom copy beyond that, reporting the drop', async () => {
    vi.useFakeTimers();
    h.ingestEvents.mockReturnValue(new Promise(() => {}));
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);

    for (let i = 0; i < 300; i++) await logToAxiom({ name: 'x', i });

    expect(h.ingestEvents).toHaveBeenCalledTimes(256);
    expect(reports()[0]).toMatchObject({ reason: 'dropped', consecutiveFailures: 1 });
  });

  it('a slot is released when its ingest settles, so the next event is sent again', async () => {
    vi.useFakeTimers();
    const pending: (() => void)[] = [];
    h.ingestEvents.mockImplementation(
      () => new Promise<void>((resolve) => pending.push(() => resolve()))
    );
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);

    for (let i = 0; i < 256; i++) await logToAxiom({ name: 'x', i });
    await logToAxiom({ name: 'dropped' });
    expect(h.ingestEvents).toHaveBeenCalledTimes(256);

    pending[0]();
    await vi.advanceTimersByTimeAsync(0); // let the settled ingest's handlers run
    await logToAxiom({ name: 'sent' });
    expect(h.ingestEvents).toHaveBeenCalledTimes(257);
  });
});
