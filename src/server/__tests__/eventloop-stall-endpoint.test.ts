import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `endpoint-helpers` spreads `env.TRPC_ORIGINS` at module load, so an unmocked
// import of the page throws `env.TRPC_ORIGINS is not iterable`. Stub the wrapper
// itself, per the pattern in
// src/server/utils/__tests__/public-endpoint-maxage.test.ts. The gate under test
// here is the module-load env check, which sits in front of the wrapper.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

const GATE = 'EVENTLOOP_WATCHDOG_STALL_ENDPOINT';

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[GATE];
  delete process.env[GATE];
  vi.resetModules();
});

afterEach(() => {
  if (saved === undefined) delete process.env[GATE];
  else process.env[GATE] = saved;
});

function mockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

describe('synthetic stall endpoint gating', () => {
  it('404s and never stalls when the env gate is unset', async () => {
    const mod = await import('~/pages/api/testing/eventloop-stall');
    const res = mockRes();

    const startedAt = Date.now();
    await mod.default({ query: { durationMs: 5000 }, body: {} } as never, res as never);
    const elapsed = Date.now() - startedAt;

    expect(res.status).toHaveBeenCalledWith(404);
    // A disabled endpoint that merely refuses AFTER doing the work is not disabled.
    // Asking for a 5s stall and returning immediately is the assertion that the
    // stall path is unreachable, not just unauthorised.
    expect(elapsed).toBeLessThan(1000);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('404s for every value of the gate except the exact string "true"', async () => {
    for (const value of ['1', 'yes', 'TRUE', 'false', '']) {
      vi.resetModules();
      process.env[GATE] = value;
      const mod = await import('~/pages/api/testing/eventloop-stall');
      const res = mockRes();

      await mod.default({ query: {}, body: {} } as never, res as never);

      expect(res.status, `gate value ${JSON.stringify(value)}`).toHaveBeenCalledWith(404);
    }
  });

  it('NEGATIVE CONTROL: serves a real stall when the gate is on', async () => {
    // Without this the 404 tests above would pass just as happily against an
    // endpoint that is broken in some unrelated way.
    process.env[GATE] = 'true';
    const mod = await import('~/pages/api/testing/eventloop-stall');
    const res = mockRes();

    await mod.default({ query: {}, body: { durationMs: 60, mode: 'spin' } } as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ requestedMs: 60, mode: 'spin' })
    );
  });

  it('clamps the requested duration into [1, 10000] without rejecting', async () => {
    // Purely on the resolver. Driving this through the handler would mean actually
    // hard-locking the thread for the clamped ceiling, which is a 10s test that also
    // starves whatever else the suite is running in parallel.
    const { resolveStallRequest } = await import('~/pages/api/testing/eventloop-stall');

    const clamped = (durationMs: unknown) => {
      const parsed = resolveStallRequest({ durationMs, mode: 'spin' });
      if (!parsed.ok) throw new Error('expected a clamp, got a rejection');
      return parsed.value.durationMs;
    };

    expect(clamped(900_000)).toBe(10_000);
    expect(clamped(10_001)).toBe(10_000);
    expect(clamped(0)).toBe(1);
    expect(clamped(-5)).toBe(1);
    expect(clamped(3000)).toBe(3000);
    expect(resolveStallRequest({}).ok && resolveStallRequest({}).value.durationMs).toBe(3000);
  });

  it('stalls for AT LEAST the requested duration in both modes', async () => {
    const { stall } = await import('~/pages/api/testing/eventloop-stall');

    for (const mode of ['spin', 'alloc'] as const) {
      const startedAt = Date.now();
      const iterations = stall(120, mode);
      const elapsed = Date.now() - startedAt;

      // REGRESSION: spin mode used to count with its own `|0` accumulator, which is
      // signed 32-bit and wraps negative after ~4 batches. Whether the reported count
      // came out positive depended on where the accumulator happened to land when the
      // clock ran out, so this assertion passed alone and failed under load — and the
      // endpoint could report a negative iteration count to its caller.
      expect(iterations, mode).toBeGreaterThan(0);
      expect(Number.isSafeInteger(iterations), `${mode} iterations=${iterations}`).toBe(true);
      // 10ms of slack for coarse timer granularity.
      expect(elapsed, mode).toBeGreaterThanOrEqual(110);
    }
  });

  // NO UPPER BOUND ON `elapsed` ABOVE, DELIBERATELY. An earlier revision asserted
  // `elapsed < 3000`, which passed in isolation and failed in the full 885-file suite
  // — a CPU-bound loop's wall-clock is set by a scheduler this process does not
  // control, so any ceiling is green on a quiet box and red on a busy one, which is
  // exactly when CI runs. Overshooting the request is the OS, not a defect: the only
  // property worth asserting is that the loop blocked for at least as long as asked.
});
