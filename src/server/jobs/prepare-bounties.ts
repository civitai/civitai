import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import dayjs from '~/shared/utils/dayjs';
import { Currency } from '~/shared/utils/prisma/enums';
import {
  createBuzzTransaction,
  createBuzzTransactionMany,
  getMultiAccountTransactionsByPrefix,
} from '~/server/services/buzz.service';
import type { BuzzAccountType, BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType, buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { Tracker } from '../clickhouse/client';
import { handleLogError } from '../utils/errorHandling';
import {
  bountyAutomaticallyAwardedEmail,
  bountyExpiredEmail,
  bountyExpiredReminderEmail,
  bountyRefundedEmail,
} from '~/server/email/templates';
import { bountiesSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
import {
  isBountyTransactionPrefix,
  refundBountyBenefactorFunds,
} from '~/server/services/bounty.service';
import { lockBountyForPayout } from '~/server/services/bounty-payout-lock';

const log = createLogger('prepare-bounties', 'blue');

const logJob = (data: MixedObject) => {
  logToAxiom({ name: 'prepare-bounties', type: 'error', ...data }, 'webhooks').catch();
};

const prepareBounties = createJob('prepare-bounties', '0 23 * * *', async () => {
  const [lastRun, setLastRun] = await getJobDate('prepare-bounties');
  const justExpiredBounties = await dbWrite.bounty.findMany({
    where: {
      complete: false,
      // Expires today
      expiresAt: dayjs().toDate(),
      userId: { not: null },
      user: {
        email: { not: null },
      },
      entries: {
        some: {},
      },
    },
    select: {
      id: true,
      name: true,
      userId: true,
      user: {
        select: {
          id: true,
          email: true,
        },
      },
      _count: {
        select: {
          entries: true,
        },
      },
    },
  });

  log(
    'justExpiredBounties IDs',
    justExpiredBounties.map((b) => b.id)
  );

  // send emails to just expired bounties:
  for (const { id, userId, user, name, _count } of justExpiredBounties) {
    log('Sending bounty expired reminder to ', userId);
    if (user?.email) {
      bountyExpiredEmail
        .send({
          bounty: { id, name, entryCount: _count.entries ?? 0 },
          user: { email: user.email },
        })
        .catch((error) =>
          logJob({
            message: 'Error sending bounty expired email',
            data: {
              email: user.email,
              bountyId: id,
              error: error.message,
              cause: error.cause,
              stack: error.stack,
            },
          })
        );
    }
  }

  const needReminderBounties = await dbWrite.bounty.findMany({
    where: {
      complete: false,
      expiresAt: dayjs().subtract(1, 'day').toDate(),
      entries: {
        some: {},
      },
    },
    select: {
      id: true,
      userId: true,
      name: true,
      user: {
        select: {
          id: true,
          username: true,
          email: true,
        },
      },
    },
  });

  log(
    'needReminderBounties IDs',
    needReminderBounties.map((b) => b.id)
  );

  for (const { id, userId, user, name } of needReminderBounties) {
    log('Sending bounty expired reminder to ', userId);
    if (user?.email && user?.username) {
      bountyExpiredReminderEmail
        .send({
          bounty: { id, name },
          user: { username: user.username, email: user.email },
        })
        .catch((error) =>
          logJob({
            message: 'Error sending bounty expired reminder email',
            data: {
              username: user.username,
              email: user.email,
              bountyId: id,
              error: error.message,
              cause: error.cause,
              stack: error.stack,
            },
          })
        );
    }
  }

  const bounties = await dbWrite.bounty.findMany({
    where: {
      AND: [
        {
          complete: false,
        },
        {
          OR: [
            {
              expiresAt: {
                lte: dayjs().subtract(2, 'day').toDate(),
              },
              entries: { some: {} },
            },
            // If no entries, mark as complete and refund
            {
              expiresAt: {
                lte: dayjs().toDate(),
              },
              entries: { none: {} },
            },
          ],
        },
      ],
    },
    select: {
      id: true,
      userId: true,
      name: true,
      user: {
        select: {
          id: true,
          email: true,
        },
      },
    },
  });

  log(
    'awardOrRefundBounties IDs',
    bounties.map((b) => b.id)
  );

  const tracker = new Tracker();

  // Get latest results for date
  for (const { id, userId, name, user } of bounties) {
    log(`Started bounty ${id}`);
    // Claimed under the payout lock; a bounty a void, refund or manual award already claimed
    // is left alone. Buzz moves only after the claim commits.
    const claim = await dbWrite.$transaction(async (tx) => {
      const locked = await lockBountyForPayout(tx, id);
      if (!locked || locked.complete || locked.refunded) return null;

      const [mainBenefactor] = await tx.$queryRaw<{ currency: Currency }[]>`
        SELECT currency FROM "BountyBenefactor" bf WHERE bf."bountyId" = ${id} AND bf."userId" = ${userId} LIMIT 1;
      `;
      if (!mainBenefactor) return null;
      const { currency } = mainBenefactor;

      const [winnerEntry] = await tx.$queryRaw<{ id: number; userId: number }[]>`SELECT
            be.id,
            be."userId",
            COALESCE(SUM(bb."unitAmount"), 0) AS "awardedUnitAmount",
            bes."reactionCountAllTime" AS "reactionCountAllTime"
        FROM "BountyEntry" be
        LEFT JOIN "BountyEntryStat" bes on bes."bountyEntryId" = be.id
        LEFT JOIN "BountyBenefactor" bb ON bb."awardedToId" = be.id AND bb.currency = ${currency}::"Currency"
        WHERE be."bountyId" = ${id}
        GROUP BY be.id, be."userId", bes."reactionCountAllTime"
        ORDER BY "awardedUnitAmount" DESC, "reactionCountAllTime" DESC, be.id ASC LIMIT 1
      `;

      if (!winnerEntry) {
        await tx.$executeRawUnsafe(`
          UPDATE "Bounty" b SET "complete" = true, "refunded" = true WHERE b.id = ${id};
        `);
        return { kind: 'refund' as const, currency };
      }

      const benefactors = await tx.$queryRaw<
        { userId: number; unitAmount: number; buzzTransactionId?: string[] | null }[]
      >`SELECT
            bf."userId",
            bf."unitAmount",
            bf."buzzTransactionId"
        FROM "BountyBenefactor" bf
        WHERE bf."bountyId" = ${id}
          AND bf.currency = ${currency}::"Currency"
          AND bf."awardedToId" IS NULL;
      `;
      await tx.$executeRawUnsafe(`
        UPDATE "BountyBenefactor" bf SET "awardedToId" = ${winnerEntry.id}, "awardedAt" = NOW() WHERE bf."bountyId" = ${id} AND bf."awardedToId" IS NULL;
      `);
      await tx.$executeRawUnsafe(`
        UPDATE "Bounty" b SET "complete" = true WHERE b.id = ${id};
      `);
      return { kind: 'award' as const, currency, winnerEntry, benefactors };
    });

    if (!claim) {
      log(` Bounty ${id} was already claimed; skipped`);
      continue;
    }
    log(" Bounty's main currency detected:", claim.currency);

    if (claim.kind === 'refund') {
      await refundBountyBenefactorFunds({
        bountyId: id,
        currency: claim.currency,
        onlyUnawarded: true,
        description: 'Reason: Bounty refund, no entries found on bounty',
      });

      if (user) {
        bountyRefundedEmail
          .send({
            bounty: { id, name },
            user: { email: user.email },
          })
          .catch((error) =>
            logJob({
              message: 'Error sending bounty refunded email',
              data: {
                email: user.email,
                bountyId: id,
                error: error.message,
                cause: error.cause,
                stack: error.stack,
              },
            })
          );
      }

      tracker.bounty({ type: 'Expire', bountyId: id, userId: -1 }).catch(handleLogError);
      log(` No entry winner detected, bounty has been refunded`);
      continue;
    }

    const { currency, winnerEntry, benefactors } = claim;
    const { id: winnerEntryId, userId: winnerUserId } = winnerEntry;
    tracker
      .bountyEntry({ type: 'Award', bountyEntryId: winnerEntryId, userId: -1 })
      .catch(handleLogError);

    try {
      await payExpiredBountyWinner({ id, currency, winnerEntryId, winnerUserId, benefactors });
    } catch (error) {
      // The award is committed; the Buzz is owed and has to be reconciled by hand.
      logJob({
        message: 'Bounty awarded but the Buzz payout failed',
        data: { bountyId: id, winnerEntryId, error: (error as Error).message },
      });
    }

    await bountiesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

    if (user) {
      bountyAutomaticallyAwardedEmail
        .send({
          bounty: { id, name },
          entry: { id: winnerEntryId },
          user: { email: user.email },
        })
        .catch((error) =>
          logJob({
            message: 'Error sending bounty awarded email',
            data: {
              email: user.email,
              bountyId: id,
              error: error.message,
              cause: error.cause,
              stack: error.stack,
            },
          })
        );
    }
    log(`Finished bounty ${id}`);
  }

  await setLastRun();
});

async function payExpiredBountyWinner({
  id,
  currency,
  winnerEntryId,
  winnerUserId,
  benefactors,
}: {
  id: number;
  currency: Currency;
  winnerEntryId: number;
  winnerUserId: number;
  benefactors: { unitAmount: number; buzzTransactionId?: string[] | null }[];
}) {
  const awardedAmounts: Partial<Record<BuzzSpendType, number>> = {};
  await Promise.all(
    benefactors.map(async ({ unitAmount, buzzTransactionId }) => {
      if (buzzTransactionId && buzzTransactionId.length > 0) {
        const txResults = await Promise.allSettled(
          buzzTransactionId.map(async (txId) =>
            isBountyTransactionPrefix(txId) ? await getMultiAccountTransactionsByPrefix(txId) : null
          )
        );

        txResults.forEach((result, idx) => {
          if (result.status === 'fulfilled' && result.value) {
            result.value.forEach((d) => {
              const accountType = d.accountType as BuzzSpendType;
              // Makes it so we can pay exact amounts.
              awardedAmounts[accountType] = (awardedAmounts[accountType] || 0) + d.amount;
            });
          } else if (result.status === 'fulfilled' && result.value === null) {
            awardedAmounts['yellow'] = (awardedAmounts['yellow'] || 0) + unitAmount;
          } else {
            log(`Bounty ${id}: Failed to get transaction data for ${buzzTransactionId[idx]}`);
          }
        });
      } else {
        awardedAmounts['yellow'] = (awardedAmounts['yellow'] || 0) + unitAmount;
      }
    })
  );

  const awardedAmount = Object.values(awardedAmounts).reduce(
    (sum, amount) => sum + (amount || 0),
    0
  );
  log(
    ` A total of ${awardedAmount} ${currency} will be awarded in this bounty to the entry ${winnerEntryId}`
  );
  if (awardedAmount <= 0 || currency !== Currency.BUZZ) return;

  if (Object.keys(awardedAmounts).length > 0) {
    await createBuzzTransactionMany(
      Object.keys(awardedAmounts).map((accountType) => ({
        fromAccountId: 0,
        toAccountId: winnerUserId,
        toAccountType: accountType as BuzzAccountType,
        amount: awardedAmounts[accountType as BuzzSpendType] || 0,
        type: TransactionType.Bounty,
        description: 'Reason: Bounty entry has been awarded!',
        details: { entityId: id, entityType: 'Bounty' },
        externalTransactionId: `bounty-award-${id}-${accountType}`,
      }))
    );
  } else {
    await createBuzzTransaction({
      fromAccountId: 0,
      toAccountId: winnerUserId,
      amount: awardedAmount,
      type: TransactionType.Bounty,
      description: 'Reason: Bounty entry has been awarded!',
      details: { entityId: id, entityType: 'Bounty' },
    });
  }
}

export const bountyJobs = [prepareBounties];
