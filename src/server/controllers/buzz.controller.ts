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
  getMultipliersForUser,
  getUserBuzzAccount,
  getUserBuzzTransactions,
} from '~/server/services/buzz.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
} from '../utils/errorHandling';
import { DEFAULT_PAGE_SIZE } from '../utils/pagination-helpers';
import { dbRead } from '~/server/db/client';
import { userContributingClubs } from '../services/club.service';
import { ClubAdminPermission } from '@prisma/client';
import { dailyBoostReward } from '~/server/rewards/active/dailyBoost.reward';

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

export function createBuzzTipTransactionHandler({
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

    return createBuzzTransaction({
      ...input,
      fromAccountId: ctx.user.id,
      type: TransactionType.Tip,
    });
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
