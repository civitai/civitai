import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getSiteAppealRefusal,
  getSiteAppealState,
  SITE_APPEAL_ALREADY_PENDING,
  SITE_APPEAL_NOT_REMOVED,
  SITE_APPEAL_NOT_RESTRICTED,
  SITE_APPEAL_REFILE_COOLDOWN_DAYS,
  submitSiteAppeal,
} from '~/server/services/site-appeal.service';
import { submitSiteAppealSchema } from '~/server/schema/site-appeal.schema';
import {
  AppealCategory,
  AppealStatus,
  ArticleStatus,
  EntityType,
  ModelStatus,
} from '~/shared/utils/prisma/enums';

const USER = { id: 41 };
const MESSAGE = 'Please take another look at this decision.';
const DAY = 24 * 60 * 60 * 1000;

const { dbWrite } = dbMock;

beforeEach(() => {
  vi.resetAllMocks();
  dbWrite.appeal.create.mockImplementation((async ({ data }: { data: unknown }) => data) as never);
});

const created = () => dbWrite.appeal.create.mock.calls[0]?.[0]?.data;

describe('submitSiteAppeal', () => {
  describe('Account', () => {
    it.each([
      ['banned', { bannedAt: new Date(), muted: false }, { banned: true, muted: false }],
      ['muted', { bannedAt: null, muted: true }, { banned: false, muted: true }],
    ])('files an appeal on the appellant when %s', async (_, user, restriction) => {
      dbWrite.user.findUnique.mockResolvedValue(user as never);

      await submitSiteAppeal({
        user: USER,
        input: { category: AppealCategory.Account, message: MESSAGE },
      });

      expect(created()).toEqual({
        userId: USER.id,
        category: AppealCategory.Account,
        entityType: EntityType.User,
        entityId: USER.id,
        appealMessage: MESSAGE,
        context: { restriction },
      });
    });

    it('refuses an account with no restriction', async () => {
      dbWrite.user.findUnique.mockResolvedValue({ bannedAt: null, muted: false } as never);

      await expect(
        submitSiteAppeal({
          user: USER,
          input: { category: AppealCategory.Account, message: MESSAGE },
        })
      ).rejects.toMatchObject({ message: SITE_APPEAL_NOT_RESTRICTED });
      expect(dbWrite.appeal.create).not.toHaveBeenCalled();
    });
  });

  describe('Article', () => {
    const input = { category: AppealCategory.Article, entityId: 9, message: MESSAGE } as const;

    it('files an appeal on an own article a moderator removed', async () => {
      dbWrite.article.findUnique.mockResolvedValue({
        userId: USER.id,
        status: ArticleStatus.UnpublishedViolation,
      } as never);

      await submitSiteAppeal({ user: USER, input });

      expect(created()).toMatchObject({ entityType: EntityType.Article, entityId: 9 });
    });

    it.each([
      ['someone else’s', { userId: 999, status: ArticleStatus.UnpublishedViolation }],
      ['an owner-unpublished', { userId: USER.id, status: ArticleStatus.Unpublished }],
      ['a published', { userId: USER.id, status: ArticleStatus.Published }],
      ['a missing', null],
    ])('refuses %s article', async (_, article) => {
      dbWrite.article.findUnique.mockResolvedValue(article as never);

      await expect(submitSiteAppeal({ user: USER, input })).rejects.toMatchObject({
        message: SITE_APPEAL_NOT_REMOVED,
      });
      expect(dbWrite.appeal.create).not.toHaveBeenCalled();
    });
  });

  describe('Model', () => {
    const input = { category: AppealCategory.Model, entityId: 5, message: MESSAGE } as const;
    const removed = { userId: USER.id, status: ModelStatus.UnpublishedViolation, deletedAt: null };

    it('files an appeal on an own model a moderator unpublished', async () => {
      dbWrite.model.findUnique.mockResolvedValue(removed as never);

      await submitSiteAppeal({ user: USER, input });

      expect(created()).toMatchObject({ entityType: EntityType.Model, entityId: 5 });
    });

    it.each([
      ['someone else’s', { ...removed, userId: 999 }],
      ['a deleted', { ...removed, deletedAt: new Date() }],
      ['an owner-unpublished', { ...removed, status: ModelStatus.Unpublished }],
      ['a wipe-kept', { ...removed, meta: { removedWithOwner: true } }],
    ])('refuses %s model', async (_, model) => {
      dbWrite.model.findUnique.mockResolvedValue(model as never);

      await expect(submitSiteAppeal({ user: USER, input })).rejects.toMatchObject({
        message: SITE_APPEAL_NOT_REMOVED,
      });
    });
  });

  it('files Other on the appellant with its subject and link', async () => {
    await submitSiteAppeal({
      user: USER,
      input: {
        category: AppealCategory.Other,
        subject: 'My comment was removed',
        link: 'https://civitai.com/images/1',
        message: MESSAGE,
      },
    });

    expect(created()).toMatchObject({
      category: AppealCategory.Other,
      entityType: EntityType.User,
      entityId: USER.id,
      context: { subject: 'My comment was removed', link: 'https://civitai.com/images/1' },
    });
  });

  it('looks up the previous appeal in the same category only', async () => {
    dbWrite.user.findUnique.mockResolvedValue({ bannedAt: new Date(), muted: false } as never);

    await submitSiteAppeal({
      user: USER,
      input: { category: AppealCategory.Account, message: MESSAGE },
    });

    expect(dbWrite.appeal.findFirst.mock.calls[0][0].where).toEqual({
      userId: USER.id,
      category: AppealCategory.Account,
      entityType: EntityType.User,
      entityId: USER.id,
    });
  });

  it('refuses while one is Pending', async () => {
    dbWrite.user.findUnique.mockResolvedValue({ bannedAt: new Date(), muted: false } as never);
    dbWrite.appeal.findFirst.mockResolvedValue({
      status: AppealStatus.Pending,
      resolvedAt: null,
    } as never);

    await expect(
      submitSiteAppeal({
        user: USER,
        input: { category: AppealCategory.Account, message: MESSAGE },
      })
    ).rejects.toMatchObject({ message: SITE_APPEAL_ALREADY_PENDING });
    expect(dbWrite.appeal.create).not.toHaveBeenCalled();
  });

  it('turns a lost race on the pending index into the same refusal', async () => {
    dbWrite.user.findUnique.mockResolvedValue({ bannedAt: new Date(), muted: false } as never);
    dbWrite.appeal.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: Prisma.prismaVersion.client,
      })
    );

    await expect(
      submitSiteAppeal({
        user: USER,
        input: { category: AppealCategory.Account, message: MESSAGE },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: SITE_APPEAL_ALREADY_PENDING });
  });
});

