import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These pin the ordering contract of `logToAxiom`: the structured stderr line
// (which Loki ingests — it carries message/stack/code/path) must be emitted
// BEFORE the `if (!axiom) return` / `if (!datastream) return` guards. Previously
// it sat after those guards, so preview environments — where the Axiom token is a
// placeholder → `axiom` is null → the function returned early — never reached Loki
// (confirmed: 0 `INTERNAL_SERVER_ERROR` matches across 2.2M preview log lines).
// The same blind spot hits any Axiom outage. Axiom ingest is otherwise unchanged.
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
// case where the module's `axiom` ends up null.
async function loadClient(opts: {
  isProd: boolean;
  axiomConfigured: boolean;
  datastream?: string;
}) {
  const ingestEvents = vi.fn().mockResolvedValue(undefined);

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

describe('logToAxiom stderr-for-Loki ordering', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.doUnmock('~/env/other');
    vi.doUnmock('~/env/server');
    vi.doUnmock('@axiomhq/axiom-node');
  });

  it('REGRESSION GUARD: emits the structured stderr line in prod even when Axiom is null (preview/outage)', async () => {
    vi.stubEnv('LOG_ERRORS_TO_STDOUT', 'true');
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

  it('does NOT emit the stderr line when LOG_ERRORS_TO_STDOUT is unset (no stderr spam)', async () => {
    // flag unset
    const { logToAxiom, ingestEvents } = await loadClient({ isProd: true, axiomConfigured: false });

    await logToAxiom(ERR);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(ingestEvents).not.toHaveBeenCalled();
  });

  it('does NOT emit the stderr line when LOG_ERRORS_TO_STDOUT is not exactly "true"', async () => {
    vi.stubEnv('LOG_ERRORS_TO_STDOUT', '1');
    const { logToAxiom } = await loadClient({ isProd: true, axiomConfigured: false });

    await logToAxiom(ERR);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still ingests to Axiom (existing behavior) AND emits the stderr line when configured + flag on', async () => {
    vi.stubEnv('LOG_ERRORS_TO_STDOUT', 'true');
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
});
