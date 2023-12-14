import dayjs from 'dayjs';
import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  GetPagedClubAdminInviteSchema,
  GetPagedClubAdminSchema,
  UpsertClubAdminInviteInput,
} from '../schema/clubAdmin.schema';
import { getPagination, getPagingData } from '../utils/pagination-helpers';

export const getClubAdminInvites = async <TSelect extends Prisma.ClubAdminInviteSelect>({
  input: { page, limit, clubId },
  select,
}: {
  input: GetPagedClubAdminInviteSchema;
  select: TSelect;
}) => {
  const { take, skip } = getPagination(limit, page);
  const orderBy: Prisma.ClubAdminInviteFindManyArgs['orderBy'] = [];

  orderBy.push({ createdAt: 'asc' });

  const where: Prisma.ClubAdminInviteWhereInput = {
    clubId,
  };

  const items = await dbRead.clubAdminInvite.findMany({
    take,
    skip,
    select,
    where,
    orderBy,
  });

  const count = await dbRead.clubAdminInvite.count({ where });

  return getPagingData({ items, count }, take, page);
};

export const getClubAdmins = async <TSelect extends Prisma.ClubAdminSelect>({
  input: { page, limit, clubId },
  select,
}: {
  input: GetPagedClubAdminSchema;
  select: TSelect;
}) => {
  const { take, skip } = getPagination(limit, page);
  const orderBy: Prisma.ClubAdminFindManyArgs['orderBy'] = [];

  orderBy.push({ createdAt: 'asc' });

  const where: Prisma.ClubAdminWhereInput = {
    clubId,
  };

  const items = await dbRead.clubAdmin.findMany({
    take,
    skip,
    select,
    where,
    orderBy,
  });

  const count = await dbRead.clubAdmin.count({ where });

  return getPagingData({ items, count }, take, page);
};

export const upsertClubAdminInvite = async ({ input }: { input: UpsertClubAdminInviteInput }) => {
  return dbWrite.clubAdminInvite.upsert({
    where: { id: input.id ?? '-1' },
    update: {
      expiresAt: input.expiresAt,
      permissions: input.permissions,
    },
    create: {
      clubId: input.clubId,
      expiresAt: input.expiresAt,
      permissions: input.permissions,
    },
  });
};
