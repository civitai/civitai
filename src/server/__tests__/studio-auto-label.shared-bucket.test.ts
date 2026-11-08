import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';

/**
 * The standalone Studio's auto-label endpoint and the embed's tRPC procedures must draw from ONE
 * per-minute bucket per user, or a user gets each limit twice. Asserted on the writes themselves:
 * an attempt the middleware records lands where the endpoint's helper reads, and the reverse.
 * Harness as in `middleware.trpc.rate-limit-key.test.ts`; `~/env/other` is mocked to production, or
 * both sides short-circuit on `isTest` and nothing here runs.
 */

const { mockHSetWithTTL, captured } = vi.hoisted(() => ({
  mockHSetWithTTL: vi.fn(),
  captured: { handler: null as ((arg: unknown) => Promise<unknown>) | null },
}));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: mockHSetWithTTL }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/trpc', () => ({
  middleware: (fn: (arg: unknown) => Promise<unknown>) => {
    captured.handler = fn;
    return fn;
  },
}));
vi.mock('~/server/services/user-preferences.service', () => ({ getAllHiddenForUser: vi.fn() }));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn() }));
vi.mock('~/server/utils/server-domain', () => ({
  getRequestDomainColor: vi.fn(() => 'blue'),
  getRequestBoardDomainColor: vi.fn(() => 'blue'),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
    NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT: 'https://orchestration.civitai.com',
  },
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { rateLimit } from '~/server/middleware.trpc';
import { STUDIO_AUTO_LABEL_RATE_LIMITS } from '~/server/services/training-studio-auto-label.service';
import { claimRateLimitAttempt } from '~/server/utils/rate-limit-bucket';

const user = { id: 7, isModerator: false } as never;
const req = { headers: {}, socket: { remoteAddress: '10.0.0.1' } } as unknown as NextApiRequest;

// The procedures in training.router.ts rate-limit with STUDIO_AUTO_LABEL_RATE_LIMITS (rules and
// sharedKey); that wiring is tested in training.router.studio-auto-label-limit.test.ts.
const PROCEDURE_PATHS = {
  submit: 'training.studioAutoLabelSubmit',
  poll: 'training.studioAutoLabelPoll',
} as const;

async function procedureAttempt(which: keyof typeof PROCEDURE_PATHS) {
  rateLimit(STUDIO_AUTO_LABEL_RATE_LIMITS[which].rules, undefined, {
    sharedKey: STUDIO_AUTO_LABEL_RATE_LIMITS[which].key,
  });
  await captured.handler!({
    ctx: { user, req },
    input: {},
    path: PROCEDURE_PATHS[which],
    next: async () => ({ ok: true }),
  });
  const [, cacheKey, hashKey] = mockHSetWithTTL.mock.calls.at(-1)!;
  return { cacheKey, hashKey };
}

async function endpointAttempt(which: keyof typeof PROCEDURE_PATHS) {
  const limit = STUDIO_AUTO_LABEL_RATE_LIMITS[which];
  const record = await claimRateLimitAttempt({ rules: limit.rules, keyName: limit.key, user, req });
  await record();
  const [, cacheKey, hashKey] = mockHSetWithTTL.mock.calls.at(-1)!;
  return { cacheKey, hashKey };
}

describe("the standalone auto-label endpoint shares the embed procedures' buckets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.redis.packed.hGet.mockResolvedValue([]);
    mockHSetWithTTL.mockResolvedValue(undefined);
  });

  it.each(['submit', 'poll'] as const)('a %s is recorded in the same bucket', async (which) => {
    const embed = await procedureAttempt(which);
    const standalone = await endpointAttempt(which);
    expect(standalone).toEqual(embed);
    expect(embed.cacheKey).toContain(PROCEDURE_PATHS[which].replace('.', ':'));
    // Positive control: the harness can tell two buckets apart.
    expect(await endpointAttempt(which === 'submit' ? 'poll' : 'submit')).not.toEqual(embed);
  });

  it.each(['submit', 'poll'] as const)(
    'a %s limit spent on the embed refuses the endpoint',
    async (which) => {
      const [{ limit }] = STUDIO_AUTO_LABEL_RATE_LIMITS[which].rules;
      redisMock.redis.packed.hGet.mockResolvedValue(Array(limit).fill(Date.now()));
      await expect(endpointAttempt(which)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      redisMock.redis.packed.hGet.mockResolvedValue(Array(limit - 1).fill(Date.now()));
      await expect(endpointAttempt(which)).resolves.toBeDefined();
    }
  );
});
