import { Prisma } from '@prisma/client';
import { isSelfOnlyClientFor } from '@civitai/auth/self-only-client';
import { revokeRunnerAuthorizations } from '@civitai/db-queries/recipe-runner';
import { constants } from '~/server/common/constants';
import { notifyModAlert } from '~/server/common/mod-alert';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { expireClientTokens } from '~/server/services/api-key.service';
import { markBanDisabledClients } from '~/server/services/oauth-ban-marker';
import { revokeCivitaiUserTokens } from '~/server/services/orchestrator/civitai';
import { APP_BLOCK_OAUTH_CLIENT_ID_PREFIX } from '~/shared/constants/block-scope.constants';

/**
 * What a BAN takes away from the account's OAuth apps and app access, called by `toggleBan`.
 *
 * `user.service` imports this and sits in the image.service import cycle, so nothing imported here
 * may lead back into it (`no-image-service-import-cycle.test.ts`).
 */

/** The boundaries the OAuth leg calls; tests pass their own. */
export type BanCleanupDeps = {
  expireClientTokens: (clientId: string) => Promise<unknown>;
  revokeCivitaiUserTokens: (args: { userId: number }) => Promise<unknown>;
  notifyModAlert: typeof notifyModAlert;
  markBanDisabledClients: (clients: { id: string; priorMode: string }[]) => Promise<void>;
};

const defaultDeps: BanCleanupDeps = {
  expireClientTokens,
  revokeCivitaiUserTokens,
  notifyModAlert,
  markBanDisabledClients,
};

export type OauthBanCleanup = {
  /** Self-only clients this run disabled. */
  disabled: string[];
  /** Other clients the account owns, left enabled and flagged for a moderator. */
  flagged: string[];
  /** Consents the account gave that this run deleted. */
  consents: number;
  /** What became of the moderator flag (`null` when nothing was flagged). */
  flagDelivery: string | null;
};

/**
 * The OAuth leg of a ban. Disables only the account's self-only clients (`isSelfOnlyClientFor`);
 * any other client it owns is a third-party app others rely on, so it is flagged for a moderator
 * instead. App Block (`appblk-`) clients and their consents are skipped. See oauth-ban-marker.ts for
 * re-opening.
 */
export async function disableOauthForBannedUser(
  userId: number,
  deps: BanCleanupDeps = defaultDeps
): Promise<OauthBanCleanup> {
  // primary: a ban acts on the clients as they are now, including one created moments ago.
  const owned = await dbWrite.oauthClient.findMany({
    where: { userId, NOT: { id: { startsWith: APP_BLOCK_OAUTH_CLIENT_ID_PREFIX } } },
    select: { id: true, name: true, accessMode: true },
  });
  const selfOnly = owned.filter((c) => isSelfOnlyClientFor(c.id, userId));
  const disabling = selfOnly.filter((c) => c.accessMode !== 'disabled');
  const toDisable = disabling.map((c) => c.id);
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
      // Only once the disable landed: a mark on a client still open would let a later enable undo
      // whatever disables it next. A mark that fails to write leaves the client disabled (closed).
      await deps
        .markBanDisabledClients(disabling.map((c) => ({ id: c.id, priorMode: c.accessMode })))
        .catch(failed('mark ban-disabled'));
      for (const clientId of toDisable)
        await deps.expireClientTokens(clientId).catch(failed(`expire ${clientId}`));
      await Promise.all(
        holders.map((h) =>
          deps.revokeCivitaiUserTokens({ userId: h.userId }).catch(failed('orchestrator revoke'))
        )
      );
    } catch (error) {
      failed('disable self-only clients')(error);
    }
  }

  // Before the consents: a run authorization outlives its consent row otherwise.
  try {
    const { kyselyWrite } = await import('~/server/db/kyselyDb');
    await revokeRunnerAuthorizations(kyselyWrite, { userId, clientId: null, reason: 'banned' });
  } catch (error) {
    failed('revoke run authorizations')(error);
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
      payload: { clientIds: others.map((c) => c.id) },
    });
    // The names are user-written: no mentions.
    flagDelivery = await deps
      .notifyModAlert(
        'Banned user owns OAuth apps: moderator decision needed',
        `User ${userId} was banned and owns ${others.length} OAuth app(s) other people may use. ` +
          `They were left enabled and their users were not signed out. Review and disable them if ` +
          `needed:\n` +
          others.map((c) => `- ${c.id} (${c.name}, ${c.accessMode})`).join('\n'),
        { noMentions: true }
      )
      .catch(() => 'rejected');
  }

  return { disabled: toDisable, flagged: others.map((c) => c.id), consents, flagDelivery };
}

/**
 * The app-access leg of a ban: every approved or pending `AppAccessRequest` is declined, attributed
 * to whoever banned them ('system' with no reviewer for the system account). Declined, not deleted,
 * so an unban does not hand access back: `submitAppAccessRequest` never auto-approves someone
 * holding a declined row. No notification (the ban email is the notice). Returns the rows declined.
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
