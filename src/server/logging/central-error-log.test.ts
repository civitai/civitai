import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';

/**
 * Tests for `buildCentralErrorLog` — the payload builder shared by the two central
 * 500-emitting chokepoints (the tRPC `onError` handler in
 * `src/pages/api/trpc/[trpc].ts` and the REST `handleEndpointError` in
 * `endpoint-helpers.ts`). It generalizes the per-router pattern in
 * `orchestrator.router.ts` so EVERY unexpected 500 becomes self-describing:
 *   - server fault → `type:'error'` + the UN-MASKED `.cause` chain
 *   - client fault → `type:'info'` + the light `safeError` shape
 *
 * The Alloy→Loki pipeline extracts **`type`** as the severity field (NOT `level`),
 * so `type` is what actually drives `detected_level`. These tests assert on `type`.
 *
 * The global setup mocks `~/server/logging/client` wholesale, so we pull the REAL
 * implementation via `importActual` (these helpers only touch TRPCError shape).
 */

const { buildCentralErrorLog } = await vi.importActual<typeof import('./client')>('./client');

// Mirror of errorHandling.ts `throwInternalServerError`: it rewrites the
// user-facing message to a generic string but PRESERVES the original error on
// `.cause`. Reproduced here so the test asserts on the exact masking shape.
function maskAsInternalServerError(original: Error): TRPCError {
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error ocurred, please try again later',
    cause: original,
  });
}

describe('buildCentralErrorLog — server faults get type:error WITH the un-masked cause', () => {
  it('un-masks a masked INTERNAL_SERVER_ERROR and tags severity type:error', () => {
    const original = new Error('Prisma P2024 connection pool timeout');
    (original as Error & { code?: string }).code = 'P2024';
    const entry = buildCentralErrorLog(maskAsInternalServerError(original));

    // `type` is the field the Alloy→Loki pipeline reads for detected_level.
    expect(entry.type).toBe('error');
    expect(entry.level).toBe('error'); // belt-and-suspenders duplicate
    expect(entry.code).toBe('INTERNAL_SERVER_ERROR');
    // The diagnosable cause is recovered from `.cause` (the whole point).
    expect((entry.cause as { message?: string }).message).toBe(
      'Prisma P2024 connection pool timeout'
    );
    expect((entry.cause as { code?: string }).code).toBe('P2024');
    expect((entry.cause as { stack?: string }).stack).toBeTruthy();
  });

  it('logs a non-TRPCError at type:error with its real message + stack', () => {
    const entry = buildCentralErrorLog(new Error('unexpected throw'));
    expect(entry.type).toBe('error');
    expect(entry.message).toBe('unexpected throw');
    expect(entry.stack).toBeTruthy();
  });

  it('classifies TIMEOUT (not a client-fault code) as a server fault → type:error', () => {
    const entry = buildCentralErrorLog(new TRPCError({ code: 'TIMEOUT', message: 'x' }));
    expect(entry.type).toBe('error');
    expect(entry.code).toBe('TIMEOUT');
  });
});

describe('buildCentralErrorLog — client-fault 4xx are NOT logged at error severity', () => {
  const clientFaultCodes = [
    'BAD_REQUEST',
    'NOT_FOUND',
    'CONFLICT',
    'PRECONDITION_FAILED',
    'FORBIDDEN',
    'UNAUTHORIZED',
    'TOO_MANY_REQUESTS',
  ] as const;

  it.each(clientFaultCodes)('tags %s as type:info (never error), preserving the code', (code) => {
    const entry = buildCentralErrorLog(new TRPCError({ code, message: 'x' }));
    expect(entry.type).toBe('info');
    expect(entry.type).not.toBe('error');
    expect(entry.code).toBe(code);
  });

  it('does NOT walk a cause chain for a client fault (stays the light safeError shape)', () => {
    const err = new TRPCError({
      code: 'BAD_REQUEST',
      message: 'bad input',
      cause: new Error('should-not-be-unmasked'),
    });
    const entry = buildCentralErrorLog(err);
    expect(entry.type).toBe('info');
    // The server-fault-only un-masked `.cause` object must be absent; only the
    // light `causeMessage` string from safeError may appear.
    expect(entry.cause).toBeUndefined();
  });
});

/**
 * The tRPC onError line already carries the OPERATION type (query/mutation) under a
 * `type` key. This replicates the emission-site merge order to prove the SEVERITY
 * `type` from buildCentralErrorLog wins in the final JSON — otherwise the op-type
 * would clobber it and the line would read `type:"query"` → detected_level unknown.
 */
describe('tRPC emission merge order — severity type wins over the op-type', () => {
  function emittedLine(error: TRPCError, opType: 'query' | 'mutation') {
    // Mirror of src/pages/api/trpc/[trpc].ts: op-type first (renamed to trpcType),
    // buildCentralErrorLog spread LAST so its `type` wins.
    return { path: 'model.getAll', trpcType: opType, ...buildCentralErrorLog(error) };
  }

  it('a server-fault query line ends up type:error (not "query"), op-type preserved', () => {
    const line = emittedLine(maskAsInternalServerError(new Error('boom')), 'query');
    expect(line.type).toBe('error');
    expect(line.trpcType).toBe('query'); // op-type kept, just not on the severity key
  });

  it('a client-fault mutation line ends up type:info (not "mutation")', () => {
    const line = emittedLine(new TRPCError({ code: 'BAD_REQUEST', message: 'x' }), 'mutation');
    expect(line.type).toBe('info');
    expect(line.trpcType).toBe('mutation');
  });
});

/**
 * The REST `handleEndpointError` TRPCError branch gates the fault log on
 * `status >= 500 && status !== 503`. SERVICE_UNAVAILABLE (503) is the retryable
 * transient-upstream mapping that fires in high-volume waves and must NOT reach the
 * error stream. Replicate the gate predicate (like the merge-order test above).
 */
describe('REST handleEndpointError gate — 5xx logs, 503 + 4xx do not', () => {
  const restShouldLog = (e: TRPCError) => {
    const status = getHTTPStatusCodeFromError(e);
    return status >= 500 && status !== 503;
  };

  it('logs INTERNAL_SERVER_ERROR (500)', () => {
    expect(restShouldLog(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'x' }))).toBe(true);
  });

  it('does NOT log SERVICE_UNAVAILABLE (503) — the retryable-503 flood exclusion', () => {
    expect(restShouldLog(new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'x' }))).toBe(false);
  });

  it('does NOT log client-fault 4xx (NOT_FOUND → 404)', () => {
    expect(restShouldLog(new TRPCError({ code: 'NOT_FOUND', message: 'x' }))).toBe(false);
  });
});
