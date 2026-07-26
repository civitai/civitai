import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

/**
 * Abuse-control rate limiter for the PUBLIC app-catalog read endpoints
 * (`GET /api/v1/apps` + `GET /api/v1/apps/{slug}`).
 *
 * Mirrors the counter shape of the sibling `/api/v1/blocks/submissions` limiter
 * (atomic `SET NX EX` + `INCR` MULTI on `sysRedis`) and the 60/60 window the
 * tRPC marketplace procs carry — keyed on the authenticated user id when a
 * bearer is present (`u:<id>`, the stable identity) and the client IP otherwise
 * (`ip:<addr>`, the anon fallback).
 *
 * DELIBERATE DIVERGENCE from the submissions limiter: these are PUBLIC, edge-
 * cacheable READ endpoints, so a Redis blip should NOT turn a catalog browse
 * into a 503 wall — this limiter FAILS OPEN (serves the request) on a limiter
 * error/malformed result, trading a transient loss of abuse-control for
 * availability. The submissions read fails CLOSED because it is a private,
 * un-cached, per-user surface. (The security gate for these endpoints is the
 * visibility SCOPE, not the rate limit.)
 *
 * Returns `true` when the request was rate-limited and a `429` has already been
 * written to `res` (the caller must stop); `false` when the caller should
 * proceed.
 */

const RATE_LIMIT = { max: 60, windowSeconds: 60 } as const;

function clientIp(req: NextApiRequest): string {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff?.split(',')[0];
  return (first ?? req.socket?.remoteAddress ?? 'unknown').trim();
}

type LimiterLog = { warn?: (message: string, meta?: Record<string, unknown>) => void };

export async function enforceAppsCatalogRateLimit({
  req,
  res,
  user,
  log,
}: {
  req: NextApiRequest;
  res: NextApiResponse;
  user: SessionUser | undefined;
  log?: LimiterLog;
}): Promise<boolean> {
  const rateSubject = user?.id ? `u:${user.id}` : `ip:${clientIp(req)}`;
  const rateKey = `${REDIS_SYS_KEYS.BLOCKS.APPS_CATALOG_RATE_LIMIT}:${rateSubject}` as const;

  let count: number;
  try {
    const multiResult = await sysRedis
      .multi()
      .set(rateKey, '0', { NX: true, EX: RATE_LIMIT.windowSeconds })
      .incr(rateKey)
      .exec();
    count = Number(multiResult?.[1]);
  } catch (err) {
    // PUBLIC read → fail OPEN (availability over abuse-control on a Redis incident).
    log?.warn?.('apps-catalog: rate limiter threw; failing open', { rateSubject });
    return false;
  }

  if (!Number.isFinite(count)) {
    log?.warn?.('apps-catalog: rate-limit counter malformed; failing open', { rateSubject });
    return false;
  }

  // Self-heal a TTL-less key (re-arm only when the TTL is actually missing, so an
  // active window is never extended) — same footgun guard as the sibling limiters.
  if (count > 1) {
    const ttl = await sysRedis.ttl(rateKey).catch(() => -1);
    if (ttl < 0) await sysRedis.expire(rateKey, RATE_LIMIT.windowSeconds).catch(() => {});
  }

  if (count > RATE_LIMIT.max) {
    const retryAfter = await sysRedis.ttl(rateKey).catch(() => RATE_LIMIT.windowSeconds);
    res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
    res.status(429).json({
      message: 'Rate limit exceeded',
      retryAfterSeconds: retryAfter,
      limit: RATE_LIMIT.max,
      windowSeconds: RATE_LIMIT.windowSeconds,
    });
    return true;
  }

  return false;
}
