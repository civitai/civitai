import { TRPCError } from '@trpc/server';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
} from '~/server/utils/errorHandling';
import { Context } from '~/server/createContext';
import { imageSelect } from '~/server/selectors/image.selector';
import {
  ToggleClubMembershipStatusInput,
  ClubMembershipOnClubInput,
  CreateClubMembershipInput,
  GetInfiniteClubMembershipsSchema,
  OwnerRemoveClubMembershipInput,
  UpdateClubMembershipInput,
} from '~/server/schema/clubMembership.schema';
import {
  cancelClubMembership,
  clubMembershipOnClub,
  clubOwnerRemoveMember,
  createClubMembership,
  getClubMemberships,
  restoreClubMembership,
  updateClubMembership,
} from '~/server/services/clubMembership.service';
import { userContributingClubs } from '~/server/services/club.service';
import { dbRead } from '~/server/db/client';
import { ClubMembershipRole } from '@prisma/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const getInfiniteClubMembershipsHandler = async ({
  input,
  ctx,
}: {
  input: GetInfiniteClubMembershipsSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;
  const limit = input.limit + 1 ?? 10;

  const userClubs = await userContributingClubs({ userId: user.id });
  const isClubOwner = userClubs.find((c) => c.id === input.clubId && c.userId === user.id);
  const isClubAdmin = userClubs.find(
    (c) => c.id === input.clubId && c.membership?.role === ClubMembershipRole.Admin
  );

  if (!(user.isModerator || isClubOwner || isClubAdmin)) {
    throw throwAuthorizationError("You are not authorized to view this club's memberships");
  }

  if (input.userId && input.userId !== user.id && !user.isModerator) {
    throw throwAuthorizationError('You are not authorized to view this user memberships');
  }

  try {
    const items = await getClubMemberships({
      input: { ...input, limit },
      select: {
        id: true,
        role: true,
        startedAt: true,
        nextBillingAt: true,
        unitAmount: true,
        currency: true,
        expiresAt: true,
        cancelledAt: true,
        downgradeClubTierId: true,
        user: {
          select: userWithCosmeticsSelect,
        },
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
            coverImage: {
              select: imageSelect,
            },
          },
        },
        downgradeClubTier: {
          select: {
            id: true,
            name: true,
            unitAmount: true,
            currency: true,
            coverImage: {
              select: imageSelect,
            },
          },
        },
      },
    });

    let nextCursor: number | undefined;
    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    return {
      nextCursor,
      items,
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getClubMembershipOnClubHandler = async ({
  input,
  ctx,
}: {
  input: ClubMembershipOnClubInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { clubId } = input;
  const { user } = ctx;
  if (!user) {
    return null;
  }

  try {
    return clubMembershipOnClub({
      input: {
        clubId,
        userId: user.id,
      },
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
            coverImage: {
              select: imageSelect,
            },
          },
        },
        downgradeClubTier: {
          select: {
            id: true,
            name: true,
            unitAmount: true,
            currency: true,
            coverImage: {
              select: imageSelect,
            },
          },
        },
      },
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export async function createClubMembershipHandler({
  input,
  ctx,
}: {
  input: CreateClubMembershipInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return createClubMembership({
      ...input,
      userId: ctx.user.isModerator ? input.userId ?? ctx.user.id : ctx.user.id,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function updateClubMembershipHandler({
  input,
  ctx,
}: {
  input: UpdateClubMembershipInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const targetUserIsNotCurrentUser = !!(input.userId && input.userId !== ctx.user.id);
    const targetUserId = input.userId ?? ctx.user.id;
    const clubTier = await dbRead.clubTier.findUniqueOrThrow({
      where: { id: input.clubTierId },
      select: {
        id: true,
        club: {
          select: {
            id: true,
            userId: true,
          },
        },
      },
    });

    const userClubs = await userContributingClubs({ userId: ctx.user.id });
    const membership = await dbRead.clubMembership.findFirst({
      where: { clubId: clubTier.id, userId: targetUserId },
    });

    const isClubOwner = clubTier.club.userId === ctx.user.id;
    const isClubAdmin = userClubs.find(
      (c) => c.id === clubTier.club.id && c.membership?.role === ClubMembershipRole.Admin
    );

    if (targetUserIsNotCurrentUser && !(ctx.user.isModerator || isClubOwner || isClubAdmin)) {
      throw throwAuthorizationError('You are not authorized to update this membership');
    }

    return updateClubMembership({
      ...input,
      userId: ctx.user.isModerator ? input.userId ?? ctx.user.id : ctx.user.id,
      // This is important. If the user assigning this new memberships is not itself, we want to
      // keep the unitAmount of the previous membership
      unitAmount: targetUserIsNotCurrentUser ? membership?.unitAmount : undefined,
      isForcedUpdate: targetUserIsNotCurrentUser,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export const removeAndRefundMemberHandler = async ({
  input,
  ctx,
}: {
  input: OwnerRemoveClubMembershipInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;

  try {
    return clubOwnerRemoveMember({
      ...input,
      sessionUserId: user.id,
      isModerator: !!user.isModerator,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const cancelClubMembershipHandler = async ({
  input,
  ctx,
}: {
  input: ToggleClubMembershipStatusInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;
  let { userId } = input;

  if (!userId) {
    userId = user.id;
  }

  try {
    if (user.id !== userId && !user.isModerator)
      throw throwAuthorizationError('You are not authorized');

    return cancelClubMembership({
      ...input,
      userId,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const restoreClubMembershipHandler = async ({
  input,
  ctx,
}: {
  input: ToggleClubMembershipStatusInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;
  let { userId } = input;

  if (!userId) {
    userId = user.id;
  }

  try {
    if (user.id !== userId && !user.isModerator)
      throw throwAuthorizationError('You are not authorized');

    return restoreClubMembership({
      ...input,
      userId,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};
