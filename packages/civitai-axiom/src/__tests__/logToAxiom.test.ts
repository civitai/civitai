import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAxiomLogger } from '../client';

// Pins the contract of `logToAxiom`'s structured-stderr sink:
//  1. ALWAYS-ON (Phase 1, Axiom→Loki migration): in prod the structured JSON line is emitted
//     UNCONDITIONALLY — no longer gated behind LOG_ERRORS_TO_STDOUT. stdout/stderr → Alloy → Loki is the
//     durable sink, so every event must land there by default.
//  2. ORDERING: the line is emitted BEFORE the `if (!axiom) return` / `if (!datastream) return` guards AND
//     independently of Axiom throwing.
//  3. SERIALIZATION GUARD: an unserializable `data` (BigInt / circular) must not throw to the caller; a
//     stringify-safe fallback is emitted and the Axiom dual-write still runs.
//  4. DUAL-WRITE: Axiom ingest still fires when a client + datastream are configured.
//
// Relocated from the main app's src/server/logging/__tests__/client.test.ts when the logger moved into this
// package: the factory takes a Partial<AxiomConfig>, so we inject isProd/token/datastream directly instead
// of mocking the app's `~/env/*` modules (which the package never reads).

const h = vi.hoisted(() => ({ ingestEvents: vi.fn() }));
vi.mock('@axiomhq/axiom-node', () => ({
  Client: class {
    ingestEvents = h.ingestEvents;
  },
}));

const ERR = {
  message: 'boom',
  stack: 'Error: boom\n  at x',
  code: 'INTERNAL_SERVER_ERROR',
  path: 'model.getById',
};

const PROD_CONFIGURED = {
  isProd: true,
  token: 'token',
  orgId: 'org',
  datastream: 'civitai-errors',
  podName: 'pod-test',
} as const;

describe('logToAxiom structured-stderr sink (always-on for Loki)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.ingestEvents.mockReset().mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('ALWAYS-ON: emits the structured stderr line in prod even when logErrorsToStdout is false (gate removed)', async () => {
    const { logToAxiom } = createAxiomLogger({ ...PROD_CONFIGURED, logErrorsToStdout: false });

    await logToAxiom(ERR);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      message: ERR.message,
      stack: ERR.stack,
      code: ERR.code,
      path: ERR.path,
    });
  });

  it('ORDERING: emits the stderr line in prod even when Axiom is null (preview/outage), before the guards', async () => {
    const { logToAxiom } = createAxiomLogger({
      isProd: true,
      token: undefined,
      orgId: undefined,
      datastream: undefined,
      podName: 'pod-test',
    });

    await logToAxiom(ERR);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      message: ERR.message,
      stack: ERR.stack,
      code: ERR.code,
      path: ERR.path,
    });
    // No datastream in previews → `_axiom` is undefined and dropped by JSON.stringify.
    expect('_axiom' in parsed).toBe(false);
    expect(h.ingestEvents).not.toHaveBeenCalled();
  });

  it('ORDERING: emits the stderr line even when Axiom ingest throws (Axiom degraded)', async () => {
    h.ingestEvents.mockRejectedValue(new Error('axiom down'));
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);

    // 🔴 This assertion USED TO BE `rejects.toThrow('axiom down')` — the rejection propagating out of
    // logToAxiom was the documented behaviour, and it is what turned the 2026-08-23 Axiom outage into
    // ~5,300 upload 500s and three crashed jobs pods. The dual-write is now contained.
    await expect(logToAxiom(ERR)).resolves.toBeUndefined();

    // The event line still lands (written before the await), plus ONE outage report.
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ message: ERR.message, code: ERR.code });
    expect(h.ingestEvents).toHaveBeenCalledTimes(1);
  });

  it('SERIALIZATION GUARD: a circular `data` does NOT throw to the caller and still attempts the Axiom dual-write', async () => {
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);

    // Circular reference → JSON.stringify throws "Converting circular structure to JSON". (A BigInt value
    // throws "Do not know how to serialize a BigInt" the same way.)
    const circular: Record<string, unknown> = { name: 'payment.webhook' };
    circular.self = circular;

    // The unconditional stringify must be contained: logToAxiom must not throw.
    await expect(logToAxiom(circular)).resolves.toBeUndefined();

    // Contained, NOT silent: a stringify-safe fallback line is emitted.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed.name).toBe('payment.webhook');
    expect(typeof parsed._stringifyError).toBe('string');

    // The failure did not abort the function — the Axiom dual-write still ran with the original object.
    expect(h.ingestEvents).toHaveBeenCalledTimes(1);
    expect(h.ingestEvents).toHaveBeenCalledWith(
      'civitai-errors',
      expect.objectContaining({ name: 'payment.webhook', pod: 'pod-test' })
    );
  });

  it('DUAL-WRITE: still ingests to Axiom AND emits the stderr line when a client + datastream are configured', async () => {
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);

    await logToAxiom(ERR);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed._axiom).toBe('civitai-errors');
    expect(parsed).toMatchObject({ message: ERR.message, code: ERR.code });

    expect(h.ingestEvents).toHaveBeenCalledTimes(1);
    expect(h.ingestEvents).toHaveBeenCalledWith(
      'civitai-errors',
      expect.objectContaining({ message: ERR.message, code: ERR.code, pod: 'pod-test' })
    );
  });
});

