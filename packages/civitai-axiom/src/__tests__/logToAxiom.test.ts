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

    // The stderr line is written synchronously before the await, so it lands even though the rejection
    // propagates out of logToAxiom.
    await expect(logToAxiom(ERR)).rejects.toThrow('axiom down');

    expect(errorSpy).toHaveBeenCalledTimes(1);
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
