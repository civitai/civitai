import { dbRead } from '~/server/db/client';
import { Prisma } from '@prisma/client';
import {
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

export const getAnnouncements = async ({ dismissed, ids }: GetAnnouncementsInput) => {
  const now = new Date();
  return dbRead.announcement.findMany({
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
    },
  });
};
