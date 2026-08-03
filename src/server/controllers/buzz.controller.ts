import { getTRPCErrorFromUnknown } from '@trpc/server';
import dayjs from '~/shared/utils/dayjs';
import { v4 as uuid } from 'uuid';
import { NotificationCategory } from '~/server/common/enums';
import type { ProtectedContext } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import { dailyBoostReward } from '~/server/rewards/active/dailyBoost.reward';
import type {
  CompleteStripeBuzzPurchaseTransactionInput,
  GetBuzzAccountSchema,
  GetBuzzAccountTransactionsSchema,
  GetDailyBuzzCompensationInput,
  GetTransactionsReportSchema,
  GetUserBuzzTransactionsMultiSchema,
  GetUserBuzzTransactionsSchema,
  PreviewMultiAccountTransactionInput,
  UserBuzzTransactionInputSchema,
} from '~/server/schema/buzz.schema';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  completeStripeBuzzTransaction,
  createBuzzTransactionMany,
  getDailyCompensationRewardByUser,
  getMultipliersForUser,
  getTransactionsReport,
  getUserBuzzAccount,
  getUserBuzzTransactions,
  getUserBuzzTransactionsMulti,
  previewMultiAccountTransaction,
  upsertBuzzTip,
} from '~/server/services/buzz.service';
import { getEntityCollaborators } from '~/server/services/entity-collaborator.service';
import { getImageById } from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import { updateEntityMetric } from '~/server/utils/metric-helpers';
import { EntityType } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import {
  handleLogError,
  throwBadRequestError,
  throwInsufficientFundsError,
} from '../utils/errorHandling';
import { DEFAULT_PAGE_SIZE } from '../utils/pagination-helpers';

