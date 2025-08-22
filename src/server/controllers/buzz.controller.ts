import { getTRPCErrorFromUnknown } from '@trpc/server';
import dayjs from '~/shared/utils/dayjs';
import { v4 as uuid } from 'uuid';
import { NotificationCategory } from '~/server/common/enums';
import type { Context } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import { dailyBoostReward } from '~/server/rewards/active/dailyBoost.reward';
import type {
  ClubTransactionSchema,
  CompleteStripeBuzzPurchaseTransactionInput,
  GetBuzzAccountSchema,
  GetBuzzAccountTransactionsSchema,
  GetDailyBuzzCompensationInput,
  GetTransactionsReportSchema,
  GetUserBuzzTransactionsSchema,
  UserBuzzTransactionInputSchema,
} from '~/server/schema/buzz.schema';
import { TransactionType } from '~/server/schema/buzz.schema';
import {
  completeStripeBuzzTransaction,
  createBuzzTransaction,
  createBuzzTransactionMany,
  getDailyCompensationRewardByUser,
  getMultipliersForUser,
  getTransactionsReport,
  getUserBuzzAccount,
  getUserBuzzTransactions,
  upsertBuzzTip,
} from '~/server/services/buzz.service';
import { getEntityCollaborators } from '~/server/services/entity-collaborator.service';
import { getImageById } from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import { updateEntityMetric } from '~/server/utils/metric-helpers';
import { ClubAdminPermission, EntityType } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { userContributingClubs } from '../services/club.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
} from '../utils/errorHandling';
import { DEFAULT_PAGE_SIZE } from '../utils/pagination-helpers';

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
      case 'club':
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
      case 'user':
      case 'generation':
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
      throw throwBadRequestError('You cannot send Buzz to the same account');

    if (input.toAccountId === -1) {
      throw throwBadRequestError('You cannot send Buzz to the system account');
    }

    let accountCreatedAt = ctx.user?.createdAt ? new Date(ctx.user.createdAt) : undefined;
    if (!accountCreatedAt) {
      const user = await dbWrite.user.findUnique({
        where: { id: fromAccountId },
        select: { createdAt: true },
      });
      accountCreatedAt = user?.createdAt;
    }
    if (!accountCreatedAt || accountCreatedAt > dayjs().subtract(1, 'day').toDate()) {
      throw throwBadRequestError('You cannot send Buzz until you have been a member for 24 hours');
    }

    const blocked = await amIBlockedByUser({
      userId: fromAccountId,
      targetUserId: input.toAccountId,
    });
    if (blocked) {
      throw throwBadRequestError('You cannot send Buzz to a user that has blocked you');
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
      throw throwBadRequestError('You cannot send Buzz to the same account');
    }

    if (targetUserIds.length > 0) {
      // Confirm none of the target users are banned:
      const bannedUsers = await dbWrite.user.findMany({
        where: { id: { in: targetUserIds }, bannedAt: { not: null } },
        select: { id: true },
      });

      if (bannedUsers.length > 0) {
        throw throwBadRequestError('One or more target users are banned');
      }
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
    const userAccount = await getUserBuzzAccount({ accountId: fromAccountId, accountType: 'user' });
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
    } else {
      const toAccountId = transactions[0].toAccountId;
      const description = transactions[0].description;
      if (toAccountId !== 0) {
        const fromUser = await dbWrite.user.findUnique({
          where: { id: fromAccountId },
          select: { username: true },
        });

        await createNotification({
          type: 'tip-received',
          userId: toAccountId,
          category: NotificationCategory.Buzz,
          key: `tip-received:${uuid()}`,
          details: {
            amount: amount,
            user: fromUser?.username,
            fromUserId: fromAccountId,
            message: description,
          },
        });
      }
    }

    if (entityType === 'Image' && !!entityId) {
      await updateEntityMetric({
        ctx,
        entityType: 'Image',
        entityId,
        metricType: 'Buzz',
        amount: finalAmount,
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
      case 'club':
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
      case 'user':
      case 'generation':
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

    const club = await dbWrite.club.findUniqueOrThrow({ where: { id: input.clubId } });

    return createBuzzTransaction({
      toAccountId: id,
      toAccountType: 'user',
      fromAccountId: input.clubId,
      fromAccountType: 'club',
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

    const club = await dbWrite.club.findUniqueOrThrow({ where: { id: input.clubId } });

    return createBuzzTransaction({
      fromAccountId: id,
      fromAccountType: 'user',
      toAccountId: input.clubId,
      toAccountType: 'club',
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
    const { ip, fingerprint, user } = ctx;
    const { id: userId } = user;
    await dailyBoostReward.apply({ userId }, { ip, fingerprint });
  } catch (error) {
    const parsedError = getTRPCErrorFromUnknown(error);
    handleLogError(parsedError);
    throw parsedError;
  }
};

export function getDailyCompensationRewardHandler({
  input,
  ctx,
}: {
  input: GetDailyBuzzCompensationInput;
  ctx: DeepNonNullable<Context>;
}) {
  if (!ctx.user.isModerator) input.userId = ctx.user.id;
  if (!input.userId) input.userId = ctx.user.id;

  try {
    return getDailyCompensationRewardByUser({ userId: ctx.user.id, ...input });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export function getTransactionsReportHandler({
  input,
  ctx,
}: {
  input: GetTransactionsReportSchema;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return getTransactionsReport({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}
