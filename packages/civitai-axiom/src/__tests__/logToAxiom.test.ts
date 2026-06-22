import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAxiomLogger } from '../client';

// Pins the ordering contract of `logToAxiom`: the structured stderr line (which Loki ingests — it carries
// message/stack/code/path) must be emitted BEFORE the `if (!axiom) return` / `if (!datastream) return`
// guards. Previously it sat after those guards, so preview environments — where the Axiom token is a
// placeholder → `axiom` is null → the function returned early — never reached Loki (confirmed: 0
// INTERNAL_SERVER_ERROR matches across 2.2M preview log lines). The same blind spot hits any Axiom outage.
//
// Relocated from the main app's src/server/logging/__tests__/client.test.ts when the logger moved into this
// package: the factory takes a Partial<AxiomConfig>, so we inject isProd/token/datastream/logErrorsToStdout
// directly instead of mocking the app's `~/env/*` modules (which the package never reads).

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

describe('logToAxiom stderr-for-Loki ordering', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.ingestEvents.mockReset().mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('REGRESSION GUARD: emits the structured stderr line in prod even when Axiom is null (preview/outage)', async () => {
    // No token → axiom client is null (the preview/outage case that was broken).
    const { logToAxiom } = createAxiomLogger({
      isProd: true,
      token: undefined,
      orgId: undefined,
      datastream: undefined,
      podName: 'pod-test',
      logErrorsToStdout: true,
    });

    await logToAxiom(ERR);

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
    // No datastream in previews → `_axiom` is undefined and dropped by JSON.stringify.
    expect('_axiom' in parsed).toBe(false);
    // Axiom ingest is correctly skipped when no client is configured.
    expect(h.ingestEvents).not.toHaveBeenCalled();
  });

  it('does NOT emit the stderr line when logErrorsToStdout is false (no stderr spam)', async () => {
    const { logToAxiom } = createAxiomLogger({
      isProd: true,
      token: undefined,
      orgId: undefined,
      logErrorsToStdout: false,
    });

    await logToAxiom(ERR);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(h.ingestEvents).not.toHaveBeenCalled();
  });

  it('still ingests to Axiom (existing behavior) AND emits the stderr line when configured + flag on', async () => {
    const { logToAxiom } = createAxiomLogger({
      isProd: true,
      token: 'token',
      orgId: 'org',
      datastream: 'civitai-errors',
      podName: 'pod-test',
      logErrorsToStdout: true,
    });

    await logToAxiom(ERR);

    // stderr line emitted, carrying the resolved datastream in `_axiom`.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed._axiom).toBe('civitai-errors');
    expect(parsed).toMatchObject({ message: ERR.message, code: ERR.code });

    // Axiom ingest preserved.
    expect(h.ingestEvents).toHaveBeenCalledTimes(1);
    expect(h.ingestEvents).toHaveBeenCalledWith(
      'civitai-errors',
      expect.objectContaining({ message: ERR.message, code: ERR.code, pod: 'pod-test' })
    );
  });
});