/**
 * The Axiom dual-write must be CONTAINED (cannot throw to the caller) and BOUNDED (cannot
 * hold the caller for the SDK's 30 s axios timeout).
 *
 * Every case here fails on the pre-2026-08-23 implementation, whose last statement was a
 * bare `await axiom.ingestEvents(datastream, sendData)`:
 *   - CONTAINMENT → the awaited call rejected into the caller.
 *   - BUDGET      → the caller was held for as long as the SDK held the socket.
 *   - NO UNHANDLED REJECTION → after a budget-based fix that used a trailing `.catch()`
 *     instead of a paired rejection handler, the abandoned promise's later rejection is
 *     unhandled, which is the exact `unhandledRejection` that killed the jobs pods.
 */
describe('logToAxiom Axiom dual-write containment', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.ingestEvents.mockReset().mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  const reports = (spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] => {
    const parsed: Record<string, unknown>[] = [];
    for (const call of spy.mock.calls as unknown[][]) {
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(call[0] as string);
      } catch {
        continue;
      }
      if (typeof line.name === 'string' && line.name.startsWith('axiom-ingest-')) parsed.push(line);
    }
    return parsed;
  };

  it('CONTAINMENT: a rejecting ingest resolves the caller and reports the failure once', async () => {
    h.ingestEvents.mockRejectedValue(new Error('ECONNREFUSED'));
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);

    await expect(logToAxiom(ERR)).resolves.toBeUndefined();

    const r = reports(errorSpy);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      name: 'axiom-ingest-failed',
      reason: 'error',
      consecutiveFailures: 1,
    });
  });

  it('BUDGET: a hanging ingest does not hold the caller past AXIOM_INGEST_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    // Never settles — the black-holed-endpoint case. Attach a sink so the abandoned promise
    // cannot register as unhandled if the implementation regresses to leaving it bare.
    h.ingestEvents.mockReturnValue(new Promise(() => {}));
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);

    let settled = false;
    const call = logToAxiom(ERR).then(() => {
      settled = true;
    });

    // Advance to just under the budget: still waiting.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);

    // Cross it: the caller is released even though the ingest never resolves.
    await vi.advanceTimersByTimeAsync(2);
    await call;
    expect(settled).toBe(true);

    expect(reports(errorSpy)[0]).toMatchObject({ name: 'axiom-ingest-failed', reason: 'timeout' });
  });

  it('NO UNHANDLED REJECTION: an ingest that rejects AFTER the budget expired is still handled', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      // Rejects long after the caller has stopped waiting — the shape that crashed the
      // background pods when nothing was attached to the promise.
      h.ingestEvents.mockReturnValue(
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late')), 10_000))
      );
      const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);

      const call = logToAxiom(ERR);
      await vi.advanceTimersByTimeAsync(2_001);
      await expect(call).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(10_000);
      // Let any unhandled-rejection detection run.
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('THROTTLE: an outage reports on the 1st and every 500th failure, not once per event', async () => {
    h.ingestEvents.mockRejectedValue(new Error('down'));
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);

    for (let i = 0; i < 501; i++) await logToAxiom(ERR);

    const r = reports(errorSpy);
    expect(r.map((x) => x.consecutiveFailures)).toEqual([1, 500]);
  });

  it('RECOVERY: the next success reports the outage total and resets the counter', async () => {
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);

    h.ingestEvents.mockRejectedValue(new Error('down'));
    await logToAxiom(ERR);
    await logToAxiom(ERR);

    h.ingestEvents.mockResolvedValue(undefined);
    await logToAxiom(ERR);

    expect(reports(errorSpy).at(-1)).toMatchObject({
      name: 'axiom-ingest-recovered',
      failedSince: 2,
    });

    // Counter reset: a later single failure reports as the FIRST of a new outage.
    errorSpy.mockClear();
    h.ingestEvents.mockRejectedValue(new Error('down again'));
    await logToAxiom(ERR);
    expect(reports(errorSpy)[0]).toMatchObject({ consecutiveFailures: 1 });
  });

  it('HEALTHY PATH IS SILENT: a successful ingest emits no outage report', async () => {
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);
    await logToAxiom(ERR);
    expect(reports(errorSpy)).toEqual([]);
  });
});

