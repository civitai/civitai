import dayjs from '~/shared/utils/dayjs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ClubAdminPermission } from '~/shared/utils/prisma/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  ToggleClubMembershipStatusInput,
  ClubMembershipOnClubInput,
  CreateClubMembershipInput,
  GetInfiniteClubMembershipsSchema,
  OwnerRemoveClubMembershipInput,
  UpdateClubMembershipInput,
} from '~/server/schema/clubMembership.schema';
import { ClubMembershipSort } from '~/server/common/enums';
import { createBuzzTransaction, getUserBuzzAccount } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';
import { calculateClubTierNextBillingDate } from '~/utils/clubs';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
} from '~/server/utils/errorHandling';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { userContributingClubs } from '~/server/services/club.service';
import { clubMetrics } from '../metrics';

export const getClubMemberships = async <TSelect extends Prisma.ClubMembershipSelect>({
  input: { cursor, limit: take, clubId, clubTierId, userId, sort },
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
    },
    orderBy,
  });
};

export const clubMembershipOnClub = async <TSelect extends Prisma.ClubMembershipSelect>({
  input: { clubId, userId, expired },
  select,
  dbClient = dbRead,
}: {
  input: ClubMembershipOnClubInput & { userId: number; expired?: boolean };
  select: TSelect;
  dbClient?: PrismaClient;
}) => {
  return dbClient.clubMembership.findUnique({
    select,
    where: {
      userId_clubId: {
        userId,
        clubId,
      },
      AND: expired
        ? undefined
        : {
            // Only return active membership.
            OR: [
              {
                expiresAt: null,
              },
              {
                expiresAt: {
                  gte: dayjs().toDate(),
                },
              },
            ],
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
      memberLimit: true,
      joinable: true,
      club: {
        select: {
          name: true,
          userId: true,
        },
      },
      _count: {
        select: {
          memberships: true,
        },
      },
    },
  });

  if (!clubTier) throw new Error('Club tier does not exist');

  if (clubTier.memberLimit && clubTier._count.memberships >= clubTier.memberLimit) {
    throw throwBadRequestError('Club tier is full');
  }

  if (!clubTier.joinable) {
    throw throwBadRequestError('Club tier is not joinable');
  }

  const clubMembership = await clubMembershipOnClub({
    input: {
      clubId: clubTier.clubId,
      userId,
      expired: true,
    },
    select: {
      id: true,
      expiresAt: true,
    },
  });

  if (clubMembership && clubMembership?.expiresAt && clubMembership?.expiresAt >= new Date())
    throw new Error('User already has an active membership.');

  const membership = await dbWrite.$transaction(async (tx) => {
    const createDate = dayjs();
    const nextBillingDate = createDate.add(1, 'month').endOf('day');

    // Use upsert in the case of an expired membership.
    const membership = !clubMembership?.id
      ? await tx.clubMembership.create({
          data: {
            startedAt: createDate.toDate(),
            nextBillingAt: nextBillingDate.toDate(),
            clubId: clubTier.clubId,
            clubTierId,
            userId,
            unitAmount: clubTier.unitAmount,
            currency: clubTier.currency,
          },
        })
      : await tx.clubMembership.update({
          where: {
            id: clubMembership.id,
          },
          data: {
            startedAt: createDate.toDate(),
            nextBillingAt: nextBillingDate.toDate(),
            clubId: clubTier.clubId,
            clubTierId,
            userId,
            // Memberships are always created as members.
            // They can be updated by moderators, club admins and owners later on.
            unitAmount: clubTier.unitAmount,
            currency: clubTier.currency,
            cancelledAt: null,
            expiresAt: null,
          },
        });

    if (clubTier.unitAmount > 0) {
      await createBuzzTransaction({
        toAccountType: 'club',
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

export const updateClubMembership = async ({
  clubTierId,
  userId,
}: UpdateClubMembershipInput & {
  userId: number;
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
      memberLimit: true,
      _count: {
        select: {
          memberships: true,
        },
      },
    },
  });

  if (!clubTier) throw new Error('Club tier does not exist');

  const clubMembership = await dbRead.clubMembership.findFirst({
    where: { clubId: clubTier.clubId, userId },
    select: {
      id: true,
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
          oneTimeFee: true,
        },
      },
    },
  });

  if (!clubMembership) throw new Error('User is not a member of this club');
  if (
    clubMembership.clubTier.id !== clubTier.id &&
    clubTier.memberLimit &&
    clubTier._count.memberships >= clubTier.memberLimit
  ) {
    throw throwBadRequestError('Club tier is full');
  }

  const isSameTier = clubTier.id === clubMembership.clubTier.id;
  const isUpgrade = !isSameTier && clubTier.unitAmount > clubMembership.clubTier.unitAmount;
  const isDowngrade = !isSameTier && clubTier.unitAmount < clubMembership.clubTier.unitAmount;

  if (isDowngrade && clubMembership.clubTier.oneTimeFee) {
    throw throwBadRequestError(
      'Cannot downgrade from a one time payment tier. Please leave the tier first'
    );
  }

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
        unitAmount: clubTier.unitAmount,
        currency: clubTier.currency,
        downgradeClubTierId: isSameTier || isUpgrade ? null : isDowngrade ? clubTier.id : undefined,
      },
    });

    if (isUpgrade) {
      await createBuzzTransaction({
        toAccountType: 'club',
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

export const completeClubMembershipCharge = async ({
  stripePaymentIntentId,
}: {
  stripePaymentIntentId: string;
}) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');
  const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntentId, {
    expand: ['payment_method'],
  });

  if (!paymentIntent || paymentIntent.status !== 'succeeded') {
    throw throwBadRequestError('Payment intent not found');
  }

  await dbWrite.$transaction(async (tx) => {
    // First, get the relevant club charge record:
    const clubMembershipCharge = await tx.clubMembershipCharge.findFirst({
      where: { invoiceId: stripePaymentIntentId },
    });

    if (!clubMembershipCharge) throw throwBadRequestError('Club charge not found');

    const clubMembership = await tx.clubMembership.findUnique({
      where: {
        userId_clubId: { userId: clubMembershipCharge.userId, clubId: clubMembershipCharge.clubId },
      },
      include: {
        downgradeClubTier: true,
      },
    });

    if (!clubMembership) throw throwBadRequestError('Club membership not found');

    // Update and renew the membership:
    await tx.clubMembership.update({
      where: {
        userId_clubId: {
          userId: clubMembershipCharge.userId,
          clubId: clubMembershipCharge.clubId,
        },
      },
      data: {
        nextBillingAt: dayjs(clubMembership.nextBillingAt).add(1, 'month').toDate(),
        clubTierId: clubMembership.downgradeClubTier?.id ?? undefined, // Won't do anything if the user doesn't have it.
        downgradeClubTierId: null,
      },
    });

    await tx.clubMembershipCharge.update({
      where: { id: clubMembershipCharge.id },
      data: {
        status: 'succeeded',
      },
    });

    // Now move money from the user's account to the club's account:
    await createBuzzTransaction({
      fromAccountId: clubMembershipCharge.userId,
      toAccountId: clubMembershipCharge.clubId,
      toAccountType: 'club',
      amount: clubMembershipCharge.unitAmount,
      type: TransactionType.ClubMembership,
      details: {
        userId: clubMembershipCharge.userId,
        clubTierId: clubMembershipCharge.clubTierId,
        clubId: clubMembershipCharge.clubId,
        clubMembershipChargeId: clubMembershipCharge.id,
        stripePaymentIntentId: clubMembershipCharge.invoiceId,
      },
      externalTransactionId: `club-membership-charge-${clubMembershipCharge.id}`,
    });
  });
};

export const clubOwnerRemoveMember = async ({
  clubId,
  userId,
  sessionUserId,
  isModerator,
}: OwnerRemoveClubMembershipInput & {
  sessionUserId: number;
  isModerator: boolean;
}) => {
  const membership = await dbRead.clubMembership.findFirst({
    where: { clubId, userId },
    include: {
      clubTier: {
        select: {
          id: true,
          name: true,
        },
      },
      club: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!membership) throw throwBadRequestError('Club membership not found');
  if (membership.userId === sessionUserId)
    throw throwBadRequestError('You cannot remove and refund yourself from a club');

  const [userClub] = await userContributingClubs({ userId: sessionUserId, clubIds: [clubId] });
  if (!userClub) {
    throw throwAuthorizationError("You are not authorized to remove a user's membership");
  }

  const isClubOwner = userClub.userId === sessionUserId;
  const canManageMemberships = userClub.admin?.permissions.includes(
    ClubAdminPermission.ManageMemberships
  );

  if (!(isModerator || isClubOwner || canManageMemberships)) {
    throw throwAuthorizationError("You are not authorized to remove a user's membership");
  }

  const clubBuzzAccount = await getUserBuzzAccount({
    accountId: membership.clubId,
    accountType: 'club',
  });

  if ((clubBuzzAccount?.balance ?? 0) < membership.unitAmount) {
    throw throwInsufficientFundsError(
      'Club does not have enough funds to refund this user as such, they cannot be removed'
    );
  }

  await clubMetrics.queueUpdate(membership.clubId);

  return dbWrite.$transaction(async (tx) => {
    // Remove the user:
    await tx.clubMembership.delete({
      where: { id: membership.id },
    });

    // Nothing to refund :shrug:
    if (membership.unitAmount === 0) return;

    // Refund the user:
    await createBuzzTransaction({
      fromAccountType: 'club',
      fromAccountId: membership.clubId,
      toAccountId: membership.userId,
      toAccountType: 'user',
      amount: membership.unitAmount,
      type: TransactionType.ClubMembershipRefund,
      details: {
        userId: membership.userId,
        clubTierId: membership.clubTierId,
        clubId: membership.clubId,
        clubMembershipId: membership.id,
      },
      description: `Refund for Club Membership: ${membership.club.name} - ${membership.clubTier.name}`,
      externalTransactionId: `club-membership-refund-${membership.id}`,
    });
  });
};

export const clubOwnerTogglePauseBilling = async ({
  clubId,
  userId,
  sessionUserId,
  isModerator,
}: OwnerRemoveClubMembershipInput & {
  sessionUserId: number;
  isModerator: boolean;
}) => {
  const membership = await dbRead.clubMembership.findFirst({
    where: { clubId, userId },
    include: {
      clubTier: {
        select: {
          id: true,
          name: true,
        },
      },
      club: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!membership) throw throwBadRequestError('Club membership not found');
  if (membership.userId === sessionUserId)
    throw throwBadRequestError('You cannot pause your own billing from a club');

  const [userClub] = await userContributingClubs({
    userId: sessionUserId,
    clubIds: [clubId],
  });

  if (!userClub) {
    throw throwAuthorizationError("You are not authorized to pause a user's membership");
  }

  const isClubOwner = userClub.userId === sessionUserId;
  const canManageMemberships = (userClub.admin?.permissions ?? []).includes(
    ClubAdminPermission.ManageMemberships
  );

  if (!(isModerator || isClubOwner || canManageMemberships)) {
    throw throwAuthorizationError("You are not authorized to pause a user's membership");
  }

  return dbWrite.clubMembership.update({
    data: {
      billingPausedAt: membership.billingPausedAt ? null : new Date(),
    },
    where: { id: membership.id },
  });
};

export const cancelClubMembership = async ({ userId, clubId }: ToggleClubMembershipStatusInput) => {
  const membership = await dbRead.clubMembership.findFirst({
    where: { clubId, userId },
    include: { clubTier: true },
  });

  if (!membership) throw throwBadRequestError('Club membership not found');

  if (membership.unitAmount === 0 || membership.clubTier.oneTimeFee) {
    await dbWrite.clubMembership.delete({
      where: { id: membership.id },
    });

    return;
  }

  const updatedMembership = await dbWrite.clubMembership.update({
    where: { id: membership.id },
    data: {
      cancelledAt: new Date(),
      expiresAt: membership?.nextBillingAt,
    },
  });

  return updatedMembership;
};

export const restoreClubMembership = async ({
  userId,
  clubId,
}: ToggleClubMembershipStatusInput) => {
  const membership = await dbRead.clubMembership.findFirst({
    where: { clubId, userId },
  });

  if (!membership) throw throwBadRequestError('Club membership not found');
  if (!membership.cancelledAt) {
    throw throwBadRequestError('Club membership is not cancelled');
  }

  if (membership.expiresAt && membership.expiresAt < new Date()) {
    throw throwBadRequestError('Club membership has expired.');
  }

  const updatedMembership = await dbWrite.$transaction(async (tx) => {
    const updatedMembership = await tx.clubMembership.update({
      where: { id: membership.id },
      data: {
        cancelledAt: null,
        expiresAt: null,
      },
    });

    return updatedMembership;
  });

  return updatedMembership;
};
