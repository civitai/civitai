import { getTRPCErrorFromUnknown } from '@trpc/server';
import { Context } from '~/server/createContext';
import {
  CompleteStripeBuzzPurchaseTransactionInput,
  CreateBuzzTransactionInput,
  GetBuzzAccountSchema,
  GetBuzzAccountTransactionsSchema,
  GetUserBuzzTransactionsSchema,
  TransactionType,
  UserBuzzTransactionInputSchema,
  ClubTransactionSchema,
} from '~/server/schema/buzz.schema';
import {
  completeStripeBuzzTransaction,
  createBuzzTransaction,
  createBuzzTransactionMany,
  getMultipliersForUser,
  getUserBuzzAccount,
  getUserBuzzTransactions,
  upsertBuzzTip,
} from '~/server/services/buzz.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
} from '../utils/errorHandling';
import { DEFAULT_PAGE_SIZE } from '../utils/pagination-helpers';
import { dbRead } from '~/server/db/client';
import { userContributingClubs } from '../services/club.service';
import { ClubAdminPermission, EntityType } from '@prisma/client';
import { dailyBoostReward } from '~/server/rewards/active/dailyBoost.reward';
import { getEntityCollaborators } from '~/server/services/entity-collaborator.service';
import { getImageById } from '~/server/services/image.service';
import { v4 as uuid } from 'uuid';
import { isDefined } from '~/utils/type-guards';

