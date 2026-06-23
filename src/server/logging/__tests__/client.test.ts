import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These pin the contract of `logToAxiom`'s structured-stderr sink:
//
//  1. ALWAYS-ON (Phase 1, Axiom→Loki migration): in prod the structured JSON line
//     is emitted UNCONDITIONALLY — it is no longer gated behind
//     `LOG_ERRORS_TO_STDOUT==='true'`. stdout/stderr → Alloy → Loki is the durable,
//     queryable sink, so every event must land there by default.
//  2. ORDERING: the line is emitted BEFORE the `if (!axiom) return` /
//     `if (!datastream) return` guards AND independently of Axiom throwing. Previously
//     it sat after those guards, so preview environments — where the Axiom token is a
//     placeholder → `axiom` is null → the function returned early — never reached Loki
//     (confirmed: 0 `INTERNAL_SERVER_ERROR` matches across 2.2M preview log lines).
//     The same blind spot hits any Axiom outage. Loki must get the line regardless.
//  3. DUAL-WRITE: Axiom ingest still fires when a client + datastream are configured
//     (kept during the transition; removed at the cutover phase).
//
// The module builds its `axiom` client and reads `isProd` at import time, so each
// case resets modules and re-mocks `~/env/other`, `~/env/server`, and
// `@axiomhq/axiom-node` before a fresh dynamic import. The global test setup
// (`src/__tests__/setup.ts`) mocks `~/server/logging/client` wholesale for other
// suites; `vi.unmock` here loads the REAL module under test.
vi.unmock('~/server/logging/client');

const ERR = { message: 'boom', stack: 'Error: boom\n  at x', code: 'INTERNAL_SERVER_ERROR', path: 'model.getById' };

// Returns the mock ingestEvents spy + a loader for the real module, configured
// for the requested env. `axiomConfigured=false` reproduces the preview/outage
// case where the module's `axiom` ends up null. `ingestThrows` reproduces an Axiom
// outage where `ingestEvents` rejects.
async function loadClient(opts: {
  isProd: boolean;
  axiomConfigured: boolean;
  datastream?: string;
  ingestThrows?: boolean;
}) {
  const ingestEvents = opts.ingestThrows
    ? vi.fn().mockRejectedValue(new Error('axiom down'))
    : vi.fn().mockResolvedValue(undefined);

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
      AXIOM_TOKEN: opts.axiomConfigured ? 'token' : undefined,
      AXIOM_ORG_ID: opts.axiomConfigured ? 'org' : undefined,
      AXIOM_DATASTREAM: opts.datastream,
    },
  }));

  vi.doMock('@axiomhq/axiom-node', () => ({
    Client: class {
      ingestEvents = ingestEvents;
    },
  }));

  const mod = await import('../client');
  return { logToAxiom: mod.logToAxiom, ingestEvents };
}

describe('logToAxiom structured-stderr sink (always-on for Loki)', () => {
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
    vi.doUnmock('@axiomhq/axiom-node');
  });

  it('ALWAYS-ON: emits the structured stderr line in prod even when LOG_ERRORS_TO_STDOUT is unset', async () => {
    // flag deliberately NOT set — the line must still be written (the gate is gone).
    const { logToAxiom } = await loadClient({
      isProd: true,
      axiomConfigured: true,
      datastream: 'civitai-errors',
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
  });

  it('ALWAYS-ON: emits the line regardless of LOG_ERRORS_TO_STDOUT value ("1", "false", etc.)', async () => {
    for (const value of ['1', 'false', '', 'no']) {
      errorSpy.mockClear();
      vi.resetModules();
      vi.stubEnv('LOG_ERRORS_TO_STDOUT', value);
      const { logToAxiom } = await loadClient({
        isProd: true,
        axiomConfigured: true,
        datastream: 'civitai-errors',
      });

      await logToAxiom(ERR);

      expect(errorSpy, `LOG_ERRORS_TO_STDOUT=${JSON.stringify(value)} should still emit`).toHaveBeenCalledTimes(1);
      vi.unstubAllEnvs();
    }
  });

  it('ORDERING: emits the stderr line in prod even when Axiom is null (preview/outage), before the guards', async () => {
    const { logToAxiom, ingestEvents } = await loadClient({ isProd: true, axiomConfigured: false });

    await logToAxiom(ERR);

    // The case that was broken: no Axiom client, yet Loki must still get the line.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = errorSpy.mock.calls[0][0] as string;
    expect(typeof payload).toBe('string');
    const parsed = JSON.parse(payload);
    expect(parsed).toMatchObject({
      message: ERR.message,
      stack: ERR.stack,
      code: ERR.code,
      path: ERR.path,
    });
    // No datastream configured in previews → `_axiom` is undefined and dropped by
    // JSON.stringify; the line still carries the error fields.
    expect('_axiom' in parsed).toBe(false);
    // Axiom ingest is correctly skipped when no client is configured.
    expect(ingestEvents).not.toHaveBeenCalled();
  });

  it('ORDERING: emits the stderr line even when Axiom ingest throws (Axiom degraded)', async () => {
    const { logToAxiom, ingestEvents } = await loadClient({
      isProd: true,
      axiomConfigured: true,
      datastream: 'civitai-errors',
      ingestThrows: true,
    });

    // The stderr line is written synchronously before the await, so it lands even
    // though ingestEvents rejects (the rejection propagates out of logToAxiom).
    await expect(logToAxiom(ERR)).rejects.toThrow('axiom down');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ message: ERR.message, code: ERR.code });
    expect(ingestEvents).toHaveBeenCalledTimes(1);
  });

  it('DUAL-WRITE: still ingests to Axiom AND emits the stderr line when a client + datastream are configured', async () => {
    const { logToAxiom, ingestEvents } = await loadClient({
      isProd: true,
      axiomConfigured: true,
      datastream: 'civitai-errors',
    });

    await logToAxiom(ERR);

    // stderr line emitted, carrying the resolved datastream in `_axiom`.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed._axiom).toBe('civitai-errors');
    expect(parsed).toMatchObject({ message: ERR.message, code: ERR.code });

    // Axiom ingest preserved.
    expect(ingestEvents).toHaveBeenCalledTimes(1);
    expect(ingestEvents).toHaveBeenCalledWith(
      'civitai-errors',
      expect.objectContaining({ message: ERR.message, code: ERR.code, pod: 'pod-test' })
    );
  });

  it('NON-PROD: logs via console.log and does NOT touch the stderr/Axiom path', async () => {
    const { logToAxiom, ingestEvents } = await loadClient({
      isProd: false,
      axiomConfigured: true,
      datastream: 'civitai-errors',
    });

    await logToAxiom(ERR);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('logToAxiom', expect.objectContaining({ message: ERR.message, pod: 'pod-test' }));
    expect(errorSpy).not.toHaveBeenCalled();
    expect(ingestEvents).not.toHaveBeenCalled();
  });
});
