import { json } from '@sveltejs/kit';
import { createRedisReadiness } from '$lib/server/redis-readiness';
import { peekRedisClients } from '$lib/server/redis';
import type { RequestHandler } from './$types';

// Readiness probe. Unlike /api/health (liveness) it fails when a Redis client has stayed closed past the
// grace period, so a pod whose client is stuck leaves rotation instead of failing every Redis-backed
// request while it stays Ready. Never point the liveness probe here: a Redis outage would restart every pod.
const readiness = createRedisReadiness({ clients: peekRedisClients });

export const GET: RequestHandler = () => {
  const { ready } = readiness.check();
  return ready ? json({ status: 'ok' }) : json({ status: 'unavailable' }, { status: 503 });
};
