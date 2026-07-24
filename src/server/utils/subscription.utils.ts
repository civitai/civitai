import { getMultipliersForUser } from '~/server/services/buzz.service';
import { getUserCapCache } from '~/server/services/creator-program.service';
import { bustCreatorMembershipValidCache } from '~/server/services/creator-membership.service';
import { invalidateCivitaiUser } from '~/server/services/orchestrator/civitai';
import { setVaultFromSubscription } from '~/server/services/vault.service';
import { refreshSession } from '~/server/auth/session-invalidation';
import { logToAxiom } from '~/server/logging/client';
// Re-export client-safe token utilities from shared module
export { getPrepaidTokens, getNextTokenUnlockDate } from '~/shared/utils/subscription-tokens';

export const invalidateSubscriptionCaches = async (userId: number) => {
  const steps = [
    ['refreshSession', () => refreshSession(userId)],
    ['getMultipliersForUser', () => getMultipliersForUser(userId, true)],
    ['setVaultFromSubscription', () => setVaultFromSubscription({ userId })],
    ['getUserCapCache.bust', () => getUserCapCache().bust(userId)],
    ['invalidateCivitaiUser', () => invalidateCivitaiUser({ userId })],
    // Read-time metric-privacy / donation-goal hide gate (#3266): the owner's cached
    // membership-validity determines whether their hidden metrics stay hidden. A
    // subscription change here can flip that validity, so bust the key so the next
    // read re-derives it (immediate, not TTL-bounded).
    ['bustCreatorMembershipValidCache', () => bustCreatorMembershipValidCache(userId)],
  ] as const;

  // Run in parallel but surface individual failures — a silent rejection here
  // is how stale tier / multiplier state leaks into production for the
  // 4h session TTL window.
  const results = await Promise.allSettled(steps.map(([, fn]) => fn()));
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      const [step] = steps[i];
      logToAxiom(
        {
          name: 'invalidate-subscription-caches-step-failed',
          type: 'error',
          userId,
          step,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          stack: result.reason instanceof Error ? result.reason.stack : undefined,
        },
        'webhooks'
      ).catch(() => null);
    }
  }
};
