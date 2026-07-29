import type { NextApiRequest } from 'next';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit coverage for the public REST articles/collections rate limiter
 * (checkPublicApiRateLimit + resolveClientIp). The security-relevant contract:
 * the unauthenticated bucket is keyed on the Cloudflare-trusted
 * `CF-Connecting-IP` header (not the client-spoofable raw `X-Forwarded-For`
 * chain), so a caller can't rotate XFF to escape their per-IP window. The authed
 * bucket is keyed on the userId regardless of any header.
 *
 * The redis cache client is mocked so no real connection is constructed.
 */

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    incrBy: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  },
}));

vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
}));

import {
  checkPublicApiRateLimit,
  resolveClientIp,
  PUBLIC_API_RATE_LIMIT_AUTH_MAX,
  PUBLIC_API_RATE_LIMIT_UNAUTH_MAX,
} from '../public-api-rate-limit';

function reqWith(headers: Record<string, string | string[]>): NextApiRequest {
  return { headers } as unknown as NextApiRequest;
}

// The key redis.incrBy was called with (the full bucket key).
function lastKey(): string {
  const calls = mockRedis.incrBy.mock.calls;
  return calls[calls.length - 1][0] as string;
}

describe('resolveClientIp', () => {
  it('prefers CF-Connecting-IP over X-Forwarded-For', () => {
    const ip = resolveClientIp(
      reqWith({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' })
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('takes the first element when cf-connecting-ip is an array + trims whitespace', () => {
    const ip = resolveClientIp(reqWith({ 'cf-connecting-ip': [' 203.0.113.9 ', '5.5.5.5'] }));
    expect(ip).toBe('203.0.113.9');
  });

  it('falls back to X-Forwarded-For when there is no CF header (non-CF / local)', () => {
    const ip = resolveClientIp(reqWith({ 'x-forwarded-for': '198.51.100.1' }));
    expect(ip).toBe('198.51.100.1');
  });
});

describe('checkPublicApiRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.incrBy.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(true);
    mockRedis.ttl.mockResolvedValue(60);
  });

  it('unauth: keys the bucket on CF-Connecting-IP, not the raw XFF', async () => {
    await checkPublicApiRateLimit({
      req: reqWith({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' }),
      family: 'articles',
    });
    const key = lastKey();
    expect(key).toContain('ip:203.0.113.7');
    expect(key).not.toContain('1.2.3.4');
  });

  it('SECURITY: two requests with different injected XFF but the SAME CF-Connecting-IP share one bucket', async () => {
    await checkPublicApiRateLimit({
      req: reqWith({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1' }),
      family: 'articles',
    });
    const keyA = lastKey();
    await checkPublicApiRateLimit({
      req: reqWith({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.99' }),
      family: 'articles',
    });
    const keyB = lastKey();
    expect(keyA).toBe(keyB);
  });

  it('each family gets its own bucket for the same client IP', async () => {
    const headers = { 'cf-connecting-ip': '203.0.113.7' };
    await checkPublicApiRateLimit({ req: reqWith(headers), family: 'articles' });
    const articlesKey = lastKey();
    await checkPublicApiRateLimit({ req: reqWith(headers), family: 'collections' });
    const collectionsKey = lastKey();
    expect(articlesKey).not.toBe(collectionsKey);
    expect(articlesKey).toContain('articles');
    expect(collectionsKey).toContain('collections');
  });

  it('authed: keys on the userId and ignores the client IP header entirely', async () => {
    await checkPublicApiRateLimit({
      req: reqWith({ 'cf-connecting-ip': '203.0.113.7' }),
      family: 'articles',
      userId: 42,
    });
    const key = lastKey();
    expect(key).toContain('user:42');
    expect(key).not.toContain('203.0.113.7');
  });

  it('over the ceiling → not allowed + Retry-After = live TTL', async () => {
    mockRedis.incrBy.mockResolvedValue(PUBLIC_API_RATE_LIMIT_UNAUTH_MAX + 1);
    mockRedis.ttl.mockResolvedValue(9);
    const res = await checkPublicApiRateLimit({
      req: reqWith({ 'cf-connecting-ip': '203.0.113.7' }),
      family: 'articles',
    });
    expect(res).toEqual({ allowed: false, retryAfterSeconds: 9 });
  });

  it('authed callers get the higher ceiling (still allowed at the unauth max + 1)', async () => {
    mockRedis.incrBy.mockResolvedValue(PUBLIC_API_RATE_LIMIT_UNAUTH_MAX + 1);
    const res = await checkPublicApiRateLimit({
      req: reqWith({ 'cf-connecting-ip': '203.0.113.7' }),
      family: 'articles',
      userId: 42,
    });
    expect(PUBLIC_API_RATE_LIMIT_AUTH_MAX).toBeGreaterThan(PUBLIC_API_RATE_LIMIT_UNAUTH_MAX);
    expect(res).toEqual({ allowed: true });
  });

  it('redis error → FAIL OPEN (allowed)', async () => {
    mockRedis.incrBy.mockRejectedValue(new Error('redis down'));
    const res = await checkPublicApiRateLimit({
      req: reqWith({ 'cf-connecting-ip': '203.0.113.7' }),
      family: 'articles',
    });
    expect(res).toEqual({ allowed: true });
  });
});
