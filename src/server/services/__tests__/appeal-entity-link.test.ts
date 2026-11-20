import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as EmailTemplates from '~/server/email/templates';
import type * as NotificationService from '~/server/services/notification.service';
import type * as UrlHelpers from '~/server/utils/url-helpers';
import { NsfwLevel } from '~/server/common/enums';
import { reportNotifications } from '~/server/notifications/report.notifications';
import {
  appealEntityLink,
  getAppealDetails,
  resolveEntityAppeal,
  settleResolvedAppeals,
} from '~/server/services/report.service';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

const { mockCreateNotification } = vi.hoisted(() => ({ mockCreateNotification: vi.fn() }));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mockCreateNotification,
}));

const { mockSendEmail } = vi.hoisted(() => ({ mockSendEmail: vi.fn() }));
vi.mock('~/server/email/templates', async (importOriginal) => ({
  ...(await importOriginal<typeof EmailTemplates>()),
  moderationActionEmail: { send: mockSendEmail },
}));

vi.mock('~/server/utils/url-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof UrlHelpers>()),
  getBaseUrl: (color?: string) => (color ? `https://${color}.test` : 'https://pod.test'),
  getColorBaseUrl: (color: string) => `https://${color}.test`,
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
  it("writes the moderator's reason and note in the statement that closes the appeal", async () => {
    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValue([]);
    await resolveEntityAppeal({
      ids: [9],
      entityType: EntityType.Model,
      status: AppealStatus.Rejected,
      resolvedReason: 'flag-confirmed',
      internalNotes: 'seen it',
      userId: 3,
    });
    await resolveEntityAppeal({
      ids: [9],
      entityType: EntityType.Model,
      status: AppealStatus.Approved,
      userId: 3,
    });

    const [ruled, system] = dbMock.dbWrite.appeal.updateManyAndReturn.mock.calls.map(
      ([arg]) => (arg as { data: Record<string, unknown> }).data
    );
    expect(ruled).toMatchObject({ resolvedReason: 'flag-confirmed', internalNotes: 'seen it' });
    // Prisma leaves an undefined field untouched, so a system close writes neither column.
    expect(system.resolvedReason).toBeUndefined();
    expect(system.internalNotes).toBeUndefined();
  });

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

    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValueOnce([appealRow(first)]);
    await resolveEntityAppeal({
      ids: [9],
      entityType: EntityType.Bounty,
      status: AppealStatus.Rejected,
      userId: 3,
    });
    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValueOnce([appealRow(second)]);
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

describe('resolveEntityAppeal — email links go to the domain that serves the item', () => {
  const appealRow = (entityId: number, entityType: EntityType = EntityType.Model) => ({
    id: entityId,
    entityId,
    entityType,
    resolvedAt: null,
    buzzTransactionId: null,
    status: AppealStatus.Pending,
    userId: 5,
    createdAt: new Date('2026-09-01T00:00:00Z'),
  });

  it('links mature, mixed-rating and unrated models to .red, PG models to the pod host, and a missing row to .red', async () => {
    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValue(
      [1, 2, 3, 4, 5].map((id) => appealRow(id))
    );
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 5, email: 'a@b.test', username: 'a' }]);
    dbMock.dbRead.model.findMany.mockResolvedValue([
      { id: 1, nsfwLevel: NsfwLevel.X },
      { id: 2, nsfwLevel: NsfwLevel.PG },
      { id: 3, nsfwLevel: NsfwLevel.PG | NsfwLevel.X },
      { id: 4, nsfwLevel: 0 },
    ]);

    await resolveEntityAppeal({
      ids: [1, 2, 3, 4, 5],
      entityType: EntityType.Model,
      status: AppealStatus.Rejected,
      userId: 3,
    });

    const urls = mockSendEmail.mock.calls[0][0].items.map((i: { url?: string }) => i.url);
    expect(urls).toEqual([
      'https://red.test/models/1',
      'https://pod.test/models/2',
      'https://red.test/models/3',
      'https://red.test/models/4',
      'https://red.test/models/5',
    ]);
  });

  const resolve = () =>
    resolveEntityAppeal({
      ids: [7],
      entityType: EntityType.Model,
      status: AppealStatus.Rejected,
      userId: 3,
    });
  const sentUrls = () => mockSendEmail.mock.calls[0][0].items.map((i: { url?: string }) => i.url);

  it('rates each entity type from its own table, sends a bounty marked mature to .red, and leaves unrated types on the pod host', async () => {
    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValue([
      appealRow(7, EntityType.Image),
      appealRow(7, EntityType.Model),
      appealRow(7, EntityType.Bounty),
      appealRow(8, EntityType.Bounty),
      appealRow(7, EntityType.Storyline),
    ]);
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 5, email: 'a@b.test', username: 'a' }]);
    dbMock.dbRead.image.findMany.mockResolvedValue([{ id: 7, nsfwLevel: NsfwLevel.PG }]);
    dbMock.dbRead.model.findMany.mockResolvedValue([{ id: 7, nsfwLevel: NsfwLevel.R }]);
    dbMock.dbRead.bounty.findMany.mockResolvedValue([
      { id: 7, nsfwLevel: NsfwLevel.PG13, nsfw: false },
      { id: 8, nsfwLevel: NsfwLevel.PG, nsfw: true },
    ]);

    await resolve();

    expect(sentUrls()).toEqual([
      'https://pod.test/images/7',
      'https://red.test/models/7',
      'https://pod.test/bounties/7',
      'https://red.test/bounties/8',
      'https://pod.test/storylines/7',
    ]);
  });

  it('still sends the email, linking to .red, when the rating read fails', async () => {
    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValue([appealRow(7)]);
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 5, email: 'a@b.test', username: 'a' }]);
    dbMock.dbRead.model.findMany.mockRejectedValue(new Error('read failed'));

    await resolve();

    expect(sentUrls()).toEqual(['https://red.test/models/7']);
  });
});