// The injected-sink seam. `emitLog` is a plain function parameter, so these use a real
// one — there is no module to mock, which is the point of injecting it.
describe('logToAxiom injected sink (deps.emitLog)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.ingestEvents.mockReset().mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('receives the SAME string that was written to stderr — identity, not an equal copy', async () => {
    const bodies: string[] = [];
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED, {
      emitLog: (body) => {
        bodies.push(body);
      },
    });

    await logToAxiom(ERR);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(1);
    // `toBe` on strings is value identity — a sink that re-serialized the payload would
    // produce an equal-looking but different string (e.g. dropping `_axiom`) and fail here.
    expect(bodies[0]).toBe(errorSpy.mock.calls[0][0]);
    expect(JSON.parse(bodies[0])._axiom).toBe('civitai-errors');
  });

  it('receives the payload and datastream alongside the line', async () => {
    const calls: Array<[string, Record<string, unknown>, string | undefined]> = [];
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED, {
      emitLog: (body, data, datastream) => {
        calls.push([body, data, datastream]);
      },
    });

    await logToAxiom(ERR);

    expect(calls).toHaveLength(1);
    const [, data, datastream] = calls[0];
    expect(datastream).toBe('civitai-errors');
    // `pod` is added by the logger, so the sink sees the same object Axiom ingests.
    expect(data).toMatchObject({ message: ERR.message, code: ERR.code, pod: 'pod-test' });
  });

  it('CATCH LADDER: an unserializable payload still yields ONE line, shared by both sinks', async () => {
    // The three-branch stringify ladder was refactored from three `console.error` calls
    // to "assign once, write once". This pins that the fallback branch still produces
    // exactly one stderr write AND that the sink gets that same fallback string.
    const bodies: string[] = [];
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED, {
      emitLog: (body) => {
        bodies.push(body);
      },
    });

    const circular: Record<string, unknown> = { name: 'payment.webhook' };
    circular.self = circular;

    await expect(logToAxiom(circular)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBe(errorSpy.mock.calls[0][0]);
    const parsed = JSON.parse(bodies[0]);
    expect(parsed.name).toBe('payment.webhook');
    expect(typeof parsed._stringifyError).toBe('string');
  });

  it('CONTAINMENT: a throwing sink does not break the caller, the stderr line, or the Axiom write', async () => {
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED, {
      emitLog: () => {
        throw new Error('sink exploded');
      },
    });

    // The caller must be untouched — logToAxiom is awaited on hot paths.
    await expect(logToAxiom(ERR)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorSpy.mock.calls[0][0] as string)).toMatchObject({
      message: ERR.message,
    });
    expect(h.ingestEvents).toHaveBeenCalledTimes(1);
  });

  it('LATE REGISTRATION: a sink attached to the deps object AFTER the logger is built still fires', async () => {
    // The app registers its sink from a server-only entry point at boot, which happens
    // after this factory has already run. That works only because `deps.emitLog` is read
    // per call rather than captured at construction — this pins exactly that.
    const deps: { emitLog?: (body: string) => void } = {};
    const bodies: string[] = [];
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED, deps);

    // Before registration: nothing to call, and the logger still works.
    await logToAxiom(ERR);
    expect(bodies).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Register late, exactly as the app does.
    deps.emitLog = (body: string) => {
      bodies.push(body);
    };

    await logToAxiom(ERR);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBe(errorSpy.mock.calls[1][0]);
  });

  it('is OPTIONAL: with no deps the logger behaves exactly as before', async () => {
    const { logToAxiom } = createAxiomLogger(PROD_CONFIGURED);

    await expect(logToAxiom(ERR)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(h.ingestEvents).toHaveBeenCalledTimes(1);
  });

  it('is NOT called outside prod, where no structured line is written either', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let called = 0;
    const { logToAxiom } = createAxiomLogger(
      { ...PROD_CONFIGURED, isProd: false },
      {
        emitLog: () => {
          called += 1;
        },
      }
    );

    await logToAxiom(ERR);

    expect(called).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });
});
