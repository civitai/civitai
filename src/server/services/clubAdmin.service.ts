import dayjs from '~/shared/utils/dayjs';
import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  AcceptClubAdminInviteInput,
  DeleteClubAdminInput,
  DeleteClubAdminInviteInput,
  GetPagedClubAdminInviteSchema,
  GetPagedClubAdminSchema,
  UpdateClubAdminInput,
  UpsertClubAdminInviteInput,
} from '../schema/clubAdmin.schema';
import { getPagination, getPagingData } from '../utils/pagination-helpers';
import { throwBadRequestError } from '../utils/errorHandling';
import { userContributingClubs } from './club.service';

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

export const deleteClubAdminInvite = async ({ input }: { input: DeleteClubAdminInviteInput }) => {
  return dbWrite.clubAdminInvite.delete({ where: { id: input.id } });
};

export const acceptClubAdminInvite = async ({
  input: { id, userId },
}: {
  input: AcceptClubAdminInviteInput & { userId: number };
}) => {
  const clubAdminInvite = await dbRead.clubAdminInvite.findUniqueOrThrow({
    where: { id: id },
    select: { clubId: true, expiresAt: true, permissions: true },
  });

  if (clubAdminInvite.expiresAt && dayjs(clubAdminInvite.expiresAt).isBefore(dayjs())) {
    throw throwBadRequestError('Invite has expired');
  }

  const [userClub] = await userContributingClubs({ userId, clubIds: [clubAdminInvite.clubId] });

  if (userClub) {
    throw throwBadRequestError('You are already a club admin or owner for this club');
  }

  return dbWrite.$transaction(async (tx) => {
    // Accept invite
    const clubAdmin = await tx.clubAdmin.create({
      data: {
        clubId: clubAdminInvite.clubId,
        userId,
        permissions: clubAdminInvite.permissions,
      },
    });

    // Delete invite
    await tx.clubAdminInvite.delete({ where: { id } });

    return clubAdmin;
  });
};

export const updateClubAdmin = async ({ input }: { input: UpdateClubAdminInput }) => {
  return dbWrite.clubAdmin.update({
    where: {
      clubId_userId: {
        clubId: input.clubId,
        userId: input.userId,
      },
    },
    data: {
      permissions: input.permissions,
    },
  });
};

export const deleteClubAdmin = async ({ input }: { input: DeleteClubAdminInput }) => {
  return dbWrite.clubAdmin.delete({
    where: {
      clubId_userId: {
        clubId: input.clubId,
        userId: input.userId,
      },
    },
  });
};
