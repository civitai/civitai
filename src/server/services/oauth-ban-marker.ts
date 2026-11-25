import { banDisabledMarkKey } from '@civitai/auth/ban-disabled-mark';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { redis } from '~/server/redis/client';

// Which disabled OAuth clients a BAN disabled. `accessMode: 'disabled'` alone cannot say: staff also
// disable clients, and a re-enable must never undo that. So the ban marks each self-only client it
// disabled, with the mode it had, and only a marked client is ever re-opened. The mark lives on the
// cache Redis; a lost mark, or one that cannot be read (read as "no mark"), fails closed: the client
// stays disabled until staff re-open it.

const BAN_DISABLED_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * The modes a re-open may restore. A mark holding anything else (garbled, or a mode a ban never
 * leaves behind) re-opens nothing.
 */
const RESTORABLE_MODES = new Set(['open', 'testers']);

const markKey = banDisabledMarkKey;

/** Marks clients as disabled by a ban, each with the mode it had. Call only AFTER the disable. */
export async function markBanDisabledClients(
  clients: { id: string; priorMode: string }[]
): Promise<void> {
  await Promise.all(
    clients.map(({ id, priorMode }) =>
      redis.set(markKey(id), priorMode, { EX: BAN_DISABLED_TTL_SECONDS })
    )
  );
}

/**
 * Re-opens `clientId` if, and only if, a ban disabled it, restoring the mode it had then.
 *
 * - The mark is CONSUMED before the database write: only the caller whose delete removed it goes
 *   on, so a staff mode change (which deletes it) or a concurrent re-open wins.
 * - The write is one conditional UPDATE: the client must still be disabled and its owner must not
 *   be banned. A ban that landed after the caller's own ban check therefore re-opens nothing, and
 *   the mark is put back so the client can be re-opened after that ban is lifted.
 * - A Redis error is "no mark": it is logged and nothing is re-opened, and the caller's enable or
 *   mint goes on.
 *
 * Returns whether it re-opened the client.
 */
export async function reopenBanDisabledClient(clientId: string): Promise<boolean> {
  let priorMode: string | null;
  try {
    priorMode = await redis.get(markKey(clientId));
    if (priorMode === null) return false;
    if ((await redis.del(markKey(clientId))) !== 1) return false;
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'oauth-ban-marker',
      message: `ban-disabled mark unreadable for ${clientId}; not re-opening: ${
        (error as Error)?.message
      }`,
    });
    return false;
  }
  if (!RESTORABLE_MODES.has(priorMode)) return false;

  const reopened = await dbWrite.$executeRaw`
    UPDATE "OauthClient" c
    SET "accessMode" = ${priorMode}
    WHERE c."id" = ${clientId}
      AND c."accessMode" = 'disabled'
      AND EXISTS (SELECT 1 FROM "User" u WHERE u."id" = c."userId" AND u."bannedAt" IS NULL)
  `;
  if (reopened > 0) return true;

  // Not re-opened. If the owner is banned again, keep the mark for after that ban.
  const [owner] = await dbWrite.$queryRaw<{ banned: boolean }[]>`
    SELECT (u."bannedAt" IS NOT NULL) AS "banned"
    FROM "OauthClient" c JOIN "User" u ON u."id" = c."userId"
    WHERE c."id" = ${clientId} AND c."accessMode" = 'disabled'
  `;
  if (owner?.banned)
    await markBanDisabledClients([{ id: clientId, priorMode }]).catch(() => undefined);
  return false;
}
