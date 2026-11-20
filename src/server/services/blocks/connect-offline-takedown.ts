import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { revokeCivitaiUserTokens } from '~/server/services/orchestrator/civitai';

/**
 * A MODERATOR TAKEDOWN of an App Store connect listing cuts the app's offline access now: every
 * refresh token held for its OAuth client is deleted, so its users must sign in again, and the
 * orchestrator's cached authentication of those users' tokens is expired.
 *
 * Only a moderator takedown does this. An owner withdrawing the offline declaration, or
 * unpublishing their own listing, only stops the chains sliding (the auth hub's
 * listing-offline.ts): they lapse at their current expiry.
 *
 * Mirrors the auth hub's revoke path for a reused refresh family (`revokeRefreshFamily`, which
 * deletes the Refresh rows and expires the orchestrator's token cache); the hub's helpers live in
 * the hub, so this uses the main app's equivalent orchestrator call, `revokeCivitaiUserTokens`.
 *
 * DARK: runs only while `oauth-offline-grant` is on, the regime in which offline access is a grant
 * a listing must declare. Off, a takedown is unchanged. Runs AFTER the takedown commits and never
 * throws: the takedown stands whatever happens here.
 */
export async function cutConnectOfflineAccessAfterTakedown(
  connectClientId: string | null | undefined
): Promise<{ users: number }> {
  if (!connectClientId) return { users: 0 };
  try {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.OAUTH_OFFLINE_GRANT))) return { users: 0 };
    // primary: the delete below must see the same rows, and the takedown just committed.
    const holders = await dbWrite.apiKey.findMany({
      where: { type: 'Refresh', clientId: connectClientId },
      select: { userId: true },
      distinct: ['userId'],
    });
    await dbWrite.apiKey.deleteMany({ where: { type: 'Refresh', clientId: connectClientId } });
    for (const { userId } of holders) await revokeCivitaiUserTokens({ userId });
    logToAxiom(
      {
        name: 'app-listing.takedown.offline-cut',
        type: 'info',
        payload: { clientId: connectClientId, users: holders.length },
      },
      'webhooks'
    );
    return { users: holders.length };
  } catch (err) {
    logToAxiom(
      {
        name: 'app-listing.takedown.offline-cut-failed',
        type: 'error',
        payload: {
          clientId: connectClientId,
          message: err instanceof Error ? err.message : String(err),
        },
      },
      'webhooks'
    );
    return { users: 0 };
  }
}
