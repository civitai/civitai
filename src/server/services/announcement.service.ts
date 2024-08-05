import { Prisma } from '@prisma/client';
import { SessionUser } from 'next-auth';
import { dbRead } from '~/server/db/client';
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
export const getAnnouncements = async ({
  dismissed,
  limit,
  ids,
  user,
}: GetAnnouncementsInput & { user?: SessionUser }) => {
  const now = new Date();
  const AND: Prisma.Enumerable<Prisma.AnnouncementWhereInput> = [
    {
      OR: [{ startsAt: { lte: now } }, { startsAt: { equals: null } }],
    },
    {
      OR: [{ endsAt: { gte: now } }, { endsAt: { equals: null } }],
    },
    {
      OR: [
        { metadata: { path: ['targetAudience'], equals: Prisma.AnyNull } },
        { metadata: { path: ['targetAudience'], equals: 'all' } },
        // Add targeted announcements.
        user
          ? { metadata: { path: ['targetAudience'], equals: 'authenticated' } }
          : { metadata: { path: ['targetAudience'], equals: 'unauthenticated' } },
      ],
    },
  ];

  if (ids) {
    AND.push({ id: { in: ids } });
  }

  if (dismissed) {
    AND.push({
      OR: [{ id: { notIn: dismissed } }, { metadata: { path: ['dismissible'], equals: false } }],
    });
  }

  const announcements = await dbRead.announcement.findMany({
    take: limit,
    where: {
      AND,
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
