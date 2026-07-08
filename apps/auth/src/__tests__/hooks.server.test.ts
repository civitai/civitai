import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandleServerError } from '@sveltejs/kit';

// Seam test for hooks.server.ts's HandleServerError. We spy the error logger, and stub the DB-pulling
// session producer so importing hooks.server doesn't construct a pg Pool at module load (db/db.ts throws
// without DATABASE_URL). This drives the real handleError export — proving it passes the EXACT alert
// marker "unhandled server error" to logAxiomError, still bumps the counter, and returns a safe message.
const h = vi.hoisted(() => ({ logAxiomError: vi.fn() }));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: h.logAxiomError, logToAxiom: vi.fn(async () => {}) }));
vi.mock('$lib/server/auth/session-producer', () => ({ getOrProduceSessionUser: vi.fn() }));

import { handleError } from '../hooks.server';
import { register } from '$lib/server/metrics';

async function unhandledCount(): Promise<number> {
  const metric = (await register.getMetricsAsJSON()).find((m) => m.name === 'hub_unhandled_errors_total');
  return metric?.values.find((v) => Object.keys(v.labels ?? {}).length === 0)?.value ?? 0;
}

beforeEach(() => h.logAxiomError.mockReset());

describe('hooks.server handleError', () => {
  it('logs the unhandled error with the exact alert marker, increments the counter, returns a safe message', async () => {
    const before = await unhandledCount();
    const error = new Error('kaboom');

    const result = (handleError as HandleServerError)({
      error,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      event: {} as any,
      status: 500,
      message: 'Internal Error',
    });

    expect(h.logAxiomError).toHaveBeenCalledTimes(1);
    const [passedError, extra] = h.logAxiomError.mock.calls[0];
    expect(passedError).toBe(error);
    expect(extra).toEqual({ event: 'unhandled server error' });
    // Alert-compat lock: the marker the Loki alert matches must be present.
    expect(JSON.stringify(extra)).toContain('unhandled server error');

    expect(await unhandledCount()).toBe(before + 1);
    expect(result).toEqual({ message: 'Internal Error' });
  });
});
