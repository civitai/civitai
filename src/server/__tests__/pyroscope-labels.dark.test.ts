import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@civitai/next-axiom', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withAxiom: (handler: unknown) => handler,
}));

// The FALSE side of the module-load gate (`PYROSCOPE_ENABLED === 'true'`). Labels are armed with a
// fake profiler in every case, so only the gate can keep the real wrapper from labelling: a looser
// gate (`!== 'false'`, `!!value`) labels here and goes red. `'true'` is covered by
// pyroscope-labels.wrappers.test.ts.

const store = new AsyncLocalStorage<{ labels?: Record<string, string> }>();
const fakeTime = {
  started: false,
  start() {
    fakeTime.started = true;
  },
  isStarted: () => fakeTime.started,
  runWithContext<R>(context: object, fn: () => R): R {
    return store.run(context, fn);
  },
};

afterEach(async () => {
  (await import('~/server/pyroscope-labels')).__resetProfileRouteLabelsForTests();
  vi.unstubAllEnvs();
});

describe('Pyroscope route labels when the flag is not exactly "true"', () => {
  it.each([undefined, 'false', '1'])('PYROSCOPE_ENABLED=%j: not armed, no label', async (value) => {
    vi.stubEnv('PYROSCOPE_ENABLED', value as string);
    vi.resetModules();
    const labels = await import('~/server/pyroscope-labels');
    expect(labels.pyroscopeArmed).toBe(false);
    fakeTime.started = false;
    expect(labels.startWallProfilingWithAsyncContext(() => fakeTime.start(), fakeTime)).toBe(true);

    const { TokenSecuredEndpoint } = await import('~/server/utils/endpoint-helpers');
    const SECRET = 'a'.repeat(40);
    let ran = false;
    let seen: unknown = 'not-run';
    const endpoint = TokenSecuredEndpoint(SECRET, async () => {
      ran = true;
      seen = store.getStore();
    }) as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
    const res = { status: () => res, json: () => res } as unknown as NextApiResponse;
    await endpoint(
      {
        method: 'GET',
        url: '/api/v1/images',
        query: {},
        headers: { authorization: `Bearer ${SECRET}` },
      } as unknown as NextApiRequest,
      res
    );

    expect(ran).toBe(true);
    expect(seen).toBeUndefined();
  });
});
