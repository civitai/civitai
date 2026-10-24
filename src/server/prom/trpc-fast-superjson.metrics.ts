import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';
import { currentSerializeCtx } from '~/server/logging/trpc-serialize-log';
import type { FastSuperjsonOutcome } from '~/server/trpc/superjson-fast-serialize';

// ---------------------------------------------------------------------------
// Outcome counter for the `trpc-fast-superjson-write` flag
// ---------------------------------------------------------------------------
//
// With the flag ON, every superjson response write tries `fastSuperjsonSerialize`. This counts how
// each attempt ended:
//   - `fast`         the walk produced the output itself;
//   - `bail`         the walk met a shape it does not handle (a shared reference, a Decimal, a
//                    Map, ...) and handed the payload to `superjson.serialize`, so the write paid
//                    the partial walk on top of the full superjson walk;
//   - `registry_off` something is registered on superjson (a class, symbol or custom
//                    transformer), so the walk was not tried at all.
// `bail / (fast + bail)` per path is the number that decides whether the walk is worth keeping.
// With the flag OFF nothing here runs: `responseWriteSerialize` never calls the walk.
//
// `path` is bounded: it is the tRPC procedure path only when it names a procedure on the app
// router (`setTrpcProcedureRegistry`, called by the route with the router's own map). The raw
// path comes from the request URL, which the client controls, so anything else is folded into
// `other`. A multi-procedure batch is `batch`, and a write with no request context (the
// serialize-log ALS is off, or the write is outside an HTTP request) is `unknown`.
//
// Registered on `instrumentationRegistry`, which `/api/metrics` merges into the scrape, so it is
// scraped whichever webpack graph registers it first.

const NAME = 'civitai_app_trpc_fast_superjson_writes_total';

const fastSuperjsonWritesCounter = registerInstrumentationMetric(
  NAME,
  () =>
    new client.Counter({
      name: NAME,
      help:
        'tRPC superjson response writes that tried the fast superjson walk (only while ' +
        'trpc-fast-superjson-write is ON), by outcome: fast (walk wrote it), bail (handed to ' +
        'superjson.serialize after a partial walk), registry_off (a superjson registration ' +
        'disabled the walk). path is the procedure path, or batch / other / unknown. UNSAMPLED.',
      labelNames: ['path', 'outcome'],
      registers: [instrumentationRegistry],
    })
);

/** The app router's flattened procedure map (`appRouter._def.procedures`), keyed by path. */
let procedureRegistry: Record<string, unknown> | undefined;

/**
 * Called once by the tRPC route with `appRouter._def.procedures`. The map is kept by reference:
 * a lazily loaded sub-router adds its procedures to it when it loads, which is always before a
 * response from one of them is serialized.
 */
export function setTrpcProcedureRegistry(procedures: Record<string, unknown>): void {
  procedureRegistry = procedures;
}

/** The bounded `path` label for a raw request path. */
export function fastSuperjsonPathLabel(path: string | undefined): string {
  if (!path || path === 'unknown') return 'unknown';
  if (path.includes(',')) return 'batch';
  if (procedureRegistry && Object.prototype.hasOwnProperty.call(procedureRegistry, path))
    return path;
  return 'other';
}

/** Never throws. */
export function recordFastSuperjsonWrite(outcome: FastSuperjsonOutcome): void {
  try {
    fastSuperjsonWritesCounter.inc({
      path: fastSuperjsonPathLabel(currentSerializeCtx()?.path),
      outcome,
    });
  } catch {
    /* never throw from telemetry */
  }
}
