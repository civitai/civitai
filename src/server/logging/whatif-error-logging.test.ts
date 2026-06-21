import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Tests for the whatIfFromGraph logging-hygiene fix.
 *
 * `orchestrator.router.ts:whatIfFromGraph` previously logged EVERY failure at
 * `type:'error'`, making it the largest error-by-name entry in prod even though
 * ~94% are expected client-fault validation (BAD_REQUEST). The fix branches on
 * the error's fault class via two pure helpers in `logging/client.ts`:
 *   - `classifyErrorFault`      → 'client' | 'server'
 *   - `buildServerFaultErrorLog`→ un-masks the underlying cause for server faults
 *
 * The global setup mocks `~/server/logging/client` wholesale, so we pull the
 * REAL implementations via `importActual` (env/prom remain mocked, which is fine —
 * these helpers only touch TRPCError shape, not env).
 */

const { classifyErrorFault, buildServerFaultErrorLog } = await vi.importActual<
  typeof import('./client')
>('./client');

// Mirror of errorHandling.ts `throwInternalServerError`: it rewrites the
// user-facing message to a generic string but PRESERVES the original error on
// `.cause`. Reproduced here (not imported) so the test asserts on the exact
// masking shape the router's catch block sees in prod.
function maskAsInternalServerError(original: Error): TRPCError {
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error ocurred, please try again later',
    cause: original,
  });
}

describe('classifyErrorFault', () => {
  const clientFaultCodes = [
    'BAD_REQUEST',
    'FORBIDDEN',
    'UNAUTHORIZED',
    'NOT_FOUND',
    'TOO_MANY_REQUESTS',
    'CONFLICT',
    'PRECONDITION_FAILED',
  ] as const;

  it.each(clientFaultCodes)('classifies TRPCError code %s as a client fault', (code) => {
    expect(classifyErrorFault(new TRPCError({ code, message: 'x' }))).toBe('client');
  });

  it('classifies INTERNAL_SERVER_ERROR as a server fault', () => {
    expect(classifyErrorFault(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'x' }))).toBe(
      'server'
    );
  });

  it('classifies TIMEOUT (not in the client set) as a server fault', () => {
    expect(classifyErrorFault(new TRPCError({ code: 'TIMEOUT', message: 'x' }))).toBe('server');
  });

  it('classifies a plain (non-TRPCError) thrown value as a server fault', () => {
    expect(classifyErrorFault(new Error('boom'))).toBe('server');
    expect(classifyErrorFault('a string')).toBe('server');
    expect(classifyErrorFault(undefined)).toBe('server');
  });
});

describe('buildServerFaultErrorLog — un-masks the underlying cause', () => {
  it('surfaces the original cause message/stack/code behind a masked INTERNAL_SERVER_ERROR', () => {
    const original = new Error('connect ECONNREFUSED 10.0.0.5:6379');
    (original as Error & { code?: string }).code = 'ECONNREFUSED';
    const masked = maskAsInternalServerError(original);

    const log = buildServerFaultErrorLog(masked);

    // The surfaced TRPCError fields are still present...
    expect(log.code).toBe('INTERNAL_SERVER_ERROR');
    expect(log.message).toBe('An unexpected error ocurred, please try again later');
    // ...AND the real failure is recovered from `.cause` (was hidden before the fix).
    expect(log.cause).toBeDefined();
    expect((log.cause as { message?: string }).message).toBe(
      'connect ECONNREFUSED 10.0.0.5:6379'
    );
    expect((log.cause as { code?: string }).code).toBe('ECONNREFUSED');
    expect((log.cause as { stack?: string }).stack).toBeTruthy();
  });

  it('logs a non-TRPCError directly with its real message + stack', () => {
    const log = buildServerFaultErrorLog(new Error('raw failure'));
    expect(log.message).toBe('raw failure');
    expect(log.stack).toBeTruthy();
  });
});

/**
 * End-to-end replication of the router's catch block. We reproduce the EXACT
 * wiring (classify → branch → log → re-throw) without importing the heavy
 * orchestrator router, and assert the observable logging + control flow.
 */
function whatIfCatchBlock(
  e: unknown,
  input: unknown,
  logToAxiom: (data: Record<string, unknown>) => Promise<void>
): never {
  if (classifyErrorFault(e) === 'client') {
    logToAxiom({
      name: 'what-if-from-graph',
      type: 'info',
      payload: input,
      error: e instanceof TRPCError ? { code: e.code, name: e.name, message: e.message } : e,
    }).catch(() => undefined);
  } else {
    logToAxiom({
      name: 'what-if-from-graph',
      type: 'error',
      payload: input,
      error: buildServerFaultErrorLog(e),
    }).catch(() => undefined);
  }
  throw e;
}

describe('whatIfFromGraph catch block — logging severity + re-throw', () => {
  it('BAD_REQUEST: NOT logged at error severity, logged at info, and still thrown', () => {
    const logToAxiom = vi.fn().mockResolvedValue(undefined);
    const err = new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Some of your resources are not available for generation: Foo',
    });

    expect(() => whatIfCatchBlock(err, { workflow: 'txt2img' }, logToAxiom)).toThrow(err);

    expect(logToAxiom).toHaveBeenCalledTimes(1);
    const logged = logToAxiom.mock.calls[0][0];
    expect(logged.type).toBe('info');
    expect(logged.type).not.toBe('error');
    expect(logged.name).toBe('what-if-from-graph');
    expect((logged.error as { code?: string }).code).toBe('BAD_REQUEST');
  });

  it('INTERNAL_SERVER_ERROR: logged at error severity WITH the un-masked cause, and still thrown', () => {
    const logToAxiom = vi.fn().mockResolvedValue(undefined);
    const original = new Error('Prisma P2024 connection pool timeout');
    const err = maskAsInternalServerError(original);

    expect(() => whatIfCatchBlock(err, { workflow: 'txt2img' }, logToAxiom)).toThrow(err);

    expect(logToAxiom).toHaveBeenCalledTimes(1);
    const logged = logToAxiom.mock.calls[0][0];
    expect(logged.type).toBe('error');
    expect((logged.error as { code?: string }).code).toBe('INTERNAL_SERVER_ERROR');
    // The masked message is generic, but the diagnosable cause is now present.
    expect((logged.error as { cause?: { message?: string } }).cause?.message).toBe(
      'Prisma P2024 connection pool timeout'
    );
  });

  it('non-TRPCError: logged at error severity with full stack, and still thrown', () => {
    const logToAxiom = vi.fn().mockResolvedValue(undefined);
    const err = new Error('unexpected throw');

    expect(() => whatIfCatchBlock(err, {}, logToAxiom)).toThrow(err);

    expect(logToAxiom).toHaveBeenCalledTimes(1);
    const logged = logToAxiom.mock.calls[0][0];
    expect(logged.type).toBe('error');
    expect((logged.error as { message?: string }).message).toBe('unexpected throw');
    expect((logged.error as { stack?: string }).stack).toBeTruthy();
  });
});
