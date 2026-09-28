import { dbRead, dbWrite } from '~/server/db/client';
import { revokeOauthConsentForBlock } from './oauth-consent-sync.service';

async function revokeGrants(userId: number, appBlockIds: string[]): Promise<number> {
  if (appBlockIds.length === 0) return 0;
  const { count } = await dbWrite.appUserScopeGrant.updateMany({
    where: { userId, appBlockId: { in: appBlockIds }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}

/**
 * Deleting the consent and its ApiKey rows stops a hub-minted token on its next request;
 * a live block JWT keeps working until it expires (15 min), accepted over a per-request read.
 */
export async function revokeScopeGrant(opts: {
  userId: number;
  appBlockId: string;
}): Promise<void> {
  await revokeGrants(opts.userId, [opts.appBlockId]);
  await revokeOauthConsentForBlock(opts);
}

/** Connected Apps revocation of a client that owns blocks; the caller already removed consent + tokens. */
export async function revokeBlockGrantsForClient(opts: {
  userId: number;
  clientId: string;
}): Promise<number> {
  const blocks = await dbRead.appBlock.findMany({
    where: { appId: opts.clientId },
    select: { id: true },
  });
  return revokeGrants(
    opts.userId,
    blocks.map((b) => b.id)
  );
}