export function getUserAccountHandler({ ctx }: { ctx: DeepNonNullable<Context> }) {
  try {
    return getUserBuzzAccount({ accountId: ctx.user.id });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getBuzzAccountHandler({
  input,
  ctx,
}: {
  input: GetBuzzAccountSchema;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { accountId, accountType } = input;

    switch (accountType) {
      case 'Club':
        const [userClub] = await userContributingClubs({
          userId: ctx.user.id,
          clubIds: [accountId],
        });
        if (!userClub) throw throwBadRequestError("You cannot view this club's transactions");

        if (
          userClub.userId !== ctx.user.id &&
          !ctx.user.isModerator &&
          !(userClub.admin?.permissions ?? []).includes(ClubAdminPermission.ViewRevenue)
        )
          throw throwBadRequestError("You cannot view this club's transactions");
        break;
      case 'User':
        if (accountId !== ctx.user.id)
          throw throwBadRequestError("You cannot view this user's transactions");
        break;
      default:
    }

    return getUserBuzzAccount({ ...input });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getUserTransactionsHandler({
  input,
  ctx,
}: {
  input: GetUserBuzzTransactionsSchema;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    input.limit ??= DEFAULT_PAGE_SIZE;

    const result = await getUserBuzzTransactions({ ...input, accountId: ctx.user.id });
    return result;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export function completeStripeBuzzPurchaseHandler({
  input,
  ctx,
}: {
  input: CompleteStripeBuzzPurchaseTransactionInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id } = ctx.user;

    return completeStripeBuzzTransaction({ ...input, userId: id });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function createBuzzTipTransactionHandler({
  input,
  ctx,
}: {
  input: UserBuzzTransactionInputSchema;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id: fromAccountId } = ctx.user;
    if (fromAccountId === input.toAccountId)
      throw throwBadRequestError('You cannot send buzz to the same account');

    if (input.toAccountId === -1) {
      throw throwBadRequestError('You cannot send buzz to the system account');
    }

    const { entityType, entityId } = input;
    let targetUserIds: number[] = input.toAccountId ? [input.toAccountId] : [];

    if ((entityType === 'Post' || entityType === 'Image') && entityId) {
      // May have contributros, check this...
      const collaboratorEntityType = EntityType.Post; // For the time being, only this is supported.
      const collaboratorEntityId =
        entityType === 'Post' ? entityId : (await getImageById({ id: entityId }))?.postId;

      if (collaboratorEntityId && collaboratorEntityType) {
        const collaborators = await getEntityCollaborators({
          entityId: collaboratorEntityId,
          entityType: collaboratorEntityType,
        });

        const collaboratorIds = collaborators.map((c) => c.user.id);

        targetUserIds = [...new Set([...targetUserIds, ...collaboratorIds])].filter(isDefined);
      }
    }

    if (targetUserIds.length === 0) {
      throw throwBadRequestError('No valid target users found');
    }

    if (targetUserIds.includes(fromAccountId)) {
      throw throwBadRequestError('You cannot send buzz to the same account');
    }

    const amount = Math.floor(input.amount / targetUserIds.length);
    const finalAmount = amount * targetUserIds.length;

    if (input.amount <= 0) {
      throw throwBadRequestError('Amount must be greater than 0');
    }

    if (amount <= 0) {
      throw throwBadRequestError('Could not split the amount between users');
    }
    // Confirm user funds:
    const userAccount = await getUserBuzzAccount({ accountId: fromAccountId });
    if ((userAccount.balance ?? 0) < finalAmount) {
      throw throwInsufficientFundsError();
    }

    const sharedId = `tip-${uuid()}-${entityType}-${entityId}-by-${ctx.user.id}`;
    const transactions = targetUserIds.map((toAccountId) => ({
      ...input,
      fromAccountId: ctx.user.id,
      type: TransactionType.Tip,
      amount,
      details: {
        ...(input.details ?? {}),
        targetUserIds,
        originalAmount: input.amount,
        // sharedId is a way to group transactions that are related to each other like contributor ones.
        // This is not global by any means, but should let us know that these transactions are related.
        sharedId,
      },
      toAccountId,
      externalTransactionId: `${sharedId}-${toAccountId}`,
    }));

    // Now, create all transactions
    const data = await createBuzzTransactionMany(transactions); // Now store these in the DB:

    if (entityType && entityId) {
      // TODO: We might wanna notify contributors, but hardly a priority right now imho.
      await upsertBuzzTip({
        ...transactions[0],
        amount: finalAmount, // This is a total amount that was sent to all users.
        entityType: entityType as string,
        entityId: entityId as number,
      });
    }

    return data;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getBuzzAccountTransactionsHandler({
  input,
  ctx,
}: {
  input: GetBuzzAccountTransactionsSchema;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    input.limit ??= DEFAULT_PAGE_SIZE;

    const { accountId, accountType } = input;

    switch (accountType) {
      case 'Club':
        const [userClub] = await userContributingClubs({
          userId: ctx.user.id,
          clubIds: [accountId],
        });

        if (!userClub) throw throwBadRequestError("You cannot view this club's transactions");

        if (
          userClub.userId !== ctx.user.id &&
          !ctx.user.isModerator &&
          !(userClub.admin?.permissions ?? []).includes(ClubAdminPermission.ViewRevenue)
        )
          throw throwBadRequestError("You cannot view this club's transactions");
        break;
      case 'User':
        if (accountId !== ctx.user.id)
          throw throwBadRequestError("You cannot view this user's transactions");
        break;
      default:
    }

    const result = await getUserBuzzTransactions({ ...input });
    return result;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function withdrawClubFundsHandler({
  input,
  ctx,
}: {
  input: ClubTransactionSchema;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id } = ctx.user;

    const [userClub] = await userContributingClubs({ userId: id, clubIds: [input.clubId] });

    if (!userClub)
      throw throwAuthorizationError('You do not have permission to withdraw funds from this club');

    if (
      userClub.userId !== id &&
      !(userClub.admin?.permissions ?? []).includes(ClubAdminPermission.WithdrawRevenue)
    ) {
      throw throwAuthorizationError('You do not have permission to withdraw funds from this club');
    }

    const club = await dbRead.club.findUniqueOrThrow({ where: { id: input.clubId } });

    return createBuzzTransaction({
      toAccountId: id,
      toAccountType: 'User',
      fromAccountId: input.clubId,
      fromAccountType: 'Club',
      amount: input.amount,
      type: TransactionType.ClubWithdrawal,
      description: `Club withdrawal from ${club.name}`,
      details: { clubId: club.id, clubName: club.name, createdAt: new Date(), userId: id },
    });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function depositClubFundsHandler({
  input,
  ctx,
}: {
  input: ClubTransactionSchema;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id } = ctx.user;

    const [userClub] = await userContributingClubs({ userId: id, clubIds: [input.clubId] });

    if (!userClub)
      throw throwAuthorizationError('You do not have permission to withdraw funds from this club');

    if (userClub.userId !== id) {
      throw throwAuthorizationError('You do not have permission to deposit funds on this club');
    }

    const club = await dbRead.club.findUniqueOrThrow({ where: { id: input.clubId } });

    return createBuzzTransaction({
      fromAccountId: id,
      fromAccountType: 'User',
      toAccountId: input.clubId,
      toAccountType: 'Club',
      amount: input.amount,
      type: TransactionType.ClubDeposit,
      description: `Club deposit on ${club.name}`,
      details: { clubId: club.id, clubName: club.name, createdAt: new Date(), userId: id },
    });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export const getUserMultipliersHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    return getMultipliersForUser(ctx.user.id);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
};

export const claimDailyBoostRewardHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    await dailyBoostReward.apply({ userId: ctx.user.id }, ctx.ip);
  } catch (error) {
    const parsedError = getTRPCErrorFromUnknown(error);
    handleLogError(parsedError);
    throw parsedError;
  }
};
