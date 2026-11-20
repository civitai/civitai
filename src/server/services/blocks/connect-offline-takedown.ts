import { dbRead } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { anotherApprovedListingDeclaresOffline } from './connect-offline-listing';

/**
 * A MODERATOR TAKEDOWN of an App Store connect listing cuts the app's offline access: every
 * refresh token held for its OAuth client is deleted (through `deleteApiKeys`, which also evicts the
 * bearer cache, revokes what the keys minted and expires each holder's orchestrator auth), so its
 * users must sign in again.
 *
 * Not when ANOTHER approved listing on the same client still declares offline access: the auth hub
 * grants per client, so that app keeps it, and cutting would only force its users to sign in again.
 *
 * Only a moderator DELIST deletes refresh tokens. Other ways a listing stops declaring only stop
 * chains sliding (listing-offline.ts); issued tokens live until their expiry (<=30 days).
 *
 * Every Refresh key of the client goes, device-flow ones included: the hub does not gate the
 * device flow, but a delisted app loses offline access whatever flow its users signed in with.
 *
 * DARK: runs only while `oauth-offline-grant` is on. Runs AFTER the takedown commits and never
 * throws: the takedown stands whatever happens here.
 */
export async function cutConnectOfflineAccessAfterTakedown(opts: {
  connectClientId: string | null | undefined;
  takenDownListingId: string;
}): Promise<{ cut: boolean; deleted: number }> {
  const { connectClientId, takenDownListingId } = opts;
  if (!connectClientId) return { cut: false, deleted: 0 };
  try {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.OAUTH_OFFLINE_GRANT)))
      return { cut: false, deleted: 0 };
    if (
      await anotherApprovedListingDeclaresOffline(dbRead, {
        connectClientId,
        excludeListingIds: [takenDownListingId],
      })
    ) {
      return { cut: false, deleted: 0 };
    }
    const { deleteApiKeys } = await import('~/server/services/api-key.service');
    const { count } = await deleteApiKeys({ type: 'Refresh', clientId: connectClientId });
    logToAxiom(
      {
        name: 'app-listing.takedown.offline-cut',
        type: 'info',
        payload: { clientId: connectClientId, deleted: count },
      },
      'webhooks'
    );
    return { cut: true, deleted: count };
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
    return { cut: false, deleted: 0 };
  }
}
