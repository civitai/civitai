import { Prisma } from '@prisma/client';

import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { GetUserDownloadsSchema, HideDownloadInput } from '~/server/schema/download.schema';
import { getUserSettings, setUserSetting } from '~/server/services/user.service';
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

  const { hideDownloadsSince } = await getUserSettings(userId);
  if (hideDownloadsSince) AND.push(Prisma.sql`dh."downloadAt" > ${new Date(hideDownloadsSince)}`);

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

export async function addUserDownload({
  userId,
  modelVersionId,
  downloadAt,
}: {
  userId?: number;
  modelVersionId: number;
  downloadAt?: Date;
}) {
  if (!userId) return;

  const excludedUsers = await sysRedis.packed.sMembers<number>(
    REDIS_SYS_KEYS.DOWNLOAD.HISTORY_EXCLUSION
  );
  if (excludedUsers.includes(userId)) return;

  await dbWrite.$executeRaw`
    -- Update user history
    INSERT INTO "DownloadHistory" ("userId", "modelVersionId", "downloadAt", hidden)
    VALUES (${userId}, ${modelVersionId}, ${downloadAt ?? new Date()}, false)
    ON CONFLICT ("userId", "modelVersionId") DO UPDATE SET "downloadAt" = excluded."downloadAt"
  `;
}

export async function excludeUserDownloadHistory(userIds: number | number[]) {
  if (!Array.isArray(userIds)) userIds = [userIds];
  await sysRedis.packed.sAdd(REDIS_SYS_KEYS.DOWNLOAD.HISTORY_EXCLUSION, userIds);
}

export const updateUserActivityById = ({
  modelVersionId,
  userId,
  data,
  all = false,
}: HideDownloadInput & { data: Prisma.DownloadHistoryUpdateInput; userId: number }) => {
  if (all) {
    setUserSetting(userId, { hideDownloadsSince: Date.now() });
  } else {
    return dbWrite.downloadHistory.updateMany({
      where: {
        modelVersionId: !all ? modelVersionId : undefined,
        userId,
        hidden: { equals: false },
      },
      data,
    });
  }
};
