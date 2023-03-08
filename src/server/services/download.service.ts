import { Prisma } from '@prisma/client';

import { dbWrite, dbRead } from '~/server/db/client';
import { GetUserDownloadsSchema, HideDownloadInput } from '~/server/schema/download.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const getUserDownloads = async <TSelect extends Prisma.DownloadHistorySelect>({
  limit = DEFAULT_PAGE_SIZE,
  cursor,
  userId,
  select,
  count = false,
}: Partial<GetUserDownloadsSchema> & {
  userId: number;
  select: TSelect;
  count?: boolean;
}) => {
  const where: Prisma.DownloadHistoryWhereInput = {
    userId,
  };
  const downloadHistoryQuery = dbRead.downloadHistory.findMany({
    take: limit,
    cursor: cursor ? { id: cursor } : undefined,
    where,
    select,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });

  if (count) {
    const [items, count] = await dbRead.$transaction([
      downloadHistoryQuery,
      dbRead.downloadHistory.count({ where }),
    ]);

    return { items, count };
  }

  const items = await downloadHistoryQuery;

  return { items };
};

export const updateUserActivityById = ({
  id,
  userId,
  data,
  all = false,
}: HideDownloadInput & { data: Prisma.UserActivityUpdateInput }) => {
  return dbWrite.userActivity.updateMany({
    where: { id: !all ? id : undefined, userId, hide: { equals: false } },
    data,
  });
};
