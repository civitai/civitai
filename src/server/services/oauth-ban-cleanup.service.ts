import { dbWrite } from '~/server/db/client';
import { expireClientTokens } from '~/server/services/api-key.service';
import { APP_BLOCK_OAUTH_CLIENT_ID_PREFIX } from '~/shared/constants/block-scope.constants';

/**
 * A BAN's OAuth leg: the account's apps stop working, in both directions.
 *
 * - As an OWNER: every OAuth client the account owns is set to `accessMode: 'disabled'`, which the
 *   auth hub refuses at every door (authorize, token exchange, the internal `app-token` mint,
 *   introspection), and the live tokens issued under it, to ANY user, are expired. The App
 *   Assistant client (`appassist-<id>`) is one of these. App Block clients (`appblk-…`) are left to
 *   the App Blocks ban handling, which suspends and restores them with the ban.
 * - As a CONSENTER: every consent the account gave is deleted, so nothing can mint a token for it
 *   from a consent it gave before the ban. (`revokeUserTokens` already expired the tokens it held.)
 *
 * An unban changes none of this: a disabled client stays disabled until an admin re-opens it (the
 * hub's access admin page), and the person consents again to any app they use. Idempotent: an
 * already-disabled client is not touched again, and a second run finds no consents.
 */
export async function disableOauthForBannedUser(
  userId: number
): Promise<{ clients: string[]; consents: number }> {
  const owned = await dbWrite.oauthClient.findMany({
    where: {
      userId,
      accessMode: { not: 'disabled' },
      NOT: { id: { startsWith: APP_BLOCK_OAUTH_CLIENT_ID_PREFIX } },
    },
    select: { id: true },
  });
  const clients = owned.map((c) => c.id);
  if (clients.length > 0) {
    await dbWrite.oauthClient.updateMany({
      where: { id: { in: clients } },
      data: { accessMode: 'disabled' },
    });
    for (const clientId of clients) await expireClientTokens(clientId);
  }
  const { count: consents } = await dbWrite.oauthConsent.deleteMany({ where: { userId } });
  return { clients, consents };
}
