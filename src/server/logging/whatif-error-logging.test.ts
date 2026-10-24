import { describe, expect, it, vi } from 'vitest';

/**
 * classifyErrorFault's non-TRPCError arms. The TRPCError codes and buildServerFaultErrorLog
 * are covered through buildCentralErrorLog in central-error-log.test.ts.
 *
 * The global setup mocks `~/server/logging/client` wholesale, so we pull the REAL
 * implementation via `importActual`.
 */

const { classifyErrorFault } = await vi.importActual<typeof import('./client')>('./client');

describe('classifyErrorFault', () => {
  it('classifies a plain (non-TRPCError) thrown value as a server fault', () => {
    expect(classifyErrorFault(new Error('boom'))).toBe('server');
    expect(classifyErrorFault('a string')).toBe('server');
    expect(classifyErrorFault(undefined)).toBe('server');
  });
});
