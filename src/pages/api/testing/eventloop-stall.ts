/**
 * Synthetic event-loop stall, for validating the off-loop watchdog.
 * =============================================================================
 *
 * A preview environment will not wedge on its own, so without this there is no way
 * to prove the watchdog (src/server/eventloop-watchdog.ts) detects and reports a
 * wedge before it reaches production.
 *
 * 🔴 This endpoint deliberately hard-locks the Node process serving it. Every
 * request to that pod — including its own response — stops until the stall ends.
 * It is gated TWICE: the module only builds a real handler when
 * EVENTLOOP_WATCHDOG_STALL_ENDPOINT === 'true' (otherwise this route is a bare 404
 * with no auth path and no reachable stall code), and when it is enabled it still
 * requires the WEBHOOK_TOKEN. The duration is clamped server-side regardless of what
 * is asked for, and a cooldown is enforced between stalls, so even with both gates
 * open a caller cannot hold the loop pinned continuously.
 *
 * Usage:
 *   POST /api/testing/eventloop-stall?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "durationMs": 5000, "mode": "spin" }
 *
 * Params:
 *   durationMs  - number, 1..10000, default 3000. Clamped, never rejected.
 *   mode        - 'spin' | 'alloc', default 'spin'.
 *                 spin  = non-allocating tight loop (no GC safepoints; the harder
 *                         case for anything that needs to interrupt the isolate)
 *                 alloc = allocating loop (produces GC pauses, closer to a real
 *                         traffic-driven pin)
 *
 * The response is sent AFTER the stall completes — the loop cannot serve it any
 * earlier — so the client sees a hung request for the duration. That is the
 * endpoint working, not failing.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const MAX_DURATION_MS = 10_000;
const MIN_DURATION_MS = 1;
const DEFAULT_DURATION_MS = 3000;
const BURN_BATCH = 100_000;
// Enforced after each stall, so a caller looping the endpoint cannot hold the loop
// pinned continuously. Generous relative to the 10s ceiling: the point is to make
// sustained pinning impossible, not to make repeat testing painful.
const COOLDOWN_MS = 30_000;

// Resolved at module load. When false, nothing below this line is reachable: the
// default export is a 404 that never consults a token and never calls stall().
const stallEndpointEnabled = process.env.EVENTLOOP_WATCHDOG_STALL_ENDPOINT === 'true';

const schema = z.object({
  // Clamp rather than reject, matching cpu-profiler.ts's handling of a
  // fat-fingered duration.
  durationMs: z.coerce
    .number()
    .transform((v) => Math.min(Math.max(Math.round(v), MIN_DURATION_MS), MAX_DURATION_MS))
    .default(DEFAULT_DURATION_MS),
  mode: z.enum(['spin', 'alloc']).default('spin'),
});

export type StallRequest = z.infer<typeof schema>;

/**
 * Exported so the clamp can be verified without a unit test that actually stalls for
 * the clamped ceiling — a 10s hard-locked thread inside a parallel suite is both slow
 * and a good way to make unrelated tests time out.
 */
export function resolveStallRequest(
  input: unknown
): { ok: true; value: StallRequest } | { ok: false; error: z.ZodError } {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error };
}

export function stall(durationMs: number, mode: 'spin' | 'alloc'): number {
  const end = Date.now() + durationMs;
  let iterations = 0;
  if (mode === 'alloc') {
    let sink: unknown;
    while (Date.now() < end) {
      sink = { i: iterations, pad: new Array(64).fill(0) };
      iterations++;
    }
    void sink;
  } else {
    // The accumulator is SEPARATE from the counter on purpose. `|0` keeps the burn
    // loop non-allocating (the whole point of spin mode), but it is signed 32-bit, so
    // it wraps negative after a few passes — counting with it made `iterations` a
    // meaningless, sometimes-negative number in the response body.
    let acc = 0;
    // Only check the clock every BURN_BATCH iterations so the loop body stays free of
    // calls; a Date.now() per iteration would make this a call-heavy loop rather than
    // the tight-spin case it is meant to reproduce.
    while (Date.now() < end) {
      for (let i = 0; i < BURN_BATCH; i++) acc = (acc + i) | 0;
      iterations += BURN_BATCH;
    }
    void acc;
  }
  return iterations;
}

// The per-request clamp bounds ONE stall; it does nothing about a caller looping the
// endpoint, which pins the loop indefinitely and would cross the liveness threshold.
// Defence in depth — it needs both gates open to matter — but a bounded primitive that
// is unbounded in aggregate is not really bounded.
let cooldownUntil = 0;

const buildHandler = () =>
  WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
    const parsed = resolveStallRequest({ ...req.query, ...(req.body ?? {}) });
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const now = Date.now();
    if (now < cooldownUntil) {
      return res.status(429).json({
        error: 'stall cooling down',
        retryAfterMs: cooldownUntil - now,
      });
    }

    const { durationMs, mode } = parsed.value;
    // Set BEFORE stalling. The loop is blocked for the whole stall, so no concurrent
    // request can be serviced anyway; what this bounds is the next one, and it must
    // already be in place when the loop starts serving again.
    cooldownUntil = now + durationMs + COOLDOWN_MS;
    const startedAt = Date.now();
    console.warn(
      `[eventloop-stall] SYNTHETIC STALL starting: ${durationMs}ms mode=${mode} — this pod is ` +
        `intentionally wedged and will not serve any request until it ends`
    );

    const iterations = stall(durationMs, mode);
    const actualMs = Date.now() - startedAt;

    console.warn(`[eventloop-stall] synthetic stall complete after ${actualMs}ms`);
    return res.status(200).json({ requestedMs: durationMs, actualMs, mode, iterations });
  });

const notFound = (_req: NextApiRequest, res: NextApiResponse) => {
  res.status(404).end();
};

// Selection happens ONCE, at module load, and the disabled build never even
// constructs the stall handler — `buildHandler()` is not called, so no token check
// and no route to `stall()` exists to be reached. This is deliberately not a runtime
// `if` inside a live handler: an authenticated endpoint whose job is to hard-lock an
// app server is a DoS primitive, and a runtime refusal leaves the path present and
// one bug away from reachable.
//
// Honest limit of that claim: `stall` is exported for the unit test, so the function
// remains in the bundle and importable in-process. Nothing imports it outside the
// test. What is absent in a disabled build is any way to reach it over HTTP.
export default stallEndpointEnabled ? buildHandler() : notFound;
