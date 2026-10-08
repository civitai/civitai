import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
// Namespace import on purpose: on a tree without these exports each case fails on its own,
// by name, instead of the whole file failing to collect (which reads as "no tests").
import * as httpErrors from '~/server/prom/http-errors';

/**
 * The allowlisted-404 log skip for tRPC `onError`, and the counter that replaces the log line.
 *
 * Two properties, each of which fails silently if lost:
 *  1. The skip stays NARROW — only the exact (procedure path, code) pairs in the allowlist. A
 *     skip that widened to every NOT_FOUND, or to every code on the procedure, would hide real
 *     client-fault bugs across the API with nothing turning red.
 *  2. A skipped error is still COUNTED. `recordTrpcError` counts only >= 500, so once the log
 *     line is gone this counter is the only remaining record of these 404s; without it their
 *     rate could never be re-derived.
 */

const PATH = 'image.getGenerationData';
const COUNTER_NAME = 'civitai_app_trpc_unlogged_client_errors_total';

const notFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'No generation data' });

type Sample = { value: number; labels: Record<string, string | number> };

async function samples(): Promise<Sample[]> {
  const metric = await httpErrors.trpcUnloggedClientErrorCounter.get();
  return metric.values as Sample[];
}

async function countFor(path: string, code: string): Promise<number | undefined> {
  return (await samples()).find((s) => s.labels.path === path && s.labels.code === code)?.value;
}

describe('shouldSkipExpectedNotFoundLog', () => {
  it('pins the allowlist to exactly one pair: image.getGenerationData / NOT_FOUND', () => {
    // Adding a second allowlisted-404 procedure is meant to be a one-line change — and this is the
    // line that makes the reviewer see it.
    expect(httpErrors.EXPECTED_NOT_FOUND_LOG_SKIPS).toEqual([{ path: PATH, code: 'NOT_FOUND' }]);
  });

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
  it(`registers ${COUNTER_NAME} with labels (path, code), seeded at 0 per allowlisted pair`, async () => {
    const metric = await httpErrors.trpcUnloggedClientErrorCounter.get();
    expect(metric.name).toBe(COUNTER_NAME);
    // Present BEFORE any increment, so "zero skipped 404s" reads as 0 rather than `no data`.
    // (>= 0 rather than === 0: another case in this file may already have incremented it.)
    for (const { path, code } of httpErrors.EXPECTED_NOT_FOUND_LOG_SKIPS) {
      expect(await countFor(path, code)).toBeGreaterThanOrEqual(0);
    }
  });

  it('increments by exactly 1 for a skipped image.getGenerationData NOT_FOUND', async () => {
    const before = (await countFor(PATH, 'NOT_FOUND')) ?? 0;
    httpErrors.recordUnloggedTrpcClientError(notFound(), PATH);
    expect(await countFor(PATH, 'NOT_FOUND')).toBe(before + 1);
  });

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
