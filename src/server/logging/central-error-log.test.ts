import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Tests for `buildCentralErrorLog` — the payload builder shared by the two central
 * 500-emitting chokepoints (the tRPC `onError` handler in
 * `src/pages/api/trpc/[trpc].ts` and the REST `handleEndpointError` in
 * `endpoint-helpers.ts`). It generalizes the per-router pattern in
 * `orchestrator.router.ts` so EVERY unexpected 500 becomes self-describing:
 *   - server fault → `level:'error'` + the UN-MASKED `.cause` chain
 *   - client fault → `level:'info'` + the light `safeError` shape
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

describe('buildCentralErrorLog — server faults get level:error WITH the un-masked cause', () => {
  it('un-masks a masked INTERNAL_SERVER_ERROR and tags level:error', () => {
    const original = new Error('Prisma P2024 connection pool timeout');
    (original as Error & { code?: string }).code = 'P2024';
    const entry = buildCentralErrorLog(maskAsInternalServerError(original));

    expect(entry.level).toBe('error');
    expect(entry.code).toBe('INTERNAL_SERVER_ERROR');
    // The diagnosable cause is recovered from `.cause` (the whole point).
    expect((entry.cause as { message?: string }).message).toBe(
      'Prisma P2024 connection pool timeout'
    );
    expect((entry.cause as { code?: string }).code).toBe('P2024');
    expect((entry.cause as { stack?: string }).stack).toBeTruthy();
  });

  it('logs a non-TRPCError at level:error with its real message + stack', () => {
    const entry = buildCentralErrorLog(new Error('unexpected throw'));
    expect(entry.level).toBe('error');
    expect(entry.message).toBe('unexpected throw');
    expect(entry.stack).toBeTruthy();
  });

  it('classifies TIMEOUT (not a client-fault code) as a server fault → level:error', () => {
    const entry = buildCentralErrorLog(new TRPCError({ code: 'TIMEOUT', message: 'x' }));
    expect(entry.level).toBe('error');
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

  it.each(clientFaultCodes)('tags %s as level:info (never error), preserving the code', (code) => {
    const entry = buildCentralErrorLog(new TRPCError({ code, message: 'x' }));
    expect(entry.level).toBe('info');
    expect(entry.level).not.toBe('error');
    expect(entry.code).toBe(code);
  });

  it('does NOT walk a cause chain for a client fault (stays the light safeError shape)', () => {
    const err = new TRPCError({
      code: 'BAD_REQUEST',
      message: 'bad input',
      cause: new Error('should-not-be-unmasked'),
    });
    const entry = buildCentralErrorLog(err);
    expect(entry.level).toBe('info');
    // The server-fault-only un-masked `.cause` object must be absent; only the
    // light `causeMessage` string from safeError may appear.
    expect(entry.cause).toBeUndefined();
  });
});