describe('getSiteAppealRefusal', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const rejectedDaysAgo = (days: number) => ({
    status: AppealStatus.Rejected,
    resolvedAt: new Date(now.getTime() - days * DAY),
  });

  it('refuses a re-file inside the cooldown and allows one after it', () => {
    const cooldown = SITE_APPEAL_REFILE_COOLDOWN_DAYS;
    expect(
      getSiteAppealRefusal(AppealCategory.Article, rejectedDaysAgo(cooldown - 1), now)
    ).toMatch(/appeal it again after/);
    expect(
      getSiteAppealRefusal(AppealCategory.Article, rejectedDaysAgo(cooldown + 1), now)
    ).toBeNull();
  });

  it('never applies the cooldown to Other, which has no single item', () => {
    expect(getSiteAppealRefusal(AppealCategory.Other, rejectedDaysAgo(1), now)).toBeNull();
  });

  it.each([AppealStatus.Approved, AppealStatus.Void])('allows a new appeal after %s', (status) => {
    expect(
      getSiteAppealRefusal(AppealCategory.Account, { status, resolvedAt: now }, now)
    ).toBeNull();
  });
});

describe('submitSiteAppealSchema', () => {
  const other = { category: 'Other', subject: 'A thing', message: MESSAGE };

  it.each([
    ['a javascript: link', { ...other, link: 'javascript:alert(1)' }],
    ['a bare word as link', { ...other, link: 'civitai' }],
    ['a short message', { ...other, message: 'too short' }],
    ['an Article with no id', { category: 'Article', message: MESSAGE }],
    ['an unknown category', { category: 'Image', entityId: 1, message: MESSAGE }],
  ])('rejects %s', (_, input) => {
    expect(submitSiteAppealSchema.safeParse(input).success).toBe(false);
  });

  it('reads an empty link as no link', () => {
    const parsed = submitSiteAppealSchema.parse({ ...other, link: '' });
    expect(parsed).toEqual({ ...other, link: undefined });
  });
});

