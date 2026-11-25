import { Prisma } from '@prisma/client';
import { isSelfOnlyClientFor } from '@civitai/auth/self-only-client';
import { constants } from '~/server/common/constants';
import { notifyModAlert } from '~/server/common/mod-alert';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { expireClientTokens } from '~/server/services/api-key.service';
import { revokeCivitaiUserTokens } from '~/server/services/orchestrator/civitai';
import { APP_BLOCK_OAUTH_CLIENT_ID_PREFIX } from '~/shared/constants/block-scope.constants';

/**
 * What a BAN takes away from the account's OAuth apps and app access. Called by `toggleBan`.
 *
 * A LEAF on purpose: `user.service` sits in the image.service import cycle, so this module must not
 * import anything that leads back into it (no service graph behind it).
 */

export type OauthBanCleanup = {
  /** Self-only clients this run disabled. */
  disabled: string[];
  /** Other clients the account owns, left as they are and flagged for a moderator. */
  flagged: string[];
  /** Consents the account gave that this run deleted. */
  consents: number;
  /** Whether the moderator flag reached the moderator channel (`null` when nothing was flagged). */
  flagDelivery: string | null;
};

/**
 * The OAuth leg of a ban.
 *
 * - SELF-ONLY clients the account owns (`isSelfOnlyClientFor`: its App Assistant and dev-tunnel
 *   clients, which nobody else uses) are disabled (`accessMode: 'disabled'`, refused by the auth hub
 *   at authorize, token exchange, the `app-token` mint and introspection), the live tokens issued
 *   under them are expired, and every user who held one is revoked at the orchestrator, as deleting
 *   a client does. An unban leaves them disabled; turning App Assistant on again, or the next
 *   dev-tunnel mint, re-opens them once those gates pass.
 * - EVERY OTHER client the account owns is a third-party app other people may rely on: it is NOT
 *   disabled and its users keep their tokens. It is flagged for a moderator to decide, on the
 *   moderator alert channel and in the logs. App Block clients (`appblk-…`) are neither: the App
 *   Blocks ban handling suspends and restores them with the ban.
 * - Every consent the account GAVE, except to App Block clients, is deleted, so no app can mint a
 *   token for it from a consent given before the ban. App Block consents belong to the App Blocks
 *   grant handling and are left to it. This runs whatever the token expiry above did.
 *
 * Idempotent: a disabled client is not disabled again, and a second run finds no consents (it does
 * flag the same third-party clients again, once per ban). Throws only when the client read itself
 * fails; a failure after it is logged and the rest still runs.
 */
export async function disableOauthForBannedUser(userId: number): Promise<OauthBanCleanup> {
  // primary: a ban acts on the clients as they are now, including one created moments ago.
  const owned = await dbWrite.oauthClient.findMany({
    where: { userId, NOT: { id: { startsWith: APP_BLOCK_OAUTH_CLIENT_ID_PREFIX } } },
    select: { id: true, name: true, accessMode: true },
  });
  const selfOnly = owned.filter((c) => isSelfOnlyClientFor(c.id, userId));
  const toDisable = selfOnly.filter((c) => c.accessMode !== 'disabled').map((c) => c.id);
  const others = owned.filter((c) => !isSelfOnlyClientFor(c.id, userId));

  const failed = (step: string) => (error: unknown) =>
    logToAxiom({
      type: 'error',
      name: 'ban-user-disable-oauth',
      message: `${step}: ${(error as Error)?.message}`,
      userId,
    });

  if (toDisable.length > 0) {
    try {
      // primary: read before the expiry below, which is what would hide these holders.
      const holders = await dbWrite.apiKey.findMany({
        where: { clientId: { in: toDisable } },
        select: { userId: true },
        distinct: ['userId'],
      });
      await dbWrite.oauthClient.updateMany({
        where: { id: { in: toDisable } },
        data: { accessMode: 'disabled' },
      });
      for (const clientId of toDisable)
        await expireClientTokens(clientId).catch(failed(`expire ${clientId}`));
      // Best-effort: revokeCivitaiUserTokens swallows its own errors.
      await Promise.all(holders.map((h) => revokeCivitaiUserTokens({ userId: h.userId })));
    } catch (error) {
      failed('disable self-only clients')(error);
    }
  }

  let consents = 0;
  try {
    ({ count: consents } = await dbWrite.oauthConsent.deleteMany({
      where: { userId, NOT: { clientId: { startsWith: APP_BLOCK_OAUTH_CLIENT_ID_PREFIX } } },
    }));
  } catch (error) {
    failed('delete consents')(error);
  }

  let flagDelivery: string | null = null;
  if (others.length > 0) {
    logToAxiom({
      type: 'info',
      name: 'ban-user-oauth-clients-for-review',
      message: `banned user ${userId} owns ${others.length} third-party oauth client(s); left enabled for a moderator to decide`,
      userId,
      clientIds: others.map((c) => c.id),
    });
    // The names are user-written: no mentions.
    flagDelivery = await notifyModAlert(
      'Banned user owns OAuth apps: moderator decision needed',
      `User ${userId} was banned and owns ${others.length} OAuth app(s) other people may use. ` +
        `They were left enabled and their users were not signed out. Review and disable them if ` +
        `needed:\n` +
        others.map((c) => `- ${c.id} (${c.name}, ${c.accessMode})`).join('\n'),
      { noMentions: true }
    ).catch(() => 'rejected');
  }

  return { disabled: toDisable, flagged: others.map((c) => c.id), consents, flagDelivery };
}

/**
 * The app-access leg of a ban: every approved or pending `AppAccessRequest` the person holds is
 * declined in one statement, attributed to whoever banned them (`reviewSource` 'system' with no
 * reviewer when that is the system account). Declined rather than deleted, so an unban does not
 * hand access back: `submitAppAccessRequest` never auto-approves someone holding a declined row,
 * and a new request after the unban waits for a moderator.
 *
 * Sends no notification (the ban email is the notice) and refreshes no session (the ban invalidates
 * it). Idempotent: a second call finds nothing to decline. Returns how many rows it declined.
 */
export async function revokeAppAccessForBannedUser({
  userId,
  actorId,
}: {
  userId: number;
  actorId: number;
}): Promise<number> {
  const bySystem = actorId === constants.system.user.id;
  const rows = await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    UPDATE "AppAccessRequest"
    SET "status" = 'declined',
        "reviewedAt" = CURRENT_TIMESTAMP,
        "reviewedById" = ${bySystem ? null : actorId}::int,
        "reviewSource" = ${bySystem ? 'system' : 'moderator'}
    WHERE "userId" = ${userId} AND "status" IN ('pending', 'approved')
    RETURNING "id"
  `);
  return rows.length;
}
