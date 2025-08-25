import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  CreateChangelogInput,
  DeleteChangelogInput,
  GetChangelogsInput,
  UpdateChangelogInput,
} from '~/server/schema/changelog.schema';
import { throwDbError } from '~/server/utils/errorHandling';
import { DomainColor } from '~/shared/utils/prisma/enums';

export type Changelog = AsyncReturnType<typeof getChangelogs>['items'][number];
export const getChangelogs = async (input: GetChangelogsInput & { hasFeature: boolean }) => {
  const { hasFeature, limit, cursor, sortDir, search, dateBefore, dateAfter, types, tags, domain } =
    input;

  const where: Prisma.ChangelogWhereInput = {
    sticky: false,
    domain: { hasSome: domain ? [DomainColor.all, domain] : [DomainColor.all] },
  };

  if (!hasFeature) {
    where['disabled'] = false;
  }

  if (search && search.length > 0) {
    where['OR'] = [
      {
        title: { contains: search, mode: 'insensitive' },
      },
      {
        content: { contains: search, mode: 'insensitive' },
      },
    ];
  }

  const now = new Date();
  const dateAfterMod = !dateAfter
    ? undefined
    : dateAfter.getTime() > now.getTime()
    ? now
    : dateAfter;
  const dateBeforeMod = !dateBefore
    ? hasFeature
      ? undefined
      : now
    : dateBefore.getTime() > now.getTime()
    ? now
    : dateBefore;

  if (dateAfterMod) {
    where['effectiveAt'] = { lte: dateBeforeMod, gte: dateAfterMod };
  } else {
    where['effectiveAt'] = { lte: dateBeforeMod };
  }

  if (types && types.length > 0) {
    where['type'] = { in: types };
  }

  // TODO this is an "or", do we want to change it to "and"? or offer option?
  if (tags && tags.length > 0) {
    where['tags'] = { hasSome: tags };
  }

  const skip = cursor ?? 0;

  const select = Prisma.validator<Prisma.ChangelogSelect>()({
    id: true,
    title: true,
    titleColor: true,
    content: true,
    link: true,
    cta: true,
    effectiveAt: true,
    updatedAt: true,
    createdAt: true,
    type: true,
    tags: true,
    disabled: true,
    sticky: true,
    domain: true,
  });

  try {
    const data = await dbRead.changelog.findMany({
      select,
      where,
      take: limit + 1,
      skip,
      orderBy: [
        {
          effectiveAt: sortDir,
        },
        {
          id: sortDir,
        },
      ],
    });

    const hasMore = data.length > limit;
    if (hasMore) {
      data.pop();
    }

    const whereSticky: Prisma.ChangelogWhereInput = {
      sticky: true,
      domain: { hasSome: domain ? [DomainColor.all, domain] : [DomainColor.all] },
    };

    if (!hasFeature) {
      whereSticky['disabled'] = false;
    }

    const now = new Date();
    const dateBeforeMod = hasFeature ? undefined : now;
    whereSticky['effectiveAt'] = { lte: dateBeforeMod };

    const stickyItems =
      skip > 0
        ? []
        : await dbRead.changelog.findMany({
            select,
            where: whereSticky,
            orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }],
          });

    const retData = [...stickyItems, ...data];

    return {
      items: retData,
      nextCursor: hasMore ? skip + data.length : undefined,
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const createChangelog = async (data: CreateChangelogInput) => {
  try {
    return dbWrite.changelog.create({ data: { ...data, updatedAt: data.effectiveAt } });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const updateChangelog = async (data: UpdateChangelogInput) => {
  const { id, ...rest } = data;

  try {
    return dbWrite.changelog.update({
      where: { id },
      data: rest,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteChangelog = async ({ id }: DeleteChangelogInput) => {
  try {
    return dbWrite.changelog.delete({
      where: { id },
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getAllTags = async (input?: { domain?: DomainColor }) => {
  const { domain } = input ?? {};

  const data = await dbRead.changelog.findMany({
    select: { tags: true },
    where: {
      disabled: false,
      effectiveAt: { lte: new Date() },
      domain: { hasSome: domain ? [DomainColor.all, domain] : [DomainColor.all] },
    },
  });

  return [...new Set(data.flatMap((x) => x.tags ?? []))];
};

export const getLatestChangelog = async (input?: { domain?: DomainColor }) => {
  const { domain } = input ?? {};

  const cl = await dbRead.changelog.findFirst({
    select: { effectiveAt: true },
    where: {
      disabled: false,
      effectiveAt: { lte: new Date() },
      domain: { hasSome: domain ? [DomainColor.all, domain] : [DomainColor.all] },
    },
    orderBy: { effectiveAt: 'desc' },
    // take: 1,
  });

  return !cl ? 0 : cl.effectiveAt.getTime();
};