export function getUserAccountHandler({ ctx }: { ctx: ProtectedContext }) {
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
  ctx: ProtectedContext;
}) {
  try {
    input.accountId = ctx.user.id;

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
  ctx: ProtectedContext;
}) {
  try {
    input.limit ??= DEFAULT_PAGE_SIZE;

    const result = await getUserBuzzTransactions({ ...input, accountId: ctx.user.id });
    return result;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getUserTransactionsMultiHandler({
  input,
  ctx,
}: {
  input: GetUserBuzzTransactionsMultiSchema;
  ctx: ProtectedContext;
}) {
  try {
    return await getUserBuzzTransactionsMulti({
      ...input,
      limit: input.limit ?? DEFAULT_PAGE_SIZE,
      accountId: ctx.user.id,
    });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export function completeStripeBuzzPurchaseHandler({
  input,
  ctx,
}: {
  input: CompleteStripeBuzzPurchaseTransactionInput;
  ctx: ProtectedContext;
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
  idempotencyKey,
}: {
  input: UserBuzzTransactionInputSchema;
  ctx: ProtectedContext;
  /**
   * OPTIONAL client idempotency key (App Blocks tip endpoint, audit 🟡-1). When
   * present, the tip's `externalTransactionId` is DERIVED from it deterministically
   * (`block-tip:${fromUserId}:${idempotencyKey}-${toAccountId}`) instead of a fresh
   * `uuid()`, so the Buzz ledger's own idempotency (a duplicate
   * `externalTransactionId` is a benign "money already moved" conflict) becomes the
   * AUTHORITATIVE dedup: a retry after the Redis sentinel has expired (a crash
   * between charge and `finalizeTipIdempotency`) collides on the ledger = money
   * moves once. Absent → today's per-call `uuid()` behavior (no ledger dedup),
   * byte-identical for the on-site tip path which never passes this.
   */
  idempotencyKey?: string;
}) {
  try {
    const { id: fromAccountId } = ctx.user;
    if (input.fromAccountType !== input.toAccountType) {
      throw throwBadRequestError('You cannot tip Buzz between different account types');
    }

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
    const userAccount = await getUserBuzzAccount({
      accountId: fromAccountId,
      accountType: input.fromAccountType ?? 'yellow',
    });

    if ((userAccount[0]?.balance ?? 0) < finalAmount) {
      throw throwInsufficientFundsError();
    }

    // The base of every transaction's `externalTransactionId` (`${sharedId}-${toAccountId}`).
    // With a client idempotency key, DERIVE it deterministically so a retry collides
    // on the ledger's unique constraint (money moves once — see the param doc). The
    // key is charset-restricted (`^[A-Za-z0-9_-]{1,64}$`) at the endpoint, and both
    // `fromUserId` and `toAccountId` are numeric, so `block-tip:${fromUserId}:${key}`
    // is delimiter-injective — no two distinct (user, key, target) triples collide.
    // Absent key → the original per-call `uuid()` (no dedup), byte-identical to today.
    const sharedId = idempotencyKey
      ? `block-tip:${ctx.user.id}:${idempotencyKey}`
      : `tip-${uuid()}-${entityType ?? ''}-${entityId ?? ''}-by-${ctx.user.id}`;
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

    // ── LEDGER CONFLICT = MONEY ALREADY MOVED (audit 🔴-2) ───────────────────────
    // `createBuzzTransactionMany` returns `{ transactions, conflicts }`, and a
    // `conflict` is the ledger REJECTING a duplicate `externalTransactionId`: that
    // transaction debited NOTHING on this call because an earlier call already moved
    // the money. The three side effects below (`upsertBuzzTip`, the `tip-received`
    // notification — keyed by a fresh uuid so it has no dedup of its own — and the
    // Image Buzz metric) are all NON-idempotent, so firing them for a conflicted
    // transaction credits a SECOND tip for money that moved ONCE: a phantom tip.
    //
    // 🔴 This state is only REACHABLE because of the deterministic
    // `externalTransactionId` introduced alongside `idempotencyKey` — with the
    // legacy per-call `uuid()` id `conflicts` was always empty here, which is why
    // ignoring it was previously (accidentally) safe. Concretely: tip N to X on
    // image A with key K → wait past the 10-min Redis sentinel → same K, same
    // recipient, DIFFERENT entityId (the derivation deliberately ignores the entity)
    // → byte-identical ledger id → conflict, zero Buzz moves, yet image B would get
    // +N Buzz, a BuzzTip row, and a 200.
    //
    // Matching is by `externalTransactionId` (what the batch endpoint reports as a
    // conflict), with a COUNT belt: if the ledger reported ZERO successes then
    // nothing moved on this call regardless of how the conflict identifiers are
    // shaped on the wire. Both signals agree on the full-replay case above; the belt
    // is what keeps the fail direction safe (never fire a side effect for money that
    // did not move) if the identifier shape ever changes.
    const conflictedIds = new Set(data.conflicts);
    const settled =
      data.transactions.length === 0
        ? []
        : transactions.filter((t) => !conflictedIds.has(t.externalTransactionId));
    // Buzz that did NOT move on this call because the ledger deduped it. 0 on every
    // non-conflicting tip → this whole block is inert for today's traffic.
    const dedupedAmount = (transactions.length - settled.length) * amount;
    const deduped = settled.length === 0 && dedupedAmount > 0;

    if (settled.length > 0) {
      if (entityType && entityId) {
        // TODO: We might wanna notify contributors, but hardly a priority right now imho.
        await upsertBuzzTip({
          ...settled[0],
          // The total that ACTUALLY moved on this call (a partially-deduped batch
          // must not record the conflicted legs again).
          amount: settled.length * amount,
          entityType: entityType as string,
          entityId: entityId as number,
        });
      } else {
        const toAccountId = settled[0].toAccountId;
        const description = settled[0].description;
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
              toAccountType: input.toAccountType,
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
          // Only the Buzz that actually moved on this call.
          amount: settled.length * amount,
        });
      }
    }

    // `deduped` / `dedupedAmount` are ADDITIVE (the on-site tRPC caller ignores
    // them). The App Blocks tip endpoint reads `dedupedAmount` to refund the daily
    // tip-cap reservation it burned for Buzz that never moved — see tip.ts.
    return { ...data, deduped, dedupedAmount };
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getBuzzAccountTransactionsHandler({
  input,
  ctx,
}: {
  input: GetBuzzAccountTransactionsSchema;
  ctx: ProtectedContext;
}) {
  try {
    input.limit ??= DEFAULT_PAGE_SIZE;
    input.accountId = ctx.user.id;

    const result = await getUserBuzzTransactions({ ...input });
    return result;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export const getUserMultipliersHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  try {
    return getMultipliersForUser(ctx.user.id);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
};

export const claimDailyBoostRewardHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  try {
    const { ip, user } = ctx;
    const { id: userId } = user;
    await dailyBoostReward.apply({ userId }, { ip });
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
}) {
  try {
    return getTransactionsReport({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export function previewMultiAccountTransactionHandler({
  input,
  ctx,
}: {
  input: Omit<PreviewMultiAccountTransactionInput, 'fromAccountId'>;
  ctx: ProtectedContext;
}) {
  try {
    return previewMultiAccountTransaction({
      ...input,
      fromAccountId: ctx.user.id,
    });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}
