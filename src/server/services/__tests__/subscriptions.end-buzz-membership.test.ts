import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import type * as Freshdesk from '~/server/integrations/freshdesk';
import type * as SubscriptionUtils from '~/server/utils/subscription.utils';

/**
 * Support ends a Buzz-purchased membership by hand. It must end only the Buzz row — a cash
 * membership on the same account keeps its perks — and stop the tier at once.
 */

const { invalidateSubscriptionCaches, upsertContact } = vi.hoisted(() => ({
  invalidateSubscriptionCaches: vi.fn(),
  upsertContact: vi.fn(),
}));
vi.mock('~/server/integrations/freshdesk', async (importOriginal) => ({
  ...(await importOriginal<typeof Freshdesk>()),
  upsertContact,
}));
vi.mock('~/server/utils/subscription.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionUtils>()),
  invalidateSubscriptionCaches,
}));

import { endBuzzMembership } from '~/server/services/subscriptions.service';

const USER_ID = 8675309;
const MODERATOR_ID = 5;
const ROW = {
  id: 'buzz-membership:8675309:civitai-buzz-bronze-monthly:yellow:2026-10-08',
  status: 'active',
  productId: 'civitai-buzz-bronze',
  currentPeriodEnd: new Date('2026-11-08T23:35:00Z'),
};
const subscription = dbMock.dbWrite.customerSubscription;

beforeEach(() => {
  resetSharedMocks();
  vi.clearAllMocks();
  subscription.findFirst.mockResolvedValue(ROW as never);
  dbMock.dbWrite.user.findFirst.mockResolvedValue({
    id: USER_ID,
    username: 'someone',
    email: 'someone@example.com',
  } as never);
  upsertContact.mockResolvedValue(undefined);
});

/** The ModActivity rows written through `$executeRaw` (a tagged template: strings, ...values). */
const modActivityWrites = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.filter(([sql]) =>
    (sql as TemplateStringsArray).join('?').includes('"ModActivity"')
  );

describe('endBuzzMembership', () => {
  it('cancels only the live Buzz-purchased row, ending it now', async () => {
    const result = await endBuzzMembership({ userId: USER_ID, moderatorId: MODERATOR_ID });

    expect(subscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: USER_ID,
          buzzType: 'buzzPurchase',
          status: { notIn: ['canceled', 'incomplete_expired'] },
        },
      })
    );
    expect(subscription.update).toHaveBeenCalledWith({
      where: { id: ROW.id },
      data: {
        status: 'canceled',
        canceledAt: result.endedAt,
        endedAt: result.endedAt,
        updatedAt: result.endedAt,
      },
    });
    expect(invalidateSubscriptionCaches).toHaveBeenCalledTimes(1);
    expect(invalidateSubscriptionCaches).toHaveBeenCalledWith(USER_ID);
    // Invalidated after the cancel, or a concurrent read re-caches the still-active tier.
    expect(invalidateSubscriptionCaches.mock.invocationCallOrder[0]).toBeGreaterThan(
      subscription.update.mock.invocationCallOrder[0]
    );
    expect(result).toMatchObject({
      subscriptionId: ROW.id,
      previousStatus: 'active',
      freshdeskSynced: true,
    });
  });

  it('records which moderator ended whose membership', async () => {
    await endBuzzMembership({ userId: USER_ID, moderatorId: MODERATOR_ID });

    const writes = modActivityWrites();
    expect(writes).toHaveLength(1);
    const [, moderatorId, entityType, activity, entityIds] = writes[0];
    expect({ moderatorId, entityType, activity, entityIds }).toEqual({
      moderatorId: MODERATOR_ID,
      entityType: 'user',
      activity: 'endBuzzMembership:civitai-buzz-bronze',
      entityIds: [USER_ID],
    });
  });

  it('is a 404 and writes nothing when there is no Buzz membership to end', async () => {
    subscription.findFirst.mockResolvedValue(null as never);

    await expect(
      endBuzzMembership({ userId: USER_ID, moderatorId: MODERATOR_ID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(subscription.update).not.toHaveBeenCalled();
    expect(modActivityWrites()).toHaveLength(0);
    expect(invalidateSubscriptionCaches).not.toHaveBeenCalled();
  });

  it('still reports the end when the Freshdesk sync fails', async () => {
    upsertContact.mockRejectedValue(new Error('Freshdesk is down'));

    const result = await endBuzzMembership({ userId: USER_ID, moderatorId: MODERATOR_ID });

    expect(result).toMatchObject({ subscriptionId: ROW.id, freshdeskSynced: false });
  });
});
