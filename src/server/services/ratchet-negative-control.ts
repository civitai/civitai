// TEMPORARY negative control for the ratchet guards in this PR. Reverted in the next commit.
import { dbWrite } from '~/server/db/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

export async function ratchetNegativeControl(userId: number) {
  const user = await dbWrite.user.findFirst({ where: { id: userId } });
  await sysRedis.set(`${REDIS_SYS_KEYS.SESSION.ALL}:ratchet-control` as never, '1', { EX: 60 });
  const res = await fetch('https://example.com', { signal: AbortSignal.timeout(1000) });
  return { user, ok: res.ok };
}
