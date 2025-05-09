import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  CreateChangelogInput,
  GetChangelogsInput,
  UpdateChangelogInput,
} from '~/server/schema/changelog.schema';
import { throwDbError } from '~/server/utils/errorHandling';

export type Changelog = AsyncReturnType<typeof getChangelogs>['items'][number];
export const getChangelogs = async (input: GetChangelogsInput & { isModerator?: boolean }) => {
  const { isModerator, limit, cursor, sortDir, search, dateBefore, dateAfter, types, tags } = input;

  const where: Prisma.ChangelogWhereInput = {};

  if (!isModerator) {
    where['disabled'] = false;
  }

  if (search && search.length > 0) {
    where['OR'] = [
      {
        title: { contains: search },
      },
      {
        content: { contains: search },
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
    ? isModerator
      ? new Date('1970-01-01')
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

  try {
    const data = await dbRead.changelog.findMany({
      select: {
        id: true,
        title: true,
        content: true,
        link: true,
        cta: true,
        effectiveAt: true,
        updatedAt: true,
        type: true,
        tags: true,
      },
      where,
      take: limit + 1,
      skip: cursor ?? 0,
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

    return {
      items: data,
      nextCursor: hasMore ? data.length : undefined,
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const createChangelog = async (data: CreateChangelogInput) => {
  try {
    return dbWrite.changelog.create({ data });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const updateChangelog = async (data: UpdateChangelogInput) => {
  const { id, ...rest } = data;

  // TODO check if this only updates non-undefined values
  try {
    return dbWrite.changelog.update({
      where: { id },
      data: rest,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getAllTags = async () => {
  const data = await dbRead.changelog.findMany({
    select: {
      tags: true,
    },
    where: {
      disabled: false,
      effectiveAt: { lte: new Date() },
    },
  });

  return [...new Set(data.flatMap((x) => x.tags ?? []))];
};
