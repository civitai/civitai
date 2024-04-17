import { Prisma } from '@prisma/client';

import { dbWrite, dbRead } from '~/server/db/client';
import { GetUserDownloadsSchema, HideDownloadInput } from '~/server/schema/download.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

type DownloadHistoryRaw = {
  downloadAt: Date;
  modelId: number;
  name: string;
  version: string;
  modelVersionId: number;
};
export const getUserDownloads = async ({
  limit = DEFAULT_PAGE_SIZE,
  userId,
  cursor,
}: Partial<GetUserDownloadsSchema> & {
  userId: number;
}) => {
  const AND = [Prisma.sql`dh."userId" = ${userId}`, Prisma.sql`dh.hidden = false`];
  if (cursor) AND.push(Prisma.sql`dh."downloadAt" < ${cursor}`);

  const downloadHistory = await dbRead.$queryRaw<DownloadHistoryRaw[]>`
    SELECT
      dh."downloadAt",
      m.id as "modelId",
      m."name" as "name",
      mv."name" as "version",
      dh."modelVersionId"
    FROM "DownloadHistory" dh
    JOIN "ModelVersion" mv ON mv.id = dh."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY dh."downloadAt" DESC
    LIMIT ${limit}
  `;

  const items = downloadHistory.map((dh) => ({
    downloadAt: dh.downloadAt,
    modelVersion: {
      id: dh.modelVersionId,
      name: dh.version,
      model: {
        id: dh.modelId,
        name: dh.name,
      },
    },
  }));

  return { items };
};

export const updateUserActivityById = ({
  modelVersionId,
  userId,
  data,
  all = false,
}: HideDownloadInput & { data: Prisma.DownloadHistoryUpdateInput; userId: number }) => {
  return dbWrite.downloadHistory.updateMany({
    where: { modelVersionId: !all ? modelVersionId : undefined, userId, hidden: { equals: false } },
    data,
  });
};
