import { ReportEntity, ReportStatus } from '@prisma/client';
import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { infiniteQuerySchema } from '~/server/schema/base.schema';
import { isDefined } from '~/utils/type-guards';

const getReportsInfiniteSchema = infiniteQuerySchema.extend({
  entityType: z.nativeEnum(ReportEntity),
  status: z
    .union([z.nativeEnum(ReportStatus), z.nativeEnum(ReportStatus).array()])
    .transform((val) => (Array.isArray(val) ? val : [val]))
    .optional(),
});

export async function getReportsInfinite({
  limit,
  cursor,
  entityType,
  status,
}: z.infer<typeof getReportsInfiniteSchema>) {
  const take = limit + 1;

  const reports = await dbRead.report2.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      entityType,
      status: !!status?.length ? { in: status } : { not: ReportStatus.Actioned },
    },
    select: {
      id: true,
      entityId: true,
      entityType: true,
      status: true,
      items: { select: { reason: true } },
    },
  });

  let nextCursor: number | undefined;
  if (reports.length > limit) {
    const nextItem = reports.pop();
    nextCursor = nextItem?.id;
  }

  const items = reports.map(({ items, ...report }) => ({
    ...report,
    reasons: items.map((x) => x.reason),
  }));

  return {
    items: await getAssociatedReportsData(entityType, items),
    cursor: nextCursor,
  };
}

async function getAssociatedReportsData<T extends { entityId: number }>(
  entityType: ReportEntity,
  reports: T[]
) {
  const entityIds = reports.map((x) => x.entityId);
  switch (entityType) {
    case ReportEntity.Image:
      const images = await dbRead.image.findMany({
        where: { id: { in: entityIds } },
        select: {
          id: true,
          name: true,
          url: true,
          nsfw: true,
          width: true,
          height: true,
          hash: true,
          meta: true,
          ingestion: true,
          scannedAt: true,
          userId: true,
          postId: true,
        },
      });

      return reports
        .map((report) => {
          const image = images.find((image) => image.id === report.entityId);
          if (!image) return null;
          return {
            ...report,
            image,
            entityType: ReportEntity.Image,
          };
        })
        .filter(isDefined);

    default:
      return reports.map((report) => ({ ...report, entityType }));
  }
}
