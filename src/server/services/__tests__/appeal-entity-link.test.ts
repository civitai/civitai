import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as NotificationService from '~/server/services/notification.service';
import {
  appealEntityLink,
  getAppealDetails,
  getLatestEntityAppeal,
  reopenEntityAppeal,
  resolveEntityAppeal,
} from '~/server/services/report.service';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

const { mockCreateNotification } = vi.hoisted(() => ({ mockCreateNotification: vi.fn() }));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mockCreateNotification,
}));

beforeEach(() => vi.clearAllMocks());

describe('appealEntityLink', () => {
  it('links a bounty', () => {
    expect(appealEntityLink(EntityType.Bounty, 9)).toEqual({
      url: expect.stringMatching(/\/bounties\/9$/),
      label: 'Bounty #9',
    });
  });
});

describe('getAppealDetails', () => {
  const OWNER = 5;
  beforeEach(() => {
    dbMock.dbRead.appeal.findUnique.mockResolvedValue({
      id: 1,
      userId: OWNER,
      entityType: EntityType.Bounty,
      entityId: 9,
      internalNotes: 'mod-only',
    });
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({ id: 9, name: 'B', userId: OWNER });
  });

  it('returns the bounty for a Bounty appeal to its owner', async () => {
    const details = await getAppealDetails({ id: 1, userId: OWNER, isModerator: false });
    expect(details.entityDetails).toEqual({ id: 9, name: 'B', userId: OWNER });
  });

  it('returns any appeal to a moderator', async () => {
    const details = await getAppealDetails({ id: 1, userId: 77, isModerator: true });
    expect(details.id).toBe(1);
  });

  it('is not found for anyone else, before reading the entity', async () => {
    await expect(getAppealDetails({ id: 1, userId: 6, isModerator: false })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(dbMock.dbRead.bounty.findUnique).not.toHaveBeenCalled();
  });
});

describe('resolveEntityAppeal — resolved notification key', () => {
  it('is unique per appeal request, so a reopened appeal notifies again', async () => {
    const first = new Date('2026-09-01T00:00:00Z');
    const second = new Date('2026-09-20T00:00:00Z');
    dbMock.dbRead.user.findMany.mockResolvedValue([]);
    const appealRow = (createdAt: Date) => ({
      id: 11,
      entityId: 9,
      entityType: EntityType.Bounty,
      resolvedAt: null,
      buzzTransactionId: null,
      status: AppealStatus.Pending,
      userId: 5,
      createdAt,
    });

    dbMock.dbRead.appeal.findMany.mockResolvedValueOnce([appealRow(first)]);
    await resolveEntityAppeal({
      ids: [9],
      entityType: EntityType.Bounty,
      status: AppealStatus.Rejected,
      userId: 3,
    });
    dbMock.dbRead.appeal.findMany.mockResolvedValueOnce([appealRow(second)]);
    await resolveEntityAppeal({
      ids: [9],
      entityType: EntityType.Bounty,
      status: AppealStatus.Approved,
      userId: 3,
    });

    const keys = mockCreateNotification.mock.calls.map(([arg]) => arg.key);
    expect(keys).toEqual([
      `entity-appeal-resolved:Bounty:9:11:${first.getTime()}`,
      `entity-appeal-resolved:Bounty:9:11:${second.getTime()}`,
    ]);
  });
});

describe('generic appeal row helpers', () => {
  it('reads the newest appeal for any entity type', async () => {
    await getLatestEntityAppeal({ entityType: EntityType.Bounty, entityId: 9, userId: 5 });
    expect(dbMock.dbRead.appeal.findFirst).toHaveBeenCalledWith({
      where: { entityType: EntityType.Bounty, entityId: 9, userId: 5 },
      orderBy: { createdAt: 'desc' },
      select: { status: true, resolvedAt: true },
    });
  });

  it('reopens the existing row for any entity type', async () => {
    await reopenEntityAppeal({
      entityType: EntityType.Bounty,
      entityId: 9,
      userId: 5,
      message: 'm',
    });
    const { where, data } = dbMock.dbWrite.appeal.update.mock.calls[0][0];
    expect(where).toEqual({
      entityType_entityId_userId: { entityType: EntityType.Bounty, entityId: 9, userId: 5 },
    });
    expect(data).toMatchObject({
      status: AppealStatus.Pending,
      appealMessage: 'm',
      resolvedAt: null,
    });
  });
});
