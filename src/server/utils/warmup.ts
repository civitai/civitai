import { dbRead, dbWrite } from '~/server/db/client';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { redis, sysRedis } from '~/server/redis/client';

let warmedUp = false;

export function isWarmedUp() {
  return warmedUp;
}

export async function runWarmup() {
  const start = Date.now();
  console.log('[warmup] Starting...');

  await Promise.allSettled([
    // Prime Prisma connection pools
    dbRead.$queryRaw`SELECT 1`,
    dbWrite.$queryRaw`SELECT 1`,

    // Prime pg connection pools
    pgDbRead.query('SELECT 1'),
    pgDbWrite.query('SELECT 1'),

    // Ping Redis to establish topology
    (redis as any).ping(),
    (sysRedis as any).ping(),

    // Self-fetch a tRPC endpoint to JIT-compile the hot middleware chain
    fetch(
      'http://localhost:3000/api/trpc/homeBlock.getAll?input=' +
        encodeURIComponent(JSON.stringify({ json: {} }))
    ).catch(() => {}),

    // Pre-warm entity metrics cache
    import('~/server/redis/entity-metric-populate').then((m) =>
      m.preWarmEntityMetrics('Image', 1000)
    ),
  ]);

  warmedUp = true;
  console.log(`[warmup] Complete in ${Date.now() - start}ms`);
}