describe('resolveEntityAppeal — bell notification links', () => {
  const appealRow = (entityId: number) => ({
    id: entityId,
    entityId,
    entityType: EntityType.Model,
    resolvedAt: null,
    buzzTransactionId: null,
    status: AppealStatus.Pending,
    userId: 5,
    createdAt: new Date('2026-09-01T00:00:00Z'),
  });
  const bellUrl = (details: MixedObject) =>
    reportNotifications['entity-appeal-resolved'].prepareMessage({
      type: 'entity-appeal-resolved',
      details,
    } as Parameters<(typeof reportNotifications)['entity-appeal-resolved']['prepareMessage']>[0])
      ?.url;

  const bellUrlsFor = async (rows: { id: number; nsfwLevel: number }[]) => {
    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValue(rows.map((r) => appealRow(r.id)));
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 5, email: 'a@b.test', username: 'a' }]);
    dbMock.dbRead.model.findMany.mockResolvedValue(rows);
    await resolveEntityAppeal({
      ids: rows.map((r) => r.id),
      entityType: EntityType.Model,
      status: AppealStatus.Approved,
      userId: 3,
    });
    return mockCreateNotification.mock.calls.map(([n]) => bellUrl(n.details));
  };

  it('opens a mature item on .red', async () => {
    expect(await bellUrlsFor([{ id: 1, nsfwLevel: NsfwLevel.X }])).toEqual([
      'https://red.test/models/1',
    ]);
  });

  it('keeps a PG item relative, so it opens on whichever host the bell is on', async () => {
    expect(await bellUrlsFor([{ id: 2, nsfwLevel: NsfwLevel.PG }])).toEqual(['/models/2']);
  });

  it('opens on .red when the rating read fails, as the email does', async () => {
    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValue([appealRow(3)]);
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 5, email: 'a@b.test', username: 'a' }]);
    dbMock.dbRead.model.findMany.mockRejectedValue(new Error('read failed'));
    await resolveEntityAppeal({
      ids: [3],
      entityType: EntityType.Model,
      status: AppealStatus.Rejected,
      userId: 3,
    });
    expect(mockCreateNotification.mock.calls.map(([n]) => bellUrl(n.details))).toEqual([
      'https://red.test/models/3',
    ]);
  });

  it('rates an approved image after its restore, which can change the rating', async () => {
    let restored = false;
    dbMock.dbWrite.$queryRaw.mockImplementation((async () => {
      restored = true;
      return [{ postId: null, pHash: null }];
    }) as never);
    dbMock.dbRead.image.findMany.mockImplementation((async () => [
      { id: 6, nsfwLevel: restored ? NsfwLevel.PG : NsfwLevel.Blocked },
    ]) as never);
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 5, email: 'a@b.test', username: 'a' }]);

    await settleResolvedAppeals([{ ...appealRow(6), entityType: EntityType.Image }] as never, {
      status: AppealStatus.Approved,
    });

    expect(mockCreateNotification.mock.calls.map(([n]) => bellUrl(n.details))).toEqual([
      '/images/6',
    ]);
  });

  it('opens a lock review ruling on a mature model on .red', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 5, email: 'a@b.test', username: 'a' }]);
    dbMock.dbRead.model.findMany.mockResolvedValue([{ id: 8, nsfwLevel: NsfwLevel.X }]);

    await settleResolvedAppeals([appealRow(8)] as never, {
      status: AppealStatus.Rejected,
      lockReview: { unlocked: [] },
    });

    expect(mockCreateNotification.mock.calls.map(([n]) => bellUrl(n.details))).toEqual([
      'https://red.test/models/8',
    ]);
  });
});
