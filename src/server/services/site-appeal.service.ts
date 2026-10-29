import type { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import type { SiteAppealContext, SubmitSiteAppealInput } from '~/server/schema/site-appeal.schema';
import { isPrismaUniqueViolation, throwBadRequestError } from '~/server/utils/errorHandling';
import type { RemovedWithOwnerMeta } from '~/server/services/model-removed-with-owner.service';
import {
  AppealCategory,
  AppealStatus,
  ArticleStatus,
  EntityType,
  ModelStatus,
} from '~/shared/utils/prisma/enums';

// A rejected appeal for the same item can be filed again once this has passed since the ruling.
export const SITE_APPEAL_REFILE_COOLDOWN_DAYS = 30;

export const SITE_APPEAL_ALREADY_PENDING = 'You already have an appeal for this under review.';
export const SITE_APPEAL_NOT_RESTRICTED = 'Your account has no restriction to appeal.';
export const SITE_APPEAL_NOT_REMOVED =
  'Only your own content removed by a moderator can be appealed here.';

const ENTITY_TYPE: Record<AppealCategory, EntityType> = {
  [AppealCategory.Account]: EntityType.User,
  [AppealCategory.Article]: EntityType.Article,
  [AppealCategory.Model]: EntityType.Model,
  [AppealCategory.Other]: EntityType.User,
};

/** An appeal row only its appellant may read: no moderator-only field. */
const appellantSelect = {
  id: true,
  category: true,
  entityType: true,
  entityId: true,
  status: true,
  appealMessage: true,
  context: true,
  createdAt: true,
  resolvedAt: true,
  resolvedMessage: true,
} satisfies Prisma.AppealSelect;

type AppealUser = { id: number };

async function getAccountRestriction(userId: number) {
  // Primary, not replica: this decides whether a submit is allowed, and a mute set a moment ago
  // must count.
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { bannedAt: true, muted: true },
  });
  return { banned: !!user?.bannedAt, muted: !!user?.muted };
}

function getRemovedArticles(userId: number) {
  return dbRead.article.findMany({
    where: { userId, status: ArticleStatus.UnpublishedViolation },
    select: { id: true, title: true },
    orderBy: { id: 'desc' },
    take: 100,
  });
}

// A model a content wipe kept is in the same status but was not taken down for what it is: there is
// no decision on it to appeal.
const removedWithOwner = (meta: unknown) =>
  (meta as RemovedWithOwnerMeta | null)?.removedWithOwner === true;

async function getRemovedModels(userId: number) {
  const models = await dbRead.model.findMany({
    where: { userId, status: ModelStatus.UnpublishedViolation, deletedAt: null },
    select: { id: true, name: true, meta: true },
    orderBy: { id: 'desc' },
    take: 100,
  });
  return models.filter((m) => !removedWithOwner(m.meta)).map(({ id, name }) => ({ id, name }));
}

/** Everything the appeal page renders for its user: what they may appeal, and what they filed. */
export async function getSiteAppealState({ user }: { user: AppealUser }) {
  const [restriction, articles, models, appeals] = await Promise.all([
    getAccountRestriction(user.id),
    getRemovedArticles(user.id),
    getRemovedModels(user.id),
    dbRead.appeal.findMany({
      where: { userId: user.id, category: { not: null } },
      select: appellantSelect,
      orderBy: { id: 'desc' },
      take: 20,
    }),
  ]);
  return { restriction, articles, models, appeals };
}

/**
 * The refusal for filing again on the same item, or null. Other has no item, so it is never
 * refused here; one Pending at a time still holds through the unique index.
 *
 * Unlike `getAppealRefusal` for in-app appeals, a rejection is not final: re-filing after the
 * cooldown is allowed, and the moderator queue marks it as a repeat.
 */
export function getSiteAppealRefusal(
  category: AppealCategory,
  latest: { status: AppealStatus; resolvedAt: Date | null } | null | undefined,
  now = new Date()
) {
  if (latest?.status === AppealStatus.Pending) return SITE_APPEAL_ALREADY_PENDING;
  if (category === AppealCategory.Other) return null;
  if (latest?.status === AppealStatus.Rejected && latest.resolvedAt) {
    const allowedAt = dayjs(latest.resolvedAt).add(SITE_APPEAL_REFILE_COOLDOWN_DAYS, 'day');
    if (allowedAt.isAfter(now))
      return `This was reviewed recently. You can appeal it again after ${allowedAt.format(
        'MMMM D, YYYY'
      )}.`;
  }
  return null;
}

async function assertEligible(input: SubmitSiteAppealInput, userId: number) {
  switch (input.category) {
    case AppealCategory.Account: {
      const restriction = await getAccountRestriction(userId);
      if (!restriction.banned && !restriction.muted)
        throw throwBadRequestError(SITE_APPEAL_NOT_RESTRICTED);
      return { entityId: userId, context: { restriction } satisfies SiteAppealContext };
    }
    case AppealCategory.Article: {
      const article = await dbWrite.article.findUnique({
        where: { id: input.entityId },
        select: { userId: true, status: true },
      });
      if (article?.userId !== userId || article.status !== ArticleStatus.UnpublishedViolation)
        throw throwBadRequestError(SITE_APPEAL_NOT_REMOVED);
      return { entityId: input.entityId, context: null };
    }
    case AppealCategory.Model: {
      const model = await dbWrite.model.findUnique({
        where: { id: input.entityId },
        select: { userId: true, status: true, deletedAt: true, meta: true },
      });
      if (
        model?.userId !== userId ||
        model.deletedAt ||
        model.status !== ModelStatus.UnpublishedViolation ||
        removedWithOwner(model.meta)
      )
        throw throwBadRequestError(SITE_APPEAL_NOT_REMOVED);
      return { entityId: input.entityId, context: null };
    }
    case AppealCategory.Other:
      return {
        entityId: userId,
        context: { subject: input.subject, link: input.link } satisfies SiteAppealContext,
      };
  }
}

export async function submitSiteAppeal({
  user,
  input,
}: {
  user: AppealUser;
  input: SubmitSiteAppealInput;
}) {
  const { entityId, context } = await assertEligible(input, user.id);
  const entityType = ENTITY_TYPE[input.category];

  const latest = await dbWrite.appeal.findFirst({
    where: { userId: user.id, category: input.category, entityType, entityId },
    orderBy: { id: 'desc' },
    select: { status: true, resolvedAt: true },
  });
  const refusal = getSiteAppealRefusal(input.category, latest);
  if (refusal) throw throwBadRequestError(refusal);

  try {
    return await dbWrite.appeal.create({
      data: {
        userId: user.id,
        category: input.category,
        entityType,
        entityId,
        appealMessage: input.message,
        context: context ?? undefined,
      },
      select: appellantSelect,
    });
  } catch (error) {
    // Lost the race on the one-Pending-form-appeal index to a concurrent submit.
    if (isPrismaUniqueViolation(error)) throw throwBadRequestError(SITE_APPEAL_ALREADY_PENDING);
    throw error;
  }
}
