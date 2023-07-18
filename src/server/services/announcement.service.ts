import { dbRead } from '~/server/db/client';
import { Prisma } from '@prisma/client';
import {
  AnnouncementMetaSchema,
  GetAnnouncementsInput,
  GetLatestAnnouncementInput,
} from '~/server/schema/announcement.schema';

export const getLatestAnnouncement = async <TSelect extends Prisma.AnnouncementSelect>({
  dismissed,
  select,
}: GetLatestAnnouncementInput & { select: TSelect }) => {
  const now = new Date();
  return await dbRead.announcement.findFirst({
    where: {
      id: { notIn: dismissed },
      AND: [
        {
          OR: [{ startsAt: { lte: now } }, { startsAt: { equals: null } }],
        },
        {
          OR: [{ endsAt: { gte: now } }, { endsAt: { equals: null } }],
        },
      ],
    },
    orderBy: { id: 'desc' },
    select,
  });
};

export type GetAnnouncement = Awaited<ReturnType<typeof getAnnouncements>>[number];
export const getAnnouncements = async ({ dismissed, ids }: GetAnnouncementsInput) => {
  const now = new Date();
  const announcements = await dbRead.announcement.findMany({
    where: {
      id: { notIn: dismissed, in: ids },
      AND: [
        {
          OR: [{ startsAt: { lte: now } }, { startsAt: { equals: null } }],
        },
        {
          OR: [{ endsAt: { gte: now } }, { endsAt: { equals: null } }],
        },
      ],
    },
    orderBy: { id: 'desc' },
    select: {
      id: true,
      title: true,
      content: true,
      color: true,
      emoji: true,
      metadata: true,
    },
  });

  return announcements.map(({ metadata, ...announcement }) => ({
    ...announcement,
    metadata: metadata as AnnouncementMetaSchema,
  }));
};
