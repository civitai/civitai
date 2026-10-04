import type { Prize, PrizeSourceType } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { PrizeBuzzType } from '~/server/schema/prize.schema';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getRequestBoardDomainColor } from '~/server/utils/server-domain';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { createLogger } from '~/utils/logging';

const log = createLogger('prize-service', 'green');

export const PRIZE_AUTO_CLAIM_DAYS = 30;
export const PRIZE_AUTO_CLAIM_BUZZ_TYPE: PrizeBuzzType = 'green';
// A claim pays inline; this long after it, the job takes over a payment that did not land.
const PRIZE_PAYMENT_RETRY_AFTER_MS = 10 * 60 * 1000;
const PRIZE_JOB_BATCH_SIZE = 200;
const PRIZE_JOB_MAX_BATCHES = 20;

/**
 * Yellow is offered only on a red-capable host (civitai.red), resolved the way leaderboards resolve
 * it. Not `ctx.domain`, which defaults an unresolved host to blue.
 */
export function getPrizeBuzzChoices(domain: ColorDomain | undefined): PrizeBuzzType[] {
  return domain === 'red' ? ['green', 'yellow'] : ['green'];
}

export function getRequestPrizeBuzzChoices(req: { headers: { host?: string } }) {
  return getPrizeBuzzChoices(getRequestBoardDomainColor(req));
}

export type PrizeInput = {
  userId: number;
  sourceType: PrizeSourceType;
  sourceId: number;
  subjectId?: number | null;
  position?: number | null;
  amount: number;
  title: string;
  externalTransactionId: string;
};

/** Idempotent on the ledger key: a re-run returns the rows it already wrote. */
export async function createPrizes(inputs: PrizeInput[], { now = new Date() } = {}) {
  const payable = inputs.filter((input) => input.amount > 0);
  if (!payable.length) return [];

  const autoClaimAt = new Date(now.getTime() + PRIZE_AUTO_CLAIM_DAYS * 24 * 60 * 60 * 1000);
  await dbWrite.prize.createMany({
    data: payable.map((input) => ({ ...input, createdAt: now, autoClaimAt })),
    skipDuplicates: true,
  });
  return dbWrite.prize.findMany({
    where: { externalTransactionId: { in: payable.map((input) => input.externalTransactionId) } },
  });
}

/**
 * Unclaimed prizes of a source are never paid once it is voided. A claimed one is left alone: its
 * payment may already be in flight or in the ledger, so it is owed, and the job finishes paying it.
 */
export async function voidPrizes(sourceType: PrizeSourceType, sourceId: number) {
  const { count } = await dbWrite.prize.updateMany({
    where: { sourceType, sourceId, claimedAt: null, voidedAt: null },
    data: { voidedAt: new Date() },
  });
  return count;
}

const onPrizePaid: Partial<Record<PrizeSourceType, (prize: Prize) => Promise<unknown>>> = {
  Crucible: (prize) =>
    redis.del(`${REDIS_KEYS.CRUCIBLE.USER_BUZZ_WON}:${prize.userId}` as RedisKeyTemplateCache),
};

/** The only place prize Buzz moves. Returns whether the ledger holds the payment. */
export async function payPrize(prize: Prize): Promise<boolean> {
  if (prize.paidAt) return true;
  if (!prize.claimedAt || !prize.buzzType || prize.voidedAt) return false;

  try {
    const result = await createBuzzTransactionMany([
      {
        fromAccountId: 0,
        fromAccountType: 'yellow',
        toAccountId: prize.userId,
        toAccountType: prize.buzzType as PrizeBuzzType,
        amount: prize.amount,
        type: TransactionType.Reward,
        description: prize.title,
        details: {
          entityId: prize.sourceId,
          entityType: prize.sourceType,
          position: prize.position,
          prizeId: prize.id,
        },
        externalTransactionId: prize.externalTransactionId,
      },
    ]);
    // A conflict is the ledger already holding this key: paid before, by this or an earlier build.
    if (result.transactions.length + result.conflicts.length < 1) {
      logToAxiom({
        type: 'error',
        name: 'prize-payment-dropped',
        message: `The ledger neither made nor recognised prize ${prize.id}'s payment`,
        prizeId: prize.id,
      }).catch(() => undefined);
      return false;
    }
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'prize-payment-failed',
      message: error instanceof Error ? error.message : String(error),
      prizeId: prize.id,
    }).catch(() => undefined);
    return false;
  }

  await dbWrite.prize.updateMany({
    where: { id: prize.id, paidAt: null },
    data: { paidAt: new Date() },
  });
  await onPrizePaid[prize.sourceType]?.(prize).catch(() => undefined);
  return true;
}

/**
 * A banned winner's prize is held, not voided: it can't be claimed or auto-paid while the ban
 * stands, and pays normally once it is lifted. Muted winners are paid as usual.
 */
async function getBannedUserIds(userIds: number[]) {
  if (!userIds.length) return new Set<number>();
  const banned = await dbWrite.user.findMany({
    where: { id: { in: [...new Set(userIds)] }, bannedAt: { not: null } },
    select: { id: true },
  });
  return new Set(banned.map((user) => user.id));
}

export function resolveClaimBuzzType(
  requested: PrizeBuzzType | undefined,
  choices: PrizeBuzzType[]
): PrizeBuzzType {
  if (choices.length === 1) return choices[0];
  if (!requested) throw throwBadRequestError('Choose which Buzz to receive');
  if (!choices.includes(requested))
    throw throwBadRequestError('That Buzz type is not available here');
  return requested;
}

