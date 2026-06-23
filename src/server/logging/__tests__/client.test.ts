import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These pin the POST Axiom→Loki Phase 4 contract of `logToAxiom`'s structured sink.
//
// Phase 1 (#2721) made the structured JSON line ALWAYS-ON (dropped the
// `LOG_ERRORS_TO_STDOUT` gate). Phase 4 (this change) removed the redundant Axiom
// dual-write entirely — there is NO `@axiomhq/axiom-node` client anymore. The sink is
// purely structured stdout/stderr → Alloy → Loki. The contract under test:
//
//  1. ALWAYS-ON: in prod the structured JSON line is emitted UNCONDITIONALLY
//     (independent of any `LOG_ERRORS_TO_STDOUT` value). stdout/stderr → Alloy → Loki
//     is the durable, queryable sink, so every event must land there by default.
//  2. NO AXIOM: there is no Axiom interaction at all — no import, no client, no
//     ingest. (This suite no longer mocks `@axiomhq/axiom-node` because the module no
//     longer imports it; a leftover mock would be inert.)
//  3. SERIALIZATION GUARD: a non-serializable `data` (circular ref / BigInt) is
//     contained — `logToAxiom` never throws to the caller (hot paths: tRPC 500
//     handler, payment webhooks, upload endpoints), and emits a stringify-safe
//     fallback line so the event isn't silently lost.
//  4. NON-PROD: logs via `console.log` and does NOT touch the stderr sink.
//
// The module reads `isProd` and `env` at import time, so each case resets modules and
// re-mocks `~/env/other` + `~/env/server` before a fresh dynamic import. The global
// test setup (`src/__tests__/setup.ts`) mocks `~/server/logging/client` wholesale for
// other suites; `vi.unmock` here loads the REAL module under test.
vi.unmock('~/server/logging/client');

const ERR = { message: 'boom', stack: 'Error: boom\n  at x', code: 'INTERNAL_SERVER_ERROR', path: 'model.getById' };

// Returns a loader for the real module, configured for the requested env.
async function loadClient(opts: { isProd: boolean; datastream?: string }) {
  vi.doMock('~/env/other', () => ({
    isProd: opts.isProd,
    isDev: false,
    isTest: true,
    isPreview: false,
  }));

  vi.doMock('~/env/server', () => ({
    env: {
      PODNAME: 'pod-test',
      IS_BUILD: false,
    },
  }));

  const mod = await import('../client');
  return { logToAxiom: mod.logToAxiom };
}

describe('logToAxiom structured sink (always-on, Loki-only, post Axiom removal)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.doUnmock('~/env/other');
    vi.doUnmock('~/env/server');
  });

  it('ALWAYS-ON: emits the structured stderr line in prod', async () => {
    const { logToAxiom } = await loadClient({ isProd: true });

    await logToAxiom(ERR);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      message: ERR.message,
      stack: ERR.stack,
      code: ERR.code,
      path: ERR.path,
      pod: 'pod-test',
    });
  });

  it('ALWAYS-ON: emits the line regardless of LOG_ERRORS_TO_STDOUT value ("1", "false", etc.)', async () => {
    for (const value of ['1', 'false', '', 'no']) {
      errorSpy.mockClear();
      vi.resetModules();
      vi.stubEnv('LOG_ERRORS_TO_STDOUT', value);
      const { logToAxiom } = await loadClient({ isProd: true });

      await logToAxiom(ERR);

      expect(
        errorSpy,
        `LOG_ERRORS_TO_STDOUT=${JSON.stringify(value)} should still emit`
      ).toHaveBeenCalledTimes(1);
      vi.unstubAllEnvs();
    }
  });

  it('DATASTREAM TAG: a passed datastream surfaces as `_axiom` on the line (now just a stream hint, no Axiom)', async () => {
    const { logToAxiom } = await loadClient({ isProd: true });

    await logToAxiom(ERR, 'civitai-errors');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed._axiom).toBe('civitai-errors');
    expect(parsed).toMatchObject({ message: ERR.message, code: ERR.code });
  });

  it('NO DATASTREAM: `_axiom` is undefined and dropped by JSON.stringify; the line still carries the fields', async () => {
    const { logToAxiom } = await loadClient({ isProd: true });

    await logToAxiom(ERR);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect('_axiom' in parsed).toBe(false);
    expect(parsed).toMatchObject({ message: ERR.message, code: ERR.code, path: ERR.path });
  });

  it('SERIALIZATION GUARD: a non-serializable `data` (circular ref) does NOT throw to the caller and emits a safe fallback', async () => {
    const { logToAxiom } = await loadClient({ isProd: true });

    // Circular reference → JSON.stringify throws "Converting circular structure to JSON".
    // (A BigInt value would throw "Do not know how to serialize a BigInt" the same way.)
    const circular: MixedObject = { name: 'payment.webhook' };
    circular.self = circular;

    // The unconditional structured-stderr stringify must be contained: logToAxiom must
    // not throw, so the hot-path caller (tRPC 500 handler / webhook / upload) is safe.
    await expect(logToAxiom(circular)).resolves.toBeUndefined();

    // The failure is contained, NOT silent: a stringify-safe fallback line is emitted.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const fallback = errorSpy.mock.calls[0][0] as string;
    expect(typeof fallback).toBe('string');
    const parsed = JSON.parse(fallback);
    expect(parsed.name).toBe('payment.webhook');
    expect(typeof parsed._stringifyError).toBe('string');
  });

  it('SERIALIZATION GUARD: a BigInt value is contained the same way (no throw, safe fallback)', async () => {
    const { logToAxiom } = await loadClient({ isProd: true });

    const withBigInt: MixedObject = { name: 'buzz.transaction', amount: BigInt(10) };

    await expect(logToAxiom(withBigInt)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed.name).toBe('buzz.transaction');
    expect(typeof parsed._stringifyError).toBe('string');
  });

  it('NON-PROD: logs via console.log and does NOT touch the stderr sink', async () => {
    const { logToAxiom } = await loadClient({ isProd: false });

    await logToAxiom(ERR);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      'logToAxiom',
      expect.objectContaining({ message: ERR.message, pod: 'pod-test' })
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
