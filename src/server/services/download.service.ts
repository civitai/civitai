import { Prisma } from '@prisma/client';

import { dbWrite, dbRead } from '~/server/db/client';
import { GetUserDownloadsSchema, HideDownloadInput } from '~/server/schema/download.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const getUserDownloads = async <TSelect extends Prisma.DownloadHistorySelect>({
  limit = DEFAULT_PAGE_SIZE,
  userId,
  cursor,
  select,
  count = false,
}: Partial<GetUserDownloadsSchema> & {
  userId: number;
  select: TSelect;
  count?: boolean;
}) => {
  let where: Prisma.DownloadHistoryWhereInput = {
    userId,
  };

  if (cursor) {
    where = {
      ...where,
      downloadAt: { lt: cursor },
    };
  }

  const downloadHistoryQuery = dbRead.downloadHistory.findMany({
    take: limit,
    where,
    select,
    orderBy: [{ downloadAt: 'desc' }, { modelVersionId: 'asc' }],
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
  modelVersionId,
  userId,
  data,
  all = false,
}: HideDownloadInput & { data: Prisma.DownloadHistoryUpdateInput }) => {
  return dbWrite.downloadHistory.updateMany({
    where: { modelVersionId: !all ? modelVersionId : undefined, userId, hidden: { equals: false } },
    data,
  });
};