export async function claimPrize({
  id,
  userId,
  buzzType,
  choices,
}: {
  id: number;
  userId: number;
  buzzType?: PrizeBuzzType;
  choices: PrizeBuzzType[];
}) {
  const prize = await dbWrite.prize.findFirst({ where: { id, userId } });
  if (!prize) throw throwNotFoundError('Prize not found');
  if (prize.voidedAt) throw throwBadRequestError('This prize is no longer available');
  if (prize.claimedAt) return toPrizeView(prize, choices);
  if ((await getBannedUserIds([userId])).size)
    throw throwAuthorizationError('This prize is on hold while your account is banned');

  const type = resolveClaimBuzzType(buzzType, choices);
  const { count } = await dbWrite.prize.updateMany({
    where: { id, userId, claimedAt: null, voidedAt: null },
    data: { claimedAt: new Date(), buzzType: type },
  });
  const claimed = await dbWrite.prize.findUniqueOrThrow({ where: { id } });
  // Lost to another claim or the job: that one pays.
  if (!count) return toPrizeView(claimed, choices);

  if (!(await payPrize(claimed)))
    log(`Prize ${id} claimed but not yet paid; the auto-pay job retries it`);
  return toPrizeView(await dbWrite.prize.findUniqueOrThrow({ where: { id } }), choices);
}

export async function autoPayPrizes({ now = new Date() } = {}) {
  let autoClaimed = 0;
  let retried = 0;

  let dueCursor = 0;
  for (let batch = 0; batch < PRIZE_JOB_MAX_BATCHES; batch++) {
    // Walked by id: a held prize stays due, and must not be served again on every batch.
    const due = await dbWrite.prize.findMany({
      where: { id: { gt: dueCursor }, claimedAt: null, voidedAt: null, autoClaimAt: { lte: now } },
      orderBy: { id: 'asc' },
      take: PRIZE_JOB_BATCH_SIZE,
    });
    if (!due.length) break;
    dueCursor = due[due.length - 1].id;
    const banned = await getBannedUserIds(due.map((prize) => prize.userId));

    for (const prize of due) {
      if (banned.has(prize.userId)) continue;
      const { count } = await dbWrite.prize.updateMany({
        where: { id: prize.id, claimedAt: null, voidedAt: null },
        data: { claimedAt: now, buzzType: PRIZE_AUTO_CLAIM_BUZZ_TYPE, autoClaimed: true },
      });
      if (!count) continue;
      autoClaimed++;
      await payPrize({
        ...prize,
        claimedAt: now,
        buzzType: PRIZE_AUTO_CLAIM_BUZZ_TYPE,
        autoClaimed: true,
      });
    }
    if (due.length < PRIZE_JOB_BATCH_SIZE) break;
  }

  const retryCutoff = new Date(now.getTime() - PRIZE_PAYMENT_RETRY_AFTER_MS);
  let cursor = 0;
  for (let batch = 0; batch < PRIZE_JOB_MAX_BATCHES; batch++) {
    const unpaid = await dbWrite.prize.findMany({
      where: {
        id: { gt: cursor },
        claimedAt: { not: null, lte: retryCutoff },
        paidAt: null,
        voidedAt: null,
      },
      orderBy: { id: 'asc' },
      take: PRIZE_JOB_BATCH_SIZE,
    });
    if (!unpaid.length) break;
    cursor = unpaid[unpaid.length - 1].id;
    const banned = await getBannedUserIds(unpaid.map((prize) => prize.userId));
    for (const prize of unpaid) {
      if (banned.has(prize.userId)) continue;
      if (await payPrize(prize)) retried++;
    }
    if (unpaid.length < PRIZE_JOB_BATCH_SIZE) break;
  }

  return { autoClaimed, retried };
}

export type PrizeView = ReturnType<typeof toPrizeView>;
function toPrizeView(prize: Prize, choices: PrizeBuzzType[]) {
  return {
    id: prize.id,
    sourceType: prize.sourceType,
    sourceId: prize.sourceId,
    position: prize.position,
    amount: prize.amount,
    title: prize.title,
    createdAt: prize.createdAt,
    autoClaimAt: prize.autoClaimAt,
    claimedAt: prize.claimedAt,
    buzzType: prize.buzzType as PrizeBuzzType | null,
    autoClaimed: prize.autoClaimed,
    paid: !!prize.paidAt,
    voided: !!prize.voidedAt,
    choices,
  };
}

export async function getPrize({
  id,
  userId,
  choices,
}: {
  id: number;
  userId: number;
  choices: PrizeBuzzType[];
}) {
  const prize = await dbWrite.prize.findFirst({ where: { id, userId } });
  if (!prize) throw throwNotFoundError('Prize not found');
  return toPrizeView(prize, choices);
}

export async function getMyPrizes({
  userId,
  choices,
  sourceType,
  sourceId,
}: {
  userId: number;
  choices: PrizeBuzzType[];
  sourceType?: PrizeSourceType;
  sourceId?: number;
}) {
  const prizes = await dbWrite.prize.findMany({
    where: { userId, voidedAt: null, sourceType, sourceId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return prizes.map((prize) => toPrizeView(prize, choices));
}
