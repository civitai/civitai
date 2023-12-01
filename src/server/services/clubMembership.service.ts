import dayjs from 'dayjs';
import { ClubMembershipRole, Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  ClubMembershipOnClubInput,
  CreateClubMembershipInput,
  GetInfiniteClubMembershipsSchema,
  UpdateClubMembershipInput,
} from '~/server/schema/clubMembership.schema';
import { ClubMembershipSort } from '~/server/common/enums';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';
import { calculateClubTierNextBillingDate } from '~/utils/clubs';
import { throwBadRequestError } from '~/server/utils/errorHandling';

export const getClubMemberships = async <TSelect extends Prisma.ClubMembershipSelect>({
  input: { cursor, limit: take, clubId, clubTierId, roles, userId, sort },
  select,
}: {
  input: GetInfiniteClubMembershipsSchema;
  select: TSelect;
}) => {
  const orderBy: Prisma.ClubMembershipFindManyArgs['orderBy'] = [];
  if (sort === ClubMembershipSort.NextBillingDate) orderBy.push({ nextBillingAt: 'asc' });
  else if (sort === ClubMembershipSort.MostExpensive) orderBy.push({ unitAmount: 'desc' });
  else orderBy.push({ startedAt: 'asc' });

  return dbRead.clubMembership.findMany({
    take,
    cursor: cursor ? { id: cursor } : undefined,
    select,
    where: {
      clubId,
      clubTierId,
      userId,
      role: (roles?.length ?? 0) > 0 ? { in: roles } : undefined,
    },
    orderBy,
  });
};

export const clubMembershipOnClub = async <TSelect extends Prisma.ClubMembershipSelect>({
  input: { clubId, userId },
  select,
}: {
  input: ClubMembershipOnClubInput & { userId: number };
  select: TSelect;
}) => {
  return dbRead.clubMembership.findUnique({
    select,
    where: {
      userId_clubId: {
        userId,
        clubId,
      },
    },
  });
};

export const createClubMembership = async ({
  clubTierId,
  userId,
}: CreateClubMembershipInput & { userId: number }) => {
  const clubTier = await dbRead.clubTier.findUnique({
    where: { id: clubTierId },
    select: {
      clubId: true,
      unitAmount: true,
      currency: true,
      name: true,
      club: {
        select: {
          name: true,
        },
      },
    },
  });

  if (!clubTier) throw new Error('Club tier does not exist');

  const clubMembership = await dbRead.clubMembership.findFirst({
    where: { clubId: clubTier.clubId, userId },
  });

  if (clubMembership) throw new Error('User is already a member of this club');

  const membership = await dbWrite.$transaction(async (tx) => {
    const createDate = dayjs();
    const nextBillingDate = createDate.add(1, 'month');

    const membership = await tx.clubMembership.create({
      data: {
        startedAt: createDate.toDate(),
        nextBillingAt: nextBillingDate.toDate(),
        clubId: clubTier.clubId,
        clubTierId,
        userId,
        // Memberships are always created as members.
        // They can be updated by moderators, club admins and owners later on.
        role: ClubMembershipRole.Member,
        unitAmount: clubTier.unitAmount,
        currency: clubTier.currency,
      },
    });

    await createBuzzTransaction({
      toAccountType: 'Club',
      toAccountId: clubTier.clubId,
      fromAccountId: userId,
      type: TransactionType.ClubMembership,
      amount: clubTier.unitAmount,
      description: `Membership fee for ${clubTier.club.name} - ${clubTier.name}`,
      details: {
        clubMembershipId: membership.id,
      },
    });
    // Attempt to pay the membership fee

    return membership;
  });

  return membership;
};

export const updateClubMembership = async ({
  clubTierId,
  userId,
  role,
  unitAmount,
  isForcedUpdate,
}: UpdateClubMembershipInput & {
  isForcedUpdate?: boolean;
  userId: number;
  unitAmount?: number;
}) => {
  const clubTier = await dbRead.clubTier.findUnique({
    where: { id: clubTierId },
    select: {
      id: true,
      clubId: true,
      unitAmount: true,
      currency: true,
      name: true,
      club: {
        select: {
          name: true,
        },
      },
    },
  });

  if (!clubTier) throw new Error('Club tier does not exist');

  const clubMembership = await dbRead.clubMembership.findFirst({
    where: { clubId: clubTier.clubId, userId },
    select: {
      id: true,
      role: true,
      startedAt: true,
      nextBillingAt: true,
      unitAmount: true,
      expiresAt: true,
      cancelledAt: true,
      downgradeClubTierId: true,
      club: {
        select: {
          id: true,
          name: true,
        },
      },
      clubTier: {
        select: {
          id: true,
          name: true,
          unitAmount: true,
          currency: true,
        },
      },
    },
  });

  if (!clubMembership) throw new Error('User is not a member of this club');

  const isSameTier = clubTier.id === clubMembership.clubTier.id;
  const isUpgrade = !isSameTier && clubTier.unitAmount > clubMembership.clubTier.unitAmount;
  const isDowngrade = !isSameTier && clubTier.unitAmount < clubMembership.clubTier.unitAmount;

  const membership = await dbWrite.$transaction(async (tx) => {
    const { nextBillingDate } = calculateClubTierNextBillingDate({
      membership: clubMembership,
      upgradeTier: clubTier,
    });

    const membership = await tx.clubMembership.update({
      where: {
        id: clubMembership.id,
      },
      data: {
        nextBillingAt: isUpgrade ? nextBillingDate.toDate() : undefined,
        clubTierId: isUpgrade ? clubTier.id : undefined,
        // Memberships are always created as members.
        // They can be updated by moderators, club admins and owners later on.
        role: role ?? ClubMembershipRole.Member,
        unitAmount: isDowngrade
          ? // When downgrading, we'll want to keep the lowest amount possible.
            Math.min(clubTier.unitAmount, unitAmount ?? Infinity)
          : // When upgrading, if this was a forced up
            unitAmount ?? clubTier.unitAmount,
        currency: clubTier.currency,
        downgradeClubTierId: isSameTier || isUpgrade ? null : isDowngrade ? clubTier.id : undefined,
      },
    });

    if (!isForcedUpdate && isUpgrade) {
      await createBuzzTransaction({
        toAccountType: 'Club',
        toAccountId: clubTier.clubId,
        fromAccountId: userId,
        type: TransactionType.ClubMembership,
        amount: clubTier.unitAmount,
        description: `Membership fee for ${clubTier.club.name} - ${clubTier.name}`,
        details: {
          clubMembershipId: membership.id,
        },
      });
    }

    return membership;
  });

  return membership;
};
