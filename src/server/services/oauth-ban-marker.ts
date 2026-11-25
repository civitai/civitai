import { dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';

/**
 * Which disabled OAuth clients a BAN disabled. `accessMode: 'disabled'` alone cannot say: staff
 * also disable clients (the hub's access page), and a re-enable must never undo that. So the ban
 * leg marks each self-only client it disables, and the re-enable paths (`enableAppAssistant`, the
 * dev-tunnel mint, both behind their own gates) re-open a client only while it carries the mark.
 *
 * The mark lives on the cache Redis with a year's TTL. Losing it fails closed: the client stays
 * disabled until staff re-open it.
 */
const BAN_DISABLED_TTL_SECONDS = 365 * 24 * 60 * 60;

const markKey = (clientId: string) =>
  `${REDIS_KEYS.OAUTH.BAN_DISABLED}:${clientId}` as RedisKeyTemplateCache;

/** Marks `clientIds` as disabled by a ban. Call BEFORE disabling them. */
export async function markBanDisabledClients(clientIds: string[]): Promise<void> {
  await Promise.all(
    clientIds.map((id) => redis.set(markKey(id), '1', { EX: BAN_DISABLED_TTL_SECONDS }))
  );
}

/**
 * Re-opens `clientId` if, and only if, a ban disabled it: `accessMode` back to 'open' (only from
 * 'disabled'), then the mark is cleared. A client with no mark is not touched, whatever its mode.
 * Returns whether it re-opened the client.
 */
export async function reopenBanDisabledClient(clientId: string): Promise<boolean> {
  if (!(await redis.exists(markKey(clientId)))) return false;
  await dbWrite.oauthClient.updateMany({
    where: { id: clientId, accessMode: 'disabled' },
    data: { accessMode: 'open' },
  });
  await redis.del(markKey(clientId));
  return true;
}