describe('submitSiteAppeal cooldown', () => {
  const input = { category: AppealCategory.Article, entityId: 9, message: MESSAGE } as const;
  const rejectedDaysAgo = (days: number) =>
    ({ status: AppealStatus.Rejected, resolvedAt: new Date(Date.now() - days * DAY) } as never);

  beforeEach(() => {
    dbWrite.article.findUnique.mockResolvedValue({
      userId: USER.id,
      status: ArticleStatus.UnpublishedViolation,
    } as never);
  });

  // Literal day counts on both sides, so a changed cooldown fails here rather than moving the
  // test along with it.
  it('refuses a re-file 29 days after a rejection', async () => {
    dbWrite.appeal.findFirst.mockResolvedValue(rejectedDaysAgo(29));
    await expect(submitSiteAppeal({ user: USER, input })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(dbWrite.appeal.create).not.toHaveBeenCalled();
  });

  it('accepts a re-file 31 days after a rejection', async () => {
    dbWrite.appeal.findFirst.mockResolvedValue(rejectedDaysAgo(31));
    await submitSiteAppeal({ user: USER, input });
    expect(dbWrite.appeal.create).toHaveBeenCalled();
  });
});

describe('getSiteAppealState', () => {
  const { dbRead } = dbMock;

  it('lists no model a content wipe kept', async () => {
    dbRead.model.findMany.mockResolvedValueOnce([
      { id: 2, name: 'taken down', meta: {} },
      { id: 1, name: 'kept by a wipe', meta: { removedWithOwner: true } },
    ] as never);

    const state = await getSiteAppealState({ user: USER });

    expect(state.models).toEqual([{ id: 2, name: 'taken down' }]);
  });

  beforeEach(() => {
    dbWrite.user.findUnique.mockResolvedValue({ bannedAt: null, muted: true } as never);
    dbRead.model.findMany.mockResolvedValue([]);
  });

  it("reads only the caller's own rows", async () => {
    const state = await getSiteAppealState({ user: USER });

    expect(state.restriction).toEqual({ banned: false, muted: true });
    expect(dbWrite.user.findUnique.mock.calls[0][0].where).toEqual({ id: USER.id });
    expect(dbRead.article.findMany.mock.calls[0][0].where).toEqual({
      userId: USER.id,
      status: ArticleStatus.UnpublishedViolation,
    });
    expect(dbRead.model.findMany.mock.calls[0][0].where).toEqual({
      userId: USER.id,
      status: ModelStatus.UnpublishedViolation,
      deletedAt: null,
    });
    expect(dbRead.appeal.findMany.mock.calls[0][0].where).toEqual({
      userId: USER.id,
      category: { not: null },
    });
  });

  // The appellant reads these rows; the moderator's notes, reason and identity stay out. Equality,
  // because the Prisma mock ignores `select` and a key added to it would otherwise pass unseen.
  it('selects no moderator-only appeal field', async () => {
    await getSiteAppealState({ user: USER });
    expect(Object.keys(dbRead.appeal.findMany.mock.calls[0][0].select).sort()).toEqual([
      'appealMessage',
      'category',
      'context',
      'createdAt',
      'entityId',
      'entityType',
      'id',
      'resolvedAt',
      'resolvedMessage',
      'status',
    ]);
  });
});
