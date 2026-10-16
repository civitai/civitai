import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { serviceOfferingTakedownReasons } from '~/server/common/moderation-helpers';
import { creatorServiceNotifications } from '~/server/notifications/creator-service.notifications';
import { takedownServiceOfferingSchema } from '~/server/schema/creator-service.schema';
import { takedownServiceOffering } from '~/server/services/creator-service.service';
import { createNotification } from '~/server/services/notification.service';
import { ServiceOfferingStatus } from '~/shared/utils/prisma/enums';

vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
}));

// Decisions (briony, 2026-10-15): a fixed reason list plus optional details; the seller is notified
// once with the reason and never with the moderator's identity; there is no restore.
const MOD = 42;
const SELLER = 7;
const OFFERING = 5;

const rejects = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: Error) => e.message
  );

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.serviceOffering.findFirst.mockResolvedValue({
    title: 'Custom badge',
    sellerId: SELLER,
    seller: { username: 'badgesmith' },
  } as never);
  dbMock.dbWrite.serviceOffering.updateMany.mockResolvedValue({ count: 1 } as never);
});

describe('takedown', () => {
  it('removes the offering and records the reason, details, time and moderator', async () => {
    await takedownServiceOffering({
      moderatorId: MOD,
      input: { id: OFFERING, reason: 'off-platform', details: 'Links to a payment page' },
    });
    const [args] = dbMock.dbWrite.serviceOffering.updateMany.mock.calls[0] as [
      { where: unknown; data: Record<string, unknown> }
    ];
    expect(args.where).toEqual({ id: OFFERING, removedReason: null });
    expect(args.data).toEqual({
      status: ServiceOfferingStatus.Removed,
      removedReason: 'off-platform',
      removedDetails: 'Links to a payment page',
      removedAt: expect.any(Date),
      removedById: MOD,
    });
  });

  // A moderator's note on a reason with its own copy stays on the row, out of the seller's payload.
  it("keeps a note out of the seller's notification unless the reason is other", async () => {
    await takedownServiceOffering({
      moderatorId: MOD,
      input: { id: OFFERING, reason: 'misleading', details: 'internal note' },
    });
    await takedownServiceOffering({
      moderatorId: MOD,
      input: { id: OFFERING, reason: 'other', details: 'Sells account access' },
    });
    const sent = vi
      .mocked(createNotification)
      .mock.calls.map(([n]) => (n as { details: { details: unknown } }).details.details);
    expect(sent).toEqual([null, 'Sells account access']);
  });

  it('notifies the seller once, keyed to the offering, without the moderator', async () => {
    await takedownServiceOffering({ moderatorId: MOD, input: { id: OFFERING, reason: 'spam' } });
    expect(createNotification).toHaveBeenCalledTimes(1);
    const [notification] = vi.mocked(createNotification).mock.calls[0];
    expect(notification).toMatchObject({
      userId: SELLER,
      type: 'service-offering-taken-down',
      key: `service-offering-taken-down:${OFFERING}`,
    });
    expect(JSON.stringify(notification)).not.toContain(String(MOD));
  });

  // Decision (briony, 2026-10-15): a seller's own remove does not shield an offering from a takedown,
  // or removing first would keep pending requests acceptable. Only a prior takedown does.
  it('looks up the offering by takedown, not by status, so a seller-removed one still qualifies', async () => {
    await takedownServiceOffering({ moderatorId: MOD, input: { id: OFFERING, reason: 'spam' } });
    const [lookup] = dbMock.dbWrite.serviceOffering.findFirst.mock.calls[0] as [{ where: unknown }];
    expect(lookup.where).toEqual({ id: OFFERING, removedReason: null });
  });

  it('refuses an offering already taken down, writing and notifying nothing', async () => {
    dbMock.dbWrite.serviceOffering.findFirst.mockResolvedValue(null as never);
    expect(
      await rejects(
        takedownServiceOffering({ moderatorId: MOD, input: { id: OFFERING, reason: 'spam' } })
      )
    ).toMatch(/already taken down/i);
    expect(dbMock.dbWrite.serviceOffering.updateMany).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('notifies once when two moderators take it down at the same time', async () => {
    dbMock.dbWrite.serviceOffering.updateMany.mockResolvedValue({ count: 0 } as never);
    expect(
      await rejects(
        takedownServiceOffering({ moderatorId: MOD, input: { id: OFFERING, reason: 'spam' } })
      )
    ).toMatch(/not found/i);
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('takedown input', () => {
  const parse = (input: object) => takedownServiceOfferingSchema.safeParse(input).success;

  it('accepts only a listed reason', () => {
    expect(parse({ id: 1, reason: 'spam' })).toBe(true);
    expect(parse({ id: 1, reason: 'not-a-reason' })).toBe(false);
    expect(parse({ id: 1 })).toBe(false);
  });

  it('requires details when the reason is other', () => {
    expect(parse({ id: 1, reason: 'other' })).toBe(false);
    expect(parse({ id: 1, reason: 'other', details: '   ' })).toBe(false);
    expect(parse({ id: 1, reason: 'other', details: 'Sells account access' })).toBe(true);
  });
});

describe('takedown notification', () => {
  const message = (details: Record<string, unknown>) =>
    creatorServiceNotifications['service-offering-taken-down'].prepareMessage({
      details: {
        offeringId: OFFERING,
        offeringTitle: 'Custom badge',
        sellerUsername: 'badgesmith',
        ...details,
      },
    } as never);

  it("tells the seller the reason's copy and links their manage page", () => {
    expect(message({ reason: 'off-platform' })).toEqual({
      message: `Your service "Custom badge" has been removed by a moderator: ${serviceOfferingTakedownReasons['off-platform'].notificationMessage}`,
      url: '/user/badgesmith/shop/manage',
    });
  });

  it("tells the seller the moderator's details when the reason is other", () => {
    expect(message({ reason: 'other', details: 'Sells account access' })?.message).toBe(
      'Your service "Custom badge" has been removed by a moderator: Sells account access'
    );
  });
});
