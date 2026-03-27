import { getMultipliersForUser } from '~/server/services/buzz.service';
import { getUserCapCache } from '~/server/services/creator-program.service';
import { invalidateCivitaiUser } from '~/server/services/orchestrator/civitai';
import { setVaultFromSubscription } from '~/server/services/vault.service';
import { refreshSession } from '~/server/auth/session-invalidation';
// Re-export client-safe token utilities from shared module
export { getPrepaidTokens, getNextTokenUnlockDate } from '~/shared/utils/subscription-tokens';

export const invalidateSubscriptionCaches = async (userId: number) => {
  await Promise.allSettled([
    refreshSession(userId),
    getMultipliersForUser(userId, true),
    setVaultFromSubscription({
      userId,
    }),
    getUserCapCache('yellow').bust(userId),
    getUserCapCache('green').bust(userId),
    invalidateCivitaiUser({ userId }),
  ]);
};
