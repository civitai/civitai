import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
// Namespace import on purpose: on a tree without these exports each case fails on its own,
// by name, instead of the whole file failing to collect (which reads as "no tests").
import * as httpErrors from '~/server/prom/http-errors';

/**
 * The allowlisted-404 log skip for tRPC `onError`, and the counter that replaces the log line.
 *
 * The skip stays NARROW — only the exact (procedure path, code) pairs in the allowlist. A skip
 * that widened to every NOT_FOUND, or to every code on the procedure, would hide real
 * client-fault bugs across the API with nothing turning red.
 */

const PATH = 'image.getGenerationData';

const notFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'No generation data' });

type Sample = { value: number; labels: Record<string, string | number> };

async function samples(): Promise<Sample[]> {
  const metric = await httpErrors.trpcUnloggedClientErrorCounter.get();
  return metric.values as Sample[];
}

describe('shouldSkipExpectedNotFoundLog', () => {
  it('skips NOT_FOUND on image.getGenerationData', () => {
    expect(httpErrors.shouldSkipExpectedNotFoundLog(PATH, notFound())).toBe(true);
  });

  it.each([
    'image.get',
    'generation.getGenerationData',
    'image.getGenerationDataX',
    'getGenerationData',
  ])('does NOT skip NOT_FOUND on a different path (%s)', (path) => {
    expect(httpErrors.shouldSkipExpectedNotFoundLog(path, notFound())).toBe(false);
  });

  it.each(['INTERNAL_SERVER_ERROR', 'BAD_REQUEST', 'CONFLICT'] as const)(
    'does NOT skip %s on image.getGenerationData',
    (code) => {
      const error = new TRPCError({ code, message: 'boom' });
      expect(httpErrors.shouldSkipExpectedNotFoundLog(PATH, error)).toBe(false);
    }
  );

  it('does NOT skip when the path is undefined', () => {
    expect(httpErrors.shouldSkipExpectedNotFoundLog(undefined, notFound())).toBe(false);
  });

  it('does NOT skip a non-TRPCError, even one shaped like a NOT_FOUND', () => {
    expect(httpErrors.shouldSkipExpectedNotFoundLog(PATH, { code: 'NOT_FOUND' })).toBe(false);
    expect(httpErrors.shouldSkipExpectedNotFoundLog(PATH, new Error('NOT_FOUND'))).toBe(false);
    expect(httpErrors.shouldSkipExpectedNotFoundLog(PATH, undefined)).toBe(false);
  });
});

describe('recordUnloggedTrpcClientError', () => {
  it('counts nothing for a pair outside the allowlist (cardinality is the allowlist size)', async () => {
    const before = await samples();
    httpErrors.recordUnloggedTrpcClientError(notFound(), 'image.get');
    httpErrors.recordUnloggedTrpcClientError(new TRPCError({ code: 'BAD_REQUEST' }), PATH);
    httpErrors.recordUnloggedTrpcClientError(notFound(), undefined);
    expect(await samples()).toEqual(before);
  });

  it('never throws, whatever it is handed', () => {
    expect(() => httpErrors.recordUnloggedTrpcClientError(undefined, undefined)).not.toThrow();
    expect(() =>
      httpErrors.recordUnloggedTrpcClientError({ code: 'NOT_FOUND' }, PATH)
    ).not.toThrow();
  });
});
