import fs from 'fs';
import { dbRead, dbWrite } from '~/server/db/client';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { redis, sysRedis } from '~/server/redis/client';

const WARMUP_FLAG = '/tmp/warmup-complete';

export function isWarmedUp() {
  return fs.existsSync(WARMUP_FLAG);
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

    // Pre-warm entity metrics cache
    import('~/server/redis/entity-metric-populate').then((m) =>
      m.preWarmEntityMetrics('Image', 1000)
    ),
  ]);

  fs.writeFileSync(WARMUP_FLAG, String(Date.now()));
  console.log(`[warmup] Complete in ${Date.now() - start}ms`);
}
