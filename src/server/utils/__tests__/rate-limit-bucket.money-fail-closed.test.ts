import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { TRPCError } from '@trpc/server';
import type { NextApiRequest } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Money and generation procedures stay FAIL-CLOSED when the rate limiter's store is unavailable.
 *
 * The per-process fallback count (rate-limit-bucket.store-down.test.ts) keeps ordinary procedures
 * working through a cache outage. For buzz, payment and generation/orchestrator procedures the
 * operator's call is the opposite: refuse with a clear 503 (SERVICE_UNAVAILABLE — never a 500)
 * rather than admit on a count the store cannot confirm. The decision is made from the PROCEDURE'S
 * router (its tRPC path), never from a sharedKey, so a money procedure cannot escape it by sharing a
 * bucket with a non-money key.
 */

vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn() }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/trpc', () => ({ middleware: (fn: unknown) => fn }));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn() }));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: vi.fn().mockResolvedValue({}),
}));

import { hSetWithTTL } from '~/server/redis/atomic';
import { rateLimit } from '~/server/middleware.trpc';
import * as bucket from '~/server/utils/rate-limit-bucket';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { claimRateLimitAttempt } = bucket;
const hGet = redisMock.redis.packed.hGet;
const HUNG = Symbol('hung');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);

let ipCounter = 0;
const freshReq = () =>
  ({
    headers: { 'cf-connecting-ip': `198.51.100.${++ipCounter}` },
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as NextApiRequest);

const RULES = [{ limit: 3, period: 60 }];

async function claim(keyName: string, scope?: string) {
  const record = await claimRateLimitAttempt({
    rules: RULES,
    keyName,
    scope,
    user: undefined,
    req: freshReq(),
  } as Parameters<typeof claimRateLimitAttempt>[0]);
  await record();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hSetWithTTL).mockResolvedValue(undefined as never);
});

const MONEY_SCOPES = ['buzz', 'nowPayments', 'generation', 'orchestrator', 'remixApp', 'training'];

describe('claimRateLimitAttempt, money scopes, store unavailable', () => {
  it.each(MONEY_SCOPES)('%s: a rejecting store refuses the first attempt with a 503', async (s) => {
    hGet.mockRejectedValue(new Error('cluster down'));
    const err = await claim(`${s}:someProcedure`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('a store that never answers refuses with a 503 within 750ms', async () => {
    hGet.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const err = await within(
      claim('buzz:getUserAccount').catch((e: unknown) => e),
      2000
    );
    expect(Date.now() - started).toBeLessThan(750);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('the scope decides, not the bucket key: a money procedure sharing a non-money key still fails closed', async () => {
    hGet.mockRejectedValue(new Error('cluster down'));
    const err = await claim('post:shared-bucket', 'orchestrator.getBoostCost').catch(
      (e: unknown) => e
    );
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('positive control: a non-money procedure is admitted on the per-process count', async () => {
    hGet.mockRejectedValue(new Error('cluster down'));
    await expect(claim('post:create', 'post.create')).resolves.toBeUndefined();
  });

  it('a healthy store still admits a money procedure', async () => {
    hGet.mockResolvedValue([]);
    await expect(claim('buzz:getUserAccount')).resolves.toBeUndefined();
  });
});

describe('rateLimit middleware passes the procedure path as the scope', () => {
  it('a buzz procedure on a shared non-money key fails closed with a 503', async () => {
    hGet.mockRejectedValue(new Error('cluster down'));
    const mw = rateLimit(RULES, undefined, { sharedKey: 'post:shared-bucket' }) as unknown as (
      opts: unknown
    ) => Promise<unknown>;
    const next = vi.fn().mockResolvedValue({ ok: true });
    const err = await mw({
      ctx: { user: undefined, req: freshReq() },
      input: {},
      next,
      path: 'buzz.claimDailyBoostReward',
    }).catch((e: unknown) => e);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect(next).not.toHaveBeenCalled();
  });
});

/**
 * LEDGER. Every router module that rate-limits a procedure must be classified, by its tRPC router
 * key, as fail-closed or fallback. The set is asserted in both directions: a new router that starts
 * rate-limiting (a new payment provider, say) fails here until someone decides which it is, and a
 * classified router that stops rate-limiting fails too, so the lists never rot into reassurance.
 * Procedures added to a fail-closed router inherit fail-closed with no further step.
 */
describe('rate-limit fail-closed ledger', () => {
  const routersDir = path.resolve(__dirname, '../../routers');
  const indexSrc = readFileSync(path.join(routersDir, 'index.ts'), 'utf8');
  const keyByFile = new Map<string, string>();
  for (const m of indexSrc.matchAll(/^\s+([a-zA-Z0-9]+): \(\) =>\s*import\('([^']+)'\)/gm)) {
    keyByFile.set(path.basename(m[2]), m[1]);
  }

  function rateLimitedRouterFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' ? [] : rateLimitedRouterFiles(full);
      if (!e.name.endsWith('.ts')) return [];
      return /\brateLimit\(/.test(readFileSync(full, 'utf8')) ? [full] : [];
    });
  }

  it('can see the routers it classifies (positive control)', () => {
    expect(keyByFile.get('buzz.router')).toBe('buzz');
    expect(keyByFile.size).toBeGreaterThan(50);
  });

  it('classifies every rate-limiting router exactly once', () => {
    const files = rateLimitedRouterFiles(routersDir);
    const unmapped = files.filter((f) => !keyByFile.has(path.basename(f, '.ts')));
    expect(unmapped).toEqual([]);
    const keys = new Set(files.map((f) => keyByFile.get(path.basename(f, '.ts'))));

    const closed = new Set(bucket.FAIL_CLOSED_RATE_LIMIT_SCOPES);
    const fallback = new Set(bucket.RATE_LIMIT_FALLBACK_SCOPES);
    expect([...closed].filter((k) => fallback.has(k))).toEqual([]);
    // REST callers draw from a procedure's bucket under its router key, so they classify there too.
    expect(new Set([...closed, ...fallback])).toEqual(keys);
  });

  it('keeps buzz, payments and generation fail-closed', () => {
    expect([...bucket.FAIL_CLOSED_RATE_LIMIT_SCOPES].sort()).toEqual([...MONEY_SCOPES].sort());
  });
});
