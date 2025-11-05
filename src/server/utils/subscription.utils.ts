import { getMultipliersForUser } from '~/server/services/buzz.service';
import { userCapCaches } from '~/server/services/creator-program.service';
import { setVaultFromSubscription } from '~/server/services/vault.service';
import { refreshSession } from '~/server/utils/session-helpers';

export const invalidateSubscriptionCaches = async (userId: number) => {
  await Promise.allSettled([
    refreshSession(userId),
    getMultipliersForUser(userId, true),
    setVaultFromSubscription({
      userId,
    }),
    userCapCaches.get('yellow')?.bust(userId),
    userCapCaches.get('green')?.bust(userId),
  ]);
};
