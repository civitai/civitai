import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// getBlocklistData -> getBlocklistDTO reads redis.get first and, when a cached
// value is present, returns it WITHOUT touching the DB. So stubbing redis.get to
// return a JSON blocklist is enough to drive throwOnBlockedLinkDomain end-to-end.
const { redisGet } = vi.hoisted(() => ({ redisGet: vi.fn() }));

vi.mock('~/server/redis/client', () => ({
  redis: { get: redisGet, set: vi.fn() },
  REDIS_KEYS: { SYSTEM: { BLOCKLIST: 'system:blocklist' } },
}));
vi.mock('~/server/db/client', () => ({
  dbWrite: { blocklist: { findFirst: vi.fn(), findUnique: vi.fn() } },
}));

import { throwOnBlockedLinkDomain } from '../blocklist.service';
import { BlocklistType } from '~/server/common/enums';

/** Make getBlocklistData return the given domains (already lower-cased in prod). */
function setBlockedDomains(domains: string[]) {
  redisGet.mockResolvedValue(
    JSON.stringify({ type: BlocklistType.LinkDomain, data: domains })
  );
}

describe('throwOnBlockedLinkDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a blocked link domain as a BAD_REQUEST TRPCError (400), not a 500', async () => {
    setBlockedDomains(['bit.ly']);

    let caught: unknown;
    try {
      await throwOnBlockedLinkDomain('check this out https://bit.ly/m/abc123');
    } catch (e) {
      caught = e;
    }

    // Must be a tRPC BAD_REQUEST — NOT a plain Error (which tRPC maps to
    // INTERNAL_SERVER_ERROR / HTTP 500). This is the regression guard.
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe('BAD_REQUEST');
    expect((caught as Error).message).toContain('invalid urls: https://bit.ly/m/abc123');
  });

  it('does not throw when all link domains are allowed', async () => {
    setBlockedDomains(['bit.ly']);

    await expect(
      throwOnBlockedLinkDomain('see https://civitai.com/models/123 and https://example.com/x')
    ).resolves.toBeUndefined();
  });

  it('does not throw when there are no links at all', async () => {
    setBlockedDomains(['bit.ly']);

    await expect(throwOnBlockedLinkDomain('just some plain text')).resolves.toBeUndefined();
  });

  it('does not raise a raw TypeError on a malformed-but-regex-matching URL', async () => {
    setBlockedDomains(['bit.ly']);

    // An invalid IPv4 octet (256): the link regex matches it, but `new URL()`
    // rejects it with a raw TypeError. Pre-fix, that TypeError escaped as a 500 on
    // user input. The guard must swallow it; it maps to no blocked host, so the
    // call resolves without throwing.
    await expect(throwOnBlockedLinkDomain('spam http://1.1.1.256/x')).resolves.toBeUndefined();
  });
});
