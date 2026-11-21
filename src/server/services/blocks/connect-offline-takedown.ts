import { dbRead, dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import type { AppListingModerationAction } from '~/server/schema/blocks/offsite-moderation.schema';
import { newAppListingModerationEventId } from '~/server/utils/app-block-ids';
import { anotherApprovedListingDeclaresOffline } from './connect-offline-listing';

/**
 * The moderation-history verbs this module writes. A cut that ran records `offline-cut` (with the
 * number of refresh tokens deleted); a cut that was attempted and threw records
 * `offline-cut-failed` (with the error message in `detail`), so a moderator can see it and retry.
 * Neither changes `app_listings.status`. Both are withheld from the OWNER's history.
 */
export const OFFLINE_CUT_ACTION = 'offline-cut' satisfies AppListingModerationAction;
export const OFFLINE_CUT_FAILED_ACTION = 'offline-cut-failed' satisfies AppListingModerationAction;

/**
 * What a cut did.
 *
 * `skipped` — nothing was attempted: the listing has no OAuth client, the flag is off (or could not
 *             be read), or another approved listing on the client still declares offline access.
 * `cut`     — the client's refresh tokens were deleted.
 * `failed`  — the cut was attempted and threw; the tokens may still be there.
 */
export type OfflineCutResult =
  | { outcome: 'skipped' }
  | { outcome: 'cut'; deleted: number }
  | { outcome: 'failed'; message: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether `oauth-offline-grant` is on. Throws when the flag cannot be evaluated. */
export async function isOfflineGrantOn(): Promise<boolean> {
  return isFlipt(FLIPT_FEATURE_FLAGS.OAUTH_OFFLINE_GRANT);
}

/**
 * Delete every Refresh key of the client (through `deleteApiKeys`, which also evicts the bearer
 * cache, revokes what the keys minted and expires each holder's orchestrator auth). Throws on
 * failure; callers decide what a failure means.
 */
async function deleteClientRefreshKeys(connectClientId: string): Promise<number> {
  const { deleteApiKeys } = await import('~/server/services/api-key.service');
  const { count } = await deleteApiKeys({ type: 'Refresh', clientId: connectClientId });
  return count;
}

/**
 * Run the cut itself (no flag or sibling check) and log it. Never throws: a failure comes back as
 * `{ outcome: 'failed' }`.
 */
export async function runOfflineCut(connectClientId: string): Promise<OfflineCutResult> {
  try {
    const deleted = await deleteClientRefreshKeys(connectClientId);
    logToAxiom(
      {
        name: 'app-listing.takedown.offline-cut',
        type: 'info',
        payload: { clientId: connectClientId, deleted },
      },
      'webhooks'
    );
    return { outcome: 'cut', deleted };
  } catch (err) {
    return logCutFailure(connectClientId, err);
  }
}

function logCutFailure(connectClientId: string, err: unknown): OfflineCutResult {
  const message = errorMessage(err);
  logToAxiom(
    {
      name: 'app-listing.takedown.offline-cut-failed',
      type: 'error',
      payload: { clientId: connectClientId, message },
    },
    'webhooks'
  );
  return { outcome: 'failed', message };
}

/**
 * Record a cut that RAN (`cut` or `failed`) in the listing's moderation history. Best-effort and
 * never throws: the takedown (or the retry) has already happened, and a missing history row must
 * not turn it into an error. A `skipped` cut records nothing.
 */
export async function recordOfflineCutEvent(opts: {
  appListingId: string;
  slug: string;
  actorUserId: number;
  connectClientId: string;
  result: OfflineCutResult;
}): Promise<void> {
  const { result } = opts;
  if (result.outcome === 'skipped') return;
  try {
    await dbWrite.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
        appListingId: opts.appListingId,
        slug: opts.slug,
        actorUserId: opts.actorUserId,
        action: result.outcome === 'cut' ? OFFLINE_CUT_ACTION : OFFLINE_CUT_FAILED_ACTION,
        reason: null,
        detail: result.outcome === 'failed' ? result.message.slice(0, 1000) : null,
        after:
          result.outcome === 'cut'
            ? { clientId: opts.connectClientId, deleted: result.deleted }
            : { clientId: opts.connectClientId },
      },
    });
  } catch (err) {
    logToAxiom(
      {
        name: 'app-listing.takedown.offline-cut-event-failed',
        type: 'error',
        payload: {
          appListingId: opts.appListingId,
          outcome: result.outcome,
          message: errorMessage(err),
        },
      },
      'webhooks'
    );
  }
}

/**
 * A MODERATOR TAKEDOWN of an App Store connect listing cuts the app's offline access: every
 * refresh token held for its OAuth client is deleted, so its users must sign in again.
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
 * A cut that ran is recorded in the listing's moderation history (`offline-cut` /
 * `offline-cut-failed`), so a moderator can see a failure and retry it
 * (`retryConnectOfflineCut` in offsite-moderation.service.ts).
 *
 * DARK: runs only while `oauth-offline-grant` is on. When the flag cannot be read, nothing is
 * attempted or recorded (the failure is logged): an unreadable flag must not surface a dark
 * feature. Runs AFTER the takedown commits and never throws: the takedown stands whatever happens
 * here.
 */
export async function cutConnectOfflineAccessAfterTakedown(opts: {
  connectClientId: string | null | undefined;
  takenDownListingId: string;
  slug: string;
  actorUserId: number;
}): Promise<OfflineCutResult> {
  const { connectClientId, takenDownListingId } = opts;
  if (!connectClientId) return { outcome: 'skipped' };
  try {
    if (!(await isOfflineGrantOn())) return { outcome: 'skipped' };
  } catch (err) {
    logCutFailure(connectClientId, err);
    return { outcome: 'skipped' };
  }
  let result: OfflineCutResult;
  try {
    result = (await anotherApprovedListingDeclaresOffline(dbRead, {
      connectClientId,
      excludeListingIds: [takenDownListingId],
    }))
      ? { outcome: 'skipped' }
      : await runOfflineCut(connectClientId);
  } catch (err) {
    result = logCutFailure(connectClientId, err);
  }
  await recordOfflineCutEvent({
    appListingId: takenDownListingId,
    slug: opts.slug,
    actorUserId: opts.actorUserId,
    connectClientId,
    result,
  });
  return result;
}
